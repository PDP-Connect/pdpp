import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from "../server/postgres-storage.js";
import {
  closeDb,
  getDb,
  initDb,
} from "../server/db.js";
import {
  getConnectorSummaryEvidence,
  rebuildConnectorSummaryEvidence,
} from "../server/connector-summary-read-model.ts";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import {
  decideConnectorSummariesCacheRead,
  getConnectorSummaryForRoute,
  invalidateConnectorSummariesCache,
  listConnectorSummaries,
} from "../server/ref-control.ts";
import { rebuildRetainedSize } from "../server/retained-size-read-model.js";

const OWNER = "owner_local";
const NOW = "2026-07-16T12:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/summary-evidence-oracle";
const INSTANCE_ID = "cin_summary_evidence_oracle";
const STREAM = "messages";
const EMPTY_STREAM = "empty_stream";
const UNEXPECTED_STREAM = "legacy_stream";
const MANIFEST = {
  protocol_version: "0.1.0",
  connector_id: CONNECTOR_ID,
  version: "1.0.0",
  display_name: "Summary Evidence Oracle",
  capabilities: {
    public_listing: { listed: true, status: "test" },
    refresh_policy: { maximum_staleness_seconds: 3153600000 },
  },
  streams: [
    { name: STREAM, primary_key: ["id"], coverage_strategy: "full_inventory" },
    { name: EMPTY_STREAM, primary_key: ["id"], coverage_strategy: "full_inventory" },
  ],
};

const MANIFEST_JSON = JSON.stringify(MANIFEST);
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function seedConnectorSqlite(manifest = MANIFEST) {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, typeof manifest === "string" ? manifest : JSON.stringify(manifest), NOW);
}

function seedInstanceSqlite({
  connectorInstanceId = INSTANCE_ID,
  status = "active",
  sourceKind = "account",
} = {}) {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, NULL)`,
    )
    .run(
      connectorInstanceId,
      OWNER,
      CONNECTOR_ID,
      "Summary evidence oracle",
      status,
      sourceKind,
      connectorInstanceId,
      NOW,
      NOW,
    );
}

function seedCanonicalRecordSqlite({
  connectorInstanceId = INSTANCE_ID,
  stream = STREAM,
  recordKey,
  version = 1,
  emittedAt = NOW,
} = {}) {
  getDb()
    .prepare(
      `INSERT INTO records(
         connector_id, connector_instance_id, stream, record_key, record_json,
         emitted_at, semantic_time, version, deleted
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      CONNECTOR_ID,
      connectorInstanceId,
      stream,
      recordKey,
      JSON.stringify({ id: recordKey, stream }),
      emittedAt,
      emittedAt,
      version,
    );
}

function seedRetainedConnectionSqlite({ dirty = 0, computedAt = NOW } = {}) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, dirty, computed_at
       ) VALUES (?, ?, 100, 10, 5, 0, ?, ?)`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, dirty, computedAt);
}

function seedRetainedStreamSqlite({
  stream,
  recordCount,
  dirty = 0,
  computedAt = NOW,
} = {}) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, record_count, dirty, computed_at
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(INSTANCE_ID, CONNECTOR_ID, stream, recordCount, dirty, computedAt);
}

function seedHealthyRetainedSnapshotSqlite({ streamCount = 1 } = {}) {
  seedRetainedConnectionSqlite({ dirty: 0 });
  seedRetainedStreamSqlite({ stream: STREAM, recordCount: streamCount, dirty: 0 });
}

async function withSqlite(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-evidence-oracle-"));
  invalidateConnectorSummariesCache();
  initDb(join(dir, "pdpp.sqlite"));
  try {
    return await fn();
  } finally {
    invalidateConnectorSummariesCache();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function listBypassCache() {
  return listConnectorSummaries(null, {
    concurrency: 1,
    includeRunSummaries: false,
  });
}

function summaryFor(summaries, instanceId = INSTANCE_ID) {
  const summary = summaries.find((row) => row.connector_instance_id === instanceId);
  assert.ok(summary, `summary for ${instanceId} must be visible`);
  return summary;
}

function streamEntry(summary, stream) {
  const entry = summary.stream_records.find((row) => row.stream === stream);
  assert.ok(entry, `stream ${stream} must be visible in the exhaustive stream set`);
  return entry;
}

test("observation barrier creates missing evidence for an active connection before synthesis", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();

    const summaries = await listBypassCache();
    summaryFor(summaries);
    const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);

    assert.ok(evidence, "a direct summary consumer must create missing active evidence");
    assert.equal(evidence.state, "fresh");
  }),
);

test("lost dirty marker cannot hide changed canonical ingest from the next observation", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "record_1" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildConnectorSummaryEvidence();

    seedCanonicalRecordSqlite({ recordKey: "record_2", emittedAt: "2026-07-16T12:01:00.000Z" });
    const summaries = await listBypassCache();
    const summary = summaryFor(summaries);

    assert.equal(summary.total_records, 2, "record snapshot must detect changed ingest without a dirty hook");
    assert.equal(streamEntry(summary, STREAM).record_count, 2);
  }),
);

test("declared empty stream exposes known_zero only after a current canonical snapshot", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildRetainedSize();

    const summary = summaryFor(await listBypassCache());
    const empty = streamEntry(summary, EMPTY_STREAM);
    assert.equal(empty.count_state, "known_zero");
    assert.equal(empty.record_count, 0);
  }),
);

test("canonical and retained-only streams become dormant diagnostic evidence", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ stream: UNEXPECTED_STREAM, recordKey: "canonical_orphan" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    seedRetainedStreamSqlite({ stream: UNEXPECTED_STREAM, recordCount: 2, dirty: 0 });
    await rebuildConnectorSummaryEvidence();

    const summary = summaryFor(await listBypassCache());
    const dormant = streamEntry(summary, UNEXPECTED_STREAM);
    assert.equal(dormant.declaration_state, "dormant");
    assert.equal(dormant.record_count, 1, "canonical current count remains diagnostic evidence");
    assert.equal(dormant.retained_record_count, 2, "retained-only evidence remains separately visible");
    assert.equal(summary.total_records, 0, "dormant canonical rows are excluded from active totals");
  }),
);

test("malformed manifest preserves connection and stream evidence as declaration unavailable", () =>
  withSqlite(async () => {
    seedConnectorSqlite("not-json");
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ stream: UNEXPECTED_STREAM, recordKey: "manifest_unavailable" });

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.manifest_declaration.state, "unavailable");
    assert.equal(streamEntry(summary, UNEXPECTED_STREAM).declaration_state, "unavailable");
  }),
);

test("retained-byte failure does not erase a current canonical count", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildRetainedSize();
    getDb()
      .prepare(
        `UPDATE retained_size_connection SET dirty = 1, computed_at = NULL
          WHERE connector_instance_id = ?`,
      )
      .run(INSTANCE_ID);

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.total_records, 1);
    assert.equal(streamEntry(summary, STREAM).count_state, "known");
    assert.equal(summary.retained_bytes, null);
  }),
);

// ---------------------------------------------------------------------------
// Retained-bytes missing→clean and clean-value-changed convergence
// (P1 finding: `classifyCandidate`'s original `retainedDirty && current`
// check could never detect a clean retained row appearing AFTER the
// evidence was already stamped `stale` — see `retainedBytesNeedsRepair` in
// connector-summary-evidence-engine.ts).
// ---------------------------------------------------------------------------

test("retained bytes missing→clean convergence: a later clean retained row is detected and repaired without any unrelated dirty hint", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });

    // First reconciliation pass: no retained_size_connection row exists yet
    // for this connection, so the repair correctly stamps `stale` (no data
    // observed) rather than a fabricated clean value.
    const firstPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(firstPass.repaired, 1, "first pass creates+repairs the missing row");
    const afterFirstPass = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(afterFirstPass.retained_bytes_evidence.state, "stale");
    assert.equal(afterFirstPass.retained_bytes, null);

    // A clean retained row now appears (e.g. the retained-size projection
    // observed this connection for the first time), WITHOUT touching
    // connector_summary_evidence's dirty flag at all — the exact scenario
    // the original `retainedDirty && storedRetainedState === "current"`
    // check could never detect, because `storedRetainedState` was already
    // `stale`, not `current`.
    seedRetainedConnectionSqlite({ dirty: 0 });

    const secondPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(
      secondPass.repaired,
      1,
      "the clean retained row appearing must classify as a repair candidate even though nothing marked it dirty",
    );

    const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(evidence.retained_bytes_evidence.state, "current");
    assert.equal(evidence.retained_bytes_evidence.reason_code, null);
    assert.ok(evidence.retained_bytes, "the real byte values must now be visible");
    assert.equal(evidence.retained_bytes.record_json_bytes, 100);
    assert.equal(evidence.retained_bytes.record_changes_json_bytes, 10);
    assert.equal(evidence.retained_bytes.blob_bytes, 5);
    assert.equal(evidence.retained_bytes.total_bytes, 115);
    assert.equal(evidence.total_retained_bytes, 115);

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.retained_bytes_evidence.state, "current");
    assert.ok(summary.retained_bytes, "the shaped summary must also expose the real bytes");
    assert.equal(summary.retained_bytes.total_bytes, 115);
  }),
);

test("retained bytes clean-value-changed convergence: new clean values are detected and repaired even when the dirty flag never fired", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });
    seedRetainedConnectionSqlite({ dirty: 0 });

    const firstPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(firstPass.repaired, 1);
    const before = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(before.retained_bytes_evidence.state, "current");
    assert.equal(before.retained_bytes.total_bytes, 115);

    // The source row's clean values change, but `dirty` is explicitly left
    // (re-set) at 0 to simulate a flag that never fired for this change —
    // the "clean-value-changed convergence" case that a dirty-flag-only
    // check can never catch.
    getDb()
      .prepare(
        `UPDATE retained_size_connection
            SET current_record_json_bytes = ?, record_history_json_bytes = ?, blob_bytes = ?, dirty = 0
          WHERE connector_instance_id = ?`,
      )
      .run(9000, 800, 700, INSTANCE_ID);

    const secondPass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(
      secondPass.repaired,
      1,
      "a changed clean value must classify as a candidate even though the dirty flag stayed 0",
    );

    const evidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(evidence.retained_bytes_evidence.state, "current");
    assert.equal(evidence.retained_bytes.record_json_bytes, 9000);
    assert.equal(evidence.retained_bytes.record_changes_json_bytes, 800);
    assert.equal(evidence.retained_bytes.blob_bytes, 700);
    assert.equal(evidence.retained_bytes.total_bytes, 10500);
  }),
);

test("retained bytes convergence is stable: two back-to-back passes after convergence both repair zero", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });

    // Pass 1: creates the row, no retained data yet -> stale.
    await reconcileConnectorSummaryEvidence(null);

    // Clean retained data appears; pass 2 detects and repairs it (the
    // missing→clean convergence proven above).
    seedRetainedConnectionSqlite({ dirty: 0 });
    const convergePass = await reconcileConnectorSummaryEvidence(null);
    assert.equal(convergePass.repaired, 1, "pass 2 converges the retained-bytes component to current");

    const afterConverge = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(afterConverge.retained_bytes_evidence.state, "current");

    // Two further passes with NOTHING changed must both report zero repair
    // work for this connection: convergence must be stable, not an
    // unbounded "state isn't current forever" churn loop.
    const stablePass1 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(stablePass1.repaired, 0, "no repair work once genuinely converged (pass 3)");
    const stablePass2 = await reconcileConnectorSummaryEvidence(null);
    assert.equal(stablePass2.repaired, 0, "no repair work once genuinely converged (pass 4)");

    const finalEvidence = await getConnectorSummaryEvidence(INSTANCE_ID);
    assert.equal(finalEvidence.retained_bytes_evidence.state, "current");
    assert.equal(finalEvidence.retained_bytes.total_bytes, 115);
  }),
);

test("retained bytes evidence component is exposed on the summary distinct from the byte-value field", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "current_record" });

    // Never-observed: no retained_size_connection row at all.
    const summaryBefore = summaryFor(await listBypassCache());
    assert.equal(summaryBefore.retained_bytes_evidence.state, "stale");
    assert.equal(summaryBefore.retained_bytes ?? null, null);

    seedRetainedConnectionSqlite({ dirty: 0 });
    await rebuildConnectorSummaryEvidence();
    const summaryAfter = summaryFor(await listBypassCache());
    assert.equal(summaryAfter.retained_bytes_evidence.state, "current");
    assert.ok(summaryAfter.retained_bytes, "byte-value payload present once current");

    // The typed component must never feed connection_health/ProjectionReliable
    // (design.md "Health boundary"): a clean, current retained-bytes
    // component alone must not itself force a healthy connection unknown,
    // and this connection has no other unreliable source.
    assert.notEqual(summaryAfter.connection_health.state, "unknown");
  }),
);

test("terminal facts distinguish never-observed from checkpointed-empty history", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    // The one observation barrier fully converges in ONE call: discovery
    // creates the missing evidence row, then the fold runs against that
    // now-existing row in the same pass, so even a never-before-seen
    // connection's terminal history is genuinely checkpointed (empty) by
    // the time this call returns — never requiring a second call to reach
    // `current`.
    const converged = summaryFor(await listBypassCache());
    assert.equal(converged.terminal_facts.state, "current");
    assert.equal(converged.terminal_facts.event_seq, 0);

    // `unobserved` is reserved for when the fold has GENUINELY never
    // completed — e.g. it failed outright — not merely deferred by call
    // ordering. Force a fold failure (spine_events unreadable) against a
    // FRESH connection so its evidence row is created by discovery but the
    // same barrier call's fold cannot complete for it.
    seedInstanceSqlite({ connectorInstanceId: "cin_never_observed" });
    getDb().exec("ALTER TABLE spine_events RENAME TO spine_events_hidden");
    try {
      const failed = summaryFor(await listBypassCache(), "cin_never_observed");
      assert.equal(failed.terminal_facts.state, "unobserved", "a genuinely failed fold leaves terminal facts unobserved, not fabricated current");
    } finally {
      getDb().exec("ALTER TABLE spine_events_hidden RENAME TO spine_events");
    }

    // Once the fold can read again, the NEXT single call fully converges
    // this connection too — proving `unobserved` was never a permanent or
    // call-order artifact.
    const recovered = summaryFor(await listBypassCache(), "cin_never_observed");
    assert.equal(recovered.terminal_facts.state, "current");
  }),
);

// One-call conformance (design.md "One internal observation barrier"): a
// never-before-seen connection with a genuine (non-empty) terminal history
// on the spine reaches record_snapshot=current, terminal_facts=current with
// the correct high-water event_seq, and manifest_declaration=current — ALL
// from exactly one consumer call. No caller may ever need a second call (or
// an explicit rebuild) to converge a healthy connection; regressing the
// barrier back to a discover-only-then-fold-next-time ordering would make
// this fail even though the earlier tests in this file could still pass.
test("a single observation fully converges every evidence component for a never-before-seen connection", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "one_call_record" });
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
         ) VALUES ('evt_one_call', 1, 'run.completed', ?, ?, 'test', 'trace_one_call', 'runtime', 'test-connector', 'run', 'run_one_call', 'succeeded', 'run_one_call', ?, '1')`,
      )
      .run(
        NOW,
        NOW,
        JSON.stringify({
          connector_instance_id: INSTANCE_ID,
          connection_id: INSTANCE_ID,
          collection_facts: {
            reference_only: true,
            schema_version: 1,
            streams: [{ stream: STREAM, collected: 1, checkpoint: "committed" }],
          },
        }),
      );

    const summary = summaryFor(await listBypassCache());
    assert.equal(summary.record_snapshot.state, "current", "one call converges record_snapshot");
    assert.equal(summary.terminal_facts.state, "current", "one call converges terminal_facts");
    assert.equal(summary.terminal_facts.event_seq, 1, "the fold reaches the real high-water seq in the same call");
    assert.equal(summary.manifest_declaration.state, "current", "one call converges manifest_declaration");
    assert.equal(summary.total_records, 1);
  }),
);

test("summary read failure never becomes an empty healthy result, and reads a reason code distinct from a merely-missing row", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildConnectorSummaryEvidence();
    getDb().exec("ALTER TABLE connector_summary_evidence RENAME TO connector_summary_evidence_unavailable");
    try {
      const summary = summaryFor(await listBypassCache());
      assert.notEqual(summary.connection_health.state, "healthy");
      const projection = summary.connection_health.conditions.find((condition) => condition.type === "ProjectionReliable");
      assert.equal(projection?.status, "false");
      // A total read failure (the whole table is unreachable) must be
      // distinguishable from the ordinary "no evidence row exists yet"
      // case (`summary_missing`) — design.md task 5.4. Both would
      // otherwise read as the exact same reason code.
      assert.equal(projection?.reason_code, "summary_evidence_read_failed");
    } finally {
      getDb().exec("ALTER TABLE connector_summary_evidence_unavailable RENAME TO connector_summary_evidence");
    }
  }),
);

test("cache decisions cannot return a prior value before observation reconciliation", () => {
  const entry = {
    freshUntil: 2_000,
    staleUntil: 10_000,
    generation: 1,
    value: [{ connector_instance_id: INSTANCE_ID, total_records: 1 }],
  };
  assert.notEqual(decideConnectorSummariesCacheRead(entry, 1_000), "return_fresh");
  assert.notEqual(decideConnectorSummariesCacheRead(entry, 5_000), "return_stale_refresh");
});

test("warm list and scoped consumers converge after canonical state changes", () =>
  withSqlite(async () => {
    seedConnectorSqlite();
    seedInstanceSqlite();
    seedCanonicalRecordSqlite({ recordKey: "before_cache" });
    seedHealthyRetainedSnapshotSqlite({ streamCount: 1 });
    await rebuildRetainedSize();
    const warm = summaryFor(await listConnectorSummaries());
    assert.equal(warm.total_records, 1);

    getDb()
      .prepare("UPDATE retained_size_stream SET record_count = 2 WHERE connector_instance_id = ? AND stream = ?")
      .run(INSTANCE_ID, STREAM);
    getDb()
      .prepare("UPDATE retained_size_connection SET record_count = 2, computed_at = ? WHERE connector_instance_id = ?")
      .run("2026-07-16T12:02:00.000Z", INSTANCE_ID);
    seedCanonicalRecordSqlite({ recordKey: "after_cache", emittedAt: "2026-07-16T12:02:00.000Z" });

    const listResult = summaryFor(await listConnectorSummaries());
    const scopedResult = await getConnectorSummaryForRoute(INSTANCE_ID);
    assert.equal(listResult.total_records, 2, "the exact default list path must not return stale cached evidence");
    assert.equal(scopedResult?.total_records, 2, "scoped detail must use the same converged evidence");
  }),
);

test(
  "real disposable PostgreSQL summary evidence has the same missing-evidence contract",
  { skip: !POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
      await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
      await postgresQuery(
        `INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)`,
        [CONNECTOR_ID, MANIFEST_JSON, NOW],
      );
      await postgresQuery(
        `INSERT INTO connector_instances(
           connector_instance_id, owner_subject_id, connector_id, display_name, status,
           source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
         ) VALUES($1, $2, $3, $4, 'active', 'account', $1, '{}'::jsonb, $5, $5, NULL)`,
        [INSTANCE_ID, OWNER, CONNECTOR_ID, "Summary evidence oracle", NOW],
      );

      const summaries = await rebuildConnectorSummaryEvidence();
      const evidence = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
      assert.ok(evidence, "real PostgreSQL rebuild must materialize the active connection");
      assert.equal(evidence.record_snapshot?.state, "current");
      assert.deepEqual(
        [...evidence.stream_records]
          .map((entry) => ({
            count_state: entry.count_state,
            declaration_state: entry.declaration_state,
            record_count: entry.record_count,
            stream: entry.stream,
          }))
          .sort((a, b) => a.stream.localeCompare(b.stream)),
        [
          {
            count_state: "known_zero",
            declaration_state: "declared",
            record_count: 0,
            stream: EMPTY_STREAM,
          },
          {
            count_state: "known_zero",
            declaration_state: "declared",
            record_count: 0,
            stream: STREAM,
          },
        ],
      );
    } finally {
      await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
      await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
      await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
      await closePostgresStorage();
    }
  },
);
