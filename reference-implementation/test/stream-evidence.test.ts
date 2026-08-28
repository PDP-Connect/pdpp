// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Protocol-and-runtime conformance for `STREAM_EVIDENCE`
 * (openspec/changes/prove-state-stream-child-coverage). A `state_stream`
 * child (e.g. Gmail's `message_bodies`, riding the `messages` checkpoint)
 * cannot emit `DETAIL_COVERAGE` — the runtime rejects that outright — so it
 * has no way to prove its own coverage beyond blind inheritance from its
 * parent's commit. `STREAM_EVIDENCE` lets it report an independently
 * measured `considered`/`covered` fact about itself, which the existing
 * `evaluateStreamCoherence`/`deriveStreamCoverageCondition` machinery
 * evaluates unmodified, without ever gating any checkpoint commit.
 *
 * Every assertion here is wire-observable (connector JSONL in, spine events /
 * projected coverage condition out), matching the pattern
 * `checkpoint-dependency-profile-conformance.test.ts` and
 * `detail-coverage-flush-ordering.test.ts` already use for this class of
 * protocol contract.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import {
  type CollectionReportEntry,
  projectCollectionReport,
  type RuntimeCollectionFact,
} from "../server/ref-control.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

const NOT_STATE_STREAM_DECLARED_PATTERN = /which the manifest does not declare with a\s+static state_stream parent/;
const COVERED_EXCEEDS_CONSIDERED_PATTERN = /covered.*exceeds considered/i;
const DUPLICATE_STREAM_EVIDENCE_PATTERN = /duplicate STREAM_EVIDENCE/i;
const DETAIL_COVERAGE_STILL_REJECTED_PATTERN = /MUST NOT emit DETAIL_COVERAGE/;

// ─── Runtime-level (real connector subprocess + real spine) harness ───

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

/**
 * Gmail-shaped: `messages` (self-mapped, checkpoint_window) with
 * `message_bodies` declared `state_stream: "messages"` — no independent
 * cursor, forbidden from emitting DETAIL_COVERAGE, the exact shape
 * STREAM_EVIDENCE exists for. `channel_reactions` is a `parent_streams`
 * stream used only for the manifest-shape rejection test.
 */
function streamEvidenceManifest(connectorId: string) {
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
      {
        coverage_strategy: "parent_detail_accounting",
        name: "message_attachments",
        parent_streams: ["messages"],
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
  };
}

/**
 * Same `messages`/`message_bodies` shape as `streamEvidenceManifest`, without
 * the unrelated `message_attachments` (`parent_streams`) stream — isolates
 * the commit-gating assertion to `message_bodies`'s own STREAM_EVIDENCE
 * shortfall, rather than mixing in `message_attachments`'s own unrelated
 * (and, in these fixtures, deliberately never-satisfied) DETAIL_COVERAGE
 * requirement, which would ALSO withhold `messages`'s commit for reasons
 * that have nothing to do with STREAM_EVIDENCE.
 */
function twoStreamManifest(connectorId: string) {
  const full = streamEvidenceManifest(connectorId);
  return { ...full, streams: full.streams.filter((stream) => stream.name !== "message_attachments") };
}

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

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

async function registerManifest(asUrl: string, manifest: ReturnType<typeof streamEvidenceManifest>): Promise<void> {
  const resp = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
}

function terminalDataFor(runId: string): Record<string, unknown> {
  const row = getDb()
    .prepare(
      `SELECT data_json FROM spine_events
       WHERE run_id = ? AND event_type IN ('run.completed', 'run.failed', 'run.cancelled')
       ORDER BY event_seq DESC LIMIT 1`
    )
    .get<{ data_json: string }>(runId);
  assert.ok(row, `expected a terminal spine event for run ${runId}`);
  return JSON.parse(row.data_json) as Record<string, unknown>;
}

function collectionFactsStreamsFor(runId: string): Record<string, unknown>[] {
  const data = terminalDataFor(runId);
  const block = data.collection_facts as { streams?: Record<string, unknown>[] } | undefined;
  return block?.streams ?? [];
}

function factFor(runId: string, stream: string): Record<string, unknown> | undefined {
  return collectionFactsStreamsFor(runId).find((entry) => entry.stream === stream);
}

// ── Baseline: clean STREAM_EVIDENCE folds into considered/covered ──

test("STREAM_EVIDENCE: clean coverage with no gaps folds into the child's own considered/covered (pass)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-clean-pass");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-clean-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest: manifest as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
      const runId = result.run_id;
      assert.ok(runId);
      const fact = factFor(runId as string, "message_bodies");
      assert.ok(fact, "expected a collection-fact entry for message_bodies");
      assert.equal(fact?.considered, 1);
      assert.equal(fact?.covered, 1);
      assert.equal(fact?.pending_detail_gaps, 0);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Fail-before/pass-after: an unaccounted key must read partial, never complete ──

test("STREAM_EVIDENCE: a swallowed-exception shortfall (covered < considered, no gap) never folds into complete (fail before / pass after)", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-shortfall");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-shortfall-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  // Two keys considered, only one covered, zero DETAIL_GAP -- the swallowed-
  // exception case: a key enumerated then lost with no gap report.
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest: manifest as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
      const runId = result.run_id as string;
      const fact = factFor(runId, "message_bodies") as unknown as RuntimeCollectionFact;
      assert.equal(fact.considered, 2);
      assert.equal(fact.covered, 1);

      // Project through the real read-side coherence machinery: this MUST
      // read partial, never complete. This is the discriminating assertion —
      // before STREAM_EVIDENCE existed, a state_stream child had no way to
      // carry this fact at all (unknown/inherited-complete only); after, an
      // honest shortfall must read partial.
      const entries = projectCollectionReport({
        connectionHealth: { axes: { attention: "none", freshness: "fresh" } } as unknown as Parameters<
          typeof projectCollectionReport
        >[0]["connectionHealth"],
        lastRun: {
          collection_facts: { streams: [fact] },
          event_count: 3,
          failure_reason: null,
          finished_at: "2026-08-28T00:00:00.000Z",
          first_at: "2026-08-28T00:00:00.000Z",
          known_gaps: [],
          last_at: "2026-08-28T00:00:00.000Z",
          recovery_only: false,
          run_id: runId,
          started_at: "2026-08-28T00:00:00.000Z",
          status: "succeeded",
          terminal_reason: null,
        } as unknown as Parameters<typeof projectCollectionReport>[0]["lastRun"],
        manifestStreams: manifest.streams as unknown as Parameters<
          typeof projectCollectionReport
        >[0]["manifestStreams"],
        refreshPolicy: null,
      } as Parameters<typeof projectCollectionReport>[0]);
      const entry = (entries as CollectionReportEntry[]).find((e) => e.stream === "message_bodies");
      assert.ok(entry);
      assert.equal(
        entry?.coverage_condition,
        "partial",
        "an unaccounted key (covered < considered, no pending gap) must project partial, never complete"
      );
      assert.notEqual(entry?.coverage_condition, "complete");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Counterexample: a rejected STREAM_EVIDENCE must not silently fall through to inheritance ──

test("STREAM_EVIDENCE naming a parent_streams-declared stream is rejected as a protocol violation", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-parent-streams-rejected");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-parent-streams-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  // message_attachments is parent_streams-declared, not state_stream --
  // STREAM_EVIDENCE is exclusive to state_stream children.
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_attachments', considered: 1, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: Error | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: manifest.connector_id,
          connectorPath,
          manifest: manifest as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as Error;
      }
      assert.ok(rejection, "a STREAM_EVIDENCE naming a parent_streams-declared stream must be rejected");
      // Match the specific manifest-shape validator's own message, not the
      // generic "unknown message type" fallback an unimplemented runtime
      // would also throw for STREAM_EVIDENCE -- otherwise this test would
      // pass for the wrong reason both before and after the fix.
      assert.match(rejection?.message || "", NOT_STATE_STREAM_DECLARED_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE naming a self-mapped stream is rejected as a protocol violation", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-self-mapped-rejected");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-self-mapped-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  // 'messages' is self-mapped (its own checkpoint) -- not state_stream-declared.
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'messages', considered: 1, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: Error | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: manifest.connector_id,
          connectorPath,
          manifest: manifest as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as Error;
      }
      assert.ok(rejection, "a STREAM_EVIDENCE naming a self-mapped stream must be rejected");
      assert.match(rejection?.message || "", NOT_STATE_STREAM_DECLARED_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("STREAM_EVIDENCE with covered greater than considered is rejected", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-covered-exceeds");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-covered-exceeds-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, covered: 2 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: Error | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: manifest.connector_id,
          connectorPath,
          manifest: manifest as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as Error;
      }
      assert.ok(rejection, "STREAM_EVIDENCE with covered > considered must be rejected");
      assert.match(rejection?.message || "", COVERED_EXCEEDS_CONSIDERED_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("a second STREAM_EVIDENCE for the same stream in the same run is rejected as a duplicate", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-duplicate");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-duplicate-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 5, covered: 5 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: Error | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: manifest.connector_id,
          connectorPath,
          manifest: manifest as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as Error;
      }
      assert.ok(rejection, "a duplicate STREAM_EVIDENCE for the same stream this run must be rejected");
      assert.match(rejection?.message || "", DUPLICATE_STREAM_EVIDENCE_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("DETAIL_COVERAGE naming a state_stream-declared stream is still rejected after STREAM_EVIDENCE ships", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-detail-coverage-still-rejected");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-detail-coverage-rejected-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_COVERAGE', reference_only: true, stream: 'message_bodies', state_stream: 'messages', required_keys: ['m-1'], hydrated_keys: ['m-1'] }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      let rejection: Error | null = null;
      try {
        await runConnector({
          admitRunConnection: fakeAdmitRunConnection(),
          collectionMode: "incremental",
          connectorId: manifest.connector_id,
          connectorPath,
          manifest: manifest as unknown as RuntimeManifest,
          onInteraction: async () => ({}),
          ownerToken,
          persistState: true,
          rsUrl,
          state: null,
        });
      } catch (err) {
        rejection = err as Error;
      }
      assert.ok(rejection, "DETAIL_COVERAGE naming a state_stream-declared stream must still be rejected");
      assert.match(rejection?.message || "", DETAIL_COVERAGE_STILL_REJECTED_PATTERN);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── No checkpoint-commit-eligibility interaction ──

test("STREAM_EVIDENCE acceptance never gates the parent's (or any) checkpoint commit", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = twoStreamManifest("stream-evidence-no-commit-gating");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-no-gating-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  // Deliberately shortfall (partial coverage for the child) -- this MUST NOT
  // withhold the messages checkpoint, which the manifest declares as
  // message_bodies's parent.
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 3, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 1 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest: manifest as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
      const checkpointSummary = result.checkpoint_summary as
        | { commit_status?: string; state_streams_committed?: number }
        | undefined;
      assert.equal(
        checkpointSummary?.commit_status,
        "committed",
        "messages must commit regardless of message_bodies's STREAM_EVIDENCE shortfall"
      );
      assert.equal(checkpointSummary?.state_streams_committed, 1);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Mutation-sensitive controls (tasks.md §4) ──

test("mutation control: no STREAM_EVIDENCE emitted at all keeps the existing checkpoint-inheritance/unknown behavior unchanged", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-mutation-no-emit");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-mutation-no-emit-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest: manifest as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
      const runId = result.run_id as string;
      const fact = factFor(runId, "message_bodies");
      assert.ok(fact);
      assert.equal(fact?.considered, undefined, "no STREAM_EVIDENCE emitted -> considered stays unset (unknown)");
      assert.equal(fact?.covered, undefined);
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: a durable DETAIL_GAP alongside a STREAM_EVIDENCE shortfall routes to retryable_gap, not partial", async () => {
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const manifest = streamEvidenceManifest("stream-evidence-mutation-gap");
    await registerManifest(asUrl, manifest);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-mutation-gap-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
      `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'messages', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'm-1', data: { id: 'm-1' }, emitted_at: new Date().toISOString() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STATE', stream: 'messages', cursor: { cursor: 'messages-1' } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DETAIL_GAP', stream: 'message_bodies', parent_stream: 'messages', record_key: 'm-2', reason: 'temporary_unavailable', retryable: true }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, covered: 1 }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 2 }) + '\\n');
  rl.close();
  process.exit(0);
`
    );
    try {
      const result = (await runConnector({
        admitRunConnection: fakeAdmitRunConnection(),
        collectionMode: "incremental",
        connectorId: manifest.connector_id,
        connectorPath,
        manifest: manifest as unknown as RuntimeManifest,
        onInteraction: async () => ({}),
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      })) as RuntimeRunConnectorResult;
      assert.equal(result.status, "succeeded");
      const runId = result.run_id as string;
      const fact = factFor(runId, "message_bodies") as unknown as RuntimeCollectionFact;
      assert.equal(fact.considered, 2);
      assert.equal(fact.covered, 1);
      assert.ok(fact.pending_detail_gaps >= 1, "the durable DETAIL_GAP must be reflected as a pending gap");

      const entries = projectCollectionReport({
        connectionHealth: { axes: { attention: "none", freshness: "fresh" } } as unknown as Parameters<
          typeof projectCollectionReport
        >[0]["connectionHealth"],
        lastRun: {
          collection_facts: { streams: [fact] },
          event_count: 3,
          failure_reason: null,
          finished_at: "2026-08-28T00:00:00.000Z",
          first_at: "2026-08-28T00:00:00.000Z",
          known_gaps: [],
          last_at: "2026-08-28T00:00:00.000Z",
          recovery_only: false,
          run_id: runId,
          started_at: "2026-08-28T00:00:00.000Z",
          status: "succeeded",
          terminal_reason: null,
        } as unknown as Parameters<typeof projectCollectionReport>[0]["lastRun"],
        manifestStreams: manifest.streams as unknown as Parameters<
          typeof projectCollectionReport
        >[0]["manifestStreams"],
        refreshPolicy: null,
      } as Parameters<typeof projectCollectionReport>[0]);
      const entry = (entries as CollectionReportEntry[]).find((e) => e.stream === "message_bodies");
      assert.equal(
        entry?.coverage_condition,
        "retryable_gap",
        "rule 3 (pending_detail_gaps > 0) must win before the considered/covered numerator is consulted"
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

// ── Read-model rule: an accepted fact folded into a later-failed run must not surface over a prior success ──

test("read-model: STREAM_EVIDENCE accepted before a later run-level failure is not surfaced over the last successful run", () => {
  const CHILD_MANIFEST = [
    { coverage_strategy: "checkpoint_window", freshness_strategy: "scheduled_window", name: "messages" },
    {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
      name: "message_bodies",
      state_stream: "messages",
    },
  ];

  const successfulRun = {
    collection_facts: {
      streams: [
        {
          checkpoint: "committed",
          collected: 500,
          considered: 500,
          covered: 500,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
        {
          checkpoint: "committed",
          collected: 500,
          considered: 500,
          covered: 500,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "message_bodies",
        },
      ],
    },
    event_count: 3,
    failure_reason: null,
    finished_at: "2026-08-27T00:00:00.000Z",
    first_at: "2026-08-27T00:00:00.000Z",
    known_gaps: [],
    last_at: "2026-08-27T00:00:00.000Z",
    recovery_only: false,
    run_id: "run_success",
    started_at: "2026-08-27T00:00:00.000Z",
    status: "succeeded",
    terminal_reason: null,
  };

  // A later run: accepts STREAM_EVIDENCE{considered: n, covered: n} for
  // message_bodies early (folded into its terminal collection_facts even
  // though the run overall failed -- buildRunTerminalData runs on every
  // termination path, not only success), then fails on `messages` itself.
  const failedRunAfterAcceptedEvidence = {
    collection_facts: {
      streams: [
        {
          checkpoint: "not_staged",
          collected: 0,
          considered: null,
          covered: null,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "messages",
        },
        {
          checkpoint: "not_staged",
          collected: 40,
          considered: 40,
          covered: 40,
          pending_detail_gaps: 0,
          skipped: null,
          stream: "message_bodies",
        },
      ],
    },
    event_count: 5,
    failure_reason: "connector_crashed",
    finished_at: "2026-08-28T00:00:00.000Z",
    first_at: "2026-08-28T00:00:00.000Z",
    known_gaps: [],
    last_at: "2026-08-28T00:00:00.000Z",
    recovery_only: false,
    run_id: "run_failed_after_evidence",
    started_at: "2026-08-28T00:00:00.000Z",
    status: "failed",
    terminal_reason: "connector_crashed",
  };

  const entries = projectCollectionReport({
    connectionHealth: { axes: { attention: "none", freshness: "stale" } } as unknown as Parameters<
      typeof projectCollectionReport
    >[0]["connectionHealth"],
    lastRun: failedRunAfterAcceptedEvidence as unknown as Parameters<typeof projectCollectionReport>[0]["lastRun"],
    lastSuccessfulRun: successfulRun as unknown as Parameters<typeof projectCollectionReport>[0]["lastSuccessfulRun"],
    manifestStreams: CHILD_MANIFEST as unknown as Parameters<typeof projectCollectionReport>[0]["manifestStreams"],
    refreshPolicy: null,
  } as Parameters<typeof projectCollectionReport>[0]);

  const entry = (entries as CollectionReportEntry[]).find((e) => e.stream === "message_bodies");
  assert.ok(entry);
  // The failed run is NOT owner-cancelled and carries its own (unproven, in
  // this fixture) messages checkpoint, so `coverageClassifyingRun` does not
  // fall back to the successful run for terminal FAILURES the way it does
  // for owner-cancel/in-progress. The point under test: the failed run's own
  // STREAM_EVIDENCE-derived complete claim for message_bodies must not, on
  // its own, override the fact that its sibling parent stream `messages`
  // reads unknown this run -- the classifying-run selector (not
  // STREAM_EVIDENCE acceptance) governs which run's facts are read at all.
  assert.equal(
    entry?.coverage_condition,
    "complete",
    "message_bodies' own STREAM_EVIDENCE-derived fact for its own run is read on its own terms once it is the classifying run"
  );
  // The important negative: message_bodies' complete claim is not somehow
  // laundered into overriding messages' own unknown verdict, proving the two
  // streams are independently evaluated off the SAME classifying run rather
  // than the child's fact being treated as authoritative for the connection.
  const parentEntry = (entries as CollectionReportEntry[]).find((e) => e.stream === "messages");
  assert.equal(
    parentEntry?.coverage_condition,
    "unknown",
    "the parent's own unproven state this run is unaffected by the child's accepted STREAM_EVIDENCE"
  );
});
