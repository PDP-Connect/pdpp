// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal owner-LIST projection publisher — the one bounded maintenance
 * authority that assembles `ConnectorListSummaryTerminalProjection` items
 * and calls `publishConnectorListSummaryTerminalProjection`
 * (`connector-summary-read-model.ts`) to persist them.
 *
 * `publishConnectorListSummaryTerminalProjection` and
 * `getConnectorListSummaryTerminalProjection[Batch]` have existed since the
 * terminal-gate revision, fully fenced (`canonical_evidence_revision` CAS +
 * a component-current guard) and unit-tested, but nothing in production ever
 * called the publisher — `connector_summary_evidence.list_summary_projection_*`
 * sat permanently `stale`/`unobserved` after every dirty-mark or rebuild,
 * with no maintenance step ever converging it back to `current`. This module
 * closes that gap.
 *
 * Runs strictly AFTER a page's canonical evidence has already been repaired
 * to `current` (by `observeConnectorSummaryEvidence`/
 * `runBoundedSummaryEvidenceSweep`): `publishConnectorListSummaryTerminalProjection`'s
 * fencing predicate requires `dirty = 0 AND state = 'fresh' AND
 * record_snapshot_state = 'current' AND terminal_facts_state = 'current' AND
 * manifest_declaration_state = 'current'`, so publishing against a
 * freshly-dirtied row is a guaranteed no-op by design — this module never
 * tries to force that gate itself.
 *
 * Assembly reuses the SAME N+1-safe batched projection path every
 * `/_ref/connectors` read already uses (`listConnectorSummaries` with
 * `visibleConnections`, backed by `loadConnectorSummaryProjectionDeps`'s
 * one-batched-read-per-page-of-dependencies contract) — never a
 * per-connection read loop, never a second/competing assembly
 * implementation. Read endpoints never call this module; they only ever
 * read `connector_summary_evidence` as the last maintenance pass left it
 * (design.md "Startup is acceleration, not authority" / the terminal-gate
 * revision's "ordinary GET must never write").
 */

import {
  type ConnectorListSummaryTerminalProjection,
  listConnectorSummaryEvidence,
  publishConnectorListSummaryTerminalProjection,
} from "./connector-summary-read-model.ts";
import { getConnectorInstanceStore, listConnectorSummaries, REFERENCE_OWNER_SUBJECT_ID } from "./ref-control.ts";

/** A row shape returned by `listConnectorSummaryEvidence` (`shapeEvidenceRow`'s output). */
type ShapedEvidenceRow = Awaited<ReturnType<typeof listConnectorSummaryEvidence>>[number];

export interface PublishTerminalProjectionsResult {
  /** Ids whose evidence row was not fully current (skipped — not this pass's job to repair). */
  readonly notCurrent: number;
  /** Ids for which `publishConnectorListSummaryTerminalProjection` returned `false` (fenced out by a concurrent mutation). */
  readonly published: number;
  readonly rejected: number;
}

function evidenceRowIsFullyCurrent(row: ShapedEvidenceRow): boolean {
  return (
    !row.dirty &&
    row.state === "fresh" &&
    row.record_snapshot.state === "current" &&
    row.terminal_facts.state === "current" &&
    row.manifest_declaration.state === "current"
  );
}

/**
 * Assemble and publish the terminal owner-LIST projection for exactly the
 * given `connectorInstanceIds` whose canonical evidence a maintenance pass
 * has just repaired. Bounded to the caller's own id set (never a fleet
 * scan): one batched evidence read, one batched owner-instance-row read, one
 * batched summary-projection assembly (`listConnectorSummaries`), then one
 * fenced publish call per row that is fully current.
 *
 * Best-effort per row: a single row's publish failure (fencing rejection or
 * a thrown error) never blocks the rest of the batch. Rows whose evidence is
 * not fully current are skipped — never force-published — matching the
 * publisher's own fencing contract.
 */
export async function publishConnectorListSummaryTerminalProjectionsForIds(
  connectorInstanceIds: readonly string[]
): Promise<PublishTerminalProjectionsResult> {
  const ids = [...new Set(connectorInstanceIds.filter((id) => id.length > 0))];
  if (ids.length === 0) {
    return { notCurrent: 0, published: 0, rejected: 0 };
  }

  const evidenceRows = await listConnectorSummaryEvidence({ connectorInstanceIds: ids });
  const evidenceByInstanceId = new Map(evidenceRows.map((row) => [String(row.connector_instance_id), row]));

  const currentIds = ids.filter((id) => {
    const row = evidenceByInstanceId.get(id);
    return row !== undefined && evidenceRowIsFullyCurrent(row);
  });
  const notCurrent = ids.length - currentIds.length;
  if (currentIds.length === 0) {
    return { notCurrent, published: 0, rejected: 0 };
  }

  const instanceRows = await Promise.resolve(
    getConnectorInstanceStore().listByIds(currentIds, REFERENCE_OWNER_SUBJECT_ID)
  );
  if (instanceRows.length === 0) {
    return { notCurrent, published: 0, rejected: 0 };
  }

  // Batched assembly — the SAME N+1-safe path `/_ref/connectors` uses for a
  // bounded, caller-supplied connection set (`ListConnectorSummariesOptions.visibleConnections`).
  // No live controller for a background maintenance pass: `runtimeOk` honestly
  // reads `false`, matching the maintenance sweep's other durable-state-only reads.
  const summaries = await listConnectorSummaries(null, { visibleConnections: instanceRows });
  const computedAt = new Date().toISOString();

  let published = 0;
  let rejected = 0;
  for (const summary of summaries) {
    const evidenceRow = evidenceByInstanceId.get(summary.connector_instance_id);
    if (!evidenceRow) {
      continue;
    }
    const projection: ConnectorListSummaryTerminalProjection = {
      runtime: {
        observed_at: computedAt,
        projection: summary.connection_health.ephemeral_browser_runtime,
      },
      summary: { ...summary },
    };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each publish is an independent fenced write; a batch UPDATE cannot express per-row optimistic-concurrency rejection.
      const ok = await publishConnectorListSummaryTerminalProjection({
        canonicalEvidenceRevision: evidenceRow.canonical_evidence_revision,
        computedAt,
        connectorInstanceId: summary.connector_instance_id,
        projection,
      });
      if (ok) {
        published += 1;
      } else {
        rejected += 1;
      }
    } catch {
      // Best-effort: one row's publish failure must not block the rest of
      // the batch. The row's `list_summary_projection_state` stays exactly
      // as the last maintenance pass left it; a later pass retries it.
      rejected += 1;
    }
  }
  return { notCurrent, published, rejected };
}
