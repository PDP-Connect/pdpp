// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Crash seam oracle for STREAM_EVIDENCE:
 *
 *   durable claim(payload + digest + event id)
 *                 | injected crash
 *   terminal run.stream_evidence_declared event
 *
 * The replay is allowed to complete the exact already-validated claim. It is
 * not allowed to accept a divergent payload or to append a second terminal
 * event. No replay path derives a new completeness fact.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
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

const typedStartServer = startServerUntyped as unknown as (opts: {
  asPort?: number;
  dbPath?: string;
  quiet?: boolean;
  rsPort?: number;
}) => Promise<ClosableServer>;

async function closeServer(server: ClosableServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const close = (httpServer: { close: (cb: (err?: Error) => void) => void }) =>
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 2000);
      httpServer.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  await Promise.allSettled([
    close(server.asServer),
    close(server.rsServer),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<{ body: T; status: number }> {
  const response = await fetch(url, init);
  return { body: (await response.json()) as T, status: response.status };
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const device = await fetchJson<{ device_code: string; user_code: string }>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "test_user", user_code: device.body.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const token = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: "cli_longview",
      device_code: device.body.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return token.body.access_token;
}

function fakeAdmitRunConnection() {
  return async ({
    connectorId,
    connectorInstanceId: requestedConnectorInstanceId,
    ownerSubjectId,
  }: {
    connectorId: string;
    connectorInstanceId: string | null;
    ownerSubjectId: string | null;
  }) => {
    const namespace = await admitOwnerRunConnection({
      connectorId,
      connectorInstanceId: requestedConnectorInstanceId,
      connectorInstanceStore: createRequestConnectorInstanceStore(),
      ownerSubjectId: ownerSubjectId || "test_user",
    });
    return {
      connectorId: namespace.connectorId,
      connectorInstanceId: namespace.connectorInstanceId,
      ownerSubjectId: ownerSubjectId || "test_user",
    };
  };
}

const MANIFEST = {
  capabilities: { human_interaction: [] },
  connector_id: "stream-evidence-crash-replay",
  display_name: "STREAM_EVIDENCE crash replay",
  manifest_uri: "https://sources.example/stream-evidence-crash-replay",
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

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

function writeConnector(tmpDir: string, body: string): string {
  const path = join(tmpDir, "connector.mjs");
  writeFileSync(
    path,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  ${body}
});
`,
    "utf8"
  );
  return path;
}

const runId = "run_stream_evidence_crash_replay";
const connectorInstanceId = "cin_stream_evidence_crash_replay";
const CRASH_PATTERN = /injected crash after STREAM_EVIDENCE claim|connector_protocol_violation/i;
const DUPLICATE_PATTERN = /duplicate STREAM_EVIDENCE/i;
const DIGEST_MISMATCH_PATTERN = /digest mismatch/i;

async function seedConnectorInstance(): Promise<void> {
  const now = new Date().toISOString();
  getDb()
    .prepare("INSERT OR IGNORE INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)")
    .run(MANIFEST.connector_id, JSON.stringify(MANIFEST), now);
  await createRequestConnectorInstanceStore().upsert({
    connectorId: MANIFEST.connector_id,
    connectorInstanceId,
    createdAt: now,
    displayName: "STREAM_EVIDENCE crash replay",
    ownerSubjectId: "test_user",
    sourceBinding: { fixture: "stream-evidence-crash-replay" },
    sourceBindingKey: "stream-evidence-crash-replay",
    sourceKind: "manual",
    status: "active",
    updatedAt: now,
  });
}

async function run(
  server: ClosableServer,
  ownerToken: string,
  connectorPath: string,
  extra: Partial<Parameters<typeof runConnector>[0]> = {}
): Promise<RuntimeRunConnectorResult> {
  return (await runConnector({
    admitRunConnection: fakeAdmitRunConnection(),
    collectionMode: "incremental",
    connectorId: MANIFEST.connector_id,
    connectorInstanceId,
    connectorPath,
    manifest: MANIFEST as unknown as RuntimeManifest,
    onInteraction: async () => ({}),
    ownerToken,
    persistState: true,
    rsUrl: `http://localhost:${server.rsPort}`,
    runId,
    state: null,
    ...extra,
  })) as RuntimeRunConnectorResult;
}

test("STREAM_EVIDENCE claim crash replays its exact payload after restart and remains at-most-once", async () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-crash-replay-"));
  const dbPath = join(root, "pdpp.sqlite");
  const firstConnectorDir = mkdtempSync(join(root, "first-"));
  const replayConnectorDir = mkdtempSync(join(root, "replay-"));
  const divergentConnectorDir = mkdtempSync(join(root, "divergent-"));
  const firstConnector = writeConnector(
    firstConnectorDir,
    `
  process.stdout.write(JSON.stringify({ type: 'RECORD', stream: 'message_bodies', key: 'body-1', data: { id: 'body-1' }, emitted_at: '2026-08-29T00:00:00.000Z' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  setTimeout(() => process.exit(3), 250);
`
  );
  const replayConnector = writeConnector(
    replayConnectorDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 1, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 0 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );
  const divergentConnector = writeConnector(
    divergentConnectorDir,
    `
  process.stdout.write(JSON.stringify({ type: 'STREAM_EVIDENCE', reference_only: true, stream: 'message_bodies', considered: 2, outcomes: { emitted: 1, unchanged: 0, gapped: 0, unaccounted: 1 } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.exit(0);
`
  );

  let firstServer: ClosableServer | null = null;
  let secondServer: ClosableServer | null = null;
  try {
    firstServer = await typedStartServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    await seedConnectorInstance();
    const firstToken = await issueOwnerToken(`http://localhost:${firstServer.asPort}`);
    await assert.rejects(
      run(firstServer, firstToken, firstConnector, {
        testOnlyStreamEvidenceAfterClaimFaultInjector: () => {
          throw new Error("injected crash after STREAM_EVIDENCE claim");
        },
      }),
      CRASH_PATTERN
    );

    const claim = getDb()
      .prepare(
        "SELECT payload_json, replay_identity_json, payload_digest, event_id FROM stream_evidence_run_registry WHERE run_id = ? AND stream = ?"
      )
      .get(runId, "message_bodies") as
      | {
          event_id: string;
          payload_digest: string;
          payload_json: string;
          replay_identity_json: string;
        }
      | undefined;
    if (!claim) {
      throw new Error("the crash leaves a durable claim");
    }
    assert.equal(typeof claim.payload_json, "string", "the durable claim carries normalized payload");
    assert.equal(typeof claim.replay_identity_json, "string", "the durable claim carries replay identity");
    assert.equal(typeof claim.payload_digest, "string", "the durable claim carries payload digest");
    const beforeReplayEvidence = getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM spine_events WHERE event_type = 'run.stream_evidence_declared' AND run_id = ? AND stream_id = ?"
      )
      .get(runId, "message_bodies") as { count: number };
    assert.equal(beforeReplayEvidence.count, 0, "the injected crash occurs before terminal evidence persistence");

    await closeServer(firstServer);
    firstServer = null;
    secondServer = await typedStartServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    const replayToken = await issueOwnerToken(`http://localhost:${secondServer.asPort}`);
    const replay = await run(secondServer, replayToken, replayConnector);
    assert.equal(replay.status, "succeeded", "restart/replay completes the exact persisted claim");

    const terminalRows = getDb()
      .prepare(
        "SELECT event_id, data_json FROM spine_events WHERE event_type = 'run.stream_evidence_declared' AND run_id = ? AND stream_id = ?"
      )
      .all(runId, "message_bodies") as Array<{ data_json: string; event_id: string }>;
    assert.equal(terminalRows.length, 1, "the replay writes exactly one terminal evidence event");
    assert.equal(terminalRows[0]?.event_id, claim.event_id, "replay uses the claim's stable event identity");
    assert.equal(JSON.stringify(JSON.parse(terminalRows[0]?.data_json || "{}")), claim.payload_json);

    await assert.rejects(
      run(secondServer, replayToken, replayConnector),
      DUPLICATE_PATTERN,
      "an exact replay after terminal persistence remains at-most-once"
    );
    const afterExactReplayEvidence = getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM spine_events WHERE event_type = 'run.stream_evidence_declared' AND run_id = ? AND stream_id = ?"
      )
      .get(runId, "message_bodies") as { count: number };
    assert.equal(afterExactReplayEvidence.count, 1, "an exact replay cannot append a second terminal evidence event");

    await assert.rejects(
      run(secondServer, replayToken, divergentConnector),
      DIGEST_MISMATCH_PATTERN,
      "a replay with a divergent normalized payload is rejected before acceptance"
    );
    const afterDivergentReplayEvidence = getDb()
      .prepare(
        "SELECT COUNT(*) AS count FROM spine_events WHERE event_type = 'run.stream_evidence_declared' AND run_id = ? AND stream_id = ?"
      )
      .get(runId, "message_bodies") as { count: number };
    assert.equal(
      afterDivergentReplayEvidence.count,
      1,
      "digest mismatch cannot append another terminal evidence event"
    );
  } finally {
    if (secondServer) {
      await closeServer(secondServer);
    }
    if (firstServer) {
      await closeServer(firstServer);
    }
    rmSync(root, { force: true, recursive: true });
  }
});
