// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Regression for run_1786242751717 (live UAT, 2026-08-08).
//
// A run authenticated, ingested real records, and then died with
// terminal_reason=connector_protocol_violation and an EMPTY connector_error_json
// — the owner saw a failure with no explanation at all. The precise reason
// ("Connector detail coverage incomplete: state_stream=... stream=...
// missing_required_keys=1") reached only the container log.
//
// Two distinct defects, both proven from the live DB:
//
// 1. SEVERITY. The connector declared DETAIL_COVERAGE for two child streams off
//    the same parent key. For the key it could not hydrate this run it declared
//    `gap_keys: [key]` on BOTH coverage entries — an honest report — but emitted
//    a durable DETAIL_GAP for only ONE of the two streams. The commit gate
//    matched durable gaps strictly by `gap.stream === coverage.stream`
//    (runtime/index.ts) and never consulted the connector's own `gap_keys`, so
//    the second stream's key counted as unaccounted and the gate THREW,
//    terminating a run whose records were already flushed and durable.
//
//    A DETAIL_COVERAGE shortfall is a coverage GAP, not a protocol violation:
//    the connector spoke a well-formed protocol and told the truth about what it
//    could not reach. The honest response is to report the shortfall and
//    withhold that state_stream's cursor (so the next run re-collects it) — not
//    to fail a run and discard the evidence of work already committed.
//
// 2. REPORTING. The runtime authored a precise `failure_message` onto the
//    terminal spine event, but the run_history writer reassembled
//    connector_error_json from `connector_error_*` fields only. A run the
//    RUNTIME failed carries none of those (the connector reported DONE with no
//    error), so the column was written NULL and the explanation was lost. Live
//    evidence: run_1786242751717 stored connector_error_json=null / error=null
//    while the terminal spine event carried the full failure_message.
//
// Live shape reproduced here connector-agnostically: parent state_stream with
// one required key, two child streams both declaring that key as a gap, only one
// carrying a durable DETAIL_GAP.
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";

import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import { admitOwnerRunConnection } from "../server/stores/connector-instance-store.ts";

// Hoisted: the coverage-shortfall explanation the runtime authors, and the
// connection-scoped denominator the sibling-isolation oracle asserts on.
const SHORTFALL_MESSAGE_PATTERN =
  /Connector detail coverage incomplete: state_stream=holdings stream=valuations missing_required_keys=1/;
const SCOPED_DENOMINATOR_PATTERN = /stream=valuations missing_required_keys=1/;
const HOLDINGS_STATE_STREAM_PATTERN = /state_stream=holdings/;
const ACTIVITY_STATE_STREAM_PATTERN = /state_stream=activity/;
const DUPLICATE_COVERAGE_PATTERN = /duplicate DETAIL_COVERAGE/;
const OVERLAPPING_OUTCOME_PATTERN = /outcome key appears in multiple sets/;

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

type RunConnectorTestOptions = Omit<Parameters<typeof runConnector>[0], "detailGapStore"> & {
  detailGapStore?: unknown;
};
type RunConnectorFn = (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;
const runConnectorWithGapStore = runConnector as RunConnectorFn;

// Mirrors the production `createController({ admitRunConnection: ... })` wiring:
// state-commit ingest checks the bearer token's subject against the target
// instance's owner, so admission must resolve the same subject issueOwnerToken
// approved. Same fixture as detail-coverage-recovered-gap-regression.test.ts.
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

// Connector-agnostic shape of the live failure: one parent state_stream
// ("holdings") whose key fans out to two child detail streams.
const MANIFEST = {
  connector_id: "coverage-shortfall-regression",
  display_name: "Coverage Shortfall Regression",
  manifest_uri: "https://registry.pdpp.dev/connectors/coverage-shortfall-regression",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "holdings",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
    {
      name: "activity",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
    {
      coverage_strategy: "parent_detail_accounting",
      name: "valuations",
      parent_streams: ["holdings", "activity"],
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

function createCannedConnector(messages: readonly Record<string, unknown>[]): {
  connectorPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-coverage-shortfall-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    const messages = ${JSON.stringify(messages)};
    for (const m of messages) process.stdout.write(JSON.stringify(m) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

/**
 * The live message sequence: a record is emitted and flushed, one child stream
 * declares a gap for key K AND carries a durable DETAIL_GAP, the sibling child
 * stream declares the SAME key as a gap but carries NO durable DETAIL_GAP.
 * Before the fix the sibling's key was unaccounted and the gate threw.
 */
function shortfallMessages(): Record<string, unknown>[] {
  return [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      detail_locator: { holding_id: "K", kind: "test.holding" },
      parent_stream: "holdings",
      reason: "temporary_unavailable",
      record_key: "K",
      retryable: true,
      stream: "activity",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: ["K"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "activity",
      type: "DETAIL_COVERAGE",
    },
    // Sibling child stream: same unreachable key, honestly declared as a gap,
    // but with no durable DETAIL_GAP of its own. This is the exact live shape.
    {
      gap_keys: ["K"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];
}

async function runShortfall(
  server: ClosableServer,
  ownerToken: string,
  messages: readonly Record<string, unknown>[],
  connectorInstanceId?: string,
  streams: readonly string[] = ["holdings", "activity", "valuations"]
): Promise<{ result: RuntimeRunConnectorResult | null; thrown: unknown }> {
  const { connectorPath, cleanup } = createCannedConnector(messages);
  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId: MANIFEST.connector_id,
      ...(connectorInstanceId ? { connectorInstanceId } : {}),
      connectorPath,
      detailGapStore: getDefaultConnectorDetailGapStore(),
      manifest: MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${server.rsPort}`,
      scope: { streams: streams.map((name) => ({ name })) },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
  }
  return { result, thrown };
}

async function registerAndAuthorize(server: ClosableServer): Promise<string> {
  const asUrl = `http://localhost:${server.asPort}`;
  await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return await issueOwnerToken(asUrl);
}

// A gap_keys declaration is diagnostic, not retry authority. Without a matching
// durable DETAIL_GAP the runtime must keep the parent checkpoint uncommitted so
// a connector cannot turn an assertion into evidence and strand the detail.
test("a connector-declared gap key without a durable DETAIL_GAP withholds the parent checkpoint", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const { result, thrown } = await runShortfall(server, ownerToken, shortfallMessages());

  assert.equal(thrown, null, "an unbacked coverage gap is incomplete, not a protocol crash");
  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded", "the run keeps the records it already ingested");
  assert.equal(result.records_emitted, 1);
  assert.equal(result.checkpoint_summary?.state_streams_staged, 1);
  assert.equal(result.checkpoint_summary?.state_streams_committed, 0, "the shared holdings parent remains uncommitted");
  assert.equal(result.checkpoint_summary?.commit_status, "not_committed");
});

// Required oracle: two instances of the SAME connector, one REVOKED (holding a
// durable detail gap of its own) and one ACTIVE. A revoked or sibling connection
// must never participate in the active run's coverage authority — neither
// satisfying its required keys nor inflating its denominator. The active run
// must retain its committed records and report its own bounded gap honestly.
test("a revoked sibling connection never participates in the active run's coverage authority", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const store = getDefaultConnectorDetailGapStore() as {
    upsertPendingGap: (input: Record<string, unknown>) => Promise<{ gap_id: string } | null>;
  };

  const revokedInstanceId = "cin_shortfall_revoked_sibling";
  const activeInstanceId = "cin_shortfall_active";

  // The live shape: one connector_id with a revoked connection and an active
  // one. Distinct binding keys — the store keys account bindings by
  // (connector_id, source_binding_key), so a shared key would collapse both
  // onto a single row and there would be no sibling at all.
  const instanceStore = createRequestConnectorInstanceStore();
  for (const [connectorInstanceId, status] of [
    [revokedInstanceId, "revoked"],
    [activeInstanceId, "active"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential fixture seeding.
    await instanceStore.upsert({
      connectorId: MANIFEST.connector_id,
      connectorInstanceId,
      createdAt: "2026-05-20T12:00:00.000Z",
      displayName: "Shortfall Connection",
      ownerSubjectId: "test_user",
      sourceBinding: { account_id: connectorInstanceId, kind: "account" },
      sourceBindingKey: connectorInstanceId,
      sourceKind: "account",
      status,
      updatedAt: "2026-05-20T12:00:00.000Z",
    });
  }

  // The revoked sibling owns a durable pending gap for the SAME record key the
  // active run will require. Scoped to the active run's own connection, this row
  // must be invisible: it belongs to a different connector_instance_id.
  const seeded = await store.upsertPendingGap({
    connectorId: MANIFEST.connector_id,
    connectorInstanceId: revokedInstanceId,
    detailLocator: { holding_id: "K", kind: "test.holding" },
    discoveredRunId: "prior_revoked",
    grantId: null,
    lastError: null,
    lastRunId: "prior_revoked",
    listCursor: null,
    parentStream: "holdings",
    reason: "temporary_unavailable",
    recordKey: "K",
    scope: null,
    source: { id: MANIFEST.connector_id, kind: "connector" },
    stream: "valuations",
  });
  assert.ok(seeded, "the revoked sibling's durable gap is seeded");

  // The active connection declares key K required with nothing to account for it
  // in ITS OWN authority. The sibling's gap must not silently satisfy it.
  const messages: Record<string, unknown>[] = [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages, activeInstanceId);

  assert.equal(thrown, null, "a sibling connection's state must never fail the active run");
  assert.ok(result, "runConnector returned a result");
  // (a) the active run RETAINS its committed records
  assert.equal(result.status, "succeeded");
  assert.equal(result.records_emitted, 1, "the active connection keeps the record it ingested");

  // (b) it reports its OWN bounded gap honestly, computed only from its own
  // connection's authority — the revoked sibling neither satisfied the key nor
  // inflated the denominator (missing_required_keys is 1, not 2).
  const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
  const coverageGap = gaps.find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.ok(coverageGap, "the active run reports its own coverage shortfall");
  assert.match(
    String(coverageGap.message ?? ""),
    SCOPED_DENOMINATOR_PATTERN,
    "the denominator counts only this connection's required keys"
  );
});

// The severity question, proven directly: a coverage shortfall the connector did
// NOT declare (no gap_keys, no durable gap) is still a real shortfall — but it
// must be REPORTED as a gap and withhold that state_stream's cursor, never kill
// a run whose records are already durable.
test("an undeclared coverage shortfall reports a gap and withholds the cursor instead of failing the run", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  // No gap_keys and no DETAIL_GAP anywhere: key K is simply unaccounted for.
  const messages: Record<string, unknown>[] = [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null, "an unproven coverage claim is a reported gap, not a run-killing error");
  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded");
  assert.equal(result.records_emitted, 1, "records already ingested are never discarded");

  // The shortfall is surfaced honestly: a known gap naming the affected stream.
  const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
  const coverageGap = gaps.find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.ok(coverageGap, "the shortfall is reported as a known gap");
  assert.equal(coverageGap.stream, "valuations");
  assert.match(
    String(coverageGap.message ?? ""),
    SHORTFALL_MESSAGE_PATTERN,
    "the gap carries the precise coverage explanation the owner needs"
  );

  // A claim of completeness must carry proof: the unproven state_stream's
  // cursor is withheld so the next run re-collects it.
  assert.ok(result.checkpoint_summary, "result carries a checkpoint_summary");
  assert.equal(
    result.checkpoint_summary.state_streams_committed,
    0,
    "the unproven state_stream's cursor is not advanced"
  );
});

test("one detail stream can independently prove two parent checkpoints", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const messages: Record<string, unknown>[] = [
    { data: { id: "H" }, emitted_at: "2026-04-18T00:00:00Z", key: "H", stream: "holdings", type: "RECORD" },
    { data: { id: "A" }, emitted_at: "2026-04-18T00:00:00Z", key: "A", stream: "activity", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["H"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    {
      hydrated_keys: ["A"],
      reference_only: true,
      required_keys: ["A"],
      state_stream: "activity",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "holdings-1" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 2, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null, "sharing a detail stream across parents is valid when each report names its parent");
  assert.ok(result?.checkpoint_summary);
  assert.equal(result.checkpoint_summary.state_streams_staged, 2);
  assert.equal(
    result.checkpoint_summary.state_streams_committed,
    1,
    "the proven activity cursor commits while the incomplete holdings cursor remains retryable"
  );
  const coverageGap = (result.known_gaps ?? []).find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.equal(coverageGap?.stream, "valuations");
  assert.match(String(coverageGap?.message ?? ""), HOLDINGS_STATE_STREAM_PATTERN);
});

test("a durable gap cannot satisfy the same detail key under a different parent", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const messages: Record<string, unknown>[] = [
    {
      detail_locator: { holding_id: "K", kind: "test.holding" },
      parent_stream: "holdings",
      reason: "temporary_unavailable",
      record_key: "K",
      retryable: true,
      stream: "valuations",
      type: "DETAIL_GAP",
    },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "activity",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "holdings-1" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null);
  assert.ok(result?.checkpoint_summary);
  assert.equal(
    result.checkpoint_summary.state_streams_committed,
    1,
    "the holdings gap accounts only for holdings; activity remains retryable despite sharing key K"
  );
  const coverageGap = (result.known_gaps ?? []).find((gap) => gap.reason === "detail_coverage_incomplete");
  assert.equal(coverageGap?.stream, "valuations");
  assert.match(String(coverageGap?.message ?? ""), ACTIVITY_STATE_STREAM_PATTERN);
});

test("a legacy parentless gap cannot authorize one parent of a manifest-declared multi-parent detail stream", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const messages: Record<string, unknown>[] = [
    {
      detail_locator: { kind: "test.valuation" },
      reason: "temporary_unavailable",
      record_key: "K",
      reference_only: true,
      retryable: true,
      status: "pending",
      stream: "valuations",
      type: "DETAIL_GAP",
    },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "activity",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages, undefined, ["activity", "valuations"]);

  assert.equal(thrown, null);
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 0);
  assert.ok(result?.known_gaps?.some((gap) => gap.reason === "detail_coverage_incomplete"));
});

test("a staged parent without its required detail coverage report cannot commit", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const messages: Record<string, unknown>[] = [
    {
      hydrated_keys: ["H"],
      reference_only: true,
      required_keys: ["H"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "holdings-1" }, stream: "holdings", type: "STATE" },
    { cursor: { page: "activity-1" }, stream: "activity", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];

  const { result, thrown } = await runShortfall(server, ownerToken, messages);

  assert.equal(thrown, null);
  assert.equal(result?.checkpoint_summary?.state_streams_staged, 2);
  assert.equal(result?.checkpoint_summary?.state_streams_committed, 1);
  const missingReport = result?.known_gaps?.find(
    (gap) => gap.reason === "detail_coverage_incomplete" && String(gap.message).includes("coverage_report=missing")
  );
  assert.ok(missingReport, "the missing activity report remains visible instead of silently committing its cursor");
});

test("duplicate coverage reports for one parent boundary fail closed", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const report = {
    hydrated_keys: ["K"],
    reference_only: true,
    required_keys: ["K"],
    state_stream: "holdings",
    stream: "valuations",
    type: "DETAIL_COVERAGE",
  };

  const { result, thrown } = await runShortfall(server, ownerToken, [report, report]);

  assert.equal(result, null);
  assert.match(String(thrown), DUPLICATE_COVERAGE_PATTERN);
});

test("overlapping coverage outcome sets fail closed", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);

  const { result, thrown } = await runShortfall(server, ownerToken, [
    {
      hydrated_keys: ["K"],
      optional_skip_keys: ["K"],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
  ]);

  assert.equal(result, null);
  assert.match(String(thrown), OVERLAPPING_OUTCOME_PATTERN);
});

test("an uncovered detail key leaves its parent retryable and a later complete pass commits it", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const ownerToken = await registerAndAuthorize(server);
  const incomplete = await runShortfall(server, ownerToken, [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "1" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);
  assert.equal(incomplete.thrown, null);
  assert.equal(incomplete.result?.checkpoint_summary?.state_streams_committed, 0);

  const complete = await runShortfall(server, ownerToken, [
    { data: { id: "K" }, emitted_at: "2026-04-18T00:00:00Z", key: "K", stream: "holdings", type: "RECORD" },
    {
      hydrated_keys: ["K"],
      reference_only: true,
      required_keys: ["K"],
      state_stream: "holdings",
      stream: "valuations",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { page: "2" }, stream: "holdings", type: "STATE" },
    { records_emitted: 1, status: "succeeded", type: "DONE" },
  ]);
  assert.equal(complete.thrown, null);
  assert.equal(complete.result?.checkpoint_summary?.state_streams_committed, 1);
});
