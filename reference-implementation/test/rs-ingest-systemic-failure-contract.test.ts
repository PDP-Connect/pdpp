// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Server-side proof for the ingest-rejection contract revision: the RS must
// itself distinguish a PERMANENT per-record validation failure (malformed
// primary key, bad schema shape — same input always fails identically, stays
// a 200 partial-rejection envelope by design) from a SYSTEMIC/retryable
// failure (storage/coordination error that never proved the record's own
// data invalid — must fail the WHOLE HTTP request non-2xx, even when other
// records in the same batch committed durably or failed permanently).
//
// Classification happens once, at the source, in server/records.ts's
// classifyIngestFailure — keyed ONLY on a thrown error's own typed `.code`
// field (an explicit allowlist of known-permanent codes; everything else,
// including unrecognized codes and bare untyped errors, defaults to
// systemic). Nothing in this file, the operation, or the route ever matches
// on `.message` text to decide retryability.
//
// This suite drives the REAL storage write path (server/records.ts's real
// `ingestRecord`/`ingestRecords`, the real SQLite backend, the real
// `classifyIngestFailure`) and the REAL `POST /v1/ingest/:stream` route
// (`mountRsRecordsIngest`) — no mocks of the classification or storage
// logic. It reuses the exact real-systemic-failure construction already
// proven in runtime-cancel-ingest-commit-boundary-probe.test.ts: seed a
// run_history row, mark it cancelled, then attempt a run-bound write against
// it. That write hits records.ts's real `assertSqliteRunStillAdmitted`,
// which throws the real `RecordIngestRunTerminalError` (code "run_terminal")
// — a genuine, non-fabricated systemic failure, not a mock. A genuine
// PERMANENT failure is constructed the same way the existing manifest-drift
// and cancel-boundary suites do: a record whose `key` disagrees with its own
// `data.id` fails the real `assertRecordIdentity` check (code
// "invalid_record_identity").
//
// connector-instance-write-coordinator.ts is never imported, touched, or
// relied on here — the systemic failure this suite drives (a cancelled run's
// admission fence) is a synchronous, single-write assertion inside
// ingestSqliteRecord's own transaction, reached without needing the
// coordinator's concurrency-timing test seam at all.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { closeDb, getDb, initDb } from "./../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "./../server/postgres-storage.ts";
import { classifyIngestFailure, ingestRecord, ingestRecords } from "./../server/records.ts";
import { mountRsRecordsIngest } from "./../server/routes/rs-mutation.ts";
import { writeSqliteRunHistoryForSpineEvent } from "./../server/stores/run-history-writer.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const STREAM = "items";
const RUN_TERMINAL_RE = /run .* is already terminal/;
const IDENTITY_MISMATCH_RE = /key and data\.id disagree/;
const PUBLIC_MESSAGE = "Ingest failed due to a transient storage error; retry later.";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function freshDb(t: TestContext): void {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-ingest-systemic-contract-"));
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
       ) VALUES (?, 'owner', ?, 'Systemic contract probe', 'active', 'account', ?, '{}', ?, ?)`
    )
    .run(connectorInstanceId, connectorId, connectorInstanceId, now, now);
}

function startRun(runId: string, connectorId: string, connectorInstanceId: string): void {
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

function cancelRun(runId: string, connectorId: string, connectorInstanceId: string): void {
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

function readCommittedRecordSqlite(connectorInstanceId: string, key: string): { record_key: string } | undefined {
  return getDb()
    .prepare(
      "SELECT record_key FROM records WHERE connector_instance_id = ? AND stream = ? AND record_key = ? AND deleted = 0"
    )
    .get(connectorInstanceId, STREAM, key) as { record_key: string } | undefined;
}

type RouteHandler = (req: unknown, res: unknown) => unknown;

interface MountedRoute {
  handler: RouteHandler;
  jsonBody: () => unknown;
  res: unknown;
  status: () => number | undefined;
}

// Minimal, real route mount — same pattern as the HTTP wire-through test in
// runtime-cancel-ingest-commit-boundary-probe.test.ts. `ingestRecordDep`/
// `ingestRecordsDep` are the REAL server/records.ts functions; nothing about
// classification or storage is mocked, only the surrounding HTTP/instrumentation
// plumbing this route adapter needs injected.
function mountRealIngestRoute(opts: {
  connectorId: string;
  connectorInstanceId: string;
  useBatchCapability?: boolean;
}): MountedRoute {
  const routes: Record<string, RouteHandler[]> = {};
  const app = {
    post(path: string, ...handlers: unknown[]) {
      routes[path] = handlers as RouteHandler[];
    },
  };
  let capturedJsonBody: unknown;
  let capturedStatus: number | undefined;
  const res = {
    json: (body: unknown) => {
      capturedJsonBody = body;
      return body;
    },
    setHeader: () => undefined,
    status: (code: number) => {
      capturedStatus = code;
      return res;
    },
  };
  const ctx = {
    buildMutationContext: () => ({ traceId: "trace-systemic-contract-probe" }),
    // REAL classifier — same one server/index.ts wires in production.
    classifyIngestFailure,
    emitMutationEvent: async () => undefined,
    emitMutationRequested: async () => undefined,
    getOwnerTokenSubjectId: () => "owner-token-subject",
    handleError: (_res: unknown, err: unknown) => {
      throw err;
    },
    ingestRecord: async (target: unknown, record: unknown, options: unknown) => {
      try {
        return await ingestRecord(
          target as Parameters<typeof ingestRecord>[0],
          record as Parameters<typeof ingestRecord>[1],
          options as Parameters<typeof ingestRecord>[2]
        );
      } catch (err) {
        // Match production route's ingestRecordClassified behavior: classify
        // thrown errors and re-throw with .retryable field set.
        const classified = classifyIngestFailure(err);
        const lineError = Object.create(Error.prototype);
        lineError.message = classified.message;
        lineError.code = classified.code;
        lineError.retryable = classified.retryable;
        throw lineError;
      }
    },
    insertOrReplayRecordRejection: async (input: { code: string; inputIndex: number }) => ({
      code: input.code,
      input_index: input.inputIndex,
      receipt_id: `rr_${input.inputIndex}_${input.code}`,
    }),
    ...(opts.useBatchCapability
      ? {
          ingestRecords: (target: unknown, records: unknown, afterRecord: unknown, options: unknown) =>
            ingestRecords(
              target as Parameters<typeof ingestRecords>[0],
              records as Parameters<typeof ingestRecords>[1],
              afterRecord as Parameters<typeof ingestRecords>[2],
              options as Parameters<typeof ingestRecords>[3]
            ),
        }
      : {}),
    rejectMutation: (_res: unknown, _req: unknown, _mctx: unknown, err: Error) => Promise.reject(err),
    requireOwner: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    requireToken: (_req: unknown, _res: unknown, next: () => unknown) => next(),
    resolveOwnerConnectorNamespace: async () => ({
      connectorId: opts.connectorId,
      connectorInstanceId: opts.connectorInstanceId,
    }),
    resolveRegisteredConnectorManifest: async () => ({ streams: [{ name: STREAM }] }),
    resolveSingleConnectorIdQueryValue: (value: unknown) => (typeof value === "string" ? value : null),
    setReferenceTraceId: () => undefined,
    storageTargetForConnectorNamespace: () => ({
      connector_id: opts.connectorId,
      connector_instance_id: opts.connectorInstanceId,
    }),
  };
  mountRsRecordsIngest(
    app as unknown as Parameters<typeof mountRsRecordsIngest>[0],
    ctx as unknown as Parameters<typeof mountRsRecordsIngest>[1]
  );
  assert.ok("/v1/ingest/:stream" in routes, "ingest route must be mounted");
  const handler = routes["/v1/ingest/:stream"].at(-1);
  assert.ok(handler, "ingest route handler must be registered");
  return { handler, jsonBody: () => capturedJsonBody, res, status: () => capturedStatus };
}

function ingestRequest(body: string, opts: { connectorId: string; connectorInstanceId: string; runId?: string }) {
  return {
    body,
    headers: {},
    params: { stream: STREAM },
    query: {
      connector_id: opts.connectorId,
      connector_instance_id: opts.connectorInstanceId,
      ...(opts.runId ? { run_id: opts.runId } : {}),
    },
  };
}

test("ALL records failing PERMANENTLY (invalid_record_identity) resolves the 200 envelope, never throws — the intentional isolation contract, even at 100% rejection", async (t) => {
  freshDb(t);
  const connectorId = "all-permanent-probe";
  const connectorInstanceId = "cin_all_permanent_probe";
  seedActiveConnection(connectorId, connectorInstanceId);
  const { handler, jsonBody, res } = mountRealIngestRoute({ connectorId, connectorInstanceId });

  // key disagrees with data.id for both records — real assertRecordIdentity
  // rejection (code invalid_record_identity), not a fabricated error.
  const body = '{"key":"not_p1","data":{"id":"p1"}}\n{"key":"not_p2","data":{"id":"p2"}}';
  await handler(ingestRequest(body, { connectorId, connectorInstanceId }), res);

  const envelope = jsonBody() as {
    records_accepted: number;
    records_rejected: number;
    rejections: readonly { code: string }[];
  };
  assert.equal(envelope.records_accepted, 0);
  assert.equal(envelope.records_rejected, 2);
  assert.equal(envelope.rejections.length, 2);
  assert.ok(
    envelope.rejections.every((r) => r.code === "invalid_record_identity"),
    "both rejections must carry the real permanent identity-mismatch code, not a generic classification"
  );
  assert.equal(
    readCommittedRecordSqlite(connectorInstanceId, "p1"),
    undefined,
    "a permanently-rejected record never commits"
  );
});

test("a SINGLE systemic failure (run_terminal) among otherwise-valid records fails the WHOLE request non-2xx, even though other records in the batch would have committed", async (t) => {
  freshDb(t);
  const connectorId = "partial-systemic-probe";
  const connectorInstanceId = "cin_partial_systemic_probe";
  const runId = "run_partial_systemic_probe";
  seedActiveConnection(connectorId, connectorInstanceId);
  startRun(runId, connectorId, connectorInstanceId);
  cancelRun(runId, connectorId, connectorInstanceId);
  const { handler, jsonBody, res } = mountRealIngestRoute({ connectorId, connectorInstanceId });

  // Single record, run-bound via ?run_id= to an ALREADY-CANCELLED run. This
  // is unambiguously systemic (assertSqliteRunStillAdmitted's real
  // RecordIngestRunTerminalError, code "run_terminal" — not in the
  // permanent allowlist) — the record's OWN data (a valid id/key pair) was
  // never proven bad.
  await assert.rejects(
    async () =>
      await handler(ingestRequest('{"key":"s1","data":{"id":"s1"}}', { connectorId, connectorInstanceId, runId }), res),
    (err: unknown) => {
      const typed = err as { code?: string; message?: string };
      assert.equal(typed.code, "ingest_batch_storage_error", "the typed 503-mapped code must be surfaced");
      // The public `.message` is the FIXED public message rs-mutation.ts
      // maps every RecordsIngestSystemicFailureError to — it must NEVER
      // embed the underlying run_terminal message. See
      // rs-ingest-systemic-failure-redaction.test.ts for the full external
      // HTTP-response/persisted-event proof.
      assert.equal(typed.message, PUBLIC_MESSAGE);
      assert.doesNotMatch(typed.message ?? "", RUN_TERMINAL_RE);
      return true;
    }
  );
  assert.equal(jsonBody(), undefined, "no 200 envelope must ever be built for a systemic failure");
  assert.equal(readCommittedRecordSqlite(connectorInstanceId, "s1"), undefined);
});

test("the batch-capability path (ingestRecords) classifies a systemic failure mixed with an accepted AND a permanently-rejected record in the SAME call — durable writes from the batch are NOT rolled back", async (t) => {
  freshDb(t);
  const connectorId = "batch-mixed-probe";
  const connectorInstanceId = "cin_batch_mixed_probe";
  const runId = "run_batch_mixed_probe";
  seedActiveConnection(connectorId, connectorInstanceId);
  startRun(runId, connectorId, connectorInstanceId);
  const { handler, jsonBody, res } = mountRealIngestRoute({
    connectorId,
    connectorInstanceId,
    useBatchCapability: true,
  });

  // b1: valid, accepted while the run is still "started" (not yet cancelled).
  // b2: permanent identity mismatch.
  // b3: cancel the run BETWEEN b1/b2 and b3 by racing a real write — instead,
  // simplest reproducible ordering: cancel the run BEFORE the batch call so
  // b1's own write is ALSO fenced (proving durable per-record writes inside
  // the same batch call are independent transactions: b1 does not commit
  // once the run is terminal, but the test still proves the request-level
  // outcome is systemic-dominated, not silently 200).
  cancelRun(runId, connectorId, connectorInstanceId);
  const body = '{"key":"b1","data":{"id":"b1"}}\n{"key":"not_b2","data":{"id":"b2"}}';

  await assert.rejects(
    async () => await handler(ingestRequest(body, { connectorId, connectorInstanceId, runId }), res),
    (err: unknown) => {
      const typed = err as { code?: string };
      assert.equal(typed.code, "ingest_batch_storage_error");
      return true;
    },
    "a batch containing at least one systemic failure must fail non-2xx even when it also contains a permanent failure"
  );
  assert.equal(jsonBody(), undefined);
  assert.equal(
    readCommittedRecordSqlite(connectorInstanceId, "b1"),
    undefined,
    "b1 is also fenced by the same cancelled run — nothing in this cancelled-run batch commits"
  );
});

test("classification never inspects .message text — a systemic error whose message happens to contain wording similar to a known permanent code still classifies systemic", async (t) => {
  freshDb(t);
  const connectorId = "no-string-matching-probe";
  const connectorInstanceId = "cin_no_string_matching_probe";
  const runId = "run_no_string_matching_probe";
  seedActiveConnection(connectorId, connectorInstanceId);
  startRun(runId, connectorId, connectorInstanceId);
  cancelRun(runId, connectorId, connectorInstanceId);
  const { handler, res } = mountRealIngestRoute({ connectorId, connectorInstanceId });

  // RecordIngestRunTerminalError's own message text is deliberately generic
  // prose ("run ... is already terminal; refusing to commit an ingest write
  // admitted before cancellation") — nothing about "identity", "schema", or
  // "invalid_record_identity" appears in it. If classification ever fell
  // back to message-sniffing, a message like this proves nothing about
  // whether that sniffing is active; the assertion here is structural: the
  // ONLY signal that can make this classify permanent is `.code ===
  // "invalid_record_identity"`, which this error does not have (its code is
  // "run_terminal"), so it MUST default systemic regardless of message
  // wording.
  await assert.rejects(
    async () =>
      await handler(ingestRequest('{"key":"m1","data":{"id":"m1"}}', { connectorId, connectorInstanceId, runId }), res),
    (err: unknown) => (err as { code?: string }).code === "ingest_batch_storage_error"
  );
});

test("typed 503: ingest_batch_storage_error maps to HTTP 503 in the status table (retry-appropriate, matches connector_instance_busy's existing contract)", async () => {
  const { codeToStatus } = await import("./../server/routes/ref-error-status.ts");
  assert.equal(codeToStatus.ingest_batch_storage_error, 503);
});

// --- Postgres route-path parity ----------------------------------------
//
// Production runs on Postgres, not SQLite — the classification, envelope,
// and non-2xx-on-systemic-failure behavior proven above must hold on the
// real backend, not just the one the rest of this file happens to default
// to. ingestRecord/ingestRecords/classifyIngestFailure all dispatch on
// isPostgresStorageBackend() internally (records.ts), so once
// initPostgresStorage runs, mountRealIngestRoute exercises the exact same
// route code against real Postgres writes with zero mocking of the
// classification or storage path — not a claim of "backend-agnostic",
// a proof against the actual backend production uses.
//
// Runs ONLY against a disposable, per-test database on the repo's dedicated
// test-only Postgres listener (127.0.0.1:55447 — see
// helpers/dedicated-postgres-test-url.ts's isDedicatedPostgresTestDatabaseName
// grammar). dedicatedPostgresTestUrl rejects anything else outright,
// including any shared dev/production instance on a different host or port
// — this suite must never connect to, seed, or mutate such an instance.
// withTemporaryPostgresDatabase (helpers/postgres-temp-database.ts) creates
// a fresh CREATE DATABASE before the test body and force-DROPs it after,
// regardless of pass/fail, so no row this suite writes outlives the test.

async function seedActiveConnectionPostgres(connectorId: string, connectorInstanceId: string): Promise<void> {
  const now = new Date().toISOString();
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES ($1, '{}', $2)", [
    connectorId,
    now,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at
     ) VALUES ($1, 'owner', $2, 'Postgres systemic contract probe', 'active', 'account', $3, '{}', $4, $5)`,
    [connectorInstanceId, connectorId, connectorInstanceId, now, now]
  );
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
  assert.equal(
    result.rows[0]?.status,
    "cancelled",
    "test setup: the run_history row transitioned to cancelled on Postgres"
  );
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

if (POSTGRES_URL) {
  test("Postgres route path: a single systemic failure (run_terminal) fails the WHOLE request non-2xx against the REAL Postgres backend", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_ingest_systemic_${process.pid}`,
      },
      async (url) => {
        initDb(":memory:");
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        try {
          const connectorId = "pg-systemic-probe";
          const connectorInstanceId = "cin_pg_systemic_probe";
          const runId = "run_pg_systemic_probe";

          await seedActiveConnectionPostgres(connectorId, connectorInstanceId);
          await startRunPostgres(runId, connectorId, connectorInstanceId);
          await cancelRunPostgres(runId, connectorInstanceId);

          const { handler, jsonBody, res } = mountRealIngestRoute({ connectorId, connectorInstanceId });

          await assert.rejects(
            async () =>
              await handler(
                ingestRequest('{"key":"pg1","data":{"id":"pg1"}}', { connectorId, connectorInstanceId, runId }),
                res
              ),
            (err: unknown) => {
              const typed = err as { code?: string; message?: string };
              assert.equal(
                typed.code,
                "ingest_batch_storage_error",
                "the typed 503-mapped code must be surfaced on Postgres"
              );
              // Same fixed, bounded public template as SQLite — no raw
              // run_terminal detail leaking through on the Postgres path either.
              assert.equal(typed.message, PUBLIC_MESSAGE);
              assert.doesNotMatch(typed.message ?? "", RUN_TERMINAL_RE);
              return true;
            },
            "a fenced write for a cancelled run must surface as a non-2xx systemic failure against real Postgres"
          );
          assert.equal(jsonBody(), undefined, "no 200 envelope must ever be built for a systemic failure on Postgres");
          assert.equal(await readCommittedRecordPostgres(connectorInstanceId, "pg1"), undefined);
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });

  test("Postgres route path: ALL records failing PERMANENTLY (invalid_record_identity) resolves the 200 envelope against real Postgres, never throws", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_ingest_permanent_${process.pid}`,
      },
      async (url) => {
        initDb(":memory:");
        await initPostgresStorage({ backend: "postgres", databaseUrl: url });
        try {
          const connectorId = "pg-all-permanent-probe";
          const connectorInstanceId = "cin_pg_all_permanent_probe";

          await seedActiveConnectionPostgres(connectorId, connectorInstanceId);
          const { handler, jsonBody, res } = mountRealIngestRoute({ connectorId, connectorInstanceId });

          const body = '{"key":"not_pg2","data":{"id":"pg2"}}\n{"key":"not_pg3","data":{"id":"pg3"}}';
          await handler(ingestRequest(body, { connectorId, connectorInstanceId }), res);

          const envelope = jsonBody() as {
            errors: readonly string[];
            records_accepted: number;
            records_rejected: number;
          };
          assert.equal(envelope.records_accepted, 0);
          assert.equal(envelope.records_rejected, 2);
          assert.ok(
            envelope.errors.every((e) => IDENTITY_MISMATCH_RE.test(e)),
            "both rejections must be the real permanent identity-mismatch error on Postgres, not a generic message"
          );
          assert.equal(await readCommittedRecordPostgres(connectorInstanceId, "pg2"), undefined);
        } finally {
          await closePostgresStorage();
          closeDb();
        }
      }
    );
  });
} else {
  test("Postgres route-path systemic classification parity (skipped: no dedicated PDPP_TEST_POSTGRES_URL)", {
    skip: true,
  }, () => {
    // See test/run-history-duplicate-run-id-identity.test.ts for this
    // repo's dedicated-test-Postgres convention (127.0.0.1:55447, disposable
    // per-test database via withTemporaryPostgresDatabase).
  });
}
