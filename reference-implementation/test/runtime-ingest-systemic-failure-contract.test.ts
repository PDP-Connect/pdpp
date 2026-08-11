// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Runtime-level proof for the ingest-rejection contract revision, driving the
// REAL runtime (`runConnector`) against a REAL resource server end to end —
// no mocks of classification, storage, or the HTTP route. Complements the
// server-side proof in rs-ingest-systemic-failure-contract.test.ts (which
// exercises the route/classifier directly) by proving the runtime's own
// `flushBatch`/cursor-commit sequencing correctly reacts to the server's
// non-2xx systemic-failure response: the run fails terminally, no cursor
// commits past the failure, and a subsequent retry (a fresh run re-emitting
// the same records) is idempotent — no duplicate rows.
//
// The systemic failure is constructed exactly as in
// runtime-cancel-ingest-commit-boundary-probe.test.ts and
// rs-ingest-systemic-failure-contract.test.ts: `runConnector` accepts an
// explicit `runId`; pre-seeding a `run_history` row for that exact
// (run_id, connector_instance_id) pair and marking it cancelled BEFORE
// starting the run means the runtime's own `run.started` write is a
// harmless `ON CONFLICT DO NOTHING` no-op (the row already exists), and the
// runtime's first ingest flush hits the real, unmocked
// `assertSqliteRunStillAdmitted` fence in server/records.ts — a genuine
// `RecordIngestRunTerminalError` (code "run_terminal"), not a fabricated
// error. connector-instance-write-coordinator.ts is never imported or
// touched.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyRuntimeFailure } from "../runtime/classify-runtime-failure.ts";
import { loadSyncState, runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";
import { writeSqliteRunHistoryForSpineEvent } from "../server/stores/run-history-writer.ts";

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ body: unknown; status: number }> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

interface ClosableServer {
  asServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
  rsServer: { close: (cb: () => void) => void; closeAllConnections?: () => void };
}

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: { close: (cb: () => void) => void }) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function streamSchema() {
  return {
    properties: { id: { type: "string" }, value: { type: "string" } },
    required: ["id"],
    type: "object",
  };
}

function manifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Runtime Systemic Failure Contract Test Connector",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" }],
    version: "1.0.0",
  };
}

function createTestConnector(messages: Record<string, unknown>[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-systemic-connector-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    const done = [...messages].reverse().find((m) => m.type === 'DONE') || null;
    const exitCode = !done ? 0 : (done.status === 'succeeded' ? 0 : 1);
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(exitCode);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

async function registerManifest(asUrl: string, connectorManifest: Record<string, unknown>): Promise<void> {
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(connectorManifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

interface DeviceAuthorizationBody {
  device_code: string;
  user_code: string;
}

interface TokenBody {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const device = body as DeviceAuthorizationBody;
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return (tokenBody as TokenBody).access_token;
}

const nowIso = () => new Date().toISOString();

const SYSTEMIC_FAILURE_RE = /already terminal|ingest_batch_storage_error|systemic\/retryable/;
const RECEIPT_REQUIRED_RE = /ingest response|records_attempted|rejection|receipt/i;
const INGEST_FAILED_RE = /Ingest failed for items/;

function validRecord(id: string) {
  return { data: { id, value: "ok" }, emitted_at: nowIso(), key: id, stream: "items", type: "RECORD" };
}

function sqliteRunHistoryFacts(runId: string): Record<string, unknown> {
  const row = getDb().prepare("SELECT facts_json FROM run_history WHERE run_id = ?").get(runId) as
    | { facts_json: string | null }
    | undefined;
  assert.ok(row, `expected run_history row for ${runId}`);
  return JSON.parse(row.facts_json ?? "{}") as Record<string, unknown>;
}

function urlFromFetchInput(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function withStubbedIngestResponse(responseForBody: (body: string) => Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input, init) => {
    const url = urlFromFetchInput(input);
    if (url.pathname === "/v1/ingest/items") {
      return Promise.resolve(responseForBody(String(init?.body ?? "")));
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("runtime accounting: all permanently rejected records are not reported as flushed or accepted", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "runtime-rejection-accounting-all";
  const runId = "run_rejection_accounting_all";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);
  const progress: unknown[] = [];
  const restoreFetch = withStubbedIngestResponse((body) => {
    assert.equal(body.split("\n").filter(Boolean).length, 2, "test setup submits two non-empty lines");
    return new Response(
      JSON.stringify({
        records_accepted: 0,
        records_attempted: 2,
        records_rejected: 2,
        rejections: [
          { code: "invalid_record_identity", input_index: 0, receipt_id: "rr_all_0" },
          { code: "invalid_record_identity", input_index: 1, receipt_id: "rr_all_1" },
        ],
      }),
      { headers: { "Content-Type": "application/json" }, status: 200 }
    );
  });
  const { connectorPath, cleanup } = createTestConnector([
    validRecord("rej1"),
    validRecord("rej2"),
    { cursor: { cursor: "all_rejected_committed" }, stream: "items", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ]);

  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: manifest(connectorId),
      onInteraction: async () => ({}),
      onProgress: (message) => progress.push(message),
      ownerToken,
      persistState: true,
      rsUrl,
      runId,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });

    assert.equal(result.status, "succeeded");
    assert.equal(result.records_emitted, 2);
    assert.equal(result.records_attempted, 2);
    assert.equal(result.records_accepted, 0);
    assert.equal(result.records_permanently_rejected, 2);
    assert.equal(result.records_unresolved_retryable, 0);
    assert.equal(result.checkpoint_summary?.records_flushed, 0, "legacy flushed means confirmed accepted only");
    assert.equal(result.checkpoint_summary?.records_attempted, 2);
    assert.equal(result.checkpoint_summary?.records_permanently_rejected, 2);

    const ingestProgress = progress.find(
      (message) => (message as { type?: string; stream?: string }).type === "ingest"
    ) as Record<string, unknown> | undefined;
    assert.equal(ingestProgress?.records_attempted, 2);
    assert.equal(ingestProgress?.records_accepted, 0);
    assert.equal(ingestProgress?.records_permanently_rejected, 2);
    assert.equal(ingestProgress?.total_records_flushed, 0);

    const facts = sqliteRunHistoryFacts(runId);
    assert.equal(facts.records_attempted, 2);
    assert.equal(facts.records_accepted, 0);
    assert.equal(facts.records_permanently_rejected, 2);
    assert.equal(facts.records_unresolved_retryable, 0);
    assert.equal(facts.records_flushed, 0);

    const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.equal(state?.items?.cursor, "all_rejected_committed", "complete receipts allow cursor commit");
  } finally {
    restoreFetch();
    cleanup();
    await closeServer(server);
  }
});

test("runtime accounting: failed ingest attempts stay unresolved and do not commit cursor state", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "runtime-rejection-accounting-unresolved";
  const runId = "run_rejection_accounting_unresolved";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);
  const progress: unknown[] = [];
  const restoreFetch = withStubbedIngestResponse(
    () =>
      new Response(JSON.stringify({ error: "simulated retryable failure" }), {
        headers: { "Content-Type": "application/json" },
        status: 503,
      })
  );
  const { connectorPath, cleanup } = createTestConnector([
    validRecord("unresolved1"),
    validRecord("unresolved2"),
    { cursor: { cursor: "must_not_commit" }, stream: "items", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ]);

  try {
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId,
          connectorPath,
          manifest: manifest(connectorId),
          onInteraction: async () => ({}),
          onProgress: (message) => progress.push(message),
          ownerToken,
          persistState: true,
          rsUrl,
          runId,
          scope: { streams: [{ name: "items" }] },
          state: null,
        }),
      (err: unknown) => {
        const typed = err as {
          checkpoint_summary?: Record<string, unknown>;
          message?: string;
          records_emitted?: number;
        };
        assert.match(typed.message ?? "", INGEST_FAILED_RE);
        assert.equal(typed.checkpoint_summary?.records_attempted, 2);
        assert.equal(typed.checkpoint_summary?.records_accepted, 0);
        assert.equal(typed.checkpoint_summary?.records_permanently_rejected, 0);
        assert.equal(typed.checkpoint_summary?.records_unresolved_retryable, 2);
        assert.equal(typed.checkpoint_summary?.records_flushed, 0);
        return true;
      }
    );

    const doneProgress = progress.findLast?.((message) => (message as { type?: string }).type === "done") as
      | Record<string, unknown>
      | undefined;
    assert.equal(doneProgress?.records_attempted, 2);
    assert.equal(doneProgress?.records_unresolved_retryable, 2);

    const facts = sqliteRunHistoryFacts(runId);
    assert.equal(facts.records_attempted, 2);
    assert.equal(facts.records_accepted, 0);
    assert.equal(facts.records_permanently_rejected, 0);
    assert.equal(facts.records_unresolved_retryable, 2);
    assert.equal(facts.records_flushed, 0);

    const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.ok(state?.items?.cursor !== "must_not_commit", "unresolved ingest attempts must block cursor commit");
  } finally {
    restoreFetch();
    cleanup();
    await closeServer(server);
  }
});

test("runtime-level: a systemic failure (run_terminal) fails the run terminally and commits NO cursor", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "runtime-systemic-no-commit";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);

  // Resolve the real connector_instance_id this connector will use, so a
  // run_history row can be pre-seeded against the EXACT (run_id,
  // connector_instance_id) pair the runtime is about to write.
  const { connectorInstanceId } = await admitOwnerRunConnection({
    connectorId,
    connectorInstanceId: null,
    connectorInstanceStore: createRequestConnectorInstanceStore(),
    ownerSubjectId: "owner_local",
  });
  const runId = "run_systemic_no_commit_probe";

  // Pre-seed run.started THEN run.cancelled for this exact run_id. The
  // runtime's own run.started write below is `ON CONFLICT DO NOTHING` —
  // harmless against an existing row — so the run's status stays cancelled
  // straight through the runtime's first ingest attempt.
  writeSqliteRunHistoryForSpineEvent({
    connectorId,
    connectorInstanceId,
    data: {},
    eventType: "run.started",
    occurredAt: nowIso(),
    runId,
    status: "started",
  });
  writeSqliteRunHistoryForSpineEvent({
    connectorId,
    connectorInstanceId,
    data: { reason: "owner_cancelled" },
    eventType: "run.cancelled",
    occurredAt: nowIso(),
    runId,
    status: "cancelled",
  });

  const { connectorPath, cleanup } = createTestConnector([
    validRecord("nc1"),
    { cursor: { cursor: "should_not_commit" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId,
          connectorInstanceId,
          connectorPath,
          manifest: manifest(connectorId),
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          runId,
          scope: { streams: [{ name: "items" }] },
          state: null,
        }),
      (err: unknown) => {
        const typed = err as { message?: string };
        assert.match(typed.message ?? "", SYSTEMIC_FAILURE_RE);
        return true;
      },
      "a run whose run_id is already cancelled must fail terminally on its first ingest attempt"
    );

    const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.ok(
      state?.items?.cursor !== "should_not_commit",
      "the cursor staged after a systemically-fenced write must NOT be committed"
    );

    const { body: itemsBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const itemsRecords = (itemsBody as { data?: unknown[]; records?: unknown[] }).data || [];
    assert.equal(itemsRecords.length, 0, "no record should have landed from the fenced write");
  } finally {
    cleanup();
    await closeServer(server);
  }
});

test("runtime-level: accepted-prefix idempotent retry — resubmitting the same records after a prior run produces exactly one row per id, no duplicates", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "runtime-idempotent-retry";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);

  // Both runs resolve to the SAME default connector_instance_id for this
  // (connectorId, ownerSubjectId) pair via fakeAdmitRunConnection's
  // connectorInstanceId: null default-account resolution — the same pattern
  // runtime-ingest-manifest-drift.test.ts relies on, so no explicit instance
  // id needs to be threaded between the two runConnector calls.
  const attempt1 = createTestConnector([
    validRecord("ir1"),
    validRecord("ir2"),
    { cursor: { cursor: "first_attempt" }, stream: "items", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ]);
  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath: attempt1.connectorPath,
      manifest: manifest(connectorId),
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");
  } finally {
    attempt1.cleanup();
  }

  // Retry: the scheduler resubmits the exact same logical records (e.g. after
  // an earlier systemic failure elsewhere in the pipeline forced a re-run).
  // Durable ingest is per-record upsert-by-key, so this must land exactly
  // once per id, never accumulate duplicate rows.
  const attempt2 = createTestConnector([
    validRecord("ir1"),
    validRecord("ir2"),
    { cursor: { cursor: "retry_attempt" }, stream: "items", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ]);
  try {
    const result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath: attempt2.connectorPath,
      manifest: manifest(connectorId),
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl,
      scope: { streams: [{ name: "items" }] },
      state: null,
    });
    assert.equal(result.status, "succeeded");

    const { body: itemsBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const itemsRecords = (itemsBody as { data?: unknown[]; records?: unknown[] }).data || [];
    const ids = itemsRecords.map((r) => (r as { id?: unknown }).id).sort();
    assert.deepEqual(ids, ["ir1", "ir2"], "exactly one row per id after the retry — no duplicates");
  } finally {
    attempt2.cleanup();
    await closeServer(server);
  }
});

// Counterweight for the legacy `{ record: { key, data, emitted_at } }`
// nesting bug fixed in detail-coverage-shortfall-severity.test.ts and
// cli.test.ts: a malformed RECORD envelope is a CONNECTOR PROTOCOL
// VIOLATION, rejected by runtime/record-message-validator.ts at the message
// boundary — before storage. Before that validator existed, this exact
// shape reached the durable write with key/data undefined, failed as an
// unclassified `NOT NULL constraint failed` error, and classifyIngestFailure
// defaulted it to systemic/retryable (the SAME ingest_batch_storage_error/
// 503 contract asserted above for a genuine storage failure) — wrong, since
// the identical envelope fails identically on every retry. Field-shape
// coverage lives in record-message-validator.test.ts; this proves the
// end-to-end wiring: correct classification AND no durable effect.
test("runtime-level: a malformed RECORD is a protocol violation, rejected before any durable write or checkpoint commit", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "runtime-malformed-record-no-write";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);

  const { connectorPath, cleanup } = createTestConnector([
    // The exact legacy bug shape: key/data/emitted_at nested under `record`
    // instead of top-level.
    {
      record: { data: { id: "malformed1", value: "should not land" }, emitted_at: nowIso(), key: "malformed1" },
      stream: "items",
      type: "RECORD",
    },
    { cursor: { cursor: "malformed_cursor" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  try {
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId,
          connectorPath,
          manifest: manifest(connectorId),
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          scope: { streams: [{ name: "items" }] },
          state: null,
        }),
      (err: unknown) => {
        assert.equal(
          classifyRuntimeFailure(err),
          "connector_protocol_violation",
          "a malformed RECORD envelope must classify as a protocol violation, not a retryable storage failure"
        );
        return true;
      }
    );

    const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.ok(
      state?.items?.cursor !== "malformed_cursor",
      "the cursor staged after a rejected RECORD envelope must NOT be committed"
    );

    const { body: itemsBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const itemsRecords = (itemsBody as { data?: unknown[]; records?: unknown[] }).data || [];
    assert.equal(itemsRecords.length, 0, "the malformed record must never land in durable storage");
  } finally {
    cleanup();
    await closeServer(server);
  }
});

test("runtime-level: a count-only permanent rejection cannot advance the cursor without receipt evidence", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  const connectorId = "runtime-permanent-rejection-receipt-required";
  await registerManifest(asUrl, manifest(connectorId));
  const ownerToken = await issueOwnerToken(asUrl);

  const { connectorPath, cleanup } = createTestConnector([
    {
      data: { id: "canonical-id", value: "must remain recoverable" },
      emitted_at: nowIso(),
      key: "mismatched-wire-key",
      stream: "items",
      type: "RECORD",
    },
    { cursor: { cursor: "must_not_commit_without_receipt" }, stream: "items", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);

  // Preserve the real route, classifier, and SQLite write path. Only remove
  // the additive receipt proof from its successful response, exactly as an
  // older resource server would respond. A new runtime must fail closed on
  // this count-only 2xx instead of treating `records_rejected` as permission
  // to clear the batch and stage the following STATE.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await realFetch(input, init);
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.pathname !== "/v1/ingest/items" || !response.ok) {
      return response;
    }
    const body = (await response.json()) as {
      errors?: unknown;
      records_accepted?: unknown;
      records_rejected?: unknown;
      stream?: unknown;
    };
    return new Response(
      JSON.stringify({
        errors: body.errors,
        records_accepted: body.records_accepted,
        records_rejected: body.records_rejected,
        stream: body.stream,
      }),
      { headers: { "Content-Type": "application/json" }, status: response.status }
    );
  };

  try {
    await assert.rejects(
      () =>
        runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "full_refresh",
          connectorId,
          connectorPath,
          manifest: manifest(connectorId),
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          scope: { streams: [{ name: "items" }] },
          state: null,
        }),
      RECEIPT_REQUIRED_RE
    );

    const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
      string,
      { cursor?: string } | undefined
    > | null;
    assert.ok(
      state?.items?.cursor !== "must_not_commit_without_receipt",
      "count-only rejection evidence must not authorize the following cursor"
    );

    const { body: itemsBody } = await fetchJson(
      `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    const itemsRecords = (itemsBody as { data?: unknown[] }).data || [];
    assert.equal(itemsRecords.length, 0, "the permanently rejected record must not appear as accepted data");
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
    await closeServer(server);
  }
});
