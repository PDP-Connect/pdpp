// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Permanent, reviewable oracle for the STREAM_EVIDENCE accepted-keys
 * store's teardown guarantee under a genuine fault in the terminal-
 * processing callback.
 *
 * Independent re-review (STREAM-EVIDENCE-P1-2-REREVIEW.md item 4) found
 * the prior round's proof of this property used a temporary, fully-
 * reverted source mutation (an unconditional throw manually inserted,
 * observed, then removed) rather than a permanent test — leaving no
 * reviewable receipt after the fact. This file closes that gap using
 * `testOnlyTerminalProcessingFaultInjector`
 * (`RuntimeRunConnectorOptions`, runtime/index.ts): a dependency-injection
 * seam in the same family as `ingestRetrySleep`/`ingestRetryRandom` —
 * defaults to a no-op, never affects production (no caller outside a test
 * sets it), and exists solely so a test can inject a controlled failure at
 * the EXACT point independent review named (inside the terminal-processing
 * callback's own `try`, before any of its fallible work such as timer
 * teardown or stderr redaction) and observe the outcome.
 *
 * The property under test: `childTerminalEvent.then(async (terminalEvent)
 * => { try { ...fallible work... } finally { cleanupChildHandles(); } })`
 * must release every child handle — in particular the STREAM_EVIDENCE
 * accepted-keys temp store `acceptedKeysDb.close()` owns — even when the
 * work INSIDE that try throws before reaching any of the run's own named
 * terminal handlers (`resolveClosedRun`, `handleDoneClose`,
 * `rejectAfterLeaseAccounting`), each of which already calls
 * `cleanupChildHandles()` on its own path. This test defeats all of those
 * named paths by injecting the fault before any of them run, isolating the
 * `finally` wrapper itself as the thing under test.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

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

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return async ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "test_user";
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId,
    });
    return { connectorId: namespace.connectorId, connectorInstanceId: namespace.connectorInstanceId, ownerSubjectId };
  };
}

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

async function registerManifest(asUrl: string, m: ReturnType<typeof manifest>): Promise<void> {
  const resp = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(m),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
}

function acceptedKeysTempDirsUnder(tmpRoot: string): string[] {
  return readdirSync(tmpRoot).filter((name) => name.startsWith("pdpp-stream-evidence-accepted-keys-"));
}

/**
 * Scopes `os.tmpdir()` to a private directory for the duration of `fn`, so
 * this test's own temp-store assertions cannot race another test FILE's
 * runs under the project's file-concurrency test runner (the same
 * technique `stream-evidence-accepted-keys.test.ts`'s own cancellation
 * teardown test uses, for the identical reason).
 */
async function withPrivateTmpRoot<T>(fn: (tmpRoot: string) => Promise<T>): Promise<T> {
  const tmpRoot = mkdtempSync(join(tmpdir(), "pdpp-teardown-fault-injection-private-tmp-root-"));
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

test("teardown: an injected fault in the terminal-processing callback, after its own message-queue drain and before any terminal-finalization handler, still releases the accepted-keys temp store", async () => {
  // `testOnlyTerminalProcessingFaultInjector` fires strictly after
  // `await waitForQueueDrain()` (runtime/index.ts), which is what makes
  // this fixture race-free: the connector's own async message queue is
  // guaranteed fully processed -- including the STREAM_EVIDENCE handler's
  // own `await flushAll()` durably accepting the message_bodies record --
  // before the injector can fire, regardless of how quickly the child
  // process itself exits afterward (test/stream-evidence-flush-ordering.test.ts
  // documents why that ordering is not implied by process exit alone).
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-teardown-fault-injection");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-teardown-fault-injection-connector-"));
    // A normal, successful run that durably accepts one message_bodies
    // record and emits a passing STREAM_EVIDENCE -- the accepted-keys store
    // is genuinely non-empty by the time the terminal-processing callback
    // fires, so this proves cleanup on a REAL populated store, not an
    // already-empty one.
    const connectorPath = writeConnectorStub(
      tmpDir,
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
      await withPrivateTmpRoot(async (tmpRoot) => {
        const INJECTED_ERROR_MESSAGE = "PERMANENT_ORACLE_INJECTED_TEARDOWN_FAULT";
        let injectorCalled = false;

        let thrown: unknown = null;
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
            testOnlyTerminalProcessingFaultInjector: () => {
              injectorCalled = true;
              throw new Error(INJECTED_ERROR_MESSAGE);
            },
          });
        } catch (err) {
          thrown = err;
        }

        assert.ok(
          injectorCalled,
          "the fault-injection seam must actually have been invoked for this assertion to mean anything"
        );
        assert.ok(thrown instanceof Error, "the injected fault must propagate as the run's rejection");
        assert.equal(
          (thrown as Error).message,
          INJECTED_ERROR_MESSAGE,
          "the run must reject with the EXACT injected error, proving the fault fired where intended and was not swallowed or replaced"
        );

        const leftover = acceptedKeysTempDirsUnder(tmpRoot);
        assert.deepEqual(
          leftover,
          [],
          "the accepted-keys temp directory must be removed even when the terminal-processing callback's own pre-cleanup work throws"
        );
      });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});

test("mutation control: with no fault injected, the same run succeeds normally and still cleans up", async () => {
  // Proves the seam itself is inert by default (no test sets it in
  // production, and this test doesn't set it either) -- the injected-fault
  // test above is discriminating specifically because of the injector, not
  // because something else about this fixture always fails or always
  // cleans up regardless.
  const { server, asUrl, rsUrl, ownerToken } = await setupServer();
  try {
    const m = manifest("stream-evidence-teardown-fault-injection-control");
    await registerManifest(asUrl, m);
    const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-teardown-fault-injection-control-"));
    const connectorPath = writeConnectorStub(
      tmpDir,
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
        assert.equal(result.status, "succeeded", "with no injected fault, the run must succeed normally");
        const leftover = acceptedKeysTempDirsUnder(tmpRoot);
        assert.deepEqual(leftover, [], "cleanup must still happen on the ordinary success path");
      });
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  } finally {
    await closeServer(server);
  }
});
