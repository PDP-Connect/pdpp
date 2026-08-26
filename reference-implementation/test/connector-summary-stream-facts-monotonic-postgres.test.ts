// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real-PostgreSQL counterpart to `connector-summary-stream-facts.test.js`'s
 * monotonic-guard and existing-row self-heal tests (Gmail
 * cin_12407c1afb78d56848fe0b20 runtime_evidence_missing defect,
 * tmp/gmail-recovery-acceptance-diagnosis-0717.md). Proves the SAME
 * behaviors the SQLite-host tests prove, but against the real Postgres
 * fold path (`createStreamFactsFoldStore()`'s Postgres branch in
 * connector-summary-read-model.ts) — the dialect-split SQL (JSONB
 * COALESCE, `IS NOT DISTINCT FROM` CAS predicates) is not exercised by the
 * SQLite-host tests at all.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  foldConnectorSummaryStreamFacts,
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
  reconcileDirtyConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const NOW = "2026-07-17T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/summary-facts-monotonic-pg";
const INSTANCE_ID = "cin_summary_facts_monotonic_pg";

const MANIFEST = {
  capabilities: { public_listing: { tier: "supported" } },
  connector_id: CONNECTOR_ID,
  display_name: "Summary Facts Monotonic Probe (Postgres)",
  protocol_version: "0.1.0",
  streams: [
    {
      coverage_strategy: "full_inventory",
      name: "messages",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
    {
      coverage_strategy: "full_inventory",
      name: "threads",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
    },
  ],
  version: "1.0.0",
};

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

let seededEventSeq = 1_000_000;

// Shape of one stream's stored latest-attempt entry, as read back through
// `getConnectorSummaryEvidence(...).stream_latest_facts` — mirrors
// `StoredStreamFactEntry` in `server/connector-summary-read-model.ts` (a
// module-private type, so it is redeclared here rather than imported). The
// raw runtime fact itself only ever needs `checkpoint`/`collected`/`stream`
// in this file's assertions.
interface StoredStreamFactEntry {
  event_seq: number;
  evidence_as_of: string | null;
  fact: { checkpoint: string; collected: number; considered?: number; covered?: number; stream: string };
  run_id: string | null;
}

type StreamFactsByStream = Record<string, StoredStreamFactEntry>;

async function seedConnector() {
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify(MANIFEST),
    NOW,
  ]);
}

async function seedInstance(instanceId = INSTANCE_ID) {
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES ($1, 'owner_local', $2, 'Summary Facts Monotonic Probe (Postgres)', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [instanceId, CONNECTOR_ID, NOW]
  );
}

async function seedTerminalEvent({
  runId,
  occurredAt,
  connectorInstanceId,
  streams,
  eventType = "run.completed",
}: {
  runId: string;
  occurredAt: string;
  connectorInstanceId: string;
  streams: Array<{ stream: string; collected: number; checkpoint: string; considered?: number; covered?: number }>;
  eventType?: string;
}) {
  seededEventSeq += 1;
  const data = {
    collection_facts: { reference_only: true, schema_version: 1, streams },
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
  };
  await postgresQuery(
    `INSERT INTO spine_events(
       event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
     ) VALUES($1, $2, $3, $4, $4, 'test', $5, 'runtime', 'test-connector', 'run', $6, 'succeeded', $6, $7, $8::jsonb, '1')`,
    [
      `evt_${seededEventSeq}`,
      seededEventSeq,
      eventType,
      occurredAt,
      `trace_${seededEventSeq}`,
      runId,
      connectorInstanceId,
      JSON.stringify(data),
    ]
  );
  return seededEventSeq;
}

async function cleanup(instanceId = INSTANCE_ID) {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("DELETE FROM spine_events WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

async function factsFor(instanceId = INSTANCE_ID): Promise<StreamFactsByStream | null> {
  const evidence = await getConnectorSummaryEvidence(instanceId);
  // `stream_latest_facts` is `unknown` at the type level (it comes back
  // through `parseEvidenceJson`, which is deliberately untyped storage
  // JSON); this file's own `StoredStreamFactEntry`/`StreamFactsByStream`
  // shapes mirror the module-private type the fold path actually writes.
  return (evidence?.stream_latest_facts as StreamFactsByStream | null | undefined) ?? null;
}

test("real PostgreSQL: a later cancelled/not_committed attempt does not regress an already-durably-proven stream", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-07-16T03:13:11.000Z",
      runId: "run_success_pg",
      streams: [{ checkpoint: "committed", collected: 20, stream: "messages" }],
    });
    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.cancelled",
      occurredAt: "2026-07-18T00:00:00.000Z",
      runId: "run_cancelled_pg",
      streams: [{ checkpoint: "not_committed", collected: 20, stream: "messages" }],
    });

    await reconcileDirtyConnectorSummaryEvidence();
    const facts = await factsFor();
    assert.ok(facts, "evidence row must exist after reconcile");
    assert.ok(facts.messages, "messages stream fact must exist");
    assert.equal(
      facts.messages.fact.checkpoint,
      "committed",
      "the cancelled run must not regress the committed proof on real PostgreSQL"
    );
    assert.equal(facts.messages.run_id, "run_success_pg", "provenance stays with the run that actually proved it");
    assert.equal(facts.messages.evidence_as_of, "2026-07-16T03:13:11.000Z");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: a later committed success still advances past a prior committed proof (forward progress unaffected)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-07-10T00:00:00.000Z",
      runId: "run_1_pg",
      streams: [{ checkpoint: "committed", collected: 3, stream: "messages" }],
    });
    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-07-12T00:00:00.000Z",
      runId: "run_2_pg",
      streams: [{ checkpoint: "committed", collected: 5, stream: "messages" }],
    });

    await reconcileDirtyConnectorSummaryEvidence();
    const facts = await factsFor();
    assert.ok(facts, "evidence row must exist after reconcile");
    assert.ok(facts.messages, "messages stream fact must exist");
    assert.equal(
      facts.messages.fact.collected,
      5,
      "a newer genuine proof still replaces an older one on real PostgreSQL"
    );
    assert.equal(facts.messages.run_id, "run_2_pg");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: recovery-only interaction — genuine success -> recovery-only successes -> interleaved cancelled attempt -> stored fact still reads the original committed proof", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-07-16T03:13:11.000Z",
      runId: "run_genuine_pg",
      streams: [
        { checkpoint: "committed", collected: 20, stream: "messages" },
        { checkpoint: "committed", collected: 15, stream: "threads" },
      ],
    });
    await Promise.all(
      Array.from({ length: 3 }, async (_, i) => {
        seededEventSeq += 1;
        await postgresQuery(
          `INSERT INTO spine_events(
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
           ) VALUES($1, $2, 'run.completed', $3, $3, 'test', $4, 'runtime', 'test-connector', 'run', $5, 'succeeded', $5, $6, $7::jsonb, '1')`,
          [
            `evt_${seededEventSeq}`,
            seededEventSeq,
            `2026-07-16T0${4 + i}:00:00.000Z`,
            `trace_${seededEventSeq}`,
            `run_recovery_${i}_pg`,
            INSTANCE_ID,
            JSON.stringify({
              connection_id: INSTANCE_ID,
              connector_instance_id: INSTANCE_ID,
              recovery_only: true,
            }),
          ]
        );
      })
    );
    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.cancelled",
      occurredAt: "2026-07-18T00:00:00.000Z",
      runId: "run_cancelled_retry_pg",
      streams: [
        { checkpoint: "not_staged", collected: 20, stream: "messages" },
        { checkpoint: "not_committed", collected: 15, stream: "threads" },
      ],
    });

    await reconcileDirtyConnectorSummaryEvidence();
    const facts = await factsFor();
    assert.ok(facts, "evidence row must exist after reconcile");
    assert.ok(facts.messages, "messages stream fact must exist");
    assert.equal(facts.messages.fact.checkpoint, "committed", "stored fact still reads the original committed proof");
    assert.equal(facts.messages.run_id, "run_genuine_pg");
    assert.ok(facts.threads, "threads stream fact must exist");
    assert.equal(facts.threads.fact.checkpoint, "committed");
    assert.equal(facts.threads.run_id, "run_genuine_pg");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

// Existing-row self-heal on real PostgreSQL — the critical acceptance gap a
// bare merge-logic fix leaves (tmp/gmail-recovery-acceptance-diagnosis-0717.md):
// the fold's `stream_facts_event_seq` is a durable high-water mark, so a row
// already corrupted by the pre-fix bug (checkpoint parked PAST the
// corrupting event) would never be re-read by an ordinary incremental fold.
// This seeds the row directly in that exact pre-fix shape on real Postgres
// (bypassing the fold, writing the columns the way the live corrupted
// cin_12407c1afb78d56848fe0b20 row was found in) and proves an ORDINARY
// reconcile call heals it via the `stream_facts_fold_version` invalidation
// lever — no Gmail-specific code path.
test("real PostgreSQL: existing-row self-heal — a row pre-seeded in the exact pre-fix corrupted shape heals via an ordinary reconcile call", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    const successSeq = await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-07-16T03:13:11.000Z",
      runId: "run_1784171338479_pg",
      streams: [
        { checkpoint: "committed", collected: 20, stream: "messages" },
        { checkpoint: "committed", collected: 15, stream: "threads" },
      ],
    });
    const cancelledSeq = await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.cancelled",
      occurredAt: "2026-07-18T00:00:00.000Z",
      runId: "run_1784180154766_pg",
      streams: [
        { checkpoint: "not_staged", collected: 20, stream: "messages" },
        { checkpoint: "not_committed", collected: 15, stream: "threads" },
      ],
    });
    assert.ok(cancelledSeq > successSeq);

    const corruptedFacts = {
      messages: {
        event_seq: cancelledSeq,
        evidence_as_of: "2026-07-18T00:00:00.000Z",
        fact: { checkpoint: "not_staged", collected: 20, stream: "messages" },
        run_id: "run_1784180154766_pg",
      },
      threads: {
        event_seq: cancelledSeq,
        evidence_as_of: "2026-07-18T00:00:00.000Z",
        fact: { checkpoint: "not_committed", collected: 15, stream: "threads" },
        run_id: "run_1784180154766_pg",
      },
    };
    await postgresQuery(
      `UPDATE connector_summary_evidence
            SET stream_latest_facts_json = $2::jsonb,
                stream_facts_event_seq = $3,
                stream_facts_fold_version = NULL,
                terminal_facts_state = 'current',
                terminal_facts_reason_code = NULL,
                dirty = 0,
                state = 'fresh'
          WHERE connector_instance_id = $1`,
      [INSTANCE_ID, JSON.stringify(corruptedFacts), cancelledSeq]
    );

    const preFixRows = (
      await postgresQuery<{
        dirty: number | string;
        state: string;
        stream_facts_event_seq: number | string | null;
        stream_facts_fold_version: number | string | null;
      }>(
        "SELECT stream_facts_event_seq, stream_facts_fold_version, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      )
    ).rows;
    const [preFixRow] = preFixRows;
    assert.ok(preFixRow, "precondition: evidence row exists");
    assert.equal(
      Number(preFixRow.stream_facts_event_seq),
      cancelledSeq,
      "premise: checkpoint already sits at/past the corrupting event"
    );
    assert.equal(preFixRow.stream_facts_fold_version, null, "premise: row predates fold-version stamping");
    assert.equal(Number(preFixRow.dirty), 0, "premise: row reads clean, exactly like the live corrupted row");
    assert.equal(preFixRow.state, "fresh");
    const preFixFacts = await factsFor();
    assert.ok(preFixFacts, "evidence row must exist before healing");
    assert.ok(preFixFacts.messages, "messages stream fact must exist");
    assert.equal(
      preFixFacts.messages.fact.checkpoint,
      "not_staged",
      "premise: the stored fact is genuinely corrupted before healing"
    );

    // The healing action is an ORDINARY reconcile call.
    await reconcileDirtyConnectorSummaryEvidence();

    const healedRows = (
      await postgresQuery<{ stream_facts_fold_version: number | string | null }>(
        "SELECT stream_facts_fold_version FROM connector_summary_evidence WHERE connector_instance_id = $1",
        [INSTANCE_ID]
      )
    ).rows;
    const [healedRow] = healedRows;
    assert.ok(healedRow, "healed evidence row exists");
    // A lower bound, not a literal: this asserts the row was re-stamped by a
    // CURRENT fold (the healing this test exists to prove) without pinning
    // the test to one specific version number, which every later
    // fold-semantics bump would otherwise falsify. The SQLite sibling's
    // self-heal test uses the same `>=` form for the same reason.
    assert.ok(
      Number(healedRow.stream_facts_fold_version) >= 5,
      "the row is stamped current under the new fold-logic version after healing"
    );
    const healedFacts = await factsFor();
    assert.ok(healedFacts, "evidence row must exist after healing");
    assert.ok(healedFacts.messages, "messages stream fact must exist");
    assert.equal(
      healedFacts.messages.fact.checkpoint,
      "committed",
      "an ordinary reconcile call self-heals the pre-existing corrupted row on real PostgreSQL"
    );
    assert.equal(
      healedFacts.messages.run_id,
      "run_1784171338479_pg",
      "provenance restored to the run that actually proved it"
    );
    assert.ok(healedFacts.threads, "threads stream fact must exist");
    assert.equal(healedFacts.threads.fact.checkpoint, "committed");
    assert.equal(healedFacts.threads.run_id, "run_1784171338479_pg");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: recompute/self-heal — a full rebuild from existing event history reproduces the same monotonic result as the incremental fold", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-07-16T03:13:11.000Z",
      runId: "run_success_recompute_pg",
      streams: [{ checkpoint: "committed", collected: 20, stream: "messages" }],
    });
    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.cancelled",
      occurredAt: "2026-07-18T00:00:00.000Z",
      runId: "run_cancelled_recompute_pg",
      streams: [{ checkpoint: "not_committed", collected: 20, stream: "messages" }],
    });

    await reconcileDirtyConnectorSummaryEvidence();
    const incremental = await factsFor();
    assert.ok(incremental, "evidence row must exist after reconcile");
    assert.ok(incremental.messages, "messages stream fact must exist");
    assert.equal(incremental.messages.fact.checkpoint, "committed");

    const foldResult = await foldConnectorSummaryStreamFacts([INSTANCE_ID]);
    assert.equal(foldResult.folded, 0, "the row is already current; a follow-up fold pass is a genuine no-op");

    const recomputed = await factsFor();
    assert.ok(recomputed, "evidence row must exist after the follow-up fold pass");
    assert.ok(recomputed.messages, "messages stream fact must exist");
    assert.equal(
      recomputed.messages.fact.checkpoint,
      "committed",
      "a follow-up fold pass reproduces the same monotonic result, not the corrupted one"
    );
    assert.equal(recomputed.messages.run_id, "run_success_recompute_pg");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

// Measured-boundary guard on the real Postgres fold path. The SQLite-host
// tests cannot reach the dialect-split SQL (JSONB COALESCE, the
// `IS NOT DISTINCT FROM` CAS predicates) that the Postgres branch of
// `createStreamFactsFoldStore()` uses to persist and re-read these facts, so
// the same semantics are proven again here against a real server.
test("real PostgreSQL: an incremental committed run carrying no coverage keys must not erase a measured proof", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-08-21T20:21:10.660Z",
      runId: "run_full_refresh_pg",
      streams: [{ checkpoint: "committed", collected: 0, considered: 1, covered: 1, stream: "messages" }],
    });
    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-08-21T22:08:21.673Z",
      runId: "run_incremental_pg",
      streams: [{ checkpoint: "committed", collected: 0, stream: "messages" }],
    });

    await reconcileDirtyConnectorSummaryEvidence();
    const facts = await factsFor();
    assert.ok(facts, "evidence row must exist after reconcile");
    assert.ok(facts.messages, "messages stream fact must exist");
    assert.equal(facts.messages.fact.considered, 1, "the measured denominator must survive on real PostgreSQL");
    assert.equal(facts.messages.fact.covered, 1, "the measured numerator must survive on real PostgreSQL");
    assert.equal(facts.messages.run_id, "run_full_refresh_pg", "provenance stays with the run that measured");
    assert.equal(facts.messages.evidence_as_of, "2026-08-21T20:21:10.660Z");
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});

test("real PostgreSQL: a genuine measured zero still replaces a larger prior proof (a truthful zero stays expressible)", {
  skip: !POSTGRES_URL,
}, async () => {
  await initPostgresStorage(postgresStorageConfig());
  try {
    await cleanup();
    await seedConnector();
    await seedInstance();
    await rebuildConnectorSummaryEvidence();

    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-08-20T00:00:00.000Z",
      runId: "run_had_five_pg",
      streams: [{ checkpoint: "committed", collected: 5, considered: 5, covered: 5, stream: "messages" }],
    });
    await seedTerminalEvent({
      connectorInstanceId: INSTANCE_ID,
      eventType: "run.completed",
      occurredAt: "2026-08-21T00:00:00.000Z",
      runId: "run_now_empty_pg",
      streams: [{ checkpoint: "committed", collected: 0, considered: 0, covered: 0, stream: "messages" }],
    });

    await reconcileDirtyConnectorSummaryEvidence();
    const facts = await factsFor();
    assert.ok(facts, "evidence row must exist after reconcile");
    assert.ok(facts.messages, "messages stream fact must exist");
    assert.equal(facts.messages.fact.considered, 0, "a measured zero must replace the stale larger proof");
    assert.equal(facts.messages.fact.covered, 0, "a measured zero numerator must replace the stale larger one");
    assert.equal(
      facts.messages.run_id,
      "run_now_empty_pg",
      "the newest MEASURING run owns the fact on real PostgreSQL too"
    );
  } finally {
    await cleanup();
    await closePostgresStorage();
  }
});
