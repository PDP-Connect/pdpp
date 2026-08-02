// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for the live symptom: a connection whose terminal history is
 * entirely generation-refused (`terminal_facts_historical`) must still
 * advance its `stream_facts_event_seq` checkpoint through the events its
 * fold pass durably inspected. Before this fix, the write loop in
 * `foldConnectorSummaryStreamFactsOnce` (connector-summary-read-model.ts)
 * floored a generation-refused participant's checkpoint write back to its
 * OWN stale incoming checkpoint instead of the pass's drained cursor
 * (`writeSeq`) — so a historical-only row re-read the exact same already-
 * inspected terminal-event batch on every maintenance pass, forever, at
 * `sinceSeq = 0`. `seedFoldState`'s `sinceSeq = Math.min(...)` scopes every
 * OTHER fleet participant's fold pass to the oldest checkpoint among them, so
 * one permanently-pinned historical row also starved every sibling
 * connection's own convergence.
 *
 * Facts must still stay refused/historical for as long as the source
 * generation is genuinely refused — only the CHECKPOINT (proof of having
 * inspected the events, not proof of a current-generation match) should
 * advance.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";

const OWNER = "owner_local";
const NOW = "2026-08-01T00:00:00.000Z";

async function withTempDb<T>(fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-historical-checkpoint-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function seedInstance(connectorInstanceId: string, connectorId: string) {
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(connectorId, JSON.stringify({ connector_id: connectorId }), NOW);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       )
       VALUES(?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`
    )
    .run(connectorInstanceId, OWNER, connectorId, connectorId, connectorInstanceId, NOW, NOW);
}

let seededEventSeq = 0;

/**
 * Appends a terminal spine event stamped with an EXPLICIT `manifest_generation`,
 * bypassing the `stamp_terminal_manifest_generation` trigger (which only fires
 * `WHEN NEW.manifest_generation IS NULL`) — the exact production shape of an
 * event recorded under a since-superseded generation, still present in
 * history after the connection's own generation later advanced.
 */
function seedTerminalEventAtGeneration({
  connectorInstanceId,
  occurredAt,
  runId,
  manifestGeneration,
  collected,
}: {
  connectorInstanceId: string;
  occurredAt: string;
  runId: string;
  manifestGeneration: number;
  collected: number;
}) {
  seededEventSeq += 1;
  const data = {
    collection_facts: {
      reference_only: true,
      schema_version: 1,
      streams: [{ checkpoint: "committed", collected, stream: "messages" }],
    },
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
  };
  getDb()
    .prepare(
      `INSERT INTO spine_events(
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
         connector_instance_id, manifest_generation
       )
       VALUES(?, ?, 'run.completed', ?, ?, 'test', ?, 'runtime', 'test-connector', 'run', ?, 'succeeded', ?, ?, '1', ?, ?)`
    )
    .run(
      `evt_${seededEventSeq}`,
      seededEventSeq,
      occurredAt,
      occurredAt,
      `trace_${seededEventSeq}`,
      runId,
      runId,
      JSON.stringify(data),
      connectorInstanceId,
      manifestGeneration
    );
  return seededEventSeq;
}

/** Bumps the connection's durable generation, mirroring a real manifest-fingerprint transition. */
function bumpEvidenceGeneration(connectorInstanceId: string, manifestGeneration: number) {
  getDb()
    .prepare("UPDATE connector_summary_evidence SET manifest_generation = ? WHERE connector_instance_id = ?")
    .run(manifestGeneration, connectorInstanceId);
}

function checkpointFor(connectorInstanceId: string): number | null {
  const row = getDb()
    .prepare("SELECT stream_facts_event_seq FROM connector_summary_evidence WHERE connector_instance_id = ?")
    .get<{ stream_facts_event_seq: number | null }>(connectorInstanceId);
  assert.ok(row, "evidence row exists");
  return row.stream_facts_event_seq === null ? null : Number(row.stream_facts_event_seq);
}

test("historical-only pass advances its checkpoint through the drained cursor without accepting facts", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    await rebuildConnectorSummaryEvidence();
    // The connection's durable generation has already moved to 1 (a real
    // manifest-fingerprint transition), but its terminal history below
    // predates that — stamped at the OLD generation 0.
    bumpEvidenceGeneration("cin_hist", 1);

    const seq1 = seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old_1",
    });
    const seq2 = seedTerminalEventAtGeneration({
      collected: 20,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:02:00.000Z",
      runId: "run_old_2",
    });
    assert.ok(seq2 > seq1);

    const pass = await foldConnectorSummaryStreamFacts();
    assert.equal(pass.refused, 2, "both generation-mismatched events are refused, not folded");

    const evidence = await getConnectorSummaryEvidence("cin_hist");
    assert.ok(evidence);
    assert.equal(evidence.terminal_facts.state, "stale", "facts stay refused — never presented as current");
    assert.equal(
      evidence.terminal_facts.reason_code,
      "terminal_facts_historical",
      "the refusal reason is the generation mismatch, not incompleteness"
    );
    assert.equal(
      checkpointFor("cin_hist"),
      seq2,
      "the checkpoint advances through the drained cursor even though the source generation is refused — " +
        "the OLD (pre-fix) behavior pinned this at null/0, forever re-reading the same inspected events"
    );
  });
});

test("a repeated pass over an unchanged historical-only row does not reread the same events", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_hist", 1);
    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old_1",
    });

    const firstPass = await foldConnectorSummaryStreamFacts();
    assert.equal(firstPass.eventsRead, 1);
    assert.equal(firstPass.refused, 1);

    // No new terminal history since the first pass — a periodic maintenance
    // tick (the real production caller, every ~60s) must not re-read the
    // event this connection's checkpoint already proved it inspected.
    const secondPass = await foldConnectorSummaryStreamFacts();
    assert.equal(
      secondPass.eventsRead,
      0,
      "the pre-fix bug re-read the same already-inspected event on every pass forever (sinceSeq pinned at the old checkpoint)"
    );
    assert.equal(secondPass.refused, 0);
    // The row still RE-PARTICIPATES every pass (its `terminal_facts_state`
    // stays `"stale"`, the durable healing-retry design in
    // `rowNeedsFoldParticipation` — a later current-generation event must
    // always get a chance to heal it). What must NOT happen is re-reading
    // history already proven inspected: `eventsRead: 0` above is the actual
    // proof: the checkpoint advanced past the only event in scope, so the
    // scoped terminal-event read finds nothing new for this pass to drain.
    assert.equal(secondPass.participants, 1);
  });
});

test("a later current-generation terminal event is still read and heals the row normally", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_hist", 1);
    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old",
    });

    const firstPass = await foldConnectorSummaryStreamFacts();
    assert.equal(firstPass.refused, 1);
    const midEvidence = await getConnectorSummaryEvidence("cin_hist");
    assert.ok(midEvidence);
    assert.equal(midEvidence.terminal_facts.state, "stale");

    // A genuinely new run lands, correctly stamped at the connection's
    // CURRENT generation (1).
    const currentSeq = seedTerminalEventAtGeneration({
      collected: 42,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 1,
      occurredAt: "2026-08-01T00:05:00.000Z",
      runId: "run_current",
    });

    const secondPass = await foldConnectorSummaryStreamFacts();
    assert.equal(secondPass.eventsRead, 1, "the fold reads the new current-generation event");
    assert.equal(secondPass.refused, 0);
    assert.equal(secondPass.folded, 1);

    const healed = await getConnectorSummaryEvidence("cin_hist");
    assert.ok(healed);
    assert.equal(healed.terminal_facts.state, "current", "a current-generation event heals the row");
    assert.equal(healed.terminal_facts.reason_code, null);
    const facts = healed.stream_latest_facts as Record<string, { fact: { collected: number } }> | null;
    assert.ok(facts?.messages, "the current-generation fact is present");
    assert.equal(facts.messages.fact.collected, 42);
    assert.equal(checkpointFor("cin_hist"), currentSeq);
  });
});

test("a mixed fleet cannot be pinned by one historical participant — a healthy sibling still converges every pass", async () => {
  await withTempDb(async () => {
    seedInstance("cin_hist", "gmail");
    seedInstance("cin_healthy", "gmail");
    await rebuildConnectorSummaryEvidence();
    bumpEvidenceGeneration("cin_hist", 1);

    seedTerminalEventAtGeneration({
      collected: 10,
      connectorInstanceId: "cin_hist",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:01:00.000Z",
      runId: "run_old",
    });
    const healthySeq = seedTerminalEventAtGeneration({
      collected: 5,
      connectorInstanceId: "cin_healthy",
      manifestGeneration: 0,
      occurredAt: "2026-08-01T00:02:00.000Z",
      runId: "run_healthy",
    });

    const firstPass = await foldConnectorSummaryStreamFacts();
    assert.equal(firstPass.refused, 1, "only the historical participant's event is refused");
    assert.equal(firstPass.folded, 1, "the healthy sibling's event folds normally in the SAME pass");

    const healthyEvidence = await getConnectorSummaryEvidence("cin_healthy");
    assert.ok(healthyEvidence);
    assert.equal(healthyEvidence.terminal_facts.state, "current");
    assert.equal(checkpointFor("cin_healthy"), healthySeq);

    // A follow-up pass — the historical row must not force the healthy
    // sibling's scope back to `sinceSeq = 0` on every subsequent tick either
    // (the pinned checkpoint would otherwise re-widen `seedFoldState`'s
    // `Math.min(...)` floor for the WHOLE scoped batch every round).
    const secondPass = await foldConnectorSummaryStreamFacts();
    assert.equal(secondPass.eventsRead, 0, "neither participant re-reads already-inspected history on the next pass");
    assert.equal(checkpointFor("cin_healthy"), healthySeq, "the healthy sibling's checkpoint stays converged");
  });
});
