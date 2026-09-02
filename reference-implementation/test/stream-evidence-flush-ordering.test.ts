// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A STREAM_EVIDENCE claim must not become durable before the records it
// claims. Records are buffered in memory and flushed to the RS only at
// BATCH_SIZE (500) or at DONE, but STREAM_EVIDENCE carries an explicit
// numeric `outcomes.emitted` count the read model trusts (via a derived
// `covered`, see connector-gap-bounding.ts) that
// `evaluateStreamCoherence` (packages/reference-contract/src/evidence/
// coherence.ts) compares against `considered` and NEVER consults
// `collected`. So a connector that emits STREAM_EVIDENCE{considered: N,
// outcomes: {emitted: N, ...}} for a batch still sitting in memory, and then
// dies before that batch flushes, leaves behind a durable claim of full
// coverage over records that never reached the database -- and the terminal
// fact block is still written on the failure path, so the lie survives the
// run. `handleStreamEvidenceMessage` additionally checks `outcomes.emitted`
// against this run's own distinct-accepted-key set, which is populated by
// the SAME flush this test pins the ordering of.
//
// handleStreamEvidenceMessage carries `await flushAll()` before tracking the
// fact, mirroring handleDetailCoverageMessage's identical ordering rule (see
// test/detail-coverage-flush-ordering.test.ts, whose header names this exact
// failure mode). Deleting that flush leaves the entire STREAM_EVIDENCE test
// suite green (verified: 11/11 pass with the flush removed) -- it is a
// consequence with no independent test, which this file closes.
//
// This test pins that ordering against the real substrate. It runs a
// fixture connector that emits a message_bodies record (a state_stream
// child of messages, per the manifest shape STREAM_EVIDENCE exists for),
// emits STREAM_EVIDENCE with covered === considered === the record count,
// and then dies WITHOUT a DONE -- the end-of-run flush never happens. Two
// facts must hold afterward:
//
//   1. The record is durable -- queryable in the record store -- even
//      though the run failed and no DONE-time flush ever ran.
//   2. The spine proves the ordering, not just the outcome: the
//      `run.batch_ingested` event that made the record durable precedes
//      the `run.stream_evidence_declared` event that made the claim
//      durable.
//
// Assertion 2 is what makes this a regression test for the ORDERING rather
// than for any flush at all: without the fix both events can still exist in
// some runs (a later batch or a DONE flush), but the coverage claim lands
// first, which is precisely the window in which a crash strands the lie.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
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

const typedStartServer = startServer as unknown as (opts: StartServerOptions) => Promise<ClosableServer>;

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

interface FetchJsonResult<T> {
  body: T;
  status: number;
}

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

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const body = (await resp.json()) as T;
  return { body, status: resp.status };
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function issueOwnerToken(asUrl: string): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorizationResponse>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "test_user", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
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

const MANIFEST = {
  connector_id: "stream-evidence-flush-ordering",
  display_name: "STREAM_EVIDENCE Flush Ordering Regression",
  manifest_uri: "https://sources.example/stream-evidence-flush-ordering",
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
  version: "1.0.0",
};

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

/**
 * A fixture connector that writes `message_bodies` and then dies mid-protocol.
 *
 * The `exitAfterMessages` cut is what reproduces the live shape: the child
 * emits its records and its STREAM_EVIDENCE claim, then exits non-zero
 * WITHOUT a DONE -- so the runtime's end-of-run flush never runs, and the
 * only thing that can make those records durable is a flush the
 * STREAM_EVIDENCE handler itself performed.
 */
function createDyingConnector(messages: readonly Record<string, unknown>[]): {
  connectorPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-stream-evidence-flush-ordering-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    // Die without DONE, the way a crashed provider session does. Give stdout
    // a tick to drain so the runtime observes every message above before the
    // exit; the point under test is the ordering of durable writes, not a
    // race on the pipe itself.
    setTimeout(() => process.exit(3), 250);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

interface SpineEventRow {
  readonly data_json: string;
  readonly event_seq: number;
  readonly event_type: string;
  readonly stream_id: string | null;
}

const RECORD_KEYS = ["m1", "m2", "m3", "m4", "m5"] as const;

test("a STREAM_EVIDENCE claim must not outlive its records: the flush precedes the claim", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;

  // Five records -- far under BATCH_SIZE (500), so nothing flushes on its
  // own. Then a STREAM_EVIDENCE claim that accounts for exactly those five
  // as emitted, with the explicit outcomes/considered shape the read model
  // trusts verbatim (covered is derived as emitted + unchanged at fold time).
  // Then death: no DONE, no end-of-run flush.
  const messages: Record<string, unknown>[] = [
    {
      data: { cursor: "messages-1" },
      emitted_at: "2026-08-28T12:00:00.000Z",
      key: "messages-1",
      stream: "messages",
      type: "STATE",
    },
    ...RECORD_KEYS.map((key) => ({
      data: { id: key },
      emitted_at: "2026-08-28T12:00:00.000Z",
      key,
      stream: "message_bodies",
      type: "RECORD",
    })),
    {
      considered: RECORD_KEYS.length,
      outcomes: { emitted: RECORD_KEYS.length, gapped: 0, unaccounted: 0, unchanged: 0 },
      reference_only: true,
      stream: "message_bodies",
      type: "STREAM_EVIDENCE",
    },
  ];
  const { connectorPath, cleanup } = createDyingConnector(messages);

  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnector({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      manifest: MANIFEST as unknown as RuntimeManifest,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "messages" }, { name: "message_bodies" }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
  }

  // The run legitimately fails -- the connector died. What must NOT happen
  // is a surviving coverage claim over records that died with it.
  const runId = result?.run_id ?? (thrown as { run_id?: string } | null)?.run_id ?? null;
  assert.ok(runId, "the failed run still carries a run_id to audit");

  const events = getDb()
    .prepare(
      `SELECT event_seq, event_type, stream_id, data_json
       FROM spine_events
       WHERE run_id = ? AND event_type IN ('run.batch_ingested', 'run.stream_evidence_declared')
       ORDER BY event_seq`
    )
    .all<SpineEventRow>(runId);

  const evidenceEvent = events.find((e) => e.event_type === "run.stream_evidence_declared");
  assert.ok(evidenceEvent, "the run declared STREAM_EVIDENCE (the claim under test was made)");
  const evidenceData = JSON.parse(evidenceEvent.data_json) as Record<string, unknown>;
  const evidenceOutcomes = evidenceData.outcomes as { emitted: number };
  assert.equal(evidenceOutcomes.emitted, RECORD_KEYS.length, "the claim asserts full coverage of all five records");
  assert.equal(evidenceData.considered, RECORD_KEYS.length);

  // The ordering assertion. A `run.batch_ingested` for `message_bodies` must
  // exist AND precede the claim: the records were durable before the claim
  // was. Without the flush in `handleStreamEvidenceMessage` there is no such
  // event at all on this path -- the batch dies buffered -- so the claim
  // stands alone over nothing.
  const ingestEvent = events.find((e) => e.event_type === "run.batch_ingested" && e.stream_id === "message_bodies");
  assert.ok(
    ingestEvent,
    "the buffered records were flushed to the record store — a coverage claim over unflushed records is a lie the run leaves behind"
  );
  assert.ok(
    ingestEvent.event_seq < evidenceEvent.event_seq,
    `the flush must precede the claim (batch_ingested seq ${ingestEvent.event_seq} vs stream_evidence_declared seq ${evidenceEvent.event_seq})`
  );
  const ingestData = JSON.parse(ingestEvent.data_json) as Record<string, unknown>;
  assert.equal(
    ingestData.records_accepted,
    RECORD_KEYS.length,
    "every claimed record was accepted, not just attempted"
  );

  // Durability itself, read from the record store rather than inferred from
  // the run's own events: the five records the claim covers are queryable
  // after the connector's death.
  const durableKeys = getDb()
    .prepare(`SELECT record_key FROM records WHERE stream = 'message_bodies' ORDER BY record_key`)
    .all<{ record_key: string }>();
  assert.deepEqual(
    durableKeys.map((row) => row.record_key).filter((key) => (RECORD_KEYS as readonly string[]).includes(key)),
    [...RECORD_KEYS],
    "every record the STREAM_EVIDENCE claim covers is durable in the record store"
  );
});
