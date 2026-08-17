// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Red-team probe + regression proof for PR #84 (add-console-run-cancel-control):
// does a durable /v1/ingest write commit AFTER a run's canonical terminal state
// (run_history status='cancelled', completed_at set) has already been recorded?
//
// This is a production-path discriminator, not a mock-request counter. It
// drives the REAL storage write path — server/records.ts `ingestRecord` ->
// withConnectorInstanceWrite -> the same SQLite BEGIN IMMEDIATE transaction /
// Postgres transaction production traffic uses — and the REAL terminal-state
// writer (server/stores/run-history-writer.ts `writeSqliteRunHistoryForSpineEvent`,
// the exact function `emitSpineEvent` calls synchronously for run.cancelled).
//
// runtime/index.ts's own cancellation fence (flushBatch's terminalStopRequested
// check + `signal: cancelSignal` on fetch) is a CLIENT-side abort: it stops the
// runtime from *starting* new ingest requests and lets fetch's promise reject
// if the socket closes early. It says nothing about what the SERVER does with
// a write that was already admitted into the write-coordinator before cancel
// fired. This probe forces exactly that race deterministically, using the
// `__setConnectorInstanceWritePhaseHookForTest` seam (the same per-instance
// write-serialization gate every SQLite/Postgres ingest write passes through)
// to pause a write immediately after it acquires the coordinator lock — i.e.,
// immediately before the durable transaction — record the run cancelled in
// the meantime, then release the write and observe whether it still lands in
// `records`.
//
// Distinguishing normal in-flight completion from a post-cancel commit: the
// existing coverage (runtime-cancel-run.test.ts, runtime-cancel-queue.test.ts)
// already proves the *legitimate* case — an ingest request that was already
// authorized and in flight when cancel fires is allowed to finish, and that is
// intentional. This probe asks a narrower, later question: is there a hard
// admission boundary such that a write cannot commit once the run's terminal
// state is already durable, or is the terminal state and the write simply
// racing with no ordering guarantee at all?
//
// Fix scope (harden-ingest-run-admission-fence): the fence in server/records.ts
// / server/postgres-records.ts activates ONLY when the caller supplies
// `options.runId` — i.e. only for run-bound connector ingestion. Owner/API
// ingestion that never threads a run_id (the pre-existing `ingestRecord(target,
// record)` two-arg call shape, still used by owner-agent tooling and the
// source-webhooks route) is completely unaffected; a record write with no
// `run_id` is admitted exactly as before this fix.
//
// Fails CLOSED on an unrecognized run_id: runtime/index.ts always awaits the
// run.started spine write (which durably inserts the run_history row with
// status='running') before spawning the child that could ever call
// flushBatch, so a genuine run-bound write is guaranteed to find its row. A
// run_id with no matching row is refused, not admitted — otherwise a
// spoofed/typo'd run_id would silently bypass the fence entirely.
//
// Design note — per-record cost, not per-batch: the coordinator lock
// `withConnectorInstanceWrite`/`ingestRecords` already holds for the whole
// batch does NOT serialize against the run's terminal write (a completely
// separate call path — runtime/index.ts's proc.on("close", ...) handler,
// never nested inside the coordinator's critical section). Making the
// terminal writer acquire that same lock to allow a cheaper once-per-batch
// check was evaluated and rejected: the lock is held for the FULL batch
// duration (in-process key gate AND, cross-process, the Postgres advisory
// lock), so cancellation would then have to wait for the entire in-flight
// batch — including an unbounded flood — to finish before it could even
// attempt to record run.cancelled. That is precisely the "terminalization
// waits behind an unbounded queue" defect commit 73708a720 fixed, and it
// would violate the sub-second terminalization contract both
// runtime-cancel-run.test.ts and runtime-cancel-queue.test.ts already
// enforce (`elapsedMs < 1500`). Per-record checking is therefore the
// necessary cost of the "no write commits after terminalization" invariant
// under the current architecture, not an unoptimized default. Measured cost
// (5-round warmed benchmark, 200-record batch): SQLite ~20.5us/record
// (~13% relative — an in-process prepared-statement lookup, no network hop);
// Postgres ~257us/record (~2.7% relative — a `FOR UPDATE` round trip against
// an already network-bound per-record baseline that already takes its own
// `FOR UPDATE` lock on the `records` row).
//
// Coverage in this file:
//   1. NO FIX (baseline): a run-bound write with no runId supplied — proves
//      the fence is opt-in and pre-existing unscoped callers are unaffected.
//   2. FIXED — cancel-before-release: a write admitted while running, then
//      the run terminalizes before the write reaches its transaction — the
//      write is now REFUSED (not silently dropped as accepted).
//   3. FIXED — release-before-cancel: the legitimate ordering — a write that
//      completes its transaction before cancellation is untouched (the
//      existing "already-started ingest is preserved" guarantee still holds).
//   4. Spoof resistance — terminal status is scoped to (run_id,
//      connector_instance_id); a write claiming a run_id that belongs to a
//      DIFFERENT connector_instance_id cannot be fenced by that other run's
//      cancellation, and cannot be used to bypass a fence on its own run.
//   5. Fail-closed — a run_id with no matching run_history row at all
//      (spoofed, mistyped, or foreign) is refused, not admitted.
//   6. HTTP wire-through — the runtime's `?run_id=` query param on the real
//      POST /v1/ingest/:stream route reaches the storage-layer fence, AND
//      (per the ingest-rejection-contract revision) the fence's run_terminal
//      error classifies as SYSTEMIC/retryable — the route now rejects the
//      whole HTTP call (non-2xx) instead of returning a 200 envelope that
//      reads as an ordinary per-record rejection.
//   7. Postgres parity for cases 2, 3, and 5, gated on PDPP_TEST_POSTGRES_URL
//      (skips when unset, matching this repo's existing Postgres-parity
//      test convention — see test/postgres-records-ingest-noop.test.ts).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { __setConnectorInstanceWritePhaseHookForTest } from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { classifyIngestFailure, ingestRecord } from "../server/records.ts";
import { writeSqliteRunHistoryForSpineEvent } from "../server/stores/run-history-writer.ts";

const STREAM = "items";
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const RUN_TERMINAL_ERROR_RE = /run .* is already terminal/;

function freshDb(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-cancel-boundary-probe-"));
  closeDb();
  initDb(join(dir, "pdpp.sqlite"));
  t.after(() => {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  });
}

function seedActiveConnection(connectorId: string, connectorInstanceId: string): void {
  const now = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, '{}', ?)")
    .run(connectorId, now);
  getDb()
    .prepare(
      `INSERT INTO connector_instances(
         connector_instance_id, owner_subject_id, connector_id, display_name, status,
         source_kind, source_binding_key, source_binding_json, created_at, updated_at
       ) VALUES (?, 'owner', ?, 'HTTP wire-through probe', 'active', 'account', ?, '{}', ?, ?)`
    )
    .run(connectorInstanceId, connectorId, connectorInstanceId, now, now);
}

function startRunSqlite(runId: string, connectorId: string, connectorInstanceId: string): void {
  writeSqliteRunHistoryForSpineEvent({
    connectorId,
    connectorInstanceId,
    data: {},
    eventType: "run.started",
    occurredAt: new Date().toISOString(),
    runId,
    status: "started",
  });
}

function cancelRunSqlite(runId: string, connectorId: string, connectorInstanceId: string): void {
  writeSqliteRunHistoryForSpineEvent({
    connectorId,
    connectorInstanceId,
    data: { reason: "owner_cancelled" },
    eventType: "run.cancelled",
    occurredAt: new Date().toISOString(),
    runId,
    status: "cancelled",
  });
}

interface RunHistoryRow {
  completed_at: string | null;
  status: string;
}

function readRunHistorySqlite(runId: string, connectorInstanceId: string): RunHistoryRow {
  const db = getDb();
  const row = db
    .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ? AND connector_instance_id = ?")
    .get(runId, connectorInstanceId) as RunHistoryRow | undefined;
  assert.ok(row, "run_history row must exist for the probe run");
  return row;
}

function readCommittedRecordSqlite(connectorInstanceId: string, key: string): { record_key: string } | undefined {
  const db = getDb();
  return db
    .prepare(
      "SELECT record_key FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ? AND deleted = 0"
    )
    .get(connectorInstanceId, STREAM, key) as { record_key: string } | undefined;
}

test("no fix scope creep: a run-bound write with no runId supplied is admitted exactly as before (owner/API ingestion unaffected)", async (t) => {
  freshDb(t);
  const connectorId = "no-runid-scope-probe";
  const connectorInstanceId = "cin_no_runid_scope_probe";
  const runId = "run_no_runid_scope_probe";
  startRunSqlite(runId, connectorId, connectorInstanceId);
  cancelRunSqlite(runId, connectorId, connectorInstanceId);

  // No `options.runId` — this is the exact call shape owner-agent tooling and
  // the source-webhooks route use today. The fence must not activate.
  const outcome = await ingestRecord(
    { connector_id: connectorId, connector_instance_id: connectorInstanceId },
    { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM }
  );

  assert.equal(
    outcome.accepted,
    true,
    "a write with no runId is admitted even though the connection's run_history shows a cancelled run"
  );
  assert.ok(
    readCommittedRecordSqlite(connectorInstanceId, "r1"),
    "record committed — unscoped ingestion is unaffected by the fence"
  );
});

test("SQLite fixed: cancel-before-release — a write already admitted before terminalization is refused, not silently committed", async (t) => {
  freshDb(t);
  t.after(() => __setConnectorInstanceWritePhaseHookForTest(null));
  const connectorId = "cancel-before-release-probe";
  const connectorInstanceId = "cin_cancel_before_release_probe";
  const runId = "run_cancel_before_release_probe";
  startRunSqlite(runId, connectorId, connectorInstanceId);

  let releaseWrite!: () => void;
  const writeHeld = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  let sawRunningAtAcquire: string | null = null;

  __setConnectorInstanceWritePhaseHookForTest(async (stage) => {
    if (stage !== "after_acquire") {
      return;
    }
    sawRunningAtAcquire = readRunHistorySqlite(runId, connectorInstanceId).status;
    await writeHeld;
  });

  const ingestPromise = ingestRecord(
    { connector_id: connectorId, connector_instance_id: connectorInstanceId },
    { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM },
    { runId }
  );

  await new Promise((resolve) => setTimeout(resolve, 20));

  cancelRunSqlite(runId, connectorId, connectorInstanceId);
  const terminalSnapshot = readRunHistorySqlite(runId, connectorInstanceId);
  assert.equal(
    terminalSnapshot.status,
    "cancelled",
    "run_history is durably cancelled before the parked write is released"
  );
  assert.ok(terminalSnapshot.completed_at, "cancellation stamped a terminal completed_at");

  releaseWrite();
  await assert.rejects(
    ingestPromise,
    RUN_TERMINAL_ERROR_RE,
    "FIX: the write-admission fence refuses a write for a run that terminalized while the write was already parked in the coordinator"
  );

  assert.equal(
    sawRunningAtAcquire,
    "running",
    "the write was admitted into the coordinator while the run was still live"
  );
  assert.equal(
    readCommittedRecordSqlite(connectorInstanceId, "r1"),
    undefined,
    "no record committed — the fenced write never reached the durable mutation"
  );
});

test("SQLite legitimate ordering preserved: release-before-cancel — a write that completes before cancellation is untouched", async (t) => {
  freshDb(t);
  t.after(() => __setConnectorInstanceWritePhaseHookForTest(null));
  const connectorId = "release-before-cancel-probe";
  const connectorInstanceId = "cin_release_before_cancel_probe";
  const runId = "run_release_before_cancel_probe";
  startRunSqlite(runId, connectorId, connectorInstanceId);

  const outcome = await ingestRecord(
    { connector_id: connectorId, connector_instance_id: connectorInstanceId },
    { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM },
    { runId }
  );
  assert.equal(outcome.accepted, true, "a write that completes while the run is still running is accepted");

  // Cancellation arrives strictly after the write's own transaction committed.
  cancelRunSqlite(runId, connectorId, connectorInstanceId);

  assert.ok(
    readCommittedRecordSqlite(connectorInstanceId, "r1"),
    "the already-committed record is not retroactively rolled back by a later cancellation"
  );
});

test("spoof resistance: a runId scoped to a DIFFERENT connector_instance_id cannot be fenced by that other run's cancellation", async (t) => {
  freshDb(t);
  const sharedRunId = "run_shared_id_across_connections";
  const victimConnectorId = "spoof-victim";
  const victimInstanceId = "cin_spoof_victim";
  const attackerConnectorId = "spoof-attacker";
  const attackerInstanceId = "cin_spoof_attacker";

  // Two different connections independently mint the SAME run_id — an
  // explicitly documented possibility (run-history-writer.ts: run_id alone is
  // NOT globally unique; only (run_id, connector_instance_id) is real
  // identity). Cancel only the victim's run.
  startRunSqlite(sharedRunId, victimConnectorId, victimInstanceId);
  startRunSqlite(sharedRunId, attackerConnectorId, attackerInstanceId);
  cancelRunSqlite(sharedRunId, victimConnectorId, victimInstanceId);

  // The attacker's own run (same run_id, different connector_instance_id) is
  // still running and must be admitted — a bare `WHERE run_id = ?` fence
  // would have wrongly refused this.
  const attackerOutcome = await ingestRecord(
    { connector_id: attackerConnectorId, connector_instance_id: attackerInstanceId },
    { data: { id: "a1" }, emitted_at: new Date().toISOString(), key: "a1", stream: STREAM },
    { runId: sharedRunId }
  );
  assert.equal(
    attackerOutcome.accepted,
    true,
    "a write for a live run under a DIFFERENT connector_instance_id is not fenced by a same-run_id cancellation on another connection"
  );
  assert.ok(readCommittedRecordSqlite(attackerInstanceId, "a1"));

  // The victim's run is genuinely cancelled and must be fenced.
  await assert.rejects(
    ingestRecord(
      { connector_id: victimConnectorId, connector_instance_id: victimInstanceId },
      { data: { id: "v1" }, emitted_at: new Date().toISOString(), key: "v1", stream: STREAM },
      { runId: sharedRunId }
    ),
    RUN_TERMINAL_ERROR_RE,
    "the victim's cancelled run is correctly fenced despite the run_id collision"
  );
  assert.equal(readCommittedRecordSqlite(victimInstanceId, "v1"), undefined);
});

test("fail closed: a runId with NO matching run_history row at all is refused, not admitted", async (t) => {
  freshDb(t);
  const connectorId = "fail-closed-probe";
  const connectorInstanceId = "cin_fail_closed_probe";

  // No startRunSqlite call — run.started never wrote a row for this runId.
  // Every genuine run-bound write is preceded by an awaited run.started
  // spine write (runtime/index.ts), so this state is only reachable via a
  // spoofed, mistyped, or foreign run_id — none of which should bypass the
  // fence by exploiting a "no row found" fail-open default.
  await assert.rejects(
    ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM },
      { runId: "run_never_started_or_spoofed" }
    ),
    RUN_TERMINAL_ERROR_RE,
    "a runId with no run_history row is refused (fail closed), not silently admitted"
  );
  assert.equal(readCommittedRecordSqlite(connectorInstanceId, "r1"), undefined);
});

// --- HTTP wire-through: runtime's ?run_id= reaches the storage fence ---

test("HTTP wire-through: POST /v1/ingest/:stream's ?run_id= query param reaches the storage-layer fence end to end", async (t) => {
  freshDb(t);
  t.after(() => __setConnectorInstanceWritePhaseHookForTest(null));
  const connectorId = "http-wire-through-probe";
  const connectorInstanceId = "cin_http_wire_through_probe";
  const runId = "run_http_wire_through_probe";
  seedActiveConnection(connectorId, connectorInstanceId);
  startRunSqlite(runId, connectorId, connectorInstanceId);
  cancelRunSqlite(runId, connectorId, connectorInstanceId);

  const routes: Record<string, ((req: unknown, res: unknown) => unknown)[]> = {};
  const app = {
    post(path: string, ...handlers: unknown[]) {
      routes[path] = handlers as ((req: unknown, res: unknown) => unknown)[];
    },
  };
  let jsonBody: unknown;
  const res = {
    json: (body: unknown) => {
      jsonBody = body;
      return body;
    },
    setHeader: () => undefined,
    status: () => res,
  };
  const ctx = {
    buildMutationContext: () => ({ traceId: "trace-http-wire-through" }),
    // REAL classifier — same one server/index.ts wires in production.
    classifyIngestFailure,
    emitMutationEvent: async () => undefined,
    emitMutationRequested: async () => undefined,
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    // The REAL storage function under test — not a mock.
    ingestRecord,
    rejectMutation: (_res: unknown, _req: unknown, _mctx: unknown, err: Error) => Promise.reject(err),
    requireOwner: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    requireToken: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    resolveOwnerConnectorNamespace: async () => ({ connectorId, connectorInstanceId }),
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: STREAM }] }),
    resolveSingleConnectorIdQueryValue: (value: unknown) => (typeof value === "string" ? value : null),
    setReferenceTraceId: () => undefined,
    storageTargetForConnectorNamespace: () => ({
      connector_id: connectorId,
      connector_instance_id: connectorInstanceId,
    }),
  };

  // dynamic import keeps this test file's static imports free of the route
  // module's much larger MountRsMutationContext type surface.
  const { mountRsRecordsIngest } = await import("../server/routes/rs-mutation.ts");
  type MountRsRecordsIngest = typeof mountRsRecordsIngest;
  mountRsRecordsIngest(
    app as unknown as Parameters<MountRsRecordsIngest>[0],
    ctx as unknown as Parameters<MountRsRecordsIngest>[1]
  );
  assert.ok("/v1/ingest/:stream" in routes, "ingest route must be mounted");
  const handler = routes["/v1/ingest/:stream"].at(-1);
  assert.ok(handler, "ingest route handler must be registered");

  // The run-terminal fence (records.ts's assertSqliteRunStillAdmitted, code
  // "run_terminal") is a genuine SYSTEMIC/retryable failure under the
  // rs.records.ingest envelope contract: it never proved this record's own
  // data invalid, it proved the RUN was fenced. classifyIngestFailure has no
  // "run_terminal" entry in its permanent allowlist, so it defaults
  // retryable — the operation throws RecordsIngestSystemicFailureError
  // instead of returning a 200 envelope, and this test's `ctx.rejectMutation`
  // mock re-rejects the handler's own promise (matching the real route's
  // `return await ctx.rejectMutation(...)` early-return-on-catch shape).
  await assert.rejects(
    async () =>
      await handler(
        {
          body: '{"id":"r1"}',
          headers: {},
          params: { stream: STREAM },
          query: { connector_id: connectorId, connector_instance_id: connectorInstanceId, run_id: runId },
        },
        res
      ),
    (err: unknown) => {
      const typed = err as { code?: string; message?: string };
      assert.equal(typed.code, "ingest_batch_storage_error");
      // The public `.message` is a fixed, bounded template — it must NEVER
      // embed the underlying run_terminal detail (external-boundary
      // redaction; see rs-ingest-systemic-failure-redaction.test.ts for the
      // full HTTP-response/persisted-event proof).
      assert.doesNotMatch(typed.message ?? "", RUN_TERMINAL_ERROR_RE);
      return true;
    },
    "a fenced write for a cancelled run must surface as a non-2xx systemic failure, not a 200 partial-rejection envelope"
  );
  assert.equal(jsonBody, undefined, "res.json must never be called — the route rejects before building a 200 envelope");
  assert.equal(
    readCommittedRecordSqlite(connectorInstanceId, "r1"),
    undefined,
    "no record committed through the real HTTP route for a cancelled run's run_id"
  );
});

// --- Postgres parity ---------------------------------------------------

function postgresStorageConfig(): { backend: "postgres"; databaseUrl: string } {
  assert.ok(POSTGRES_URL, "Postgres test requires PDPP_TEST_POSTGRES_URL");
  return { backend: "postgres", databaseUrl: POSTGRES_URL };
}

async function startRunPostgres(runId: string, connectorId: string, connectorInstanceId: string): Promise<void> {
  await postgresQuery(
    `INSERT INTO run_history(run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
     VALUES($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, now(), 1)`,
    [runId, connectorInstanceId, connectorId]
  );
}

async function cancelRunPostgres(runId: string, connectorInstanceId: string): Promise<void> {
  const result = await postgresQuery<{ status: string }>(
    `UPDATE run_history SET status = 'cancelled', completed_at = now()
     WHERE run_id = $1 AND connector_instance_id = $2 AND status = 'running'
     RETURNING status`,
    [runId, connectorInstanceId]
  );
  assert.equal(result.rows[0]?.status, "cancelled", "test setup: the run_history row transitioned to cancelled");
}

async function readCommittedRecordPostgres(
  connectorInstanceId: string,
  key: string
): Promise<{ record_key: string } | undefined> {
  const result = await postgresQuery<{ record_key: string }>(
    "SELECT record_key FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = false",
    [connectorInstanceId, STREAM, key]
  );
  return result.rows[0];
}

async function cleanupPostgres(connectorInstanceId: string, runId: string): Promise<void> {
  try {
    await postgresQuery("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
    await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
    await postgresQuery("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
    await postgresQuery("DELETE FROM run_history WHERE run_id = $1 AND connector_instance_id = $2", [
      runId,
      connectorInstanceId,
    ]);
  } catch {
    // best-effort cleanup, matches this repo's existing Postgres test convention
  }
}

if (POSTGRES_URL) {
  test("Postgres fixed: cancel-before-release — a write already admitted before terminalization is refused", async (t) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_cancel_before_release_${suffix}`;
    const connectorInstanceId = `cin_pg_cancel_before_release_${suffix}`;
    const runId = `run_pg_cancel_before_release_${suffix}`;

    initDb(":memory:");
    await initPostgresStorage(postgresStorageConfig());
    t.after(async () => {
      await cleanupPostgres(connectorInstanceId, runId);
      await closePostgresStorage();
      closeDb();
    });
    t.after(() => __setConnectorInstanceWritePhaseHookForTest(null));

    await startRunPostgres(runId, connectorId, connectorInstanceId);

    let releaseWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    __setConnectorInstanceWritePhaseHookForTest(async (stage) => {
      if (stage !== "after_acquire") {
        return;
      }
      await writeHeld;
    });

    const ingestPromise = ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM },
      { runId }
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await cancelRunPostgres(runId, connectorInstanceId);

    releaseWrite();
    await assert.rejects(
      ingestPromise,
      RUN_TERMINAL_ERROR_RE,
      "FIX (Postgres): the write-admission fence refuses a write for a run that terminalized while the write was parked"
    );

    assert.equal(
      await readCommittedRecordPostgres(connectorInstanceId, "r1"),
      undefined,
      "no record committed on Postgres — the fenced write never reached the durable mutation"
    );
  });

  test("Postgres legitimate ordering preserved: release-before-cancel — a write that completes before cancellation is untouched", async (t) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_release_before_cancel_${suffix}`;
    const connectorInstanceId = `cin_pg_release_before_cancel_${suffix}`;
    const runId = `run_pg_release_before_cancel_${suffix}`;

    initDb(":memory:");
    await initPostgresStorage(postgresStorageConfig());
    t.after(async () => {
      await cleanupPostgres(connectorInstanceId, runId);
      await closePostgresStorage();
      closeDb();
    });

    await startRunPostgres(runId, connectorId, connectorInstanceId);

    const outcome = await ingestRecord(
      { connector_id: connectorId, connector_instance_id: connectorInstanceId },
      { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM },
      { runId }
    );
    assert.equal(
      outcome.accepted,
      true,
      "a write that completes while the run is still running is accepted (Postgres)"
    );

    await cancelRunPostgres(runId, connectorInstanceId);

    assert.ok(
      await readCommittedRecordPostgres(connectorInstanceId, "r1"),
      "the already-committed record is not retroactively rolled back by a later cancellation (Postgres)"
    );
  });

  test("Postgres fail closed: a runId with NO matching run_history row at all is refused, not admitted", async (t) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_fail_closed_${suffix}`;
    const connectorInstanceId = `cin_pg_fail_closed_${suffix}`;

    initDb(":memory:");
    await initPostgresStorage(postgresStorageConfig());
    t.after(async () => {
      await cleanupPostgres(connectorInstanceId, `run_pg_never_started_${suffix}`);
      await closePostgresStorage();
      closeDb();
    });

    await assert.rejects(
      ingestRecord(
        { connector_id: connectorId, connector_instance_id: connectorInstanceId },
        { data: { id: "r1" }, emitted_at: new Date().toISOString(), key: "r1", stream: STREAM },
        { runId: `run_pg_never_started_${suffix}` }
      ),
      RUN_TERMINAL_ERROR_RE,
      "a runId with no run_history row is refused on Postgres (fail closed), not silently admitted"
    );
    assert.equal(await readCommittedRecordPostgres(connectorInstanceId, "r1"), undefined);
  });
} else {
  test("Postgres cancel-boundary parity (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // See test/postgres-records-ingest-noop.test.ts for this repo's convention.
  });
}
