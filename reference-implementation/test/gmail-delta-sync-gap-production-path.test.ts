// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Production-path regression for the live gmail checkpoint-loss incident
// (2026-07-31, run_1785535147325_1 / run_1785535845977_2) and its REVISE
// (a bare PROGRESS note on delta-pass failure was a false-green path: a
// `succeeded` run with a silently-skipped flag/label delta sync is
// indistinguishable, from the terminal record and coverage projection
// alone, from a run that actually completed it).
//
// This test drives the REAL runtime (`runConnector`, the real detail-gap
// store, the real spine/run_history projection surface) through a "canned
// connector" subprocess scripted to emit exactly the message sequence
// `runDeltaPassWithGapAccounting` (packages/polyfill-connectors/connectors/
// gmail/index.ts) produces on a delta-pass failure, then on a later
// successful delta sync. No IMAP mocking is needed — the fix under test is
// entirely in the runtime-protocol layer (what the connector emits and how
// the runtime durably projects it), not in the IMAP client itself, and that
// layer is exactly what this canned-connector harness exercises end to end.
//
// Proves, against the real production surfaces:
//   1. A run whose delta pass fails still terminalizes `succeeded` with a
//      committed checkpoint (no failure/backoff/runtime_error state).
//   2. The failure surfaces as a typed, retryable `detail_gap` known_gap —
//      not silently absorbed into an invisible PROGRESS note.
//   3. The messages STATE cursor commits regardless (safe cursor ordering:
//      the delta-gap emission does not block or reorder the checkpoint).
//   4. A later run is served the same gap back and, on a successful delta
//      sync this time, emits DETAIL_GAP_RECOVERED — the durable store
//      transitions the gap to `recovered` and it no longer appears in
//      terminal known_gaps (next-run retry/clear semantics).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { type RuntimeRunConnectorResult, runConnector } from "../runtime/index.ts";
import { startServer } from "../server/index.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { getDefaultConnectorDetailGapStore } from "../server/stores/connector-detail-gap-store.ts";
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

type RunConnectorTestOptions = Omit<Parameters<typeof runConnector>[0], "detailGapStore"> & {
  detailGapStore?: unknown;
};
type RunConnectorFn = (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;
const runConnectorWithGapStore = runConnector as RunConnectorFn;

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

interface DetailGapForTest {
  readonly gap_id: string;
  readonly recovered_run_id: string | null;
  readonly status: string;
  readonly [key: string]: unknown;
}

interface DetailGapStoreForTest {
  getGapById: (gapId: string) => Promise<DetailGapForTest | null>;
}

function getTestDetailGapStore(): DetailGapStoreForTest {
  return getDefaultConnectorDetailGapStore() as DetailGapStoreForTest;
}

interface DetailGapKnownGapForTest {
  readonly kind: "detail_gap";
  readonly recovery_hint?: { readonly action?: string };
  readonly scope?: { readonly record_key?: string | null };
}

function isDetailGapKnownGap(gap: Record<string, unknown>): gap is Record<string, unknown> & DetailGapKnownGapForTest {
  return gap.kind === "detail_gap";
}

async function fetchJson<T = Record<string, unknown>>(url: string, opts: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, opts);
  return (await resp.json()) as T;
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
  const device = await fetchJson<DeviceAuthorizationResponse>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: "test_user", user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const body = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
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
  connector_id: "gmail-delta-sync-gap-regression",
  display_name: "Gmail Delta-Sync Gap Regression",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "messages",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

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

/**
 * A canned connector scripted to reproduce `runDeltaPassWithGapAccounting`'s
 * exact wire behavior without any IMAP dependency: on START, if it was
 * served a pending gap on the `messages` stream whose `detail_locator.kind`
 * is `gmail.delta_sync` (the same marker the real gmail connector uses), it
 * emits DETAIL_GAP_RECOVERED for that gap instead of failing again. If
 * `failDelta` is true and no such served gap exists yet, it emits the
 * failure-shaped DETAIL_GAP first. Either way it commits the messages STATE
 * cursor and terminalizes succeeded — the exact sequence the real fix
 * produces.
 */
function createGmailShapedConnector(options: { failDelta: boolean; priorModseq: string }): {
  cleanup: () => void;
  connectorPath: string;
} {
  const tmpDir = mkdtempSync(join(tmpdir(), "pdpp-gmail-delta-gap-regression-"));
  const connectorPath = join(tmpDir, "connector.mjs");
  const script = `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const detailGaps = Array.isArray(msg.detail_gaps) ? msg.detail_gaps : [];
  const servedGap = detailGaps.find(
    (g) => g && g.stream === 'messages' && g.detail_locator && g.detail_locator.kind === 'gmail.delta_sync'
  );
  const out = [];
  out.push({ type: 'RECORD', stream: 'messages', id: 'msg-1', data: { id: 'msg-1' } });
  if (servedGap) {
    out.push({
      type: 'DETAIL_GAP_RECOVERED',
      reference_only: true,
      gap_id: servedGap.gap_id,
      ...(servedGap.lease_id ? { lease_id: servedGap.lease_id } : {}),
      record_key: ${JSON.stringify(options.priorModseq)},
      stream: 'messages',
    });
  } else if (${options.failDelta}) {
    out.push({
      type: 'DETAIL_GAP',
      reference_only: true,
      status: 'pending',
      stream: 'messages',
      record_key: ${JSON.stringify(options.priorModseq)},
      detail_locator: { kind: 'gmail.delta_sync', modseq: ${JSON.stringify(options.priorModseq)} },
      reason: 'temporary_unavailable',
      retryable: true,
      last_error: { class: 'delta_sync_failed', message: 'IMAP connection reset while fetching flag/label deltas' },
    });
  }
  out.push({ type: 'STATE', stream: 'messages', cursor: { all_mail: { uidnext: 100, highest_modseq: ${JSON.stringify(options.priorModseq)} } } });
  out.push({ type: 'DONE', records_emitted: 1, status: 'succeeded' });
  for (const m of out) process.stdout.write(JSON.stringify(m) + '\\n');
  rl.close();
  process.exit(0);
});
`;
  writeFileSync(connectorPath, script, "utf-8");
  return { cleanup: () => rmSync(tmpDir, { force: true, recursive: true }), connectorPath };
}

test("gmail delta-sync failure: run still succeeds with a committed checkpoint, and the failure surfaces as a typed retryable known_gap (not a silent PROGRESS note)", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;
  const store = getTestDetailGapStore();

  const { connectorPath, cleanup } = createGmailShapedConnector({ failDelta: true, priorModseq: "42" });

  let result: RuntimeRunConnectorResult | null = null;
  let thrown: unknown = null;
  try {
    result = await runConnectorWithGapStore({
      admitRunConnection: fakeAdmitRunConnection(),
      collectionMode: "incremental",
      connectorId,
      connectorPath,
      detailGapStore: store,
      manifest: MANIFEST,
      onInteraction: async () => ({}),
      ownerToken,
      persistState: true,
      rsUrl: `http://localhost:${rsPort}`,
      scope: { streams: [{ name: "messages" }] },
      state: null,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
  }

  assert.equal(thrown, null, "no thrown error reaches the caller");
  assert.ok(result, "runConnector returned a result");

  // 1. Terminal status: succeeded, not failed/runtime_error. Budget/pass
  // exhaustion on an unrelated sub-pass must not flip the run to a failure
  // state or arm the scheduler's consecutive-failure backoff.
  assert.equal(result.status, "succeeded", "a delta-sync failure alone must not fail the whole run");
  assert.notEqual(result.terminal_reason, "runtime_error");

  // 2. Safe cursor ordering: the messages STATE cursor committed despite
  // the delta-sync failure, proving the gap emission did not block or
  // reorder the checkpoint commit.
  assert.ok(result.checkpoint_summary, "result carries a checkpoint_summary");
  assert.equal(result.checkpoint_summary.commit_status, "committed");
  assert.equal(result.checkpoint_summary.state_streams_committed, 1);
  const committedMessagesState = (result.state as { messages?: { all_mail?: { highest_modseq?: unknown } } }).messages;
  assert.equal(committedMessagesState?.all_mail?.highest_modseq, "42", "the committed cursor carries the real value");

  // 3. Terminal known_gaps/coverage projection: the failure is visible as a
  // typed, retryable detail_gap -- the exact evidence a false-green PROGRESS
  // note would have hidden.
  assert.ok(result.known_gaps, "result carries a known_gaps list");
  const detailGapKnownGaps = result.known_gaps.filter(isDetailGapKnownGap);
  assert.equal(detailGapKnownGaps.length, 1, "the delta-sync failure surfaces as exactly one known_gap");
  const [deltaGapKnownGap] = detailGapKnownGaps;
  assert.ok(deltaGapKnownGap);
  assert.equal(deltaGapKnownGap.scope?.record_key, "42", "keyed by the un-advanced priorModseq");
  assert.equal(
    deltaGapKnownGap.recovery_hint?.action,
    "retry_by_runtime",
    "the gap is actionable/resumable, not a dead end"
  );

  // 4. Durable store: the gap is pending, so the next run will be served it
  // back and can retry.
  assert.ok(result.detail_gaps, "result carries a detail_gaps list");
  assert.equal(result.detail_gaps.length, 1);
  const [storedGapRef] = result.detail_gaps;
  assert.ok(storedGapRef?.gap_id);
  const storedGap = await store.getGapById(storedGapRef.gap_id);
  assert.ok(storedGap, "the delta-sync gap is durably persisted");
  assert.equal(storedGap.status, "pending");
});

test("gmail delta-sync recovery: a later run served the same gap resolves it via DETAIL_GAP_RECOVERED, clearing it from known_gaps", async (t) => {
  const server = await typedStartServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  t.after(() => closeServer(server));
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(MANIFEST),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;
  const store = getTestDetailGapStore();

  // Run 1: delta sync fails, records the gap (same as the previous test).
  const runOptions = {
    admitRunConnection: fakeAdmitRunConnection(),
    collectionMode: "incremental" as const,
    connectorId,
    detailGapStore: store,
    manifest: MANIFEST,
    onInteraction: async () => ({}),
    ownerToken,
    persistState: true,
    rsUrl: `http://localhost:${rsPort}`,
    scope: { streams: [{ name: "messages" }] },
  };

  const firstConnector = createGmailShapedConnector({ failDelta: true, priorModseq: "99" });
  let firstResult: RuntimeRunConnectorResult | null = null;
  try {
    firstResult = await runConnectorWithGapStore({
      ...runOptions,
      connectorPath: firstConnector.connectorPath,
      state: null,
    });
  } finally {
    firstConnector.cleanup();
  }
  assert.ok(firstResult);
  assert.equal(firstResult.status, "succeeded");
  const detailGapKnownGapsAfterFirstRun = (firstResult.known_gaps ?? []).filter(isDetailGapKnownGap);
  assert.equal(detailGapKnownGapsAfterFirstRun.length, 1, "run 1 records the pending delta-sync gap");

  // Run 2: the runtime serves the pending gap back on START.detail_gaps
  // (proven by the connector script's own logic: it only emits
  // DETAIL_GAP_RECOVERED when it actually finds a served gmail.delta_sync
  // gap). This run's delta sync succeeds, so it resolves the gap instead of
  // re-failing it -- next-run retry/clear semantics.
  const secondConnector = createGmailShapedConnector({ failDelta: false, priorModseq: "99" });
  let secondResult: RuntimeRunConnectorResult | null = null;
  try {
    secondResult = await runConnectorWithGapStore({
      ...runOptions,
      connectorPath: secondConnector.connectorPath,
      state: (firstResult.state as Record<string, unknown> | undefined) ?? null,
    });
  } finally {
    secondConnector.cleanup();
  }
  assert.ok(secondResult);
  assert.equal(secondResult.status, "succeeded");

  // The gap must no longer appear as an outstanding known_gap once
  // recovered.
  const detailGapKnownGapsAfterSecondRun = (secondResult.known_gaps ?? []).filter(isDetailGapKnownGap);
  assert.equal(
    detailGapKnownGapsAfterSecondRun.length,
    0,
    "a resolved delta-sync gap must not still read as an outstanding known_gap"
  );

  // The durable store row itself transitioned to recovered.
  assert.ok(firstResult.detail_gaps?.length);
  const [firstStoredGapRef] = firstResult.detail_gaps;
  assert.ok(firstStoredGapRef?.gap_id);
  const storedGapAfterRecovery = await store.getGapById(firstStoredGapRef.gap_id);
  assert.ok(storedGapAfterRecovery, "the durable gap row still exists");
  assert.equal(storedGapAfterRecovery.status, "recovered", "the gap store durably reflects the recovery");
});
