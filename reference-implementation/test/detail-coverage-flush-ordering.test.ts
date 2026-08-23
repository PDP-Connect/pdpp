// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// A DETAIL_COVERAGE claim must not become durable before the records it
// claims. Records are buffered in memory and flushed to the RS only at
// BATCH_SIZE (500) or at DONE, but a coverage message carries an explicit
// numeric `covered` count that the read model trusts verbatim:
// `evaluateStreamCoherence` (packages/reference-contract/src/evidence/
// coherence.ts) compares `covered` against `considered` and NEVER consults
// `collected`. So a connector that emits DETAIL_COVERAGE{considered:N,
// covered:N} for a batch still sitting in memory, and then dies before that
// batch flushes, leaves behind a durable claim of full coverage over records
// that never reached the database — and the terminal fact block is still
// written on the failure path, so the lie survives the run.
//
// The fix is the ordering rule the state and gap-recovery handlers already
// apply (`handleStateMessage` flushes its stream, `handleDetailGapRecovered`
// flushes everything): `handleDetailCoverageMessage` flushes first, so the
// records are durable at the instant the claim is.
//
// This test pins that ordering against the real substrate. It runs a fixture
// connector that emits a handful of records (far under BATCH_SIZE, so they
// stay buffered), emits DETAIL_COVERAGE with covered === considered === the
// record count, and then dies WITHOUT a DONE — the end-of-run flush never
// happens. Two facts must hold afterward:
//
//   1. The records are durable — queryable in the record store — even though
//      the run failed and no DONE-time flush ever ran.
//   2. The spine proves the ordering, not just the outcome: the
//      `run.batch_ingested` event that made those records durable precedes
//      the `run.detail_coverage_declared` event that made the claim durable.
//
// Assertion 2 is what makes this a regression test for the ORDERING rather
// than for any flush at all: without the fix both events can still exist in
// some runs (a later batch or a DONE flush), but the coverage claim lands
// first, which is precisely the window in which a crash strands the lie.
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

/**
 * `server/index.ts` exposes the migrated server surface. This test keeps the
 * narrow handle below so its teardown contract stays explicit — same shape
 * `detail-coverage-recovered-gap-regression.test.ts` uses.
 */
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

// Real state-commit ingest (the `rsUrl` writes this test drives through)
// checks the bearer token's own subject against the target connector
// instance's owner and 403s on `connector_instance_owner_mismatch` — so
// admission MUST resolve the same subject `issueOwnerToken` approved
// ('test_user'). Mirrors the production wiring in server/index.ts's
// `createController({ admitRunConnection: ... })`.
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
  connector_id: "coverage-flush-ordering",
  display_name: "Coverage Flush Ordering Regression",
  manifest_uri: "https://sources.example/coverage-flush-ordering",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "conversations",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
    {
      name: "messages",
      primary_key: ["id"],
      schema: {
        properties: { conversation_id: { type: "string" }, id: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

type RuntimeManifest = Parameters<typeof runConnector>[0]["manifest"];

function runtimeManifest(manifest: {
  streams: ReadonlyArray<{ name: string; selection?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}): RuntimeManifest {
  return {
    ...manifest,
    streams: manifest.streams.map((stream) => {
      const { selection: _selection, ...withoutSelection } = stream;
      return withoutSelection;
    }),
  };
}

/**
 * A fixture connector that writes `messages` and then dies mid-protocol.
 *
 * The `exitAfterMessages` cut is what reproduces the live shape: the child
 * emits its records and its coverage claim, then exits non-zero WITHOUT a
 * DONE — so the runtime's end-of-run flush never runs, and the only thing
 * that can make those records durable is a flush the coverage handler itself
 * performed.
 */
function createDyingConnector(messages: readonly Record<string, unknown>[]): {
  connectorPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-coverage-flush-ordering-"));
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

test("a DETAIL_COVERAGE claim must not outlive its records: the flush precedes the claim", async (t) => {
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

  // Five records — far under BATCH_SIZE (500), so nothing flushes on its own.
  // Then a coverage claim that accounts for exactly those five as hydrated,
  // with the explicit numeric `covered`/`considered` pair the read model
  // trusts verbatim. Then death: no DONE, no end-of-run flush.
  const messages: Record<string, unknown>[] = [
    ...RECORD_KEYS.map((key) => ({
      data: { conversation_id: "C1", id: key },
      emitted_at: "2026-08-23T12:00:00.000Z",
      key,
      stream: "messages",
      type: "RECORD",
    })),
    {
      considered: RECORD_KEYS.length,
      covered: RECORD_KEYS.length,
      gap_keys: [],
      hydrated_keys: [...RECORD_KEYS],
      reference_only: true,
      required_keys: [...RECORD_KEYS],
      state_stream: "conversations",
      stream: "messages",
      type: "DETAIL_COVERAGE",
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
      manifest: runtimeManifest(MANIFEST),
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "conversations" }, { name: "messages" }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
  }

  // The run legitimately fails — the connector died. What must NOT happen is
  // a surviving coverage claim over records that died with it.
  const runId = result?.run_id ?? (thrown as { run_id?: string } | null)?.run_id ?? null;
  assert.ok(runId, "the failed run still carries a run_id to audit");

  const events = getDb()
    .prepare(
      `SELECT event_seq, event_type, stream_id, data_json
       FROM spine_events
       WHERE run_id = ? AND event_type IN ('run.batch_ingested', 'run.detail_coverage_declared')
       ORDER BY event_seq`
    )
    .all<SpineEventRow>(runId);

  const coverageEvent = events.find((e) => e.event_type === "run.detail_coverage_declared");
  assert.ok(coverageEvent, "the run declared detail coverage (the claim under test was made)");
  const coverageData = JSON.parse(coverageEvent.data_json) as Record<string, unknown>;
  assert.equal(coverageData.covered, RECORD_KEYS.length, "the claim asserts full coverage of all five records");
  assert.equal(coverageData.considered, RECORD_KEYS.length);

  // The ordering assertion. A `run.batch_ingested` for `messages` must exist
  // AND precede the claim: the records were durable before the claim was.
  // Without the flush in `handleDetailCoverageMessage` there is no such event
  // at all on this path — the batch dies buffered — so the claim stands alone
  // over nothing.
  const ingestEvent = events.find((e) => e.event_type === "run.batch_ingested" && e.stream_id === "messages");
  assert.ok(
    ingestEvent,
    "the buffered records were flushed to the record store — a coverage claim over unflushed records is a lie the run leaves behind"
  );
  assert.ok(
    ingestEvent.event_seq < coverageEvent.event_seq,
    `the flush must precede the claim (batch_ingested seq ${ingestEvent.event_seq} vs detail_coverage_declared seq ${coverageEvent.event_seq})`
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
    .prepare(`SELECT record_key FROM records WHERE stream = 'messages' ORDER BY record_key`)
    .all<{ record_key: string }>();
  assert.deepEqual(
    durableKeys.map((row) => row.record_key).filter((key) => (RECORD_KEYS as readonly string[]).includes(key)),
    [...RECORD_KEYS],
    "every record the coverage claim accounts for is durable in the record store"
  );
});
