// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Regression for run_1780695286180 (ChatGPT terminal connector_protocol_violation
// after the capped-tail gap materialization fix on main 37f8fcac).
//
// Root cause: a conversation whose durable detail gap is already `recovered`
// (this run's recovery pass, or a prior run) is re-deferred by the SAME run's
// run-cap forward pass with the IDENTICAL gap identity. The store's
// upsertPendingGap ON CONFLICT pins the row to `recovered`
// (`status = CASE WHEN ... = 'recovered' THEN 'recovered' ELSE 'pending' END`),
// so it never re-opens to `pending`. The forward DETAIL_COVERAGE still lists the
// key as required (hydrated_keys empty, because the run budget was spent in the
// recovery pass), but the commit gate `assertDetailCoverageSatisfiedBeforeCommit`
// builds its satisfied set only from `status === 'pending'` gaps. The key is
// neither hydrated, nor optional-skip, nor pending -> the gate throws
// "Connector detail coverage incomplete" and the whole run terminates as
// connector_protocol_violation with 0 of N state streams committed.
//
// Live evidence (run_1780695286180, rev 37f8fcac): records_flushed=459,
// state_streams_staged=6, committed=0, known_gaps count=2221
// (retry_exhausted=2219, not_committed=1, connector_protocol_violation=1).
// Forward coverage: required_keys=2490, hydrated_keys=0, gap_keys=2129.
// 451 message record_keys had a `recovered` store row with NO `pending` row;
// 90 of them were re-emitted as run-cap DETAIL_GAPs this run and stayed
// `recovered`.
//
// The commit gate counts a `recovered` durable gap as satisfying a required key,
// because a recovered gap means the detail was obtained rather than missing.
import test from "node:test";
import { listSpineEventsPage } from "../lib/spine.ts";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
import {
  admitOwnerRunConnection,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";

/**
 * `server/index.ts` now exposes the migrated server surface. This test keeps
 * the narrow handle below so its teardown contract remains explicit.
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

type RunConnectorTestOptions = Omit<Parameters<typeof runConnector>[0], "detailGapStore"> & {
  detailGapStore?: unknown;
};
type RunConnectorFn = (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;
const runConnectorWithGapStore = runConnector as RunConnectorFn;

// Real state-commit ingest (the `rsUrl` writes every test here drives through)
// checks the bearer token's own subject against the target connector
// instance's owner and 403s on `connector_instance_owner_mismatch` — so
// admission MUST resolve the same subject `issueOwnerToken` approved
// ('test_user'), not the detail-gap store's own hardcoded default subject.
// Mirrors the production wiring in server/index.ts's
// `createController({ admitRunConnection: ... })` and the identical fixture
// already applied in event-spine.test.ts and collection-profile.test.ts.
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
 * `getDefaultConnectorDetailGapStore()` returns `unknown` (server/stores/
 * connector-detail-gap-store.ts — the SQLite/Postgres backends are not
 * modeled as a shared exported interface). Same pattern as
 * `ref-connectors-connection-projection.test.ts`: type only the methods this
 * file actually calls, against the real per-backend implementations'
 * signatures.
 */
interface DetailGapForTest {
  readonly gap_id: string;
  readonly recovered_run_id: string | null;
  readonly status: string;
  readonly [key: string]: unknown;
}

interface DetailGapStoreForTest {
  getGapById: (gapId: string) => Promise<DetailGapForTest | null>;
  listPendingGaps: (...args: unknown[]) => Promise<null>;
  markGapStatus: (gapId: string, status: string, options?: { runId?: string }) => Promise<DetailGapForTest | null>;
  markLeasedGapAttempt: (...args: unknown[]) => Promise<null>;
  settleLeasedGapPending: (...args: unknown[]) => Promise<null>;
  settleLeasedGapRecovered: (...args: unknown[]) => Promise<null>;
  upsertPendingGap: (input: Record<string, unknown>) => Promise<DetailGapForTest | null>;
}

function getTestDetailGapStore(): DetailGapStoreForTest {
  return getDefaultConnectorDetailGapStore() as DetailGapStoreForTest;
}

/**
 * `runtime/connector-gap-bounding.ts`'s `buildKnownGap` returns
 * `Record<string, unknown>` (its `scope`/`recovery_hint` are genuinely
 * dynamic bags assembled from connector-supplied fields) and
 * `RuntimeRunConnectorResult.known_gaps` inherits that looseness. This test
 * only reads the `kind` / `scope.record_key` / `recovery_hint.action` fields
 * a `detail_gap`-kind known_gap actually carries (see the
 * `kind: 'detail_gap'` / `scope: { record_key, parent_stream }` /
 * `recovery_hint: normalizeRecoveryHint(...)` call sites in
 * runtime/index.ts), so narrow to that shape locally rather than trust the
 * loose `Record<string, unknown>`.
 */
interface DetailGapKnownGapForTest {
  readonly kind: "detail_gap";
  readonly recovery_hint?: { readonly action?: string };
  readonly scope?: { readonly record_key?: string | null };
}

function isDetailGapKnownGap(gap: Record<string, unknown>): gap is Record<string, unknown> & DetailGapKnownGapForTest {
  return gap.kind === "detail_gap";
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
  connector_id: "chatgpt-recovered-regression",
  display_name: "ChatGPT Recovered-Gap Regression",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "conversations",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" }, title: { type: "string" } }, required: ["id"], type: "object" },
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
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

function createCannedConnector(messages: readonly Record<string, unknown>[]): {
  connectorPath: string;
  cleanup: () => void;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-recovered-regression-"));
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

test("a recovered detail gap re-deferred with the same identity must not fail the commit gate", async (t) => {
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

  // Conversation X's durable gap, with a stable locator. Seed pending, then
  // recover it (as a prior run's recovery pass would). connectorInstanceId is
  // set explicitly to the SAME default-account binding `admitRunConnection`
  // resolves for the run's owner subject ('test_user', via issueOwnerToken),
  // keeping the gap_id identity collision faithful — the gap store's own
  // implicit default assumes a different, hardcoded subject and would
  // otherwise seed a sibling instance's row instead of colliding with it.
  const LOCATOR = { conversation_id: "X", kind: "chatgpt.conversation" };
  const store = getTestDetailGapStore();
  const seeded = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: makeDefaultAccountConnectorInstanceId("test_user", connectorId),
    detailLocator: LOCATOR,
    discoveredRunId: "prior",
    grantId: null,
    lastError: null,
    lastRunId: "prior",
    listCursor: null,
    parentStream: null,
    reason: "retry_exhausted",
    recordKey: "X",
    scope: null,
    source: { id: connectorId, kind: "connector" },
    stream: "messages",
  });
  assert.ok(seeded, "seeded gap is persisted");
  await store.markGapStatus(seeded.gap_id, "recovered", { runId: "prior" });

  // This run: the forward pass requires X but the run budget was already spent,
  // so it re-defers X as a run-cap DETAIL_GAP with the SAME locator/identity.
  // hydrated_keys is empty exactly as in the live coverage event.
  const messages = [
    {
      detail_locator: LOCATOR,
      reason: "retry_exhausted",
      record_key: "X",
      retryable: true,
      stream: "messages",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: ["X"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["X"],
      state_stream: "conversations",
      stream: "messages",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "messages", type: "STATE" },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "conversations", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      detailGapStore: store,
      manifest: MANIFEST,
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

  assert.equal(thrown, null);
  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded");
  assert.ok(result.checkpoint_summary, "result carries a checkpoint_summary");
  assert.equal(result.checkpoint_summary.state_streams_committed, 2);
});

// SLVP-ideal audit logging (docs/research/slvp-ideal-audit-logging-2026-06-12.md):
// run.detail_gap_recorded is a first-sighting lifecycle FACT, emitted ONCE per
// gap identity — NOT a per-run re-observation breadcrumb. A run that re-defers a
// gap first discovered in a PRIOR run must NOT append a fresh recorded event
// (that was the ~6000 rows/day bloat + a dishonest "something happened" signal);
// a brand-new gap this run emits exactly one. The durable row's attempt_count /
// last_run_id carry the "worked across runs" story.
test("run.detail_gap_recorded fires once at first sighting, NOT on a prior-run re-defer", async (t) => {
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
  const store = getTestDetailGapStore();

  // Gap OLD: discovered in a PRIOR run, still pending. This run re-defers it with
  // the same identity — the spine must stay silent (discovered_run_id !== runId).
  const OLD_LOCATOR = { conversation_id: "OLD", kind: "chatgpt.conversation" };
  await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: makeDefaultAccountConnectorInstanceId("test_user", connectorId),
    detailLocator: OLD_LOCATOR,
    discoveredRunId: "prior",
    grantId: null,
    lastError: null,
    lastRunId: "prior",
    listCursor: null,
    parentStream: null,
    reason: "retry_exhausted",
    recordKey: "OLD",
    scope: null,
    source: { id: connectorId, kind: "connector" },
    stream: "messages",
  });

  // This run emits a DETAIL_GAP for OLD (a re-defer) and for NEW (first sighting).
  const messages = [
    {
      detail_locator: OLD_LOCATOR,
      reason: "retry_exhausted",
      record_key: "OLD",
      retryable: true,
      stream: "messages",
      type: "DETAIL_GAP",
    },
    {
      detail_locator: { conversation_id: "NEW", kind: "chatgpt.conversation" },
      reason: "retry_exhausted",
      record_key: "NEW",
      retryable: true,
      stream: "messages",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: ["OLD", "NEW"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["OLD", "NEW"],
      state_stream: "conversations",
      stream: "messages",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "messages", type: "STATE" },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "conversations", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result: RuntimeRunConnectorResult | null = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      detailGapStore: store,
      manifest: MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "conversations" }, { name: "messages" }] },
      state: null,
    });
  } finally {
    cleanup();
  }

  assert.ok(result, "runConnector returned a result");
  // Both gaps are durably pending (lose-nothing intact) — the gate touches only
  // the spine emit, never the durable substrate.
  assert.ok(result.detail_gaps, "result carries a detail_gaps list");
  const durableKeys = result.detail_gaps.map((g) => g.gap_id).sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  assert.equal(durableKeys.length, 2, "both gaps are durably recorded (lose-nothing)");

  // The spine carries exactly ONE run.detail_gap_recorded for THIS run — the NEW
  // gap's first sighting. The OLD re-defer is suppressed.
  assert.ok(result.run_id, "result carries a run_id");
  const page = listSpineEventsPage("run", result.run_id, { limit: 500 });
  const recordedEvents = page.events.filter((e) => e.event_type === "run.detail_gap_recorded");
  assert.equal(
    recordedEvents.length,
    1,
    "exactly one recorded event this run — the new gap, not the prior-run re-defer"
  );
  const [recordedEvent] = recordedEvents;
  assert.ok(recordedEvent, "exactly one recorded event was found");
  const recordedData = recordedEvent.data as Record<string, unknown>;
  assert.equal(recordedData.record_key, "NEW", "the single recorded event is the first-sighting NEW gap");
  // Self-describing first-sighting payload (the discriminating fields an auditor needs).
  assert.equal(recordedData.discovered_run_id, result.run_id, "recorded event names the discovering run");
  assert.equal(typeof recordedData.attempt_count, "number", "recorded event carries attempt_count");
});

// Live evidence (run_1783616353033 through run_1783961621015, Amazon connector
// cin_a8ec003e6d441205d646f178, order_items stream, 2026-07-09..07-13): a run
// that recovered every truly-pending order_items detail gap still reported
// connection health degraded / coverage retryable_gap, because the connector's
// ordinary forward pass rediscovers the same order identities every run
// (independent of the runtime's separate gap-recovery pass) and re-emits
// DETAIL_GAP for detail it already has. The store's upsertPendingGap originally
// pinned `status` sticky at `recovered` UNCONDITIONALLY, and the runtime
// suppressed the resulting known_gap noise (fixed by 52b97f950) — but that fix
// only hid the symptom. The live Amazon connection kept re-declaring the SAME
// 12 order ids as `DETAIL_COVERAGE.gap_keys` on every 12h run for weeks
// (`covered` stuck at 200 while `considered` grew 210->211->212), because
// `status: 'recovered'` in the durable store never re-opened: the item was
// stranded outside both the pending-retry queue (sticky-recovered) and the
// quarantine escalation path (`maybeQuarantineGap` only fires from
// pending/in_progress), with zero owner-visible signal and no way to ever
// retry. The fix: `upsertPendingGap` now reopens a `recovered` row to
// `pending` when the re-upsert's `lastRunId` differs from the row's own
// `recovered_run_id` — i.e. a LATER run reporting fresh attempt evidence that
// a previously-closed record is missing again. A same-run re-defer (the
// original §10-A regression this file's first three tests cover) is
// unaffected: `recovered_run_id` still equals the current run's id in that
// case, so the row stays `recovered` and the known_gap stays suppressed.
test("a recovered gap re-deferred by a LATER run reopens to pending and surfaces as a known_gap", async (t) => {
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
  const store = getTestDetailGapStore();

  // Distinct record key from every other test in this file: the default gap
  // store is a process-wide singleton (`getDefaultConnectorDetailGapStore`),
  // not scoped to this test's `:memory:` server, so key collisions leak state
  // across test cases in this file.
  const LOCATOR = { conversation_id: "LATER_X", kind: "chatgpt.conversation" };
  const seeded = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: makeDefaultAccountConnectorInstanceId("test_user", connectorId),
    detailLocator: LOCATOR,
    discoveredRunId: "prior",
    grantId: null,
    lastError: null,
    lastRunId: "prior",
    listCursor: null,
    parentStream: null,
    reason: "retry_exhausted",
    recordKey: "LATER_X",
    scope: null,
    source: { id: connectorId, kind: "connector" },
    stream: "messages",
  });
  assert.ok(seeded, "seeded gap is persisted");
  // Recovered by a PRIOR run (a run distinct from the one about to re-defer it
  // below) — this is the "closed, then broke again" shape, not a same-run
  // forward/recovery-pass race.
  await store.markGapStatus(seeded.gap_id, "recovered", { runId: "prior" });

  const messages = [
    {
      detail_locator: LOCATOR,
      reason: "retry_exhausted",
      record_key: "LATER_X",
      retryable: true,
      stream: "messages",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: ["LATER_X"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["LATER_X"],
      state_stream: "conversations",
      stream: "messages",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "messages", type: "STATE" },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "conversations", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result: RuntimeRunConnectorResult | null = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      detailGapStore: store,
      manifest: MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "conversations" }, { name: "messages" }] },
      state: null,
    });
  } finally {
    cleanup();
  }

  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded");
  assert.ok(result.detail_gaps, "result carries a detail_gaps list");
  assert.equal(result.detail_gaps.length, 1);
  const [resultGap] = result.detail_gaps;
  assert.ok(resultGap, "result.detail_gaps has one entry");
  // Reopened: a later run's fresh DETAIL_GAP for a previously-`recovered`
  // identity proves the recovery did not durably hold. `result.detail_gaps` is
  // a thin run-local projection (no `recovered_run_id`); read the durable row
  // from the store for the full picture.
  assert.equal(resultGap.status, "pending", "a later-run re-defer reopens a recovered gap to pending");
  const storedRow = await store.getGapById(seeded.gap_id);
  assert.ok(storedRow, "durable gap row still exists");
  assert.equal(storedRow.status, "pending");
  assert.equal(storedRow.recovered_run_id, "prior", "the run that first recovered it is preserved for audit");
  // The run's owner-facing known_gaps MUST contain a detail_gap entry for it —
  // it is once again genuinely outstanding work, and hiding it is what let the
  // live Amazon defect run undetected for weeks.
  assert.ok(result.known_gaps, "result carries a known_gaps list");
  const detailGapKnownGaps = result.known_gaps.filter(isDetailGapKnownGap);
  assert.equal(detailGapKnownGaps.length, 1, "a later-run re-defer of a recovered gap must surface as a known_gap");
  const [detailGapKnownGap] = detailGapKnownGaps;
  assert.ok(detailGapKnownGap, "one detail_gap known_gap was found");
  assert.equal(detailGapKnownGap.scope?.record_key, "LATER_X");
});

// The original §10-A regression this file opens with: a SAME-run re-defer
// (the forward pass rediscovering an identity the SAME run's own recovery
// pass already closed) must stay suppressed — `recovered_run_id` equals the
// re-defer's own `lastRunId` in this case, so the sticky-status branch still
// applies and no phantom known_gap or coverage regression appears.
test("a recovered gap re-deferred by the SAME run that recovered it stays recovered and suppressed", async (t) => {
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
  const store = getTestDetailGapStore();

  // Distinct record key from every other test in this file (see the comment
  // in the previous test on the default gap store's cross-test collision risk).
  const LOCATOR = { conversation_id: "SAME_X", kind: "chatgpt.conversation" };
  const seeded = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: makeDefaultAccountConnectorInstanceId("test_user", connectorId),
    detailLocator: LOCATOR,
    discoveredRunId: "prior",
    grantId: null,
    lastError: null,
    lastRunId: "prior",
    listCursor: null,
    parentStream: null,
    reason: "retry_exhausted",
    recordKey: "SAME_X",
    scope: null,
    source: { id: connectorId, kind: "connector" },
    stream: "messages",
  });
  assert.ok(seeded, "seeded gap is persisted");
  await store.markGapStatus(seeded.gap_id, "recovered", { runId: "prior" });

  // Realistic same-run ordering: this run's OWN recovery pass closes SAME_X
  // first (DETAIL_GAP_RECOVERED, naming the seeded gap_id so identity
  // matches), and only afterward does the ordinary forward pass rediscover
  // SAME_X and re-defer it with the SAME identity — the exact race the
  // original §10-A fix targeted.
  const messages = [
    {
      gap_id: seeded.gap_id,
      record_key: "SAME_X",
      reference_only: true,
      stream: "messages",
      type: "DETAIL_GAP_RECOVERED",
    },
    {
      detail_locator: LOCATOR,
      reason: "retry_exhausted",
      record_key: "SAME_X",
      retryable: true,
      stream: "messages",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: [],
      hydrated_keys: ["SAME_X"],
      reference_only: true,
      required_keys: ["SAME_X"],
      state_stream: "conversations",
      stream: "messages",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "messages", type: "STATE" },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "conversations", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result: RuntimeRunConnectorResult | null = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      detailGapStore: store,
      manifest: MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "conversations" }, { name: "messages" }] },
      state: null,
    });
  } finally {
    cleanup();
  }

  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded");
  // result.detail_gaps is a per-message diagnostic log (one push per
  // DETAIL_GAP/DETAIL_GAP_RECOVERED processed, not deduped by identity) — this
  // run emits both for the same gap, so it carries two entries for one row.
  // The durable row itself is the single source of truth for final state.
  assert.ok(result.detail_gaps, "result carries a detail_gaps list");
  const gapIds = new Set(result.detail_gaps.map((g) => g.gap_id));
  assert.equal(gapIds.size, 1, "both diagnostic entries name the same durable gap");
  const storedRow = await store.getGapById(seeded.gap_id);
  assert.ok(storedRow, "durable gap row still exists");
  assert.equal(storedRow.status, "recovered", "the SAME-run recovery-then-redefer leaves the gap recovered");
  assert.equal(storedRow.recovered_run_id, result.run_id, "recovered_run_id now names THIS run");
  assert.ok(result.known_gaps, "result carries a known_gaps list");
  const detailGapKnownGaps = result.known_gaps.filter(isDetailGapKnownGap);
  assert.equal(detailGapKnownGaps.length, 0, "a same-run recover-then-redefer must not surface a phantom known_gap");
});

test("a truly pending gap still surfaces as a retryable known_gap", async (t) => {
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
  const store = getTestDetailGapStore();

  const messages = [
    {
      detail_locator: { conversation_id: "NEW", kind: "chatgpt.conversation" },
      reason: "retry_exhausted",
      record_key: "NEW",
      retryable: true,
      stream: "messages",
      type: "DETAIL_GAP",
    },
    {
      gap_keys: ["NEW"],
      hydrated_keys: [],
      reference_only: true,
      required_keys: ["NEW"],
      state_stream: "conversations",
      stream: "messages",
      type: "DETAIL_COVERAGE",
    },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "messages", type: "STATE" },
    { cursor: { last_update_time: "2026-06-05T21:21:53.495Z" }, stream: "conversations", type: "STATE" },
    { records_emitted: 0, status: "succeeded", type: "DONE" },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result: RuntimeRunConnectorResult | null = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "full_refresh",
      connectorId,
      connectorPath,
      detailGapStore: store,
      manifest: MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "conversations" }, { name: "messages" }] },
      state: null,
    });
  } finally {
    cleanup();
  }

  assert.ok(result, "runConnector returned a result");
  assert.equal(result.status, "succeeded");
  assert.ok(result.detail_gaps, "result carries a detail_gaps list");
  assert.equal(result.detail_gaps.length, 1);
  const [resultGap] = result.detail_gaps;
  assert.ok(resultGap, "result.detail_gaps has one entry");
  assert.equal(resultGap.status, "pending");
  assert.ok(result.known_gaps, "result carries a known_gaps list");
  const detailGapKnownGaps = result.known_gaps.filter(isDetailGapKnownGap);
  assert.equal(detailGapKnownGaps.length, 1, "a genuinely pending gap must still surface as a known_gap");
  const [detailGapKnownGap] = detailGapKnownGaps;
  assert.ok(detailGapKnownGap, "one detail_gap known_gap was found");
  assert.equal(detailGapKnownGap.recovery_hint?.action, "retry_by_runtime");
});
