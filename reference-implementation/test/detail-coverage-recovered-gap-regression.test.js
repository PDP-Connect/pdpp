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
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConnector } from '../runtime/index.js';
import { startServer } from '../server/index.js';
import { getDefaultConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import { listSpineEventsPage } from '../lib/spine.ts';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const c = (srv) => new Promise((r) => { const t = setTimeout(r, 2000); srv.close(() => { clearTimeout(t); r(); }); });
  await Promise.allSettled([c(server.asServer), c(server.rsServer)]);
}
async function fetchJson(url, opts = {}) { const resp = await fetch(url, opts); return { status: resp.status, body: await resp.json() }; }
async function issueOwnerToken(asUrl) {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: clientId }).toString() });
  await fetch(`${asUrl}/device/approve`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user_code: device.user_code, subject_id: 'test_user' }).toString() });
  const { body } = await fetchJson(`${asUrl}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: clientId }).toString() });
  return body.access_token;
}

const MANIFEST = {
  protocol_version: '0.1.0', connector_id: 'chatgpt-recovered-regression', version: '1.0.0', display_name: 'ChatGPT Recovered-Gap Regression',
  streams: [
    { name: 'conversations', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
    { name: 'messages', semantics: 'append_only', schema: { type: 'object', properties: { id: { type: 'string' }, conversation_id: { type: 'string' } }, required: ['id'] }, primary_key: ['id'] },
  ],
};

function createCannedConnector(messages) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-recovered-regression-'));
  const connectorPath = join(tmpDir, 'connector.mjs');
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
  writeFileSync(connectorPath, script, 'utf-8');
  return { connectorPath, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

test('a recovered detail gap re-deferred with the same identity must not fail the commit gate', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;

  // Conversation X's durable gap, with a stable locator. Seed pending, then
  // recover it (as a prior run's recovery pass would). connectorInstanceId is
  // omitted so the store derives the same default the runtime uses
  // (runConnector passes connectorInstanceId=null), keeping the gap_id identity
  // collision faithful.
  const LOCATOR = { kind: 'chatgpt.conversation', conversation_id: 'X' };
  const store = getDefaultConnectorDetailGapStore();
  const seeded = await store.upsertPendingGap({
    connectorId, grantId: null,
    source: { kind: 'connector', id: connectorId }, stream: 'messages', parentStream: null, recordKey: 'X',
    detailLocator: LOCATOR, listCursor: null, scope: null, reason: 'retry_exhausted',
    lastError: null, discoveredRunId: 'prior', lastRunId: 'prior',
  });
  await store.markGapStatus(seeded.gap_id, 'recovered', { runId: 'prior' });

  // This run: the forward pass requires X but the run budget was already spent,
  // so it re-defers X as a run-cap DETAIL_GAP with the SAME locator/identity.
  // hydrated_keys is empty exactly as in the live coverage event.
  const messages = [
    { type: 'DETAIL_GAP', stream: 'messages', record_key: 'X', reason: 'retry_exhausted', retryable: true, detail_locator: LOCATOR },
    { type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'conversations', stream: 'messages',
      required_keys: ['X'], hydrated_keys: [], gap_keys: ['X'] },
    { type: 'STATE', stream: 'messages', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'STATE', stream: 'conversations', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result = null;
  let thrown = null;
  try {
    result = await runConnector({
      connectorPath, connectorId, ownerToken, manifest: MANIFEST,
      scope: { streams: [{ name: 'conversations' }, { name: 'messages' }] },
      state: null, collectionMode: 'full_refresh', persistState: true,
      rsUrl: `http://localhost:${rsPort}`, onInteraction: async () => ({}),
      detailGapStore: store,
    });
  } catch (err) {
    thrown = err;
  } finally {
    cleanup();
    await closeServer(server);
  }

  assert.equal(thrown, null);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.checkpoint_summary.state_streams_committed, 2);
});

// SLVP-ideal audit logging (docs/research/slvp-ideal-audit-logging-2026-06-12.md):
// run.detail_gap_recorded is a first-sighting lifecycle FACT, emitted ONCE per
// gap identity — NOT a per-run re-observation breadcrumb. A run that re-defers a
// gap first discovered in a PRIOR run must NOT append a fresh recorded event
// (that was the ~6000 rows/day bloat + a dishonest "something happened" signal);
// a brand-new gap this run emits exactly one. The durable row's attempt_count /
// last_run_id carry the "worked across runs" story.
test('run.detail_gap_recorded fires once at first sighting, NOT on a prior-run re-defer', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;
  const store = getDefaultConnectorDetailGapStore();

  // Gap OLD: discovered in a PRIOR run, still pending. This run re-defers it with
  // the same identity — the spine must stay silent (discovered_run_id !== runId).
  const OLD_LOCATOR = { kind: 'chatgpt.conversation', conversation_id: 'OLD' };
  await store.upsertPendingGap({
    connectorId, grantId: null,
    source: { kind: 'connector', id: connectorId }, stream: 'messages', parentStream: null, recordKey: 'OLD',
    detailLocator: OLD_LOCATOR, listCursor: null, scope: null, reason: 'retry_exhausted',
    lastError: null, discoveredRunId: 'prior', lastRunId: 'prior',
  });

  // This run emits a DETAIL_GAP for OLD (a re-defer) and for NEW (first sighting).
  const messages = [
    { type: 'DETAIL_GAP', stream: 'messages', record_key: 'OLD', reason: 'retry_exhausted', retryable: true, detail_locator: OLD_LOCATOR },
    { type: 'DETAIL_GAP', stream: 'messages', record_key: 'NEW', reason: 'retry_exhausted', retryable: true, detail_locator: { kind: 'chatgpt.conversation', conversation_id: 'NEW' } },
    { type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'conversations', stream: 'messages',
      required_keys: ['OLD', 'NEW'], hydrated_keys: [], gap_keys: ['OLD', 'NEW'] },
    { type: 'STATE', stream: 'messages', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'STATE', stream: 'conversations', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result = null;
  try {
    result = await runConnector({
      connectorPath, connectorId, ownerToken, manifest: MANIFEST,
      scope: { streams: [{ name: 'conversations' }, { name: 'messages' }] },
      state: null, collectionMode: 'full_refresh', persistState: true,
      rsUrl: `http://localhost:${rsPort}`, onInteraction: async () => ({}),
      detailGapStore: store,
    });
  } finally {
    cleanup();
  }

  // Both gaps are durably pending (lose-nothing intact) — the gate touches only
  // the spine emit, never the durable substrate.
  const durableKeys = result.detail_gaps.map((g) => g.gap_id).sort();
  assert.equal(durableKeys.length, 2, 'both gaps are durably recorded (lose-nothing)');

  // The spine carries exactly ONE run.detail_gap_recorded for THIS run — the NEW
  // gap's first sighting. The OLD re-defer is suppressed.
  const page = listSpineEventsPage('run', result.run_id, { limit: 500 });
  const recordedEvents = page.events.filter((e) => e.event_type === 'run.detail_gap_recorded');
  await closeServer(server);

  assert.equal(recordedEvents.length, 1, 'exactly one recorded event this run — the new gap, not the prior-run re-defer');
  assert.equal(recordedEvents[0].data.record_key, 'NEW', 'the single recorded event is the first-sighting NEW gap');
  // Self-describing first-sighting payload (the discriminating fields an auditor needs).
  assert.equal(recordedEvents[0].data.discovered_run_id, result.run_id, 'recorded event names the discovering run');
  assert.equal(typeof recordedEvents[0].data.attempt_count, 'number', 'recorded event carries attempt_count');
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
test('a recovered gap re-deferred by a LATER run reopens to pending and surfaces as a known_gap', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;
  const store = getDefaultConnectorDetailGapStore();

  // Distinct record key from every other test in this file: the default gap
  // store is a process-wide singleton (`getDefaultConnectorDetailGapStore`),
  // not scoped to this test's `:memory:` server, so key collisions leak state
  // across test cases in this file.
  const LOCATOR = { kind: 'chatgpt.conversation', conversation_id: 'LATER_X' };
  const seeded = await store.upsertPendingGap({
    connectorId, grantId: null,
    source: { kind: 'connector', id: connectorId }, stream: 'messages', parentStream: null, recordKey: 'LATER_X',
    detailLocator: LOCATOR, listCursor: null, scope: null, reason: 'retry_exhausted',
    lastError: null, discoveredRunId: 'prior', lastRunId: 'prior',
  });
  // Recovered by a PRIOR run (a run distinct from the one about to re-defer it
  // below) — this is the "closed, then broke again" shape, not a same-run
  // forward/recovery-pass race.
  await store.markGapStatus(seeded.gap_id, 'recovered', { runId: 'prior' });

  const messages = [
    { type: 'DETAIL_GAP', stream: 'messages', record_key: 'LATER_X', reason: 'retry_exhausted', retryable: true, detail_locator: LOCATOR },
    { type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'conversations', stream: 'messages',
      required_keys: ['LATER_X'], hydrated_keys: [], gap_keys: ['LATER_X'] },
    { type: 'STATE', stream: 'messages', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'STATE', stream: 'conversations', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result = null;
  try {
    result = await runConnector({
      connectorPath, connectorId, ownerToken, manifest: MANIFEST,
      scope: { streams: [{ name: 'conversations' }, { name: 'messages' }] },
      state: null, collectionMode: 'full_refresh', persistState: true,
      rsUrl: `http://localhost:${rsPort}`, onInteraction: async () => ({}),
      detailGapStore: store,
    });
  } finally {
    cleanup();
    await closeServer(server);
  }

  assert.equal(result.status, 'succeeded');
  assert.equal(result.detail_gaps.length, 1);
  // Reopened: a later run's fresh DETAIL_GAP for a previously-`recovered`
  // identity proves the recovery did not durably hold. `result.detail_gaps` is
  // a thin run-local projection (no `recovered_run_id`); read the durable row
  // from the store for the full picture.
  assert.equal(result.detail_gaps[0].status, 'pending', 'a later-run re-defer reopens a recovered gap to pending');
  const storedRow = await store.getGapById(seeded.gap_id);
  assert.equal(storedRow.status, 'pending');
  assert.equal(storedRow.recovered_run_id, 'prior', 'the run that first recovered it is preserved for audit');
  // The run's owner-facing known_gaps MUST contain a detail_gap entry for it —
  // it is once again genuinely outstanding work, and hiding it is what let the
  // live Amazon defect run undetected for weeks.
  const detailGapKnownGaps = result.known_gaps.filter((g) => g.kind === 'detail_gap');
  assert.equal(detailGapKnownGaps.length, 1, 'a later-run re-defer of a recovered gap must surface as a known_gap');
  assert.equal(detailGapKnownGaps[0].scope.record_key, 'LATER_X');
});

// The original §10-A regression this file opens with: a SAME-run re-defer
// (the forward pass rediscovering an identity the SAME run's own recovery
// pass already closed) must stay suppressed — `recovered_run_id` equals the
// re-defer's own `lastRunId` in this case, so the sticky-status branch still
// applies and no phantom known_gap or coverage regression appears.
test('a recovered gap re-deferred by the SAME run that recovered it stays recovered and suppressed', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;
  const store = getDefaultConnectorDetailGapStore();

  // Distinct record key from every other test in this file (see the comment
  // in the previous test on the default gap store's cross-test collision risk).
  const LOCATOR = { kind: 'chatgpt.conversation', conversation_id: 'SAME_X' };
  const seeded = await store.upsertPendingGap({
    connectorId, grantId: null,
    source: { kind: 'connector', id: connectorId }, stream: 'messages', parentStream: null, recordKey: 'SAME_X',
    detailLocator: LOCATOR, listCursor: null, scope: null, reason: 'retry_exhausted',
    lastError: null, discoveredRunId: 'prior', lastRunId: 'prior',
  });
  await store.markGapStatus(seeded.gap_id, 'recovered', { runId: 'prior' });

  // Realistic same-run ordering: this run's OWN recovery pass closes SAME_X
  // first (DETAIL_GAP_RECOVERED, naming the seeded gap_id so identity
  // matches), and only afterward does the ordinary forward pass rediscover
  // SAME_X and re-defer it with the SAME identity — the exact race the
  // original §10-A fix targeted.
  const messages = [
    { type: 'DETAIL_GAP_RECOVERED', gap_id: seeded.gap_id, stream: 'messages', record_key: 'SAME_X', reference_only: true },
    { type: 'DETAIL_GAP', stream: 'messages', record_key: 'SAME_X', reason: 'retry_exhausted', retryable: true, detail_locator: LOCATOR },
    { type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'conversations', stream: 'messages',
      required_keys: ['SAME_X'], hydrated_keys: ['SAME_X'], gap_keys: [] },
    { type: 'STATE', stream: 'messages', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'STATE', stream: 'conversations', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result = null;
  try {
    result = await runConnector({
      connectorPath, connectorId, ownerToken, manifest: MANIFEST,
      scope: { streams: [{ name: 'conversations' }, { name: 'messages' }] },
      state: null, collectionMode: 'full_refresh', persistState: true,
      rsUrl: `http://localhost:${rsPort}`, onInteraction: async () => ({}),
      detailGapStore: store,
    });
  } finally {
    cleanup();
    await closeServer(server);
  }

  assert.equal(result.status, 'succeeded');
  // result.detail_gaps is a per-message diagnostic log (one push per
  // DETAIL_GAP/DETAIL_GAP_RECOVERED processed, not deduped by identity) — this
  // run emits both for the same gap, so it carries two entries for one row.
  // The durable row itself is the single source of truth for final state.
  const gapIds = new Set(result.detail_gaps.map((g) => g.gap_id));
  assert.equal(gapIds.size, 1, 'both diagnostic entries name the same durable gap');
  const storedRow = await store.getGapById(seeded.gap_id);
  assert.equal(storedRow.status, 'recovered', 'the SAME-run recovery-then-redefer leaves the gap recovered');
  assert.equal(storedRow.recovered_run_id, result.run_id, 'recovered_run_id now names THIS run');
  const detailGapKnownGaps = result.known_gaps.filter((g) => g.kind === 'detail_gap');
  assert.equal(detailGapKnownGaps.length, 0, 'a same-run recover-then-redefer must not surface a phantom known_gap');
});

test('a truly pending gap still surfaces as a retryable known_gap', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const { asPort, rsPort } = server;
  const asUrl = `http://localhost:${asPort}`;
  await fetchJson(`${asUrl}/connectors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(MANIFEST) });
  const ownerToken = await issueOwnerToken(asUrl);
  const connectorId = MANIFEST.connector_id;
  const store = getDefaultConnectorDetailGapStore();

  const messages = [
    { type: 'DETAIL_GAP', stream: 'messages', record_key: 'NEW', reason: 'retry_exhausted', retryable: true,
      detail_locator: { kind: 'chatgpt.conversation', conversation_id: 'NEW' } },
    { type: 'DETAIL_COVERAGE', reference_only: true, state_stream: 'conversations', stream: 'messages',
      required_keys: ['NEW'], hydrated_keys: [], gap_keys: ['NEW'] },
    { type: 'STATE', stream: 'messages', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'STATE', stream: 'conversations', cursor: { last_update_time: '2026-06-05T21:21:53.495Z' } },
    { type: 'DONE', status: 'succeeded', records_emitted: 0 },
  ];
  const { connectorPath, cleanup } = createCannedConnector(messages);

  let result = null;
  try {
    result = await runConnector({
      connectorPath, connectorId, ownerToken, manifest: MANIFEST,
      scope: { streams: [{ name: 'conversations' }, { name: 'messages' }] },
      state: null, collectionMode: 'full_refresh', persistState: true,
      rsUrl: `http://localhost:${rsPort}`, onInteraction: async () => ({}),
      detailGapStore: store,
    });
  } finally {
    cleanup();
    await closeServer(server);
  }

  assert.equal(result.status, 'succeeded');
  assert.equal(result.detail_gaps.length, 1);
  assert.equal(result.detail_gaps[0].status, 'pending');
  const detailGapKnownGaps = result.known_gaps.filter((g) => g.kind === 'detail_gap');
  assert.equal(detailGapKnownGaps.length, 1, 'a genuinely pending gap must still surface as a known_gap');
  assert.equal(detailGapKnownGaps[0].recovery_hint.action, 'retry_by_runtime');
});
