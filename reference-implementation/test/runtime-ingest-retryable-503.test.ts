// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Oracle for the connector runtime's bounded ingest retry.
//
// The defect this covers: the RS answers a SYSTEMIC ingest failure with 503
// `ingest_batch_storage_error` — a status its own error-status table documents
// as "safe to retry the identical batch" — and the runtime's `flushBatch` used
// to issue a bare `fetch` that threw on any non-2xx. The 503 killed the run and
// discarded every buffered record. In production that dropped 56,440 buffered
// records across 129 runs.
//
// These tests drive the REAL `runConnector` against a scripted stub RS, so the
// retry decision under test is the runtime's own `postIngestBatchWithRetry`,
// not a mock of it. The stub is deliberately minimal: it answers only the three
// endpoints a run touches (state GET/PUT and the ingest POST) and scripts the
// ingest status sequence per test.
//
// No test here sleeps for real. `ingestRetrySleep` and `ingestRetryRandom` are
// injected, so the retry SEQUENCE (attempt count, per-attempt delay, honored
// `Retry-After`, bounded exhaustion) is asserted deterministically and the whole
// file runs in milliseconds. A test that genuinely slept would be both slow and
// unable to assert the delays it waited through.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { runConnector } from "../runtime/index.ts";
import { closeDb, initDb } from "../server/db.ts";

// `runConnector` writes run/detail-gap rows through the process-global DB
// handle. The stub RS below replaces only the HTTP surface, so an in-memory DB
// still has to be open for the run to reach its ingest flush at all.
before(() => {
  initDb(":memory:");
});

after(() => {
  closeDb();
});

const CONNECTOR_ID = "retry-test";
/** Names the attempt bound the exhaustion message must state. */
const EXHAUSTED_ATTEMPTS_RE = /exhausted 3 attempts/;
/** The server's own error code, which must survive the retry into the message. */
const SERVER_DIAGNOSIS_RE = /ingest_batch_storage_error/;
const OWNER_TOKEN = "owner-token-for-stub";

function streamSchema() {
  return {
    properties: { id: { type: "string" }, value: { type: "string" } },
    required: ["id"],
    type: "object",
  };
}

function manifest() {
  return {
    connector_id: CONNECTOR_ID,
    display_name: "Ingest Retry Test Connector",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" }],
    version: "1.0.0",
  };
}

/** A connector child that emits one record then DONE. */
function createTestConnector() {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-ingest-retry-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const messages = [
    {
      data: { id: "i1", value: "ok" },
      emitted_at: new Date().toISOString(),
      key: "i1",
      stream: "items",
      type: "RECORD",
    },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    for (const m of ${JSON.stringify(messages)}) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    "utf-8"
  );
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

interface ScriptedIngestResponse {
  /** Value for the `Retry-After` response header; omitted when absent. */
  retryAfter?: string;
  status: number;
}

interface StubRs {
  close: () => Promise<void>;
  /** One entry per ingest POST actually received, in order. */
  readonly ingestAttempts: { body: string }[];
  url: string;
}

/**
 * Stub resource server whose /v1/ingest responses are scripted.
 *
 * `script` is consumed one entry per ingest POST; once exhausted, every further
 * POST gets 200. That shape lets a test say "fail twice, then succeed" without
 * counting the total number of flushes the runtime performs.
 */
async function startStubRs(script: ScriptedIngestResponse[]): Promise<StubRs> {
  const ingestAttempts: { body: string }[] = [];
  let scriptIndex = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = req.url ?? "";
      const body = Buffer.concat(chunks).toString("utf-8");

      if (url.startsWith("/v1/ingest/")) {
        ingestAttempts.push({ body });
        const scripted = script[scriptIndex];
        scriptIndex += 1;
        const status = scripted ? scripted.status : 200;
        if (scripted?.retryAfter !== undefined) {
          res.setHeader("Retry-After", scripted.retryAfter);
        }
        if (status === 200) {
          const lines = body.split("\n").filter((l) => l.trim().length > 0);
          res.writeHead(200, { "content-type": "application/json" });
          // Mirror the real hosted RS envelope (server/routes/rs-mutation.ts
          // always sets hostedRejectionReceipts: true), which the runtime's
          // strict readIngestResponse (runtime/ingest-failure.ts) requires:
          // records_attempted present and equal to the batch size, plus an
          // index-exact rejections vector even when empty.
          res.end(
            JSON.stringify({
              errors: [],
              records_accepted: lines.length,
              records_attempted: lines.length,
              records_rejected: 0,
              rejections: [],
            })
          );
          return;
        }
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { code: status >= 500 ? "ingest_batch_storage_error" : "invalid_record", message: "scripted" },
          })
        );
        return;
      }

      // Connector sync state: empty on read, accepted on write.
      if (url.startsWith("/v1/state/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.method === "GET" ? { state: {} } : { ok: true }));
        return;
      }

      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "stub" } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
    ingestAttempts,
    url: `http://127.0.0.1:${port}`,
  };
}

interface RunOutcome {
  ingestAttempts: number;
  result: Awaited<ReturnType<typeof runConnector>> | null;
  /** Every delay passed to the injected sleep, in order. */
  sleeps: number[];
  thrown: unknown;
}

/**
 * Drive one real run against a scripted stub RS with injected clock + jitter.
 *
 * `random` is pinned to 0.5, making the jitter multiplier exactly 1.0 so the
 * expected backoff is the bare exponential and a test can assert exact numbers.
 */
async function runAgainstScript(
  script: ScriptedIngestResponse[],
  overrides: { maxAttempts?: number } = {}
): Promise<RunOutcome> {
  const rs = await startStubRs(script);
  const { cleanup, connectorPath } = createTestConnector();
  const sleeps: number[] = [];
  let result: Awaited<ReturnType<typeof runConnector>> | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnector({
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? `${connectorId}:default`,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      collectionMode: "full_refresh",
      connectorId: CONNECTOR_ID,
      connectorPath,
      ingestRetryPolicy: {
        baseDelayMs: 100,
        maxAttempts: overrides.maxAttempts ?? 4,
        maxDelayMs: 8000,
        maxRetryAfterMs: 15_000,
      },
      ingestRetryRandom: () => 0.5,
      // Records the delay the runtime WOULD have waited, then resolves
      // immediately — the whole point of the seam.
      ingestRetrySleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      manifest: manifest(),
      onInteraction: async () => ({}),
      ownerToken: OWNER_TOKEN,
      persistState: false,
      rsUrl: rs.url,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
    await rs.close();
  }
  return { ingestAttempts: rs.ingestAttempts.length, result, sleeps, thrown };
}

function failureOf(outcome: RunOutcome): { failure_reason?: string; message?: string } {
  if (outcome.thrown instanceof Error) {
    return outcome.thrown as { failure_reason?: string; message?: string };
  }
  const result = outcome.result as { error?: { failure_reason?: string; message?: string } } | null;
  return result?.error ?? {};
}

// ─── (a) 503 WITH Retry-After → retried, then succeeds ──────────────────────

test("a 503 carrying Retry-After is retried after the server-instructed delay, then succeeds", async () => {
  const outcome = await runAgainstScript([{ retryAfter: "2", status: 503 }]);

  assert.equal(outcome.thrown, null, "run must not throw when the retry succeeds");
  assert.equal(outcome.result?.status, "succeeded", "run should succeed once the retried batch is accepted");
  assert.equal(outcome.ingestAttempts, 2, "the identical batch should be POSTed exactly twice");
  assert.deepEqual(
    outcome.sleeps,
    [2000],
    "the server's Retry-After (2s) must be honored verbatim, NOT replaced by the 100ms computed backoff"
  );
});

// ─── (b) 503 WITHOUT Retry-After → computed backoff, then succeeds ──────────

test("a 503 with no Retry-After falls back to jittered exponential backoff, then succeeds", async () => {
  const outcome = await runAgainstScript([{ status: 503 }, { status: 503 }]);

  assert.equal(outcome.thrown, null, "run must not throw when the retry succeeds");
  assert.equal(outcome.result?.status, "succeeded", "run should succeed once the retried batch is accepted");
  assert.equal(outcome.ingestAttempts, 3, "two failures then a success is three POSTs");
  // random pinned to 0.5 → jitter multiplier 1.0 → bare exponential off a
  // 100ms base: 100 * 2^0, then 100 * 2^1.
  assert.deepEqual(outcome.sleeps, [100, 200], "backoff must grow exponentially between attempts");
});

// ─── (c) persistent 503 → bounded, honest saturation error, no hang ─────────

test("a persistently saturated ingest endpoint fails with a bounded, honest saturation error", async () => {
  const persistent503 = Array.from({ length: 20 }, () => ({ status: 503 }));
  const outcome = await runAgainstScript(persistent503, { maxAttempts: 3 });

  assert.equal(outcome.ingestAttempts, 3, "attempts must be bounded by maxAttempts, not unbounded");
  assert.equal(outcome.sleeps.length, 2, "maxAttempts attempts means maxAttempts-1 sleeps — a finite total wait");

  const failure = failureOf(outcome);
  assert.equal(
    failure.failure_reason,
    "ingest_endpoint_saturated",
    "exhaustion must name the saturation, distinct from a genuine terminal ingest rejection"
  );
  assert.match(
    String(failure.message ?? ""),
    EXHAUSTED_ATTEMPTS_RE,
    "the message should state the attempt bound it exhausted"
  );
  assert.notEqual(failure.failure_reason, "ingest_http_error", "must not be reported as a plain ingest HTTP error");
  // The saturation framing must ADD to the server's diagnosis, not replace it.
  // Retrying consumes each response body, so without deliberately carrying the
  // last one forward an operator would be told the endpoint was saturated but
  // never told why — losing `ingest_batch_storage_error` / `run_terminal` /
  // `connector_instance_busy`, which is the actionable half of the report.
  assert.match(
    String(failure.message ?? ""),
    SERVER_DIAGNOSIS_RE,
    "the server's own error code from the final response must survive into the terminal message"
  );
});

// ─── (d) 4xx stays fatal, with NO retry ─────────────────────────────────────

test("a 4xx content rejection stays fatal on the first response and is never retried", async () => {
  const outcome = await runAgainstScript([{ status: 400 }, { status: 400 }, { status: 400 }, { status: 400 }]);

  assert.equal(outcome.ingestAttempts, 1, "a 4xx must NOT be retried: replaying identical content only re-rejects");
  assert.deepEqual(outcome.sleeps, [], "no backoff may be spent on a non-retryable status");

  const failure = failureOf(outcome);
  assert.notEqual(
    failure.failure_reason,
    "ingest_endpoint_saturated",
    "a content rejection must not be reported as endpoint saturation"
  );
  assert.notEqual(outcome.result?.status, "succeeded", "a 4xx must remain a terminal failure");
});

test("a 401 credential failure is likewise fatal without retry", async () => {
  const outcome = await runAgainstScript([{ status: 401 }, { status: 401 }]);

  assert.equal(outcome.ingestAttempts, 1, "waiting cannot repair a credential fault, so it must not be retried");
  assert.deepEqual(outcome.sleeps, []);
  assert.notEqual(outcome.result?.status, "succeeded");
});

// ─── (e) a first-attempt success is completely unchanged ────────────────────

test("a successful first attempt adds no extra request and no added latency", async () => {
  const outcome = await runAgainstScript([]);

  assert.equal(outcome.thrown, null);
  assert.equal(outcome.result?.status, "succeeded");
  assert.equal(outcome.ingestAttempts, 1, "the happy path must still be exactly one POST");
  assert.deepEqual(outcome.sleeps, [], "the happy path must not sleep at all");
});

// ─── Idempotency: the retried batch is byte-identical ───────────────────────
//
// Retry-safety rests on the storage layer's upsert on
// (connector_instance_id, stream, record_key). That guarantee only applies if
// the client re-sends the SAME records rather than a re-derived or partial
// batch, so this asserts the payload identity the upsert argument depends on.

test("a retried batch is byte-identical to the attempt it replaces", async () => {
  const rs = await startStubRs([{ status: 503 }]);
  const { cleanup, connectorPath } = createTestConnector();
  try {
    await runConnector({
      admitRunConnection: async ({ connectorId, connectorInstanceId, ownerSubjectId }) => ({
        connectorId,
        connectorInstanceId: connectorInstanceId ?? `${connectorId}:default`,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      collectionMode: "full_refresh",
      connectorId: CONNECTOR_ID,
      connectorPath,
      ingestRetryRandom: () => 0.5,
      // Resolve instantly: this test asserts payload identity, not timing.
      ingestRetrySleep: () => Promise.resolve(),
      manifest: manifest(),
      onInteraction: async () => ({}),
      ownerToken: OWNER_TOKEN,
      persistState: false,
      rsUrl: rs.url,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(rs.ingestAttempts.length, 2, "expected one failed attempt and one retry");
    assert.equal(
      rs.ingestAttempts[0]?.body,
      rs.ingestAttempts[1]?.body,
      "the retry must re-POST the identical NDJSON, which is what makes the server-side upsert dedupe it"
    );
  } finally {
    cleanup();
    await rs.close();
  }
});
