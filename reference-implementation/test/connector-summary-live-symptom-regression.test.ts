// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end regression for the exact live symptom: after a successful
 * connector run with fully-covered required streams, `/_ref/connectors`
 * (via `listConnectorSummaries`, the real route path) must report the
 * connection `ProjectionReliable: true` and `connection_health.state:
 * "healthy"` once ONE bounded maintenance cycle (`runBoundedSummaryEvidenceSweep`,
 * the exact primitive the periodic 60s tick and the startup pass both call)
 * has run — with no read-time reconcile/mutation.
 *
 * This proves (or disproves) the claim that the existing bounded sweep
 * already closes `evidenceUnreliableSources` (server/ref-control.ts:3539)
 * for a genuinely-successful connection, rather than asserting it from code
 * review alone.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { emitSpineEvent } from "../lib/spine.ts";
import {
  getConnectorListSummaryTerminalProjection,
  getConnectorSummaryEvidence,
  markConnectorSummaryEvidenceDirty,
  runBoundedSummaryEvidenceSweep,
} from "../server/connector-summary-read-model.ts";
import { publishConnectorListSummaryTerminalProjectionsForIds } from "../server/connector-summary-terminal-publisher.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { invalidateConnectorSummariesCache, listConnectorSummaries } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const NOW = "2026-07-31T00:00:00.000Z";
const OWNER = "owner_local";
const CONNECTOR_INSTANCE_ID = "cin_live_symptom_probe";

// The REAL registered Amazon connector manifest (packages/polyfill-connectors/
// manifests/amazon.json) — the exact connector named in the live symptom
// report. Read directly rather than hand-authored, so this regression cannot
// silently drift from what the real connector actually declares (in
// particular `capabilities.refresh_policy.maximum_staleness_seconds`, which
// is required for the freshness axis to resolve at all — see
// deriveReferenceFreshness in server/freshness.ts).
const REAL_AMAZON_MANIFEST = JSON.parse(
  readFileSync(new URL("../../packages/polyfill-connectors/manifests/amazon.json", import.meta.url), "utf8")
) as {
  readonly capabilities: Record<string, unknown>;
  readonly connector_id: string;
  readonly streams: readonly { readonly name: string; readonly primary_key: readonly string[] }[];
};
const CONNECTOR_ID = REAL_AMAZON_MANIFEST.connector_id;
if (REAL_AMAZON_MANIFEST.streams.length === 0) {
  throw new Error("premise: the real Amazon manifest declares at least one stream");
}

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-live-symptom-"));
    initDb(join(dir, "pdpp.sqlite"));
    invalidateConnectorSummariesCache();
    try {
      await fn();
    } finally {
      invalidateConnectorSummariesCache();
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

function seedConnector() {
  // The verbatim real manifest — including its real `refresh_policy`
  // (`maximum_staleness_seconds: 86400`, `recommended_mode: "manual"`) and
  // `public_listing.listed: true`. No synthetic capability is added.
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(REAL_AMAZON_MANIFEST), NOW);
}

async function seedInstance() {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    displayName: "Amazon (browser-collector)",
    ownerSubjectId: OWNER,
    sourceBinding: { account: "amazon", kind: "browser_collector" },
    sourceBindingKey: "amazon-live-symptom",
    sourceKind: "browser_collector",
    status: "active",
    updatedAt: NOW,
  });
}

/**
 * Mirrors the live "successful ChatGPT/Amazon run" shape: a real
 * `run.started` -> `run.completed` pair on the spine, through the SAME
 * `emitSpineEvent` production entrypoint the controller calls, with EVERY
 * stream the real manifest declares fully covered (considered === covered,
 * no known_gaps) so nothing OTHER than evidence reliability could keep the
 * connection from reading healthy — a partially-fed stream set would leave
 * `coverage: unknown` for reasons unrelated to the fix under test.
 */
async function seedSuccessfulCoveredRun(runId: string, occurredAt: string) {
  const baseData = {
    connection_id: CONNECTOR_INSTANCE_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
    source: { id: CONNECTOR_ID, kind: "connector" },
  };
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: { ...baseData, boot_epoch: "00000000-0000-4000-8000-000000000099", seq: 1 },
    event_type: "run.started",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: "started",
    trace_id: `trc_${runId}`,
  });
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: {
      ...baseData,
      collection_facts: {
        streams: REAL_AMAZON_MANIFEST.streams.map((stream) => ({
          checkpoint: "committed",
          collected: 12,
          considered: 12,
          covered: 12,
          pending_detail_gaps: 0,
          skipped: null,
          stream: stream.name,
        })),
      },
    },
    event_type: "run.completed",
    object_id: runId,
    object_type: "run",
    occurred_at: occurredAt,
    run_id: runId,
    source_id: CONNECTOR_ID,
    source_kind: "connector",
    status: "succeeded",
    trace_id: `trc_${runId}`,
  });
}

test(
  "LIVE SYMPTOM: after a successful fully-covered run, one bounded maintenance cycle makes /_ref/connectors report ProjectionReliable and healthy, with no read-time fallback/mutation",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    await seedSuccessfulCoveredRun("run_live_symptom_1", "2026-07-31T00:05:00.000Z");

    // Pre-condition: the terminal run.completed event's own scoped
    // convergence trigger (lib/spine.ts's emitSpineEvent) already created and
    // converged the evidence row before any maintenance cycle runs — proven
    // separately by connector-summary-terminal-event-triggers-convergence.test.ts.
    // This test's job is the NEXT layer: that the periodic maintenance sweep
    // is ALSO sufficient on its own (the durable backstop), so it still runs
    // one bounded cycle below regardless of this pre-existing convergence.
    const before = await getConnectorSummaryEvidence(CONNECTOR_INSTANCE_ID);
    assert.ok(before, "the terminal event's own convergence trigger already created the evidence row");
    assert.equal(before.terminal_facts.state, "current");

    // ONE bounded maintenance cycle — the exact primitive both the periodic
    // 60s tick (connector-maintenance-sweep.ts) and the startup pass call.
    // Not `rebuildConnectorSummaryEvidence()` (unbounded, test-only shortcut)
    // and not a second/extra call — exactly what production runs once.
    const sweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 5000, pageSize: 25 });
    assert.equal(sweep.incomplete, false, "one bounded cycle must fully converge a single-connection fleet");
    assert.ok(sweep.observedIds.includes(CONNECTOR_INSTANCE_ID));

    // Evidence-row proof: the three components `evidenceUnreliableSources`
    // (server/ref-control.ts:3539) gates on are all current after this one
    // cycle — this is the exact mechanism the live symptom depends on.
    const evidence = await getConnectorSummaryEvidence(CONNECTOR_INSTANCE_ID);
    assert.ok(evidence, "evidence row exists after the maintenance cycle");
    assert.equal(evidence.dirty, false);
    assert.equal(evidence.state, "fresh");
    assert.equal(evidence.record_snapshot.state, "current");
    assert.equal(evidence.terminal_facts.state, "current", "terminal fold must have converged in this one cycle");
    assert.equal(evidence.manifest_declaration.state, "current");

    // No-mutation-on-read proof: capture the write count, then read.
    const beforeReadRow = getDb().prepare("SELECT total_changes() AS changes").get<{ changes: number }>();
    assert.ok(beforeReadRow);

    // The actual production read path: listConnectorSummaries is what
    // /_ref/connectors calls (server/ref-control.ts).
    const summaries = await listConnectorSummaries();

    const afterReadRow = getDb().prepare("SELECT total_changes() AS changes").get<{ changes: number }>();
    assert.ok(afterReadRow);
    assert.equal(
      afterReadRow.changes,
      beforeReadRow.changes,
      "the owner-facing read must never write — no inline reconcile/fallback mutation"
    );

    const summary = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === CONNECTOR_INSTANCE_ID
    );
    assert.ok(summary, "the connection projects a summary");

    // The exact live symptom, inverted: ProjectionReliable must be true
    // (no unreliable-evidence condition), never false/unknown.
    const projectionCondition = summary.connection_health.conditions.find((c) => c.type === "ProjectionReliable");
    assert.ok(projectionCondition, "a ProjectionReliable condition is always emitted");
    assert.equal(
      projectionCondition.status,
      "true",
      `ProjectionReliable must read true after one maintenance cycle on a genuinely current, fully-covered connection (got reason=${String(projectionCondition.reason)})`
    );

    assert.equal(
      summary.connection_health.state,
      "healthy",
      `connection_health.state must read healthy, not unknown/degraded (axes=${JSON.stringify(summary.connection_health.axes)})`
    );
    assert.equal(summary.connection_health.axes.coverage, "complete");
    assert.equal(summary.rendered_verdict.pill.label, "Healthy");
  })
);

test(
  "LIVE SYMPTOM (dirty-then-repair shape): a successful run followed by a local-binding repair dirty-mark still converges to reliable+healthy after one bounded cycle, and the terminal LIST projection itself moves from stale to current",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    await seedSuccessfulCoveredRun("run_live_symptom_2", "2026-07-31T00:05:00.000Z");

    // First bounded cycle: establishes a current, published baseline —
    // exactly the "after successful run" state before any repair mutation.
    const firstSweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 5000, pageSize: 25 });
    assert.equal(firstSweep.incomplete, false);
    const firstPublish = await publishConnectorListSummaryTerminalProjectionsForIds(firstSweep.observedIds);
    assert.equal(firstPublish.published, 1);
    const currentProjection = await getConnectorListSummaryTerminalProjection(CONNECTOR_INSTANCE_ID);
    assert.equal(currentProjection.state, "current");

    // Simulate a local-binding repair / record mutation after the run — the
    // exact live-proof wording: "after ... a local-binding repair,
    // connector_summary_evidence rows stay dirty/stale". This is what
    // markConnectorSummaryEvidenceDirty's real production callers do
    // (server/records.ts, on record ingest/delete).
    await markConnectorSummaryEvidenceDirty({
      connectorInstanceId: CONNECTOR_INSTANCE_ID,
      reason: "local-binding repair",
    });
    const dirtyEvidence = await getConnectorSummaryEvidence(CONNECTOR_INSTANCE_ID);
    assert.ok(dirtyEvidence?.dirty, "premise: the repair mutation actually dirtied the row");
    const staleProjection = await getConnectorListSummaryTerminalProjection(CONNECTOR_INSTANCE_ID);
    assert.equal(
      staleProjection.state,
      "stale",
      "premise: the dirty mark invalidates the previously-current terminal LIST projection"
    );

    // A read taken RIGHT NOW (before any further maintenance cycle) is
    // honestly unreliable — this is the live symptom's starting point, not
    // a bug: the maintenance sweep, not the read, is the repair authority.
    const midSummaries = await listConnectorSummaries();
    const midSummary = midSummaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === CONNECTOR_INSTANCE_ID
    );
    assert.ok(midSummary);
    const midCondition = midSummary.connection_health.conditions.find((c) => c.type === "ProjectionReliable");
    assert.equal(midCondition?.status, "false", "premise: a freshly-dirtied row is honestly unreliable until repaired");

    // ONE more bounded maintenance cycle — same primitive, same bound —
    // must repair the dirty evidence AND let the publisher re-converge the
    // terminal LIST projection from stale back to current.
    const secondSweep = await runBoundedSummaryEvidenceSweep({ maxDurationMs: 5000, pageSize: 25 });
    assert.equal(secondSweep.incomplete, false);
    const secondPublish = await publishConnectorListSummaryTerminalProjectionsForIds(secondSweep.observedIds);
    assert.equal(secondPublish.published, 1, "the publisher must re-converge the projection after the repair cycle");

    const republished = await getConnectorListSummaryTerminalProjection(CONNECTOR_INSTANCE_ID);
    assert.equal(republished.state, "current");

    const afterSummaries = await listConnectorSummaries();
    const afterSummary = afterSummaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === CONNECTOR_INSTANCE_ID
    );
    assert.ok(afterSummary);
    const afterCondition = afterSummary.connection_health.conditions.find((c) => c.type === "ProjectionReliable");
    assert.equal(
      afterCondition?.status,
      "true",
      `ProjectionReliable must recover to true after the repair cycle (got reason=${String(afterCondition?.reason)})`
    );
    assert.equal(afterSummary.connection_health.state, "healthy");
  })
);
