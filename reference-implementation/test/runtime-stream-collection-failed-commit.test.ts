// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SpineEventRecord } from "../lib/spine.ts";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

// Regression coverage for the live runtime path (reference-implementation/runtime/index.ts)
// used by every real connector run, as distinct from the standalone
// polyfill-connectors local collector (packages/polyfill-connectors/src/collector-runner.ts),
// which is a separate, unrelated execution path and is NOT exercised by this file.
//
// Incident: a run enumerating several streams hit a retryable, stream-scoped
// failure on one of them (reported via SKIP_RESULT{reason:"stream_collection_failed"}
// + a terminal DONE{status:"failed", error:{code:"stream_collection_failed"}}).
// The runtime's `handleDoneClose` only ever committed staged STATE when
// `done.status === "succeeded"`; any failed DONE discarded every staged
// cursor, including ones for sibling streams that had already reached their
// own terminal STATE with no reported failure — forcing a full re-scan on
// retry.
//
// Fix: `handleDoneClose` now also commits when a failed DONE is structurally
// certified as stream-scoped — DONE.error.code === "stream_collection_failed"
// AND at least one in-scope SKIP_RESULT named the failing stream(s) — and
// then commits only the staged streams NOT named by those SKIP_RESULTs. Any
// other failure shape (no matching SKIP_RESULT, missing DONE/crash, global
// failure, cancellation, protocol mismatch) still discards everything, exactly
// as before.
//
// `runConnector` RESOLVES (never rejects) for any connector-reported terminal
// status, including "failed" — it only rejects for genuine runtime errors
// (e.g. a state-PUT that itself fails mid-commit). Every test below awaits
// the resolved result directly.

const CHILD_B_STREAM_NAME_PATTERN = /child_b/;

interface ClosableServer {
  asPort: number;
  asServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
  rsPort: number;
  rsServer: { close: (cb: () => void) => void; closeAllConnections: () => void };
}
interface StartServerOptions {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}
const startServer = startServerUntyped as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

interface TestSpineEventData {
  [key: string]: unknown;
}
type TestSpineEvent = Omit<SpineEventRecord, "data"> & { data: TestSpineEventData };
interface TraceTimelineBody {
  data: TestSpineEvent[];
}

type RunResult = RuntimeRunConnectorResult & {
  checkpoint_summary?: {
    state_streams_committed?: number;
    state_streams_staged?: number;
  };
  connector_error?: { code?: string; message?: string; retryable?: boolean | null } | null;
};

async function closeServer(server: ClosableServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "u1"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

function fakeAdmitRunConnection(
  ownerSubjectIdDefault = "u1"
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

// Two in-scope streams; no provider identity anywhere in the manifest/connector
// stub — the incident's real connector had three sibling streams and one
// failing stream, but the fix is provider-neutral and this is the minimal
// shape that discriminates it: one sibling that fully succeeds, one stream
// that reports its own certified failure.
function testManifest(connectorId: string) {
  return {
    connector_id: connectorId,
    display_name: "Runtime stream isolation test",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "sibling_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "sibling_b",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

type RuntimeManifest = NonNullable<Parameters<typeof runConnector>[0]["manifest"]> & {
  connector_id: string;
  streams: NonNullable<NonNullable<Parameters<typeof runConnector>[0]["manifest"]>["streams"]>;
};
type RuntimeManifestStream = NonNullable<RuntimeManifest["streams"]>[number];

function completeManifest(connectorId: string, streams: RuntimeManifestStream[]): RuntimeManifest {
  return {
    connector_id: connectorId,
    display_name: "Runtime stream isolation test",
    manifest_uri: `https://registry.pdpp.dev/connectors/${connectorId}`,
    protocol_version: "0.1.0",
    streams: streams.map((stream) => ({
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
      ...stream,
    })),
    version: "1.0.0",
  };
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

async function runStub(input: {
  asUrl: string;
  connectorPath: string;
  manifest: RuntimeManifest;
  ownerToken: string;
  rsUrl: string;
}): Promise<RunResult> {
  return (await runConnector({
    admitRunConnection: fakeAdmitRunConnection(),
    collectionMode: "incremental",
    connectorId: input.manifest.connector_id,
    connectorPath: input.connectorPath,
    manifest: input.manifest,
    onInteraction: async () => ({}),
    ownerToken: input.ownerToken,
    persistState: true,
    rsUrl: input.rsUrl,
    state: null,
  })) as RunResult;
}

test("runConnector commits the untouched sibling's checkpoint when the other stream reports a certified stream_collection_failed", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-certified-partial-failure-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });

    // The run stayed failed and retryable — the connection must not falsely
    // read complete.
    assert.equal(result.status, "failed");
    assert.equal(result.connector_error?.code, "stream_collection_failed");
    assert.equal(result.connector_error?.retryable, true);

    // But the untouched sibling's checkpoint DID commit.
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(stateResp.status, 200);
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });

    const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
      `${asUrl}/_ref/runs/${encodeURIComponent(result.run_id ?? "")}/timeline`
    );
    const eventTypes = (runTimeline.data || []).map((event) => event.event_type);
    assert.ok(eventTypes.includes("run.state_advanced"), "expected the sibling commit to advance state");
    assert.ok(eventTypes.includes("run.stream_skipped"), "expected the failed stream's SKIP_RESULT to be recorded");
    assert.ok(eventTypes.includes("run.failed"), "expected the run to still terminate as failed");
    assert.ok(!eventTypes.includes("run.completed"), "a stream-scoped failure must never read as run.completed");

    const advancedEvent = (runTimeline.data || []).find((event) => event.event_type === "run.state_advanced");
    assert.equal(advancedEvent?.stream_id, "sibling_a");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds an unrelated DETAIL_COVERAGE shortfall during a certified stream failure", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-failure-and-coverage-shortfall-test", [
      ...testManifest("unused").streams,
      {
        name: "shortfall_sibling",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-shortfall-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'shortfall_sibling', stream: 'shortfall_sibling', required_keys: ['detail-1'], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'shortfall_sibling', cursor: { cursor: 'shortfall_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 0, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    const runId = result.run_id;
    assert.ok(runId);
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });

    const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
      `${asUrl}/_ref/runs/${encodeURIComponent(result.run_id ?? "")}/timeline`
    );
    const eventTypes = (runTimeline.data || []).map((event) => event.event_type);
    assert.ok(eventTypes.includes("run.stream_skipped"), "the coverage shortfall must be reported");
    assert.ok(eventTypes.includes("run.failed"), "the certified failure must keep the run failed");
    assert.ok(!eventTypes.includes("run.completed"), "a stream-scoped failure must not read as success");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds the failed stream's cursor even when the child leaks a STATE for it before failing it", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-leaked-cursor-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-leaked-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_b', cursor: { cursor: 'unsafe_leaked_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");

    // Even though sibling_b leaked a STATE cursor before reporting its own
    // failure, that cursor must never commit — only sibling_a, which
    // reported no failure, is provably safe.
    assert.equal(result.checkpoint_summary?.state_streams_staged, 2);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state, { sibling_a: { cursor: "sibling_a_cursor" } });
    assert.ok(!("sibling_b" in (stateBody.state ?? {})), "the failed stream's leaked cursor must not commit");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds a manifest-declared PARENT state_stream shared with a failed CHILD data stream", async () => {
  // SKIP_RESULT.stream names a DATA stream, but STATE/newState/commitState
  // are keyed by STATE_STREAM — a manifest may declare several data streams
  // sharing one parent state_stream (stream.state_stream). If the failed
  // data stream is mapped through as if its own name WERE the state_stream
  // key, the filter finds no matching newState entry and falsely commits the
  // shared parent checkpoint even though one of its two child streams
  // reported a certified failure and never finished.
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-parent-state-stream-test", [
      {
        coverage_strategy: "checkpoint_window",
        name: "child_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        state_stream: "parent",
      },
      {
        coverage_strategy: "checkpoint_window",
        name: "child_b",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        state_stream: "parent",
      },
      // state_stream must name another declared manifest stream (server-side
      // registration validation) — 'parent' is itself a declared stream that
      // the connector never emits RECORD/SKIP_RESULT for directly; it only
      // exists as the shared checkpoint key child_a/child_b both declare.
      {
        name: "parent",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-parent-state-stream-"));
  // child_a finishes and the connector advances the SHARED parent cursor;
  // child_b then fails. The connector never emits a second STATE for
  // 'parent' after the failure (the honest, GroupMe-shaped behavior this
  // suite already assumes elsewhere) -- the one staged 'parent' cursor
  // reflects a run that did NOT finish walking everything state_stream
  // 'parent' covers, so it must not commit.
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'child_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'parent', cursor: { cursor: 'parent_cursor_after_child_a' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'child_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: child_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");

    // The shared 'parent' state_stream must NOT commit: child_b (which maps
    // to it via the manifest) reported a certified failure, so the parent
    // checkpoint is unproven even though child_a's own portion succeeded.
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state ?? {}, {}, "the shared parent checkpoint must not falsely commit");
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector rejects a state_stream-declared child that emits its own DETAIL_COVERAGE, preventing any commit", async () => {
  // Manifest-authoritative model (spec "Precedence between manifest and
  // run-time evidence"): a state_stream-declared child's checkpoint parent
  // is ALWAYS the manifest's static declaration. Live DETAIL_COVERAGE can no
  // longer supersede it — a state_stream-declared stream MUST NOT emit
  // DETAIL_COVERAGE at all, and doing so is a protocol violation that fails
  // the whole run (no commit for any staged stream, including the unrelated
  // child_a). This replaces the old "live wins unconditionally" behavior
  // this exact scenario used to exercise as a feature.
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-detail-coverage-state-stream-test", [
      {
        name: "child_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      {
        coverage_strategy: "checkpoint_window",
        name: "child_b",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        state_stream: "manifest_parent",
      },
      {
        name: "manifest_parent",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      {
        name: "runtime_parent",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-detail-coverage-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'child_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'runtime_parent', cursor: { cursor: 'runtime_parent_cursor_after_child_a' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'runtime_parent', stream: 'child_b', required_keys: [], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'child_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: child_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    let rejection: Error | null = null;
    try {
      await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    } catch (err) {
      rejection = err as Error;
    }

    assert.ok(rejection, "a state_stream-declared stream (child_b) emitting DETAIL_COVERAGE must be rejected");
    assert.match(rejection?.message || "", CHILD_B_STREAM_NAME_PATTERN, "the rejection must name the offending stream");

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state ?? {},
      {},
      "no checkpoint may advance once the connector violates the static state_stream contract, not even runtime_parent's own STATE"
    );
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector withholds every declared parent of a failed shared detail stream", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = completeManifest("runtime-stream-isolation-conflicting-detail-coverage-test", [
      {
        name: "sibling_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      {
        name: "parent_a",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      {
        name: "parent_b",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
      // sibling_b is a manifest-declared parent_detail_accounting stream with
      // BOTH parent_a and parent_b as its declared parents. Under the
      // manifest-authoritative model, its failure must withhold every
      // DECLARED parent — including parent_b, which committed its own STATE
      // this run but never got a live DETAIL_COVERAGE report for this failed
      // run at all (see spec "Precedence between manifest and run-time
      // evidence"). This is distinct from the old defect where an
      // undeclared, ad-hoc live parent pair could be introduced with no
      // manifest declaration at all.
      {
        coverage_strategy: "parent_detail_accounting",
        name: "sibling_b",
        parent_streams: ["parent_a", "parent_b"],
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      },
  ]);
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-conflict-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'parent_a', cursor: { cursor: 'parent_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'parent_b', cursor: { cursor: 'parent_b_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'parent_a', stream: 'sibling_b', required_keys: [], hydrated_keys: [] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'SKIP_RESULT', stream: 'sibling_b', reason: 'stream_collection_failed', message: 'upstream 500' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 0, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);
    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    const runId = result.run_id;
    assert.ok(runId);
    assert.equal(result.checkpoint_summary?.state_streams_staged, 3);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 1);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(
      stateBody.state ?? {},
      { sibling_a: { cursor: "sibling_a_cursor" } },
      "every declared parent of the failed detail stream is withheld — including parent_b, which got no live coverage report this run — while an unrelated sibling still commits"
    );

    const { body: runTimeline } = await fetchJson<TraceTimelineBody>(
      `${asUrl}/_ref/runs/${encodeURIComponent(runId)}/timeline`
    );
    const eventTypes = (runTimeline.data || []).map((event) => event.event_type);
    assert.ok(eventTypes.includes("run.failed"));
    assert.ok(eventTypes.includes("run.state_advanced"));
    assert.ok(!eventTypes.includes("run.completed"));
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector discards every staged checkpoint when DONE claims stream_collection_failed but no SKIP_RESULT named any stream", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-uncertified-code-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-uncertified-"));
  // Same terminal error.code as the certified case, but with ZERO SKIP_RESULT
  // messages — the runtime cannot verify which (if any) stream actually
  // failed, so this must fail exactly like an ordinary global failure: no
  // commit at all, not even for sibling_a which reached its own STATE.
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { code: 'stream_collection_failed', message: 'stream collection failed: sibling_b: upstream 500', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state ?? {}, {});
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector discards every staged checkpoint on an ordinary uncoded failed DONE (counterweight)", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-generic-failure-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-generic-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'failed', records_emitted: 1, error: { message: 'boom', retryable: true } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});

test("runConnector discards every staged checkpoint when the connector crashes without a terminal DONE (counterweight)", async () => {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = testManifest("runtime-stream-isolation-crash-no-done-test");
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-runtime-stream-isolation-crash-"));
  const connectorPath = writeConnectorStub(
    tmpDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'sibling_a', key: 'a-1', data: { id: 'a-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'sibling_a', cursor: { cursor: 'sibling_a_cursor' } }) + '\\n');
  rl.close();
  process.exit(1);
`
  );

  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    const ownerToken = await issueOwnerToken(asUrl);

    const result = await runStub({ asUrl, connectorPath, manifest, ownerToken, rsUrl });
    assert.equal(result.status, "failed");
    assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
    assert.equal(result.checkpoint_summary?.state_streams_committed, 0);

    const stateResp = await fetch(`${rsUrl}/v1/state/${encodeURIComponent(manifest.connector_id)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const stateBody = (await stateResp.json()) as { state?: Record<string, unknown> };
    assert.deepEqual(stateBody.state ?? {}, {});
  } finally {
    rmSync(tmpDir, { force: true, recursive: true });
    await closeServer(server);
  }
});
