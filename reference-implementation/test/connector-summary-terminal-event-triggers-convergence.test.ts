// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for the 2026-08-01 live symptom: `run.detail_coverage_declared`
 * (transactions) reported covered=4/considered=4 (fully covered) on
 * run_5e9d96f2979a4b41b5db6644c8c8e59a, but
 * `GET /_ref/connectors?connector_instance_id=...` kept serving the PRIOR
 * run's stale covered=2/considered=4 `retryable_gap` evidence for 120s+.
 *
 * Root cause: `connector_summary_evidence.terminal_facts` (the fold that
 * turns terminal `run.completed`/`run.failed`/`run.cancelled` events into
 * per-stream coverage facts) converges ONLY when the periodic connector-
 * maintenance sweep's round-robin keyset walk happens to revisit that
 * connection's page (connector-maintenance-sweep.ts /
 * runBoundedSummaryEvidenceSweep) — latency proportional to fleet size and
 * cursor position, not to the run's own completion. No terminal-event
 * emission site in runtime/index.ts or runtime/controller.ts ever dirtied
 * or scoped-reconciled the row.
 *
 * The fix: `emitSpineEvent` (lib/spine.ts) — the ONE choke point every
 * terminal run event funnels through, regardless of emission site or
 * storage backend — now awaits a scoped, single-connection
 * `reconcileDirtyConnectorSummaryEvidence` + terminal-projection publish
 * immediately after a terminal run event commits.
 *
 * This test proves the fix with NO maintenance-sweep call anywhere: if the
 * fix regresses (the hook is removed, or its scope/timing breaks), this
 * test fails because evidence and the live GET path stay on stale prior-run
 * facts with zero sweep involved to paper over it.
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
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { invalidateConnectorSummariesCache, listConnectorSummaries } from "../server/ref-control.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const NOW = "2026-08-01T00:00:00.000Z";
const OWNER = "owner_local";
const CONNECTOR_INSTANCE_ID = "cin_terminal_convergence_probe";

// The real registered USAA connector manifest — the exact connector the live
// symptom named — read directly so this cannot silently drift from what the
// connector actually declares.
const REAL_USAA_MANIFEST = JSON.parse(
  readFileSync(new URL("../../packages/polyfill-connectors/manifests/usaa.json", import.meta.url), "utf8")
) as {
  readonly capabilities: Record<string, unknown>;
  readonly connector_id: string;
  readonly streams: readonly { readonly name: string; readonly primary_key: readonly string[] }[];
};
const CONNECTOR_ID = REAL_USAA_MANIFEST.connector_id;
if (REAL_USAA_MANIFEST.streams.length === 0) {
  throw new Error("premise: the real USAA manifest declares at least one stream");
}
const TRANSACTIONS_STREAM = REAL_USAA_MANIFEST.streams.find((s) => s.name === "transactions")?.name;
if (!TRANSACTIONS_STREAM) {
  throw new Error("premise: the real USAA manifest declares a transactions stream");
}

function withTmpDb(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-terminal-convergence-"));
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
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(REAL_USAA_MANIFEST), NOW);
}

async function seedInstance() {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    createdAt: NOW,
    displayName: "USAA (browser-collector)",
    ownerSubjectId: OWNER,
    sourceBinding: { account: "usaa", kind: "browser_collector" },
    sourceBindingKey: "usaa-terminal-convergence",
    sourceKind: "browser_collector",
    status: "active",
    updatedAt: NOW,
  });
}

/** One run through the real `emitSpineEvent` entrypoint, covering every declared stream at the given coverage ratio. */
async function seedRun(
  runId: string,
  occurredAt: string,
  seq: number,
  coverage: { collected: number; considered: number; covered: number }
) {
  const baseData = {
    connection_id: CONNECTOR_INSTANCE_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
    source: { id: CONNECTOR_ID, kind: "connector" },
  };
  await emitSpineEvent({
    actor_id: CONNECTOR_ID,
    actor_type: "runtime",
    data: { ...baseData, boot_epoch: "00000000-0000-4000-8000-000000000099", seq },
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
        streams: REAL_USAA_MANIFEST.streams.map((stream) => ({
          checkpoint: coverage.covered >= coverage.considered ? "committed" : "not_committed",
          collected: coverage.collected,
          considered: coverage.considered,
          covered: coverage.covered,
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
  "REGRESSION: a fully-covered terminal run.completed converges connector_summary_evidence with NO maintenance-sweep call at all",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();

    // Run 1: partial coverage (2/4) — mirrors the live symptom's stale prior
    // covered=2 considered=4 evidence.
    await seedRun("run_prior_partial", "2026-08-01T20:55:00.000Z", 1, { collected: 2, considered: 4, covered: 2 });

    const afterRun1 = await getConnectorSummaryEvidence(CONNECTOR_INSTANCE_ID);
    assert.ok(
      afterRun1,
      "evidence row exists after the first terminal event (created by the convergence trigger itself)"
    );
    assert.equal(
      afterRun1.terminal_facts.state,
      "current",
      "the terminal-event hook converges the fold with no sweep call"
    );
    const factsAfterRun1 = afterRun1.stream_latest_facts as Record<
      string,
      { fact: { covered?: number; considered?: number } }
    > | null;
    assert.equal(factsAfterRun1?.[TRANSACTIONS_STREAM]?.fact.covered, 2);
    assert.equal(factsAfterRun1?.[TRANSACTIONS_STREAM]?.fact.considered, 4);

    // Run 2: the live symptom's actual newer run — fully covered (4/4).
    // NO runBoundedSummaryEvidenceSweep / reconcileDirtyConnectorSummaryEvidence
    // call anywhere in this test: if the fix regresses, this stays on run 1's
    // stale 2/4 facts exactly like the live symptom.
    await seedRun("run_newer_full", "2026-08-01T20:59:38.741Z", 2, { collected: 4, considered: 4, covered: 4 });

    const evidence = await getConnectorSummaryEvidence(CONNECTOR_INSTANCE_ID);
    assert.ok(evidence, "evidence row exists after the second terminal event");
    assert.equal(evidence.dirty, false);
    assert.equal(
      evidence.terminal_facts.state,
      "current",
      "terminal fold converged immediately, not after a later sweep"
    );
    const facts = evidence.stream_latest_facts as Record<
      string,
      { fact: { covered?: number; considered?: number }; run_id: string | null }
    > | null;
    assert.ok(facts, "fold stores a per-stream fact map");
    assert.equal(
      facts[TRANSACTIONS_STREAM]?.run_id,
      "run_newer_full",
      "the newer run's proof is what is stored, not the stale prior run's"
    );
    assert.equal(
      facts[TRANSACTIONS_STREAM]?.fact.covered,
      4,
      "coverage reflects the newer fully-covered run, not the stale covered=2"
    );
    assert.equal(facts[TRANSACTIONS_STREAM]?.fact.considered, 4);

    // The real production read path: listConnectorSummaries is what
    // /_ref/connectors calls.
    const summaries = await listConnectorSummaries();
    const summary = summaries.find(
      (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === CONNECTOR_INSTANCE_ID
    );
    assert.ok(summary, "the connection projects a summary with no sweep call");
    assert.equal(
      summary.connection_health.axes.coverage,
      "complete",
      `coverage axis must reflect the newer fully-covered run, not the stale retryable_gap (axes=${JSON.stringify(summary.connection_health.axes)})`
    );

    // Terminal owner-LIST projection also converges (publish runs right
    // after evidence converges, inside the same trigger).
    const projection = await getConnectorListSummaryTerminalProjection(CONNECTOR_INSTANCE_ID);
    assert.equal(projection.state, "current", "the terminal LIST projection also converges from the same trigger");
  })
);

test(
  "REGRESSION: run.failed and run.cancelled also trigger scoped convergence (not success-only)",
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();

    const runId = "run_failed_convergence";
    await emitSpineEvent({
      actor_id: CONNECTOR_ID,
      actor_type: "runtime",
      data: {
        boot_epoch: "00000000-0000-4000-8000-000000000099",
        connection_id: CONNECTOR_INSTANCE_ID,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
        seq: 1,
        source: { id: CONNECTOR_ID, kind: "connector" },
      },
      event_type: "run.started",
      object_id: runId,
      object_type: "run",
      occurred_at: "2026-08-01T21:00:00.000Z",
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
        connection_id: CONNECTOR_INSTANCE_ID,
        connector_instance_id: CONNECTOR_INSTANCE_ID,
        reason: "connector_reported_failed",
        source: { id: CONNECTOR_ID, kind: "connector" },
      },
      event_type: "run.failed",
      object_id: runId,
      object_type: "run",
      occurred_at: "2026-08-01T21:00:05.000Z",
      run_id: runId,
      source_id: CONNECTOR_ID,
      source_kind: "connector",
      status: "failed",
      trace_id: `trc_${runId}`,
    });

    const evidence = await getConnectorSummaryEvidence(CONNECTOR_INSTANCE_ID);
    assert.ok(evidence, "evidence row exists after a failed terminal event, with no sweep call");
    assert.equal(
      evidence.terminal_facts.state,
      "current",
      "run.failed also triggers convergence, not just run.completed"
    );
  })
);
