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
