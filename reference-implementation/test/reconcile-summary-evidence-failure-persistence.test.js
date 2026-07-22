// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reconciles two independently-verified fail-open defects
 * (openspec/changes/reconcile-active-summary-evidence design.md "Health
 * boundary" / "components are independent"):
 *
 *   Probe 1 (repair-candidate failure): `repairCandidate`'s in-memory
 *   `buildFailedRow` shape was never persisted to
 *   `connector_summary_evidence` on an upsert failure — the durable row was
 *   left exactly as it read before the failed repair attempt (e.g. a stale
 *   `record_snapshot.state: "current"` with a stale `total_records`), so a
 *   subsequent `listConnectorSummaries()` served the stale value as
 *   trustworthy (`ProjectionReliable.status: "true"`) even though
 *   `reconcileConnectorSummaryEvidence` itself correctly counted the
 *   failure.
 *
 *   Probe 2 (terminal-fold failure): a fold failure durably marked the
 *   generic `dirty`/`state` columns but never degraded the specific
 *   `terminal_facts_state` component. `evidenceUnreliableSources` only
 *   inspects the four typed components, never the generic honesty
 *   envelope, so a row left at `terminal_facts.state: "current"` from a
 *   prior successful fold kept reading as fully current/healthy after a
 *   fold failure.
 *
 * Both probes prove the fix via the real production entry points
 * (`reconcileConnectorSummaryEvidence`, `listConnectorSummaries`), with
 * real SQLite fault injection — a trigger for probe 1 (rejects only the
 * summary-evidence write), a table rename for probe 2 (the same pattern
 * `connector-summary-evidence-engine-concurrency.test.js`'s "a failed
 * terminal fold does not launder..." test uses for `spine_events`).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeDb, getDb, initDb } from "../server/db.js";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { reconcileDirtyConnectorSummaryEvidence } from "../server/connector-summary-read-model.ts";
import { invalidateConnectorSummariesCache, listConnectorSummaries } from "../server/ref-control.ts";
import { ingestRecord } from "../server/records.js";

const OWNER = "owner_local";
const NOW = "2026-07-17T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/failure-persistence";
const INSTANCE_ID = "cin_failure_persistence";
const STREAM = "messages";

const MANIFEST = {
  protocol_version: "0.1.0",
  connector_id: CONNECTOR_ID,
  version: "1.0.0",
  display_name: "Failure Persistence Probe",
  capabilities: {
    public_listing: { listed: true, status: "test" },
  },
  streams: [
    {
      name: STREAM,
      primary_key: ["id"],
      coverage_strategy: "full_inventory",
      schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ],
};

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-summary-failure-persistence-"));
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

function seedConnector() {
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(CONNECTOR_ID, JSON.stringify(MANIFEST), NOW);
}

function seedInstance() {
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
       ) VALUES (?, ?, ?, ?, 'active', 'account', ?, '{}', ?, ?, NULL)`,
    )
    .run(INSTANCE_ID, OWNER, CONNECTOR_ID, "Failure Persistence Probe", INSTANCE_ID, NOW, NOW);
}

function storageTarget() {
  return { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE_ID };
}

async function listBypassCache() {
  return listConnectorSummaries(null, { concurrency: 1, includeRunSummaries: false });
}

function summaryFor(summaries) {
  const summary = summaries.find((row) => row.connector_instance_id === INSTANCE_ID);
  assert.ok(summary, "summary for the probe connection must be visible");
  return summary;
}

function projectionReliable(summary) {
  return summary.connection_health.conditions.find((condition) => condition.type === "ProjectionReliable");
}

test("probe 1: a repair-candidate upsert failure durably fails the row instead of leaving it stale-but-current", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    // First pass: create a genuinely current, correct zero-record evidence row.
    const first = await reconcileConnectorSummaryEvidence(null);
    assert.equal(first.failed, 0, "the first pass has nothing to fail");
    const before = getDb()
      .prepare("SELECT total_records, record_snapshot_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get(INSTANCE_ID);
    assert.equal(before.total_records, 0);
    assert.equal(before.record_snapshot_state, "current");
    assert.equal(before.dirty, 0);
    assert.equal(before.state, "fresh");

    // Add one canonical record via the real ingest path so a repair
    // candidate now exists (checkpoint mismatch).
    await ingestRecord(storageTarget(), {
      stream: STREAM,
      key: "msg_1",
      data: { id: "msg_1" },
      emitted_at: NOW,
    });

    // Fault injection: reject ONLY the summary-evidence write. A BEFORE
    // INSERT trigger fires both on a plain INSERT and on the INSERT..ON
    // CONFLICT upsert's conflict path used by the fenced repair's success
    // path (`upsertSqliteEvidenceRow`) — but NOT on a plain UPDATE, which is
    // the primary path `persistFailedEvidenceSqlite` takes when a row
    // already exists. This isolates "the repair's upsert fails" from "the
    // failure-persistence write also fails", proving the fix's durable
    // write actually lands.
    getDb().exec(
      `CREATE TRIGGER fault_summary_evidence_insert
         BEFORE INSERT ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected summary-evidence upsert fault');
       END`,
    );
    let result;
    let summary;
    try {
      result = await reconcileConnectorSummaryEvidence(null);

      assert.equal(result.repaired, 1, "the repair pass still counts the attempt");
      assert.equal(result.failed, 1, "the repair pass correctly detects and counts the failure");

      const after = getDb()
        .prepare(
          "SELECT total_records, record_snapshot_state, record_snapshot_reason_code, dirty, state, last_error FROM connector_summary_evidence WHERE connector_instance_id = ?",
        )
        .get(INSTANCE_ID);
      assert.notEqual(
        after.record_snapshot_state,
        "current",
        "the durable row must NOT still claim record_snapshot is current after the write failed",
      );
      assert.equal(after.dirty, 1, "the durable row is marked dirty so a later pass retries");
      assert.notEqual(after.state, "fresh", "the durable row's honesty envelope reflects the failure");
      assert.ok(after.last_error, "the durable row records the sanitized error");

      // The real production read path must not serve the stale pre-failure
      // value as trustworthy. Read it WHILE the fault is still active — a
      // subsequent read after the fault lifts would trigger its own
      // internal barrier pass, which would legitimately self-heal the row
      // (the correct next-pass-retries contract) and prove the wrong
      // thing: that reconcile retries, not that THIS failed attempt was
      // durably visible to a same-pass reader.
      summary = summaryFor(await listBypassCache());
    } finally {
      getDb().exec("DROP TRIGGER fault_summary_evidence_insert");
    }

    const projection = projectionReliable(summary);
    // This is the actual defect this probe proves fixed: BEFORE the fix,
    // `total_records` still read the stale pre-failure `0` (a genuinely
    // wrong answer — one real record had landed) AND `ProjectionReliable`
    // read `true`, so the wrong number was served as trustworthy with no
    // signal to the contrary. The fix does not (and should not) fabricate
    // a corrected `total_records` — the repair genuinely failed, so the
    // true count is unknown, not "1". What the fix guarantees is that
    // `ProjectionReliable` is `false`, so no consumer can mistake the
    // still-stale `total_records` for a verified answer.
    assert.equal(projection?.status, "false", "ProjectionReliable must be false, never true, for this connection");
    assert.equal(summary.total_records, 0, "total_records still carries the last known (now-unverified) value");
  }));

test("probe 1b: a first-ever observation that immediately fails is never left silently 'current'", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    getDb().exec(
      `CREATE TRIGGER fault_summary_evidence_insert
         BEFORE INSERT ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected summary-evidence upsert fault');
       END`,
    );
    let result;
    try {
      result = await reconcileConnectorSummaryEvidence(null);

      // Read the row state WHILE the fault is still active — this is the
      // fair test of what the failure-persistence path itself durably
      // achieves. (A later, unfaulted `listConnectorSummaries` call would
      // run its own internal reconcile pass and self-heal the row, which
      // would prove the wrong thing here: that reconcile eventually
      // retries, not that this specific failed attempt was recorded.)
      assert.equal(result.failed, 1);
      const row = getDb()
        .prepare("SELECT record_snapshot_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
        .get(INSTANCE_ID);
      // Best-effort: the failure-persistence path's own fallback INSERT is
      // ALSO blocked by the same trigger for a genuinely brand-new row (no
      // existing row for its UPDATE branch to match), so this specific
      // interaction cannot durably record the failure either — a
      // documented residual gap (see the report). Assert the row is never
      // silently "current" — either absent, or explicitly failed.
      if (row) {
        assert.notEqual(row.record_snapshot_state, "current");
      }
    } finally {
      getDb().exec("DROP TRIGGER fault_summary_evidence_insert");
    }

    // With the fault lifted, the next real observation barrier call (as
    // `listConnectorSummaries` performs) must still never read this
    // connection as reliable while genuinely no evidence row exists for it
    // (or must self-heal it to a real, non-fabricated row) — either way,
    // the visible-missing case itself is required to fail closed
    // (`summary_missing` in `evidenceUnreliableSources`).
    const summary = summaryFor(await listBypassCache());
    if (!getDb().prepare("SELECT 1 FROM connector_summary_evidence WHERE connector_instance_id = ?").get(INSTANCE_ID)) {
      const projection = projectionReliable(summary);
      assert.equal(projection?.status, "false", "a genuinely missing evidence row must never read as reliable");
    }
  }));

test("probe 1c: simultaneous repair failure AND failure-marker-write failure (both INSERT and UPDATE rejected) still fails closed through the real production read", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    // First pass: create a genuinely current, correct zero-record evidence
    // row (an existing row, so persistFailedEvidence's primary path is the
    // UPDATE branch, not the first-ever-observation INSERT fallback probe
    // 1b already covers).
    const first = await reconcileConnectorSummaryEvidence(null);
    assert.equal(first.failed, 0);
    const before = getDb()
      .prepare("SELECT total_records, record_snapshot_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get(INSTANCE_ID);
    assert.equal(before.total_records, 0);
    assert.equal(before.record_snapshot_state, "current");

    // A real record lands via the production ingest path so a repair
    // candidate now exists (checkpoint mismatch) — the true count is now 1,
    // but the durable row still (wrongly, absent a fix) reads 0.
    await ingestRecord(storageTarget(), {
      stream: STREAM,
      key: "msg_1",
      data: { id: "msg_1" },
      emitted_at: NOW,
    });

    // Fault injection: reject BOTH the repair upsert's INSERT..ON CONFLICT
    // AND persistFailedEvidence's own UPDATE — the exact double-failure
    // Sol's verdict reproduced (a fault surface broad enough to break the
    // repair AND the failure-marker write in the same pass). Before the
    // fix, `reconcileConnectorSummaryEvidence` discarded the in-memory
    // failed row entirely on this path, so a same-pass reader re-read the
    // untouched `current`/`fresh` row and served a stale zero as reliable.
    getDb().exec(
      `CREATE TRIGGER fault_summary_evidence_insert
         BEFORE INSERT ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected summary-evidence insert fault');
       END`,
    );
    getDb().exec(
      `CREATE TRIGGER fault_summary_evidence_update
         BEFORE UPDATE ON connector_summary_evidence
       BEGIN
         SELECT RAISE(ABORT, 'injected summary-evidence update fault');
       END`,
    );
    let summary;
    try {
      const result = await reconcileConnectorSummaryEvidence(null);
      assert.equal(result.failed, 1, "the repair pass detects the failure even though neither durable write landed");
      assert.equal(
        result.failedRows.size,
        1,
        "the in-memory failedRows map carries exactly the one candidate whose durable failure-marker write also failed",
      );
      assert.ok(result.failedRows.has(INSTANCE_ID));

      // The durable row is untouched by the rejected repair/failure-marker
      // writes specifically — this is the exact condition that used to
      // fail open. `dirty`/`state` reflect `ingestRecord`'s own happy-path
      // `markConnectorSummaryEvidenceDirty` call (a genuinely separate,
      // successful write) that ran before either fault-injected trigger
      // existed — the two rejected writes never got a chance to clear them
      // back to a fresh state, so this is itself consistent evidence
      // nothing repaired this row.
      const untouchedRow = getDb()
        .prepare("SELECT total_records, record_snapshot_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
        .get(INSTANCE_ID);
      assert.equal(untouchedRow.total_records, 0, "the durable row is genuinely untouched by the double-rejected writes");
      assert.equal(untouchedRow.record_snapshot_state, "current", "the durable row's own state is unchanged (both writes were rejected)");
      assert.equal(untouchedRow.dirty, 1, "dirty stays set from ingestRecord's own prior successful marker write, never cleared by either rejected write");
      assert.equal(untouchedRow.state, "stale", "state stays set from ingestRecord's own prior successful marker write, never cleared by either rejected write");

      // The real production entry point, read in the SAME pass while the
      // fault is still active, must NOT serve the stale untouched row as
      // reliable — this is the fix under test: reconcileDirtyConnectorSummaryEvidence's
      // caller (loadConnectorSummaryProjectionDeps) merges the in-memory
      // failedRows over its subsequent durable read for this exact
      // instance id.
      summary = summaryFor(await listBypassCache());
    } finally {
      getDb().exec("DROP TRIGGER fault_summary_evidence_insert");
      getDb().exec("DROP TRIGGER fault_summary_evidence_update");
    }

    const projection = projectionReliable(summary);
    assert.equal(
      projection?.status,
      "false",
      "ProjectionReliable must be false — a stale count must never read reliable when BOTH the repair and its failure-marker write failed",
    );
  }));

test("probe 2: a fold failure after a previously-clean checkpointed-empty terminal history fails closed", () =>
  withTempDb(async () => {
    seedConnector();
    seedInstance();

    // Reach a genuinely clean, checkpointed-empty terminal history: no
    // terminal spine events exist yet, so the first observation stamps a
    // zero checkpoint and terminal_facts reads current (see
    // `foldConnectorSummaryStreamFacts`'s "no terminal events exist yet"
    // branch).
    await reconcileConnectorSummaryEvidence(null);
    await reconcileDirtyConnectorSummaryEvidence();
    const before = getDb()
      .prepare("SELECT terminal_facts_state, record_snapshot_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?")
      .get(INSTANCE_ID);
    assert.equal(before.terminal_facts_state, "current", "terminal_facts starts genuinely current");
    assert.equal(before.record_snapshot_state, "current");

    const beforeSummary = summaryFor(await listBypassCache());
    assert.equal(projectionReliable(beforeSummary)?.status, "true", "the connection starts genuinely healthy");

    // Land a real terminal event so the NEXT fold pass has genuine work
    // (a checkpoint advance) to attempt and fail on.
    getDb()
      .prepare(
        `INSERT INTO spine_events(
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
         ) VALUES ('evt_probe2', 1, 'run.completed', ?, ?, 'test', 'trace_probe2', 'runtime', 'test-connector', 'run', 'run_probe2', 'succeeded', 'run_probe2', ?, '1')`,
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
            streams: [{ stream: STREAM, collected: 0, checkpoint: "committed" }],
          },
        }),
      );

    // Fault injection: reject ONLY the fold's own write
    // (`updateStreamFacts`'s `stream_facts_event_seq` advance) — a trigger
    // scoped to that exact column, so discovery and the record-snapshot
    // repair machinery are entirely untouched and this isolates a pure
    // fold-only failure (design.md "Fold failure changes only the
    // terminal_facts component ... cannot be erased by a successful
    // record-snapshot repair" — and, symmetrically, must not itself erase a
    // genuinely current record_snapshot).
    getDb().exec(
      `CREATE TRIGGER fault_fold_write
         BEFORE UPDATE OF stream_facts_event_seq ON connector_summary_evidence
         WHEN NEW.stream_facts_event_seq IS NOT OLD.stream_facts_event_seq
       BEGIN
         SELECT RAISE(ABORT, 'injected fold write fault');
       END`,
    );
    let afterSummary;
    try {
      await reconcileDirtyConnectorSummaryEvidence();

      const after = getDb()
        .prepare(
          "SELECT total_records, record_snapshot_state, terminal_facts_state, terminal_facts_reason_code, dirty, state, last_error FROM connector_summary_evidence WHERE connector_instance_id = ?",
        )
        .get(INSTANCE_ID);
      assert.notEqual(after.terminal_facts_state, "current", "terminal_facts must NOT still read current after the fold failed");
      assert.ok(after.terminal_facts_reason_code, "the failure carries a reason code");
      assert.equal(after.dirty, 1);
      assert.notEqual(after.state, "fresh");
      assert.ok(after.last_error);
      assert.equal(
        after.record_snapshot_state,
        "current",
        "record_snapshot stays current — a pure fold failure is NOT laundered onto an unrelated, genuinely current component",
      );

      // Read the real production path WHILE the fault is still active, for
      // the same same-pass-visibility reason as probe 1.
      afterSummary = summaryFor(await listBypassCache());
    } finally {
      getDb().exec("DROP TRIGGER fault_fold_write");
    }

    const projection = projectionReliable(afterSummary);
    assert.equal(projection?.status, "false", "ProjectionReliable must be false after the fold failure, never true");
  }));

test(
  "probe 3: simultaneous fold failure AND terminal-facts-failed-marker write failure (Sol third-verdict P1.1) still fails closed through the real production read",
  () =>
    withTempDb(async () => {
      seedConnector();
      seedInstance();

      // Reach a genuinely clean, checkpointed-empty terminal history first —
      // same starting point as probe 2.
      await reconcileConnectorSummaryEvidence(null);
      await reconcileDirtyConnectorSummaryEvidence();
      const before = getDb()
        .prepare(
          "SELECT terminal_facts_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?",
        )
        .get(INSTANCE_ID);
      assert.equal(before.terminal_facts_state, "current", "terminal_facts starts genuinely current");
      assert.equal(before.dirty, 0, "starts genuinely clean/fresh, not merely current");
      assert.equal(before.state, "fresh");

      const beforeSummary = summaryFor(await listBypassCache());
      assert.equal(projectionReliable(beforeSummary)?.status, "true", "the connection starts genuinely healthy");

      // Land a real terminal event so the next fold pass has genuine
      // checkpoint-advancing work to attempt and fail on.
      getDb()
        .prepare(
          `INSERT INTO spine_events(
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, connector_instance_id, data_json, version
           ) VALUES ('evt_probe3', 1, 'run.completed', ?, ?, 'test', 'trace_probe3', 'runtime', 'test-connector', 'run', 'run_probe3', 'succeeded', 'run_probe3', ?, ?, '1')`,
        )
        .run(
          NOW,
          NOW,
          INSTANCE_ID,
          JSON.stringify({
            connector_instance_id: INSTANCE_ID,
            connection_id: INSTANCE_ID,
            collection_facts: {
              reference_only: true,
              schema_version: 1,
              streams: [{ stream: STREAM, collected: 0, checkpoint: "committed" }],
            },
          }),
        );

      // Fault injection: reject BOTH the fold's own write
      // (`stream_facts_event_seq` advance) AND the terminal-facts-failed
      // marker's own write (`terminal_facts_state` degrade) — the exact
      // simultaneous double-failure Sol's third verdict reproduced. Before
      // this fix, `markTerminalFactsFailedForAllRows` caught and silently
      // discarded its own write failure, and `observeConnectorSummaryEvidence`
      // ignored `foldStreamFactsBestEffort`'s `{ok:false}` entirely — the
      // durable row stayed `terminal_facts_state=current`/`dirty=0`/
      // `state=fresh` and the returned summary reported `ProjectionReliable:
      // true`.
      getDb().exec(
        `CREATE TRIGGER fault_probe3_fold_write
           BEFORE UPDATE OF stream_facts_event_seq ON connector_summary_evidence
           WHEN NEW.stream_facts_event_seq IS NOT OLD.stream_facts_event_seq
         BEGIN
           SELECT RAISE(ABORT, 'injected fold write fault');
         END`,
      );
      getDb().exec(
        `CREATE TRIGGER fault_probe3_marker_write
           BEFORE UPDATE OF terminal_facts_state ON connector_summary_evidence
           WHEN NEW.terminal_facts_state IS NOT OLD.terminal_facts_state
         BEGIN
           SELECT RAISE(ABORT, 'injected terminal-facts-failed marker write fault');
         END`,
      );
      let summary;
      try {
        summary = summaryFor(await listBypassCache());
      } finally {
        getDb().exec("DROP TRIGGER fault_probe3_fold_write");
        getDb().exec("DROP TRIGGER fault_probe3_marker_write");
      }

      // The durable row is genuinely untouched by either rejected write —
      // this is the exact condition that used to read as healthy.
      const untouchedRow = getDb()
        .prepare(
          "SELECT terminal_facts_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?",
        )
        .get(INSTANCE_ID);
      assert.equal(
        untouchedRow.terminal_facts_state,
        "current",
        "the durable row's terminal_facts_state is genuinely untouched by the double-rejected writes",
      );
      assert.equal(untouchedRow.dirty, 0, "dirty is genuinely untouched — neither rejected write landed");
      assert.equal(untouchedRow.state, "fresh", "state is genuinely untouched — neither rejected write landed");

      // The real production entry point, read in the SAME pass while the
      // fault is still active, must surface the fold failure via the
      // in-memory typed overlay even though nothing durable reflects it.
      assert.equal(
        projectionReliable(summary)?.status,
        "false",
        "ProjectionReliable must be false — a stale current terminal_facts must never read reliable when BOTH the fold and its failure-marker write failed",
      );
    }),
);

test(
  "probe 4: simultaneous discovery failure AND discovery-failed-marker write failure (Sol third-verdict P1.1) still fails closed through the real production read",
  () =>
    withTempDb(async () => {
      seedConnector();
      seedInstance();

      // First pass: create a genuinely current, correct evidence row.
      const first = await reconcileConnectorSummaryEvidence(null);
      assert.equal(first.failed, 0);
      const before = getDb()
        .prepare(
          "SELECT record_snapshot_state, manifest_declaration_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?",
        )
        .get(INSTANCE_ID);
      assert.equal(before.record_snapshot_state, "current");
      assert.equal(before.manifest_declaration_state, "current");
      assert.equal(before.dirty, 0);
      assert.equal(before.state, "fresh");

      const beforeSummary = summaryFor(await listBypassCache());
      assert.equal(projectionReliable(beforeSummary)?.status, "true", "the connection starts genuinely healthy");

      // Fault injection: break discovery itself by renaming `version_counter`
      // (discovery's composite-checkpoint read — the exact table Sol's
      // verdict named: "I made canonical discovery fail by making
      // version_counter unreadable"), out from under any in-flight
      // `connector_summary_evidence` read/write, AND simultaneously reject
      // the discovery-failed marker's own write
      // (`record_snapshot_state`/`manifest_declaration_state` degrade) — the
      // exact simultaneous double-failure. Before this fix, the durable row
      // stayed current/fresh and the returned summary reported
      // `ProjectionReliable: true`.
      getDb().exec("ALTER TABLE version_counter RENAME TO version_counter_hidden_probe4");
      getDb().exec(
        `CREATE TRIGGER fault_probe4_marker_write
           BEFORE UPDATE OF record_snapshot_state ON connector_summary_evidence
           WHEN NEW.record_snapshot_state IS NOT OLD.record_snapshot_state
         BEGIN
           SELECT RAISE(ABORT, 'injected discovery-failed marker write fault');
         END`,
      );
      let summary;
      try {
        summary = summaryFor(await listBypassCache());
      } finally {
        getDb().exec("DROP TRIGGER fault_probe4_marker_write");
        getDb().exec("ALTER TABLE version_counter_hidden_probe4 RENAME TO version_counter");
      }

      // The durable row is genuinely untouched by either rejected write.
      const untouchedRow = getDb()
        .prepare(
          "SELECT record_snapshot_state, manifest_declaration_state, dirty, state FROM connector_summary_evidence WHERE connector_instance_id = ?",
        )
        .get(INSTANCE_ID);
      assert.equal(
        untouchedRow.record_snapshot_state,
        "current",
        "the durable row's record_snapshot_state is genuinely untouched by the double-rejected writes",
      );
      assert.equal(untouchedRow.dirty, 0, "dirty is genuinely untouched — neither rejected write landed");
      assert.equal(untouchedRow.state, "fresh", "state is genuinely untouched — neither rejected write landed");

      assert.equal(
        projectionReliable(summary)?.status,
        "false",
        "ProjectionReliable must be false — a stale current record_snapshot must never read reliable when BOTH discovery and its failure-marker write failed",
      );
    }),
);
