// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression coverage for the silent whole-batch-rejection defect proven live
// on GroupMe run `run_1786339135735_1`: four consecutive `run.batch_ingested`
// events with `batch_size=500, records_accepted=0, records_rejected=500,
// status="succeeded"`. `flushBatch` (runtime/index.ts) trusted any HTTP-2xx,
// structurally-valid ingest response as proof of durable acceptance — it
// never compared `records_rejected` against the batch size, always emitted
// `run.batch_ingested{status:"succeeded"}`, and always cleared the buffer.
// A stream whose ENTIRE batch was rejected therefore still had its cursor
// committed later (via `handleStateMessage`'s `await flushBatch(...)` falling
// through to `newState[stream] = cursor`), silently dropping every record in
// that batch with no retry and no terminal signal.
//
// This suite drives the REAL runtime against a REAL resource server — no
// mocks of the ingest path — using the same real per-record identity
// validator (`assertRecordIdentity` in server/record-expand-helpers.ts) the
// production write path already enforces: a record whose `key` disagrees
// with its own declared primary-key field in `data` is a genuine,
// non-fabricated per-record rejection (`invalid_record_identity`). Sending an
// entire batch of such records reproduces a real whole-batch rejection
// without touching connector-instance-write-coordinator.ts or any storage
// internals.
//
// Coverage:
//   1. FIXED — whole-batch rejection (all records rejected) is never treated
//      as success: the run fails terminally, `run.batch_ingested` is never
//      emitted with status "succeeded" for that batch, and the stream's
//      cursor is NOT committed.
//   2. Partial rejection (some records rejected, some accepted) is still the
//      legitimate per-record isolation contract: the run succeeds, the
//      accepted records land, the cursor commits, and the rejected count is
//      reported honestly.
//   3. No duplicate records on retry: resubmitting the same (now-corrected)
//      batch that previously failed whole-batch does not create duplicate
//      rows — ingest is idempotent per primary_key/upsert semantics.
//   4. Retry classification: the thrown error carries a stable
//      `failure_reason`/`ingest_failure` shape distinguishing this case from
//      the existing HTTP-failure and invalid-response-shape failures, so a
//      caller (scheduler) can tell "retry this run" apart from other
//      terminal failure kinds.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadSyncState, runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

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
    display_name: "Batch Rejection Contract Test Connector",
    protocol_version: "0.1.0",
    streams: [{ name: "items", primary_key: ["id"], schema: streamSchema(), semantics: "append_only" }],
    version: "1.0.0",
  };
}

function createTestConnector(messages: Record<string, unknown>[]) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-batch-rejection-connector-"));
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

const WHOLE_BATCH_REJECTED_MESSAGE_RE = /rejected the entire batch \(3\/3 records rejected, 0 accepted\)/;

// A record whose `key` disagrees with its own `data.id` fails the real
// per-record identity check (assertRecordIdentity) with a genuine
// `invalid_record_identity` error — not a fabricated/mocked rejection.
function identityMismatchRecord(id: string) {
  return {
    data: { id, value: "poisoned" },
    emitted_at: nowIso(),
    key: `not_${id}`,
    stream: "items",
    type: "RECORD",
  };
}

function validRecord(id: string) {
  return { data: { id, value: "ok" }, emitted_at: nowIso(), key: id, stream: "items", type: "RECORD" };
}

async function setUp() {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  const rsUrl = `http://localhost:${rsPort}`;
  return { asPort, asUrl, rsPort, rsUrl, server };
}

test("ingest batch-rejection contract", async (t) => {
  await t.test(
    "FIXED: whole-batch rejection (all records rejected) fails the run terminally instead of committing a false-success cursor",
    async () => {
      const { asUrl, rsUrl, server } = await setUp();
      const connectorId = "batch-rejection-all";
      await registerManifest(asUrl, manifest(connectorId));
      const ownerToken = await issueOwnerToken(asUrl);

      const { connectorPath, cleanup } = createTestConnector([
        identityMismatchRecord("a1"),
        identityMismatchRecord("a2"),
        identityMismatchRecord("a3"),
        { cursor: { cursor: "should_not_commit" }, stream: "items", type: "STATE" },
        { records_emitted: 3, status: "succeeded", type: "DONE" },
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
            const typed = err as {
              failure_reason?: string;
              ingest_failure?: { phase?: string; stream?: string };
              message?: string;
              pdpp_error_code?: string;
            };
            assert.equal(typed.failure_reason, "ingest_batch_rejected");
            assert.equal(typed.pdpp_error_code, "ingest_batch_rejected");
            assert.equal(typed.ingest_failure?.phase, "batch_rejected");
            assert.equal(typed.ingest_failure?.stream, "items");
            assert.match(typed.message ?? "", WHOLE_BATCH_REJECTED_MESSAGE_RE);
            return true;
          },
          "a whole-batch rejection must fail the run, not resolve as success"
        );

        // No cursor was committed — the run never reached the success path.
        const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
          string,
          { cursor?: string } | undefined
        > | null;
        assert.ok(state?.items?.cursor !== "should_not_commit", "the poisoned batch's cursor must NOT be committed");

        // No records landed either — the rejected batch was never durably accepted.
        const { body: itemsBody } = await fetchJson(
          `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        const itemsRecords = itemsBody as { data?: unknown[]; records?: unknown[] };
        assert.equal(
          (itemsRecords.data || itemsRecords.records || []).length,
          0,
          "no records should have landed from the wholly rejected batch"
        );
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  );

  await t.test(
    "partial rejection (some records rejected, some accepted) stays the legitimate isolation contract: run succeeds, accepted records land, cursor commits",
    async () => {
      const { asUrl, rsUrl, server } = await setUp();
      const connectorId = "batch-rejection-partial";
      await registerManifest(asUrl, manifest(connectorId));
      const ownerToken = await issueOwnerToken(asUrl);

      const { connectorPath, cleanup } = createTestConnector([
        validRecord("p1"),
        identityMismatchRecord("p2"),
        validRecord("p3"),
        { cursor: { cursor: "partial_committed" }, stream: "items", type: "STATE" },
        { records_emitted: 3, status: "succeeded", type: "DONE" },
      ]);

      try {
        const result = await runConnector({
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
        });

        assert.equal(result.status, "succeeded", "partial per-record rejection must not fail the whole run");

        const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
          string,
          { cursor?: string } | undefined
        > | null;
        assert.equal(state?.items?.cursor, "partial_committed", "the stream cursor should commit for a partial batch");

        const { body: itemsBody } = await fetchJson(
          `${rsUrl}/v1/streams/items/records?connector_id=${encodeURIComponent(connectorId)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        const itemsRecords = (itemsBody as { data?: unknown[]; records?: unknown[] }).data || [];
        const ids = itemsRecords.map((r) => (r as { id?: unknown }).id).sort();
        assert.deepEqual(ids, ["p1", "p3"], "only the two valid records should have landed");
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  );

  await t.test(
    "no duplicate records on retry: resubmitting a corrected batch after a whole-batch-rejection failure does not create duplicates",
    async () => {
      const { asUrl, rsUrl, server } = await setUp();
      const connectorId = "batch-rejection-retry";
      await registerManifest(asUrl, manifest(connectorId));
      const ownerToken = await issueOwnerToken(asUrl);

      // First attempt: entire batch is poisoned, run fails.
      const attempt1 = createTestConnector([
        identityMismatchRecord("r1"),
        identityMismatchRecord("r2"),
        { records_emitted: 2, status: "succeeded", type: "DONE" },
      ]);
      try {
        await assert.rejects(() =>
          runConnector({
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
          })
        );
      } finally {
        attempt1.cleanup();
      }

      // Retry: the scheduler resubmits the SAME logical records, now
      // correctly keyed. Ingest is per-record upsert-by-key, so this must
      // land exactly once per id, not accumulate duplicates from the first
      // (failed, non-durable) attempt.
      const attempt2 = createTestConnector([
        validRecord("r1"),
        validRecord("r2"),
        { cursor: { cursor: "retry_committed" }, stream: "items", type: "STATE" },
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
        assert.deepEqual(
          ids,
          ["r1", "r2"],
          "exactly one row per id after retry — no duplicates from the failed attempt"
        );
      } finally {
        attempt2.cleanup();
        await closeServer(server);
      }
    }
  );

  await t.test(
    "coverage/checkpoint counterweight: a whole-batch rejection withholds the STATE cursor that would have followed it",
    async () => {
      const { asUrl, rsUrl, server } = await setUp();
      const connectorId = "batch-rejection-checkpoint";
      await registerManifest(asUrl, manifest(connectorId));
      const ownerToken = await issueOwnerToken(asUrl);

      // The connector believes it emitted 2 records and advances its cursor
      // accordingly via STATE. Both records are actually rejected. Before
      // the fix, flushBatch (called from handleStateMessage before staging
      // the cursor) would resolve normally and let the cursor commit anyway
      // -- claiming coverage for data that was never durably written.
      const { connectorPath, cleanup } = createTestConnector([
        identityMismatchRecord("c1"),
        identityMismatchRecord("c2"),
        { cursor: { cursor: "false_coverage_claim" }, stream: "items", type: "STATE" },
        { records_emitted: 2, status: "succeeded", type: "DONE" },
      ]);

      try {
        await assert.rejects(() =>
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
          })
        );

        const state = (await loadSyncState(connectorId, ownerToken, { rsUrl })) as Record<
          string,
          { cursor?: string } | undefined
        > | null;
        assert.ok(
          state?.items?.cursor !== "false_coverage_claim",
          "the cursor staged right after the rejected batch must not have committed"
        );
      } finally {
        cleanup();
        await closeServer(server);
      }
    }
  );
});
