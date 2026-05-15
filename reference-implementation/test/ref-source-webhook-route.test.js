import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

function sign(secret, timestamp, body) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

async function withHarness(fn) {
  const oldSecrets = process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
  const secret = 'spotify_source_secret';
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const sourceId = spotifyManifest.connector_id;
  process.env.PDPP_SOURCE_WEBHOOK_SECRETS = `spotify:${secret}:${sourceId}`;
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await fn({ rsUrl, secret, sourceId: 'spotify' });
  } finally {
    if (oldSecrets === undefined) delete process.env.PDPP_SOURCE_WEBHOOK_SECRETS;
    else process.env.PDPP_SOURCE_WEBHOOK_SECRETS = oldSecrets;
    await closeServer(server);
  }
}

async function postWebhook(rsUrl, sourceId, secret, eventId, body) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const resp = await fetch(`${rsUrl}/_ref/source-webhooks/${encodeURIComponent(sourceId)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'PDPP-Webhook-Timestamp': timestamp,
      'PDPP-Webhook-Event-Id': eventId,
      'PDPP-Webhook-Signature': sign(secret, timestamp, body),
    },
    body,
  });
  return { status: resp.status, body: await resp.json() };
}

test('source webhook route rejects missing signature before mutation', async () => {
  await withHarness(async ({ rsUrl }) => {
    const resp = await fetch(`${rsUrl}/_ref/source-webhooks/spotify`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{"action":"schedule_run"}',
    });
    assert.equal(resp.status, 401);
    const body = await resp.json();
    assert.equal(body.error.code, 'missing_event_id');
  });
});

test('source webhook route ingests signed records and dedupes event id', async () => {
  await withHarness(async ({ rsUrl, secret, sourceId }) => {
    const body = JSON.stringify({
      action: 'ingest_records',
      stream: 'top_artists',
      records: [{
        key: 'artist_webhook_1',
        data: { id: 'artist_webhook_1', name: 'Webhook Artist' },
        emitted_at: new Date().toISOString(),
      }],
    });
    const first = await postWebhook(rsUrl, sourceId, secret, 'evt_ingest_1', body);
    assert.equal(first.status, 200);
    assert.equal(first.body.ingest.records_accepted, 1);

    const duplicate = await postWebhook(rsUrl, sourceId, secret, 'evt_ingest_1', body);
    assert.equal(duplicate.status, 202);
    assert.equal(duplicate.body.duplicate, true);
  });
});

test('source webhook route accepts schedule_run as scheduler input only', async () => {
  await withHarness(async ({ rsUrl, secret, sourceId }) => {
    const result = await postWebhook(rsUrl, sourceId, secret, 'evt_schedule_1', '{"action":"schedule_run"}');
    assert.equal(result.status, 200);
    assert.equal(result.body.action, 'schedule_run');
    assert.equal(result.body.accepted, true);
  });
});
