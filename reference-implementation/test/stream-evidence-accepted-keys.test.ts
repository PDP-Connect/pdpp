// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * STREAM_EVIDENCE.outcomes.emitted must equal the run's own DISTINCT count of
 * durably-accepted (stream, key) tuples for that stream — an exact intra-run
 * duplicate-key and rejected-write closure the plain `covered <= considered`
 * bound could not provide (see local/STREAM-EVIDENCE-TERMINAL-DESIGN-REVIEW.md
 * §10.1(b)/(c)). This file covers the cases
 * test/stream-evidence.test.ts and test/stream-evidence-flush-ordering.test.ts
 * do not: intra-run duplicate keys (scalar and compound), permanently-rejected
 * writes, an all-unchanged steady-state run, a mixed emitted+unchanged run, a
 * transient-manifest-drift-skipped stream, a genuinely forced 503-then-success
 * retry (byte-identical re-POST, counted once), STREAM_EVIDENCE's per-stream
 * terminal-fact enforcement (a late RECORD or DETAIL_GAP for an
 * already-evidenced stream is rejected), and temp-store cleanup on every
 * terminal path including owner cancellation.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { initDb } from "../server/db.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import {
  admitOwnerRunConnection,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

/**
 * The two stub-RS retry tests below drive `runConnector` against a bare
 * `node:http` stub with no real resource server or `startServer()` behind
 * it, so — unlike every other test in this file, which gets a DB via
 * `setupServer()`'s `startServer()` call — they have no DB of their own.
 * `runConnector` still touches the process-global DB handle (e.g.
 * `reclaimStrandedInProgressGaps`), so running this file's stub-RS tests in
 * isolation (not after an earlier `setupServer()`-based test already opened
 * one) throws "No database is open." `initDb` detaches rather than closes
 * a prior handle (server/db.ts), so calling it again here is always safe
 * and does not interfere with this file's other, `setupServer()`-backed
 * tests' own DB usage.
 */
function ensureDbOpenForStubRsTests(): void {
  initDb(":memory:");
}

interface ClosableServer {
  abortStartupBackfill: (reason: string) => void;
  asPort: number;
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  schedulerManager?: { stop: () => void };
  startupBackfillDone: Promise<unknown>;
  startupSummaryEvidenceSweepDone: Promise<unknown>;
  stopBrowserSurfaceLeaseSweep: () => void;
  stopClientEventDeliveryWorker: () => Promise<void>;
}

interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}

const typedStartServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const c = (srv: { close: (cb: (err?: Error) => void) => void }) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, 2000);
      srv.close(() => {
        clearTimeout(t);
        r();
      });
    });
  await Promise.allSettled([
    c(server.asServer),
    c(server.rsServer),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "test_user"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return body.access_token;
}

function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "test_user"
): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || ownerSubjectIdDefault;
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

/** Gmail-shaped: `messages` (self-mapped) with `message_bodies` a state_stream child. */
function manifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "messages",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        coverage_strategy: "checkpoint_window",
        name: "message_bodies",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "append_only",
        state_stream: "messages",
      },
    ],
    version: "0.1.0",
  };
}

/**
 * Same shape as `manifest()`, but `message_bodies` declares a two-field
 * compound `primary_key` — the shape `RECORD.key` arrives as an array for
 * (spec-core.md: "Array for compound keys; order matches the
 * SourceDeclaration `primary_key`"), rather than the scalar single-field
 * key every other test in this file uses.
 */
function compoundKeyManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "messages",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        coverage_strategy: "checkpoint_window",
        name: "message_bodies",
        primary_key: ["part_a", "part_b"],
        schema: {
          properties: { part_a: { type: "string" }, part_b: { type: "string" } },
          required: ["part_a", "part_b"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "append_only",
        state_stream: "messages",
      },
    ],
    version: "0.1.0",
  };
}

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

interface RuntimeRejectionError extends Error {
  failure_reason?: string;
}

function writeConnectorStub(tmpDir: string, script: string): string {
  const connectorPath = join(tmpDir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  ${script}
});
`,
    "utf8"
  );
  return connectorPath;
}

interface TestServerHandle {
  asUrl: string;
  ownerToken: string;
  rsUrl: string;
  server: ClosableServer;
}

async function setupServer(): Promise<TestServerHandle> {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const ownerToken = await issueOwnerToken(asUrl);
  return { asUrl, ownerToken, rsUrl, server };
}

async function registerManifest(
  asUrl: string,
  m: ReturnType<typeof manifest> | ReturnType<typeof compoundKeyManifest>
): Promise<void> {
  const resp = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(m),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
}

const EMITTED_MISMATCH_PATTERN = /outcomes\.emitted.*does not equal this run's distinct durably-accepted record count/i;
const GAPPED_MISMATCH_PATTERN = /outcomes\.gapped.*does not equal this run's distinct durable DETAIL_GAP count/i;
const LATE_RECORD_AFTER_EVIDENCE_PATTERN =
  /RECORD for stream 'message_bodies' after already reporting STREAM_EVIDENCE/i;
const LATE_GAP_AFTER_EVIDENCE_PATTERN =
  /DETAIL_GAP for stream 'message_bodies' after already reporting STREAM_EVIDENCE/i;

/**
 * `createAcceptedKeysStore` (runtime/index.ts) calls `os.tmpdir()` inside
 * THIS process (the runtime side of `runConnector`, not the spawned
 * connector child) — `os.tmpdir()` reads `process.env.TMPDIR` live, so
 * scoping it to a private-per-test directory for the duration of `fn`
 * isolates this test's temp-store creation/teardown from every other test
 * FILE's runs sharing the real OS tmp root under `node --test`'s file-level
 * concurrency (`scripts/run-tests.ts`'s `fileConcurrency` worker pool).
 * Without this, two files' tests can race a shared `readdirSync(tmpdir())`
 * before/after diff against each other's temp dirs.
 */
async function withPrivateTmpRoot<T>(fn: (tmpRoot: string) => Promise<T>): Promise<T> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-private-tmp-root-"));
  const original = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  try {
    return await fn(tmpRoot);
  } finally {
    if (original === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = original;
    }
    rmSync(tmpRoot, { force: true, recursive: true });
  }
}

test("STREAM_EVIDENCE: intra-run duplicate RECORD keys cannot inflate emitted (fail before / pass after)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-duplicate-keys");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-dup-keys-"));
    // Same key emitted 50x for message_bodies; claiming emitted:50 must fail
    // because the distinct-accepted-key set only ever holds 1 row for it.
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  for (let i = 0; i < 50; i++) {
    process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 50, outcomes: { emitted: 50, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 51 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(rejection, "claiming emitted:50 over 1 distinct durably-accepted key must be rejected");
      assert.match(rejection?.message || "", EMITTED_MISMATCH_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: intra-run duplicate keys claimed honestly (emitted:1) pass", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-duplicate-keys-honest");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-dup-keys-honest-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "an honest emitted:1 over the same key emitted twice into one ingest batch must pass"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a permanently-rejected record cannot be claimed as emitted (fail before / pass after)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-rejected-record");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-rejected-"));
    // m-bad's data.id ("wrong-id") does not match its key ("m-bad") --
    // assertRecordIdentity (server/record-expand-helpers.ts) permanently
    // rejects it at ingest as invalid_record_identity. Only m-good is
    // durably accepted, so claiming emitted:2 must fail.
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-good', data: { id: 'm-good' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-bad', data: { id: 'wrong-id' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 2, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(rejection, "claiming emitted:2 when the RS permanently rejected one record must be rejected");
      assert.match(rejection?.message || "", EMITTED_MISMATCH_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a run that honestly claims only the accepted record (emitted:1) passes despite a sibling rejection", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-rejected-record-honest");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-rejected-honest-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-good', data: { id: 'm-good' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-bad', data: { id: 'wrong-id' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 1 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: an all-unchanged steady-state run (zero RECORD, considered==unchanged) passes and projects complete", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-all-unchanged");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-all-unchanged-"));
    // Zero RECORD messages for message_bodies at all -- the connector
    // enumerated 500 keys, found every one byte-identical to the prior run,
    // and suppressed every write. Per connector-gap-bounding.ts:571 this
    // MUST still classify complete (the case the whole outcomes design
    // exists to keep honest, per STREAM-EVIDENCE-TERMINAL-DESIGN-REVIEW.md
    // §1's regression guard).
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 500, outcomes: { emitted: 0, unchanged: 500, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded", "an honest all-unchanged claim with zero RECORD traffic must pass");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a mixed emitted+unchanged run passes with the exact distinct emitted count", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-mixed");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-mixed-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-b', data: { id: 'm-b' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 5, outcomes: { emitted: 2, unchanged: 3, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a claimed gapped:1 with zero matching durable DETAIL_GAP is rejected", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-gapped-no-durable-gap");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-gapped-fabricated-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 0, unchanged: 0, gapped: 1, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(rejection, "a gapped claim with zero durable DETAIL_GAP for the stream must be rejected");
      assert.match(rejection?.message || "", GAPPED_MISMATCH_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Independent re-review, item 3: gapped reconciliation is exact (equality), not a one-sided ceiling ──

test("STREAM_EVIDENCE: a claimed gapped:1 with TWO real distinct durable DETAIL_GAPs is rejected (under-claim, not just over-claim)", async () => {
  // The exact scenario independent review named: gapped:1 must NOT pass
  // silently when 2 distinct durable gaps actually exist for the stream
  // this run -- an earlier revision of this check used `evidenceGapped >
  // durableGappedForStream` (a one-sided ceiling: 1 > 2 is false, so it
  // passed). The fixed check requires exact equality.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-gapped-under-claim");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-gapped-under-claim-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-a', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-b', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  // Two REAL, distinct durable gaps exist for message_bodies, but the
  // connector under-claims gapped:1 instead of the honest gapped:2.
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 0, unchanged: 0, gapped: 1, unaccounted: 1 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(
        rejection,
        "a gapped:1 claim under-declaring 2 real distinct durable gaps for the stream must be rejected"
      );
      assert.match(rejection?.message || "", GAPPED_MISMATCH_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: an honest gapped:2 matching two real distinct durable DETAIL_GAPs is accepted", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-gapped-honest-two");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-gapped-honest-two-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-a', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-b', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 0, unchanged: 0, gapped: 2, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "an honest gapped:2 exactly matching 2 real distinct durable gaps must be accepted"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: zero/zero verified-empty claim passes and creates no temp store", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-zero-zero");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-zero-zero-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 0, outcomes: { emitted: 0, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      await withPrivateTmpRoot(async (tmpRoot) => {
        const result = (await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        })) as RuntimeRunConnectorResult;
        assert.equal(result.status, "succeeded", "0/0 is a legitimate verified-empty claim, not a violation");
        const tmpAfter = readdirSync(tmpRoot).filter((name) => name.startsWith("pdpp-stream-evidence-accepted-keys-"));
        assert.deepEqual(
          tmpAfter,
          [],
          "a run whose only stream never accepted a record must never create the accepted-keys temp store"
        );
      });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: the accepted-keys temp store is torn down after a succeeded run (cleanup)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-cleanup-success");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-cleanup-success-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      await withPrivateTmpRoot(async (tmpRoot) => {
        const result = (await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        })) as RuntimeRunConnectorResult;
        assert.equal(result.status, "succeeded");
        const tmpAfter = readdirSync(tmpRoot).filter((name) => name.startsWith("pdpp-stream-evidence-accepted-keys-"));
        assert.deepEqual(tmpAfter, [], "the accepted-keys temp directory must be removed after a succeeded run");
      });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: the accepted-keys temp store is torn down after a rejected (protocol-violation) run (cleanup)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-cleanup-failure");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-cleanup-failure-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 99, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      await withPrivateTmpRoot(async (tmpRoot) => {
        let rejection: RuntimeRejectionError | null = null;
        try {
          await runConnector({
            admitRunConnection: fakeAdmitRunConnection(),
            collectionMode: "incremental",
            connectorId: m.connector_id,
            connectorPath,
            manifest: m as unknown as RuntimeManifest,
            onInteraction: async () => ({}),
            ownerToken,
            persistState: true,
            rsUrl,
            state: null,
          });
        } catch (err) {
          rejection = err as RuntimeRejectionError;
        }
        assert.ok(rejection, "the fabricated emitted:99 claim must be rejected");
        const tmpAfter = readdirSync(tmpRoot).filter((name) => name.startsWith("pdpp-stream-evidence-accepted-keys-"));
        assert.deepEqual(
          tmpAfter,
          [],
          "the accepted-keys temp directory must be removed even after a protocol-violation failure"
        );
      });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a transient-manifest-drift-skipped stream's dropped batch cannot be claimed as emitted", async () => {
  // Drift-skip (harden-ingest-against-transient-manifest-drift) fires when the
  // RS rejects an in-scope stream's ingest as not_found because its persisted
  // connectors row is momentarily stale relative to the runtime's own START
  // read. The runtime degrades that to a per-stream gap and drops the batch --
  // simulated here by unregistering message_bodies from the RS's manifest
  // view after START scope was already built, forcing the exact
  // runtime-START-says-yes / RS-ingest-says-not_found split the drift guard
  // exists for.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-drift-skip");
    await registerManifest(asUrl, m);
    const driftedManifest = { ...m, streams: m.streams.filter((stream) => stream.name !== "message_bodies") };
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-drift-skip-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      // Re-register the manifest WITHOUT message_bodies so the RS's ingest-time
      // manifest read 404s that stream, while the runtime's own START scope
      // (already built against the original registration) still believes it
      // is in scope -- the exact drift window `driftSkippedStreams` exists for.
      await registerManifest(asUrl, driftedManifest);
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(
        rejection,
        "a claim of emitted:1 for a stream whose only batch was drift-skipped (dropped, never durable) must be rejected"
      );
      assert.match(rejection?.message || "", EMITTED_MISMATCH_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: two keys split across separate BATCH_SIZE-forced flushes both count exactly once (batching, not retry)", async () => {
  // NOTE: despite this test's original name, an EARLIER revision set
  // PDPP_RUNTIME_BATCH_SIZE=2 for exactly 2 message_bodies records --
  // `streamBatch.length >= BATCH_SIZE` (runtime/index.ts) only flushes once
  // BOTH records have been pushed (2 >= 2), so that was genuinely ONE
  // flush of 2 records, not "two separate flushes," despite what this
  // test's name and this comment both claimed (independent re-review round
  // 3, item 5). Fixed by setting BATCH_SIZE=1: after the first record push
  // (1 >= 1), the batch flushes immediately containing that ONE record,
  // then the second record push triggers a SECOND, separate flush. This
  // test injects no network failure, no 503, and asserts no second POST of
  // the SAME batch -- it is a real batching-boundary test (two keys, two
  // GENUINELY separate one-shot flushes, both durably accepted), not a
  // retry test. Renamed per independent review round 2 (P2: "the purported
  // retry test ... injects no 503/network failure and asserts no second
  // POST"). The actual forced-503-then-success retry proof is the test
  // immediately below this one.
  const originalBatchSize = process.env.PDPP_RUNTIME_BATCH_SIZE;
  process.env.PDPP_RUNTIME_BATCH_SIZE = "1";
  try {
    const { server, asUrl, rsUrl, ownerToken } = await setupServer();
    try {
      const m = manifest("stream-evidence-separate-flushes-no-double-count");
      await registerManifest(asUrl, m);
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-separate-flushes-"));
      const connectorPath = writeConnectorStub(
        tmpDir,
        `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-b', data: { id: 'm-b' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 2, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
      );
      try {
        const result = (await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        })) as RuntimeRunConnectorResult;
        assert.equal(
          result.status,
          "succeeded",
          "two GENUINELY separate BATCH_SIZE=1-forced flushes must each durably accept their one key exactly once"
        );
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    } finally {
      await closeServer(server);
    }
  } finally {
    if (originalBatchSize === undefined) {
      delete process.env.PDPP_RUNTIME_BATCH_SIZE;
    } else {
      process.env.PDPP_RUNTIME_BATCH_SIZE = originalBatchSize;
    }
  }
});

// ── Independent review round 2, item 5: a genuine forced 503-then-success retry ──

interface ScriptedIngestResponse {
  retryAfter?: string;
  status: number;
}

interface StubRs {
  close: () => Promise<void>;
  /** One entry per ingest POST actually received, in order, verbatim body. */
  readonly ingestAttempts: { body: string }[];
  url: string;
}

/**
 * Minimal scripted stub RS, adapted from
 * test/runtime-ingest-retryable-503.test.ts's pattern: answers state GET/PUT
 * unconditionally and scripts the ingest POST's status sequence, recording
 * every attempt's raw body so a test can assert two POSTs are byte-identical
 * -- proving a genuine retry, not merely "the run succeeded."
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
        res.end(JSON.stringify({ error: { code: "ingest_batch_storage_error", message: "scripted" } }));
        return;
      }

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

test("STREAM_EVIDENCE: a batch that gets a forced 503 then succeeds is retried with a byte-identical POST and counted once", async () => {
  ensureDbOpenForStubRsTests();
  const rs = await startStubRs([{ status: 503 }]);
  const connectorId = "stream-evidence-real-503-retry";
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-real-retry-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );
  try {
    const result = (await runConnector({
      admitRunConnection: async ({ connectorId: cid, connectorInstanceId, ownerSubjectId }) => ({
        connectorId: cid,
        connectorInstanceId: connectorInstanceId ?? `${cid}:default`,
        ownerSubjectId: ownerSubjectId ?? "owner_local",
      }),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      ingestRetryPolicy: { baseDelayMs: 1, maxAttempts: 4, maxDelayMs: 10, maxRetryAfterMs: 10 },
      ingestRetryRandom: () => 0.5,
      ingestRetrySleep: () => Promise.resolve(),
      manifest: {
        connector_id: connectorId,
        display_name: "Real 503 Retry Test Connector",
        protocol_version: "0.1.0",
        streams: [
          {
            name: "messages",
            primary_key: ["id"],
            schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
            semantics: "mutable_state",
          },
          {
            coverage_strategy: "checkpoint_window",
            name: "message_bodies",
            primary_key: ["id"],
            schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
            semantics: "append_only",
            state_stream: "messages",
          },
        ],
        version: "1.0.0",
      } as unknown as RuntimeManifest,
      onInteraction: async () => ({}),
      ownerToken: "owner-token-for-stub",
      persistState: false,
      rsUrl: rs.url,
      scope: { streams: [{ name: "messages" }, { name: "message_bodies" }] },
      state: null,
    })) as RuntimeRunConnectorResult;

    assert.equal(result.status, "succeeded", "the run must succeed once the retried batch lands");
    assert.equal(rs.ingestAttempts.length, 2, "exactly one retry: the scripted 503, then a 200");
    assert.equal(
      rs.ingestAttempts[0]?.body,
      rs.ingestAttempts[1]?.body,
      "the retried POST must re-send the byte-identical batch, not a new one"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await rs.close();
  }
});

test("mutation control: a permanently-rejected (non-retryable) 4xx is never retried", async () => {
  // isRetryableIngestStatus (runtime/ingest-retry.ts) retries EXACTLY 408
  // and 503 -- not "5xx" generally and not 429 (independent re-review
  // round 3, item 5, found an earlier revision of this comment claimed
  // "5xx/429", which is wrong on both counts: a 500, 502, or 504 is NOT
  // retried, and 429 is NOT retried either). A 400 must never see a second
  // POST. Scripting a 400 for every attempt
  // (the stub's fallback for an exhausted script list is 200, so scripting
  // just one entry and confirming exactly one POST occurred proves no retry
  // was attempted -- a second attempt would either 200 the run to success,
  // failing this test's rejection assertion, or would itself be visible in
  // `rs.ingestAttempts.length`).
  ensureDbOpenForStubRsTests();
  const rs = await startStubRs([{ status: 400 }]);
  const connectorId = "stream-evidence-4xx-no-retry";
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-4xx-no-retry-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );
  try {
    let rejection: RuntimeRejectionError | null = null;
    try {
      await runConnector({
        admitRunConnection: async ({ connectorId: cid, connectorInstanceId, ownerSubjectId }) => ({
          connectorId: cid,
          connectorInstanceId: connectorInstanceId ?? `${cid}:default`,
          ownerSubjectId: ownerSubjectId ?? "owner_local",
        }),
        collectionMode: "full_refresh",
        connectorId,
        connectorPath,
        ingestRetryPolicy: { baseDelayMs: 1, maxAttempts: 4, maxDelayMs: 10, maxRetryAfterMs: 10 },
        ingestRetryRandom: () => 0.5,
        ingestRetrySleep: () => Promise.resolve(),
        manifest: {
          connector_id: connectorId,
          display_name: "4xx No-Retry Test Connector",
          protocol_version: "0.1.0",
          streams: [
            {
              name: "messages",
              primary_key: ["id"],
              schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
              semantics: "mutable_state",
            },
            {
              coverage_strategy: "checkpoint_window",
              name: "message_bodies",
              primary_key: ["id"],
              schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
              semantics: "append_only",
              state_stream: "messages",
            },
          ],
          version: "1.0.0",
        } as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken: "owner-token-for-stub",
        persistState: false,
        rsUrl: rs.url,
        scope: { streams: [{ name: "messages" }, { name: "message_bodies" }] },
        state: null,
      });
    } catch (err) {
      rejection = err as RuntimeRejectionError;
    }
    assert.ok(rejection, "a permanent 4xx ingest failure must fail the run, not retry it away");
    assert.equal(rs.ingestAttempts.length, 1, "a non-retryable 4xx must never be retried");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await rs.close();
  }
});

// ── Independent review round 2, item 1: canonical compound-key encoding ──

test("STREAM_EVIDENCE: distinct compound keys that collide under naive string concatenation are NOT collapsed", async () => {
  // The bounded oracle from the independent review: ["a","b,c"] and
  // ["a,b","c"] both concatenate to the string "a,b,c" under String(array),
  // but are distinct RS keys under the canonical minified-JSON-array
  // encoding (encodeKey, server/records.ts) the RS itself uses. An honest
  // emitted:2 claim over these two distinct keys must be accepted, not
  // rejected as if only one distinct key had been durably accepted.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = compoundKeyManifest("stream-evidence-compound-key-distinct");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-compound-distinct-"));
    const keyA = ["a", "b,c"];
    const keyB = ["a,b", "c"];
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: ${JSON.stringify(keyA)}, data: { part_a: 'a', part_b: 'b,c' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: ${JSON.stringify(keyB)}, data: { part_a: 'a,b', part_b: 'c' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 2, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "two distinct compound keys that collide under naive String(array) concatenation must both count as distinct"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: claiming 2 emitted for the SAME compound key sent twice is rejected (mutation control)", async () => {
  // Inverse of the collision-oracle test above: the SAME compound key,
  // canonically encoded, must still collapse to one distinct entry --
  // proving the fix closes duplicates without opening a new hole for
  // compound keys.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = compoundKeyManifest("stream-evidence-compound-key-duplicate");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-compound-duplicate-"));
    const key = ["a", "b,c"];
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: ${JSON.stringify(key)}, data: { part_a: 'a', part_b: 'b,c' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: ${JSON.stringify(key)}, data: { part_a: 'a', part_b: 'b,c' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 2, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(rejection, "the SAME compound key emitted twice, canonically encoded, must still collapse to 1");
      assert.match(rejection?.message || "", EMITTED_MISMATCH_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Independent review round 2, item 3: STREAM_EVIDENCE is a terminal fact per stream ──

test("STREAM_EVIDENCE: a RECORD for the same stream after its accepted STREAM_EVIDENCE is rejected", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-late-record-after-evidence");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-late-record-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  // A late RECORD for message_bodies -- the exact sequence the independent
  // review flagged: RECORD -> STREAM_EVIDENCE{emitted:1} -> RECORD -> DONE.
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-b', data: { id: 'm-b' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(rejection, "a RECORD for a stream after its accepted STREAM_EVIDENCE must be rejected");
      assert.match(rejection?.message || "", LATE_RECORD_AFTER_EVIDENCE_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a DETAIL_GAP for the same stream after its accepted STREAM_EVIDENCE is rejected", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-late-gap-after-evidence");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-late-gap-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-b', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(rejection, "a DETAIL_GAP for a stream after its accepted STREAM_EVIDENCE must be rejected");
      assert.match(rejection?.message || "", LATE_GAP_AFTER_EVIDENCE_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: a RECORD for a DIFFERENT stream after STREAM_EVIDENCE is still accepted", async () => {
  // Guards against an over-broad fix that rejects ANY RECORD after ANY
  // STREAM_EVIDENCE, rather than scoping the rejection to the SAME stream.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-late-record-different-stream");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-late-record-other-stream-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  // A LATER RECORD for 'messages' (a different stream) must be unaffected.
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-2', data: { id: 'm-2' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-2' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "a RECORD for a DIFFERENT stream after STREAM_EVIDENCE for another stream must not be rejected"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Independent review round 2, item 4: teardown on cancellation and on a forced terminal-processing throw ──

test("teardown: the accepted-keys temp store is removed after an owner-cancelled run", async () => {
  // message_bodies is a state_stream child: it never carries its own STATE,
  // so nothing flushes its batch except hitting BATCH_SIZE or the run's own
  // end-of-run flush -- neither of which this stub's idle-forever shape
  // reaches. Force BATCH_SIZE=1 so the single message_bodies RECORD flushes
  // (and is durably accepted into acceptedKeysDb) immediately on emission,
  // before the test observes the ingest progress event and aborts.
  const originalBatchSize = process.env.PDPP_RUNTIME_BATCH_SIZE;
  process.env.PDPP_RUNTIME_BATCH_SIZE = "1";
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-teardown-cancellation");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-teardown-cancel-"));
    // Emits one message_bodies RECORD, then idles forever (no DONE) --
    // mirrors test/runtime-cancel-run.test.ts's stub pattern.
    const connectorPath = join(tmpDir, "connector.mjs");
    writeFileSync(
      connectorPath,
      `
import { createInterface } from 'node:readline';
async function main() {
  await new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    rl.once('line', () => { rl.close(); resolve(); });
  });
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stderr.write('STUB_READY\\n');
  setInterval(() => {}, 1000);
}
main();
`,
      "utf8"
    );
    try {
      await withPrivateTmpRoot(async (tmpRoot) => {
        const controller = new AbortController();
        let resolveIngested: () => void = () => undefined;
        const ingested = new Promise<void>((resolve) => {
          resolveIngested = resolve;
        });
        // Abort as soon as the RS has durably accepted the message_bodies
        // record -- the run is past its flush and acceptedKeysDb is
        // genuinely non-empty, the motivating case for this test.
        ingested.then(() => controller.abort());

        const result = await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          cancelSignal: controller.signal,
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          onProgress: (message: unknown) => {
            const typed = message as { stream?: string; type?: string };
            if (typed.type === "ingest" && typed.stream === "message_bodies") {
              resolveIngested();
            }
          },
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });

        assert.equal(result.status, "cancelled", "the run must terminate as cancelled, not error out unexpectedly");
        const tmpAfter = readdirSync(tmpRoot).filter((name) => name.startsWith("pdpp-stream-evidence-accepted-keys-"));
        assert.deepEqual(tmpAfter, [], "the accepted-keys temp directory must be removed after an owner-cancelled run");
      });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
    if (originalBatchSize === undefined) {
      delete process.env.PDPP_RUNTIME_BATCH_SIZE;
    } else {
      process.env.PDPP_RUNTIME_BATCH_SIZE = originalBatchSize;
    }
  }
});

// ── Independent re-review, item 2: one-fact-per-stream-per-run_id across separate runConnector invocations ──

const DUPLICATE_SAME_RUN_ID_PATTERN = /duplicate STREAM_EVIDENCE for stream=message_bodies under run_id=/i;
const DUPLICATE_SAME_RUN_ID_BODY_0_PATTERN =
  /duplicate STREAM_EVIDENCE for stream=body_0 under run_id=|digest mismatch/i;

test("STREAM_EVIDENCE: a second accepted fact for the same stream under the SAME run_id, across two separate runConnector invocations, is rejected", async () => {
  // spec-collection-profile.md rule 5: "at most one accepted STREAM_EVIDENCE
  // per stream per run_id." `streamEvidenceByStream` alone only scopes this
  // WITHIN one `runConnector` invocation (a fresh Map per call) -- it cannot
  // by itself stop a caller-supplied run_id from being reused across two
  // SEPARATE invocations (runtime/scheduler/run-executor.ts's retry loop
  // does exactly this when the caller supplies an explicit runId: each
  // retry attempt is a new runConnector call, but `buildAttemptCall`'s
  // `call.runId ?? ...` fallback only fires when no runId was already set).
  // This test drives that scenario directly: two independent runConnector
  // calls, same explicit runId, each with its own manifest registration and
  // connector stub, both emitting STREAM_EVIDENCE for message_bodies. The
  // second must be rejected as a duplicate under the shared run_id.
  const sharedRunId = `run_shared_${Date.now()}`;
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m1 = manifest("stream-evidence-same-run-id-first");
    await registerManifest(asUrl, m1);
    const tmpDir1 = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-same-run-id-1-"));
    const connectorPath1 = writeConnectorStub(
      tmpDir1,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const firstResult = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m1.connector_id,
        connectorPath: connectorPath1,
        manifest: m1 as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        runId: sharedRunId,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        firstResult.status,
        "succeeded",
        "the first invocation under the shared run_id must accept its evidence"
      );
    } finally {
      rmSync(tmpDir1, { force: true, recursive: true });
    }

    // Second, SEPARATE runConnector invocation, same sharedRunId, a
    // different connector (its own manifest/registration) whose own
    // message_bodies stream also reports STREAM_EVIDENCE. Different
    // connector, same run_id, same stream NAME -- the registry is keyed on
    // [run_id, stream], matching the spec's literal wording ("per stream
    // per run_id"), not on connector identity.
    const m2 = manifest("stream-evidence-same-run-id-second");
    await registerManifest(asUrl, m2);
    const tmpDir2 = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-same-run-id-2-"));
    const connectorPath2 = writeConnectorStub(
      tmpDir2,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-b', data: { id: 'm-b' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m2.connector_id,
          connectorPath: connectorPath2,
          manifest: m2 as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          runId: sharedRunId,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(
        rejection,
        "a second accepted STREAM_EVIDENCE for message_bodies under the SAME run_id, from a separate runConnector invocation, must be rejected"
      );
      assert.match(rejection?.message || "", DUPLICATE_SAME_RUN_ID_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir2, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: a second accepted fact for the same stream under a DIFFERENT run_id is still accepted", async () => {
  // Guards against an over-broad fix that rejects ANY repeated
  // stream-name STREAM_EVIDENCE regardless of run_id, rather than scoping
  // the rejection to the SAME run_id -- which would make every ordinary
  // run of the same connector's second-ever run fail outright.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-different-run-id-control");
    await registerManifest(asUrl, m);

    async function runOnce(runId: string, key: string): Promise<RuntimeRunConnectorResult> {
      const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-different-run-id-"));
      const connectorPath = writeConnectorStub(
        tmpDir,
        `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: '${key}', data: { id: '${key}' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
      );
      try {
        return (await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          runId,
          state: null,
        })) as RuntimeRunConnectorResult;
      } finally {
        rmSync(tmpDir, { force: true, recursive: true });
      }
    }

    const first = await runOnce(`run_control_a_${Date.now()}`, "m-a");
    assert.equal(first.status, "succeeded");
    const second = await runOnce(`run_control_b_${Date.now()}`, "m-b");
    assert.equal(
      second.status,
      "succeeded",
      "a repeated stream name under a DIFFERENT run_id must not be treated as a duplicate"
    );
  } finally {
    await closeServer(server);
  }
});

// ── Independent exact-head re-review, item 1: the cross-invocation registry must never evict ──

const EVICTION_REGRESSION_STREAM_COUNT = 50;

/**
 * A manifest with `EVICTION_REGRESSION_STREAM_COUNT` distinct `state_stream`
 * children of `messages`, named `body_0`..`body_{N-1}`.
 */
function manyStateStreamChildrenManifest(connectorId: string) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: connectorId,
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "messages",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      ...Array.from({ length: EVICTION_REGRESSION_STREAM_COUNT }, (_, i) => ({
        coverage_strategy: "checkpoint_window",
        name: `body_${i}`,
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "append_only",
        state_stream: "messages",
      })),
    ],
    version: "0.1.0",
  };
}

test("STREAM_EVIDENCE: the cross-invocation run_id registry never evicts — the FIRST of many entries is still rejected as a duplicate after many more are inserted", async () => {
  // Regression oracle for independent exact-head re-review item 1: an
  // earlier revision capped `streamEvidenceSeenByRunId` at a FIFO size
  // limit, which silently accepted a duplicate once the registry exceeded
  // that cap and evicted the oldest entry. The fix removed eviction
  // entirely (see the registry's doc comment, runtime/index.ts) rather than
  // raising the cap, which independent review explicitly required ("do not
  // just raise the cap").
  //
  // This test cannot practically reach the OLD cap (10,000) through real
  // runConnector invocations without being prohibitively slow, but it does
  // not need to: the fix removed the eviction CODE PATH itself, not merely
  // widened its threshold, so ANY number of entries greater than one is a
  // valid regression witness for "no eviction occurs" -- if eviction logic
  // ever reappears (at any cap), the oldest of these
  // EVICTION_REGRESSION_STREAM_COUNT entries is exactly the one a
  // FIFO-by-insertion-order policy would evict first, which is precisely
  // what this test re-claims and asserts is still rejected.
  const sharedRunId = `run_eviction_regression_${Date.now()}`;
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manyStateStreamChildrenManifest("stream-evidence-eviction-regression");
    await registerManifest(asUrl, m);

    // One run, one run_id, EVICTION_REGRESSION_STREAM_COUNT distinct
    // accepted STREAM_EVIDENCE facts -- inserted in a single invocation so
    // this stays fast (one connector process, one server round trip per
    // stream, not one runConnector invocation per stream).
    const tmpDir1 = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-eviction-regression-1-"));
    const manyStreamsScript = Array.from({ length: EVICTION_REGRESSION_STREAM_COUNT }, (_, i) => {
      const stream = `body_${i}`;
      return [
        `process.stdout.write(JSON.stringify({ type: 'RECORD', stream: '${stream}', key: 'k-${i}', data: { id: 'k-${i}' }, emitted_at: new Date().toISOString() }) + '\\n');`,
        `process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: '${stream}', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');`,
      ].join("\n  ");
    }).join("\n  ");
    const connectorPath1 = writeConnectorStub(
      tmpDir1,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  ${manyStreamsScript}
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: ${EVICTION_REGRESSION_STREAM_COUNT + 1} }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const firstResult = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath: connectorPath1,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        runId: sharedRunId,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        firstResult.status,
        "succeeded",
        `the first invocation must accept all ${EVICTION_REGRESSION_STREAM_COUNT} distinct STREAM_EVIDENCE facts`
      );
    } finally {
      rmSync(tmpDir1, { force: true, recursive: true });
    }

    // Second, SEPARATE invocation, SAME run_id, re-claiming STREAM_EVIDENCE
    // for `body_0` -- the FIRST stream registered, and therefore the one a
    // FIFO-by-insertion-order eviction policy would have evicted first once
    // any later entry pushed the registry over a capacity threshold. If
    // eviction logic has reappeared at any cap <= this test's count, this
    // claim would be wrongly ACCEPTED; the fix requires it stay rejected
    // regardless of how many entries came after it.
    // No RECORD messages here: the first invocation already left
    // `sharedRunId` terminal in the RS's own run history, so a RECORD
    // ingest under the same run_id in this second invocation would be
    // rejected at the RS layer (`run_terminal`) before STREAM_EVIDENCE is
    // even reached -- an unrelated RS run-lifecycle rule, not the registry
    // this test targets. Re-claiming STREAM_EVIDENCE directly, with zero
    // durably-accepted keys this run, is what isolates the registry check:
    // `outcomes.emitted: 0` matches this run's own (zero) distinct
    // durably-accepted count for `body_0`, so the emitted-count
    // reconciliation cannot be what rejects this claim -- only the
    // cross-invocation run_id registry can.
    const tmpDir2 = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-eviction-regression-2-"));
    const connectorPath2 = writeConnectorStub(
      tmpDir2,
      `
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'body_0', considered: 0, outcomes: { emitted: 0, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath: connectorPath2,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          runId: sharedRunId,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(
        rejection,
        "the FIRST-registered stream's fact must still be rejected as a duplicate after many more entries were inserted under the same run_id -- proving no eviction occurred"
      );
      assert.match(rejection?.message || "", DUPLICATE_SAME_RUN_ID_BODY_0_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir2, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Recovered-gap reconciliation (pdpp#238 provisional review P1-1): a gap
// recovered THIS run must not still count toward outcomes.gapped. The append
// log records the same gap_id more than once across a run (e.g. pending from
// a prior run, then recovered), and the fix must reconcile against the FINAL
// status per gap_id, not raw membership. ──

const LATE_GAP_RECOVERED_AFTER_EVIDENCE_PATTERN =
  /DETAIL_GAP_RECOVERED for stream 'message_bodies' after already reporting STREAM_EVIDENCE/i;

/**
 * `getDefaultConnectorDetailGapStore()` returns `unknown` (the SQLite/Postgres
 * backends are not modeled as a shared exported interface); narrow to only
 * the methods these tests call, matching the existing pattern in
 * detail-coverage-recovered-gap-regression.test.ts.
 */
interface DetailGapForTest {
  readonly gap_id: string;
  readonly status: string;
  readonly [key: string]: unknown;
}

interface DetailGapStoreForTest {
  getGapById: (gapId: string) => Promise<DetailGapForTest | null>;
  markGapStatus: (gapId: string, status: string, options?: { runId?: string }) => Promise<DetailGapForTest | null>;
  upsertPendingGap: (input: Record<string, unknown>) => Promise<DetailGapForTest | null>;
}

function getTestDetailGapStore(): DetailGapStoreForTest {
  return getDefaultConnectorDetailGapStore() as DetailGapStoreForTest;
}

/** Seeds a durable pending detail gap on `message_bodies` as a prior run would have left it. */
async function seedPriorRunPendingGap(
  store: DetailGapStoreForTest,
  connectorId: string,
  recordKey: string
): Promise<DetailGapForTest> {
  const seeded = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: makeDefaultAccountConnectorInstanceId("test_user", connectorId),
    detailLocator: { key: recordKey },
    discoveredRunId: "prior",
    grantId: null,
    lastError: null,
    lastRunId: "prior",
    listCursor: null,
    parentStream: "messages",
    reason: "temporary_unavailable",
    recordKey,
    scope: null,
    source: { id: connectorId, kind: "connector" },
    stream: "message_bodies",
  });
  assert.ok(seeded, "seeded prior-run pending gap is persisted");
  return seeded as DetailGapForTest;
}

test("STREAM_EVIDENCE: a prior-run pending gap recovered THIS run passes honest gapped:0 (not counted as still-gapped)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-recovered-gap-gapped-zero");
    await registerManifest(asUrl, m);
    const store = getTestDetailGapStore();
    const seeded = await seedPriorRunPendingGap(store, m.connector_id, "m-a");
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-recovered-gapped-zero-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP_RECOVERED', stream: 'message_bodies', record_key: 'm-a', reference_only: true, gap_id: '${seeded.gap_id}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "an honest gapped:0 after recovering the only prior-run pending gap this run must be accepted"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a gap recovered by an EARLIER run then re-deferred THIS run counts as gapped:1 (reopened to pending, final status wins)", async () => {
  // The store's upsertPendingGap ON CONFLICT only keeps a `recovered` status
  // sticky when `recovered_run_id` equals the re-defer's OWN run_id (a
  // same-run re-defer of a gap this SAME run already recovered -- covered by
  // the "new gap discovered and recovered within the SAME run" test above,
  // and by detail-coverage-recovered-gap-regression.test.ts's "stays
  // recovered and suppressed" case). A re-defer from a DIFFERENT run than
  // the one that recovered it reopens the row to `pending` -- so THIS run's
  // durable append log for the gap ends the run with status `pending`, not
  // `recovered`, and must count toward gapped.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-recovered-then-redeferred");
    await registerManifest(asUrl, m);
    const store = getTestDetailGapStore();
    const seeded = await seedPriorRunPendingGap(store, m.connector_id, "m-a");
    await store.markGapStatus(seeded.gap_id, "recovered", { runId: "prior" });
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-recovered-redeferred-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-a', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 0, unchanged: 0, gapped: 1, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "a gap recovered by an earlier run and reopened to pending by this run's re-defer must count gapped:1"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a new gap discovered and recovered within the SAME run (no prior seed) passes honest gapped:0", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-same-run-new-then-recovered");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-same-run-new-recovered-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-a', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const probeResult = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      const [firstGap] = probeResult.detail_gaps ?? [];
      assert.ok(firstGap, "the probe run recorded one fresh detail gap");
      const discoveredGapId = firstGap.gap_id as string;
      assert.ok(discoveredGapId, "the fresh gap has an id");

      const connectorPath2 = writeConnectorStub(
        tmpDir,
        `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-2', data: { id: 'm-2' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-2' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP_RECOVERED', stream: 'message_bodies', record_key: 'm-a', reference_only: true, gap_id: '${discoveredGapId}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
      );
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath: connectorPath2,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "a gap discovered and recovered within the same run must pass honest gapped:0"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: mixed recovered/pending/terminal durable gaps reconcile exactly (equality, not ceiling)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-mixed-gap-statuses");
    await registerManifest(asUrl, m);
    const store = getTestDetailGapStore();
    // Seed THREE prior-run gaps: one will be recovered this run, one stays
    // pending, one is marked terminal (simulating a permanently-unavailable
    // classification from a prior run's terminate pass). `durableDetailGaps`
    // is a run-scoped append log populated only by messages THIS run
    // actually processes -- a durable row untouched by any message this run
    // never enters it -- so the pending/terminal gaps must be re-observed
    // (re-deferred) via DETAIL_GAP this run, exactly as a real connector
    // re-lists still-outstanding work every run until it resolves.
    const recoveredSeed = await seedPriorRunPendingGap(store, m.connector_id, "m-recovered");
    await seedPriorRunPendingGap(store, m.connector_id, "m-pending");
    const terminalSeed = await seedPriorRunPendingGap(store, m.connector_id, "m-terminal");
    await store.markGapStatus(terminalSeed.gap_id, "terminal", { runId: "prior" });

    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-mixed-gap-statuses-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP_RECOVERED', stream: 'message_bodies', record_key: 'm-recovered', reference_only: true, gap_id: '${recoveredSeed.gap_id}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-recovered', data: { id: 'm-recovered' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-pending', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-terminal', reason: 'permanent_unavailable', retryable: false }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 3, outcomes: { emitted: 1, unchanged: 0, gapped: 2, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "gapped:2 (the still-pending + terminal gaps, excluding the recovered one) must be accepted"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: mixed recovered/pending/terminal gaps reject a gapped count that still includes the recovered gap", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-mixed-gap-statuses-over-claim");
    await registerManifest(asUrl, m);
    const store = getTestDetailGapStore();
    const recoveredSeed = await seedPriorRunPendingGap(store, m.connector_id, "m-recovered");
    await seedPriorRunPendingGap(store, m.connector_id, "m-pending");
    const terminalSeed = await seedPriorRunPendingGap(store, m.connector_id, "m-terminal");
    await store.markGapStatus(terminalSeed.gap_id, "terminal", { runId: "prior" });

    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-mixed-gap-over-claim-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP_RECOVERED', stream: 'message_bodies', record_key: 'm-recovered', reference_only: true, gap_id: '${recoveredSeed.gap_id}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-recovered', data: { id: 'm-recovered' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-pending', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-terminal', reason: 'permanent_unavailable', retryable: false }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 4, outcomes: { emitted: 1, unchanged: 0, gapped: 3, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(
        rejection,
        "gapped:3 (still counting the recovered gap) must be rejected even though 3 durable rows exist for the stream"
      );
      assert.match(rejection?.message || "", GAPPED_MISMATCH_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE: a DETAIL_GAP_RECOVERED for the same stream after its accepted STREAM_EVIDENCE is rejected (evidence is a terminal fact; no retroactive reinterpretation)", async () => {
  // Ordering invariant: STREAM_EVIDENCE is a terminal fact per stream per
  // run, exactly like the existing late-RECORD and late-DETAIL_GAP guards.
  // A late recovery arriving after that fact was already accepted must be
  // rejected before it can mutate the gap store/append log -- it must not be
  // silently allowed to durably recover a gap the runtime has already
  // finalized a gapped count for. The connector emits an honest gapped:1
  // (matching the one real pending durable gap at evidence time), then
  // attempts to recover that same gap afterward.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-late-recovery-after-evidence");
    await registerManifest(asUrl, m);
    const store = getTestDetailGapStore();
    const seeded = await seedPriorRunPendingGap(store, m.connector_id, "m-a");
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-late-recovery-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-a', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 0, unchanged: 0, gapped: 1, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP_RECOVERED', stream: 'message_bodies', record_key: 'm-a', reference_only: true, gap_id: '${seeded.gap_id}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: RuntimeRejectionError | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: m.connector_id,
          connectorPath,
          manifest: m as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as RuntimeRejectionError;
      }
      assert.ok(
        rejection,
        "a DETAIL_GAP_RECOVERED for a stream after its accepted STREAM_EVIDENCE must be rejected, not silently applied"
      );
      assert.match(rejection?.message || "", LATE_GAP_RECOVERED_AFTER_EVIDENCE_PATTERN);
      assert.equal(rejection?.failure_reason, "connector_protocol_violation");
      // The rejection must land BEFORE the store mutation -- the gap must
      // still be pending, not recovered, proving no retroactive reinterpretation.
      const storedRow = await store.getGapById(seeded.gap_id);
      assert.ok(storedRow, "the durable gap row still exists after the run terminated");
      assert.equal(
        storedRow?.status,
        "pending",
        "the rejected DETAIL_GAP_RECOVERED must not have durably recovered the gap"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: a DETAIL_GAP_RECOVERED for a DIFFERENT stream after STREAM_EVIDENCE for the first stream is still accepted", async () => {
  // Guards against an over-broad fix that rejects ANY DETAIL_GAP_RECOVERED
  // after ANY STREAM_EVIDENCE, rather than only a same-stream one. This
  // manifest has two independent state_stream children of `messages`
  // (message_bodies, message_attachments) so a recovery on the SECOND
  // stream, after evidence was already accepted for the FIRST, must remain
  // allowed -- STREAM_EVIDENCE's terminal-fact rule is scoped per stream,
  // not per run.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = {
      capabilities: { human_interaction: [] },
      connector_id: "stream-evidence-recovery-different-stream-ok",
      display_name: "stream-evidence-recovery-different-stream-ok",
      manifest_uri: "https://sources.example/stream-evidence-recovery-different-stream-ok",
      protocol_version: "0.1.0",
      streams: [
        {
          name: "messages",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "mutable_state",
        },
        {
          coverage_strategy: "checkpoint_window",
          name: "message_bodies",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "append_only",
          state_stream: "messages",
        },
        {
          coverage_strategy: "checkpoint_window",
          name: "message_attachments",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
          selection: { fields: true, resources: true },
          semantics: "append_only",
          state_stream: "messages",
        },
      ],
      version: "0.1.0",
    };
    await registerManifest(asUrl, m as unknown as ReturnType<typeof manifest>);
    const store = getTestDetailGapStore();
    const seeded = await store.upsertPendingGap({
      connectorId: m.connector_id,
      connectorInstanceId: makeDefaultAccountConnectorInstanceId("test_user", m.connector_id),
      detailLocator: { key: "a-1" },
      discoveredRunId: "prior",
      grantId: null,
      lastError: null,
      lastRunId: "prior",
      listCursor: null,
      parentStream: "messages",
      reason: "temporary_unavailable",
      recordKey: "a-1",
      scope: null,
      source: { id: m.connector_id, kind: "connector" },
      stream: "message_attachments",
    });
    assert.ok(seeded, "seeded prior-run pending gap on message_attachments is persisted");
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-recovery-different-stream-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-a', data: { id: 'm-a' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP_RECOVERED', stream: 'message_attachments', record_key: 'a-1', reference_only: true, gap_id: '${seeded.gap_id}' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_attachments', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_attachments', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 3 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: m.connector_id,
        connectorPath,
        manifest: m as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(
        result.status,
        "succeeded",
        "a DETAIL_GAP_RECOVERED for a DIFFERENT stream after STREAM_EVIDENCE for the first stream must remain accepted"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});
