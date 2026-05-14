import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { closeDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import {
  buildPendingInteractionPushPayload,
  createMemoryWebPushSubscriptionStore,
  createPostgresWebPushSubscriptionStore,
  createSqliteWebPushSubscriptionStore,
  fanoutPendingInteractionWebPush,
} from '../server/web-push-notifications.js';

const TEST_PASSWORD = 'web-push-owner-test-password';
const VAPID_PUBLIC = 'BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd';
const VAPID_PRIVATE = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(opts, fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ...opts,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

function sampleSubscription(endpoint = 'https://push.example.invalid/sub/one') {
  return {
    endpoint,
    keys: {
      p256dh: 'public-key-material',
      auth: 'auth-secret',
    },
  };
}

async function runWebPushSubscriptionStoreConformance(makeStore, prefix = 'store') {
  const store = await makeStore();
  const localEndpoint = `https://push.example.invalid/sub/${prefix}-local`;
  const otherEndpoint = `https://push.example.invalid/sub/${prefix}-other`;

  const created = await store.upsert('owner_local', sampleSubscription(localEndpoint), {
    platform: 'android',
    device_label: 'Pixel test device',
  });
  assert.equal(created.endpoint, localEndpoint);
  assert.equal(created.platform, 'android');
  assert.equal(created.device_label, 'Pixel test device');
  assert.equal(created.revoked_at, null);

  await store.upsert('owner_other', sampleSubscription(otherEndpoint), { platform: 'desktop' });
  assert.equal((await store.list('owner_local')).length, 1);
  assert.equal((await store.list('owner_other')).length, 1);
  assert.deepEqual(
    (await store.listActiveRaw('owner_local')).map((record) => record.endpoint),
    [localEndpoint],
  );
  assert.deepEqual((await store.listActiveRaw('owner_local'))[0].keys, {
    p256dh: 'public-key-material',
    auth: 'auth-secret',
  });

  await store.markFailure(localEndpoint, 'temporary upstream error');
  let visible = (await store.list('owner_local'))[0];
  assert.equal(visible.last_failure_reason, 'temporary upstream error');
  assert.equal(visible.revoked_at, null);

  await store.markSuccess(localEndpoint);
  visible = (await store.list('owner_local'))[0];
  assert.equal(visible.last_failure_reason, null);
  assert.equal(visible.last_success_at !== null, true);

  await store.markFailure(localEndpoint, 'Gone', { revoke: true });
  assert.equal((await store.list('owner_local')).length, 0);
  visible = (await store.list('owner_local', { activeOnly: false }))[0];
  assert.equal(visible.last_failure_reason, 'Gone');
  assert.equal(visible.revoked_at !== null, true);

  const revived = await store.upsert('owner_local', sampleSubscription(localEndpoint), { platform: 'updated' });
  assert.equal(revived.revoked_at, null);
  assert.equal(revived.platform, 'updated');

  assert.equal(await store.revoke('owner_other', localEndpoint), null);
  assert.equal((await store.list('owner_local')).length, 1);
  assert.equal((await store.revoke('owner_local', localEndpoint)).endpoint, localEndpoint);
  assert.equal((await store.list('owner_local')).length, 0);
}

test('web push subscription management requires owner session when owner auth is enabled', async () => {
  await withServer(
    {
      ownerAuthPassword: TEST_PASSWORD,
      webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
      webPushConfig: {
        enabled: true,
        publicKey: VAPID_PUBLIC,
        privateKey: VAPID_PRIVATE,
        subject: 'mailto:test@example.invalid',
        unavailableReason: null,
      },
    },
    async ({ asUrl }) => {
      const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ subscription: sampleSubscription() }),
        redirect: 'manual',
      });
      assert.equal(create.status, 401);

      const list = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      assert.equal(list.status, 401);

      const remove = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ endpoint: sampleSubscription().endpoint }),
        redirect: 'manual',
      });
      assert.equal(remove.status, 401);
    },
  );
});

test('pending interaction Web Push payload omits sensitive connector and interaction values', () => {
  const payload = buildPendingInteractionPushPayload({
    runId: 'run_secret',
    connectorDisplayName: 'Bank connector',
    interaction: {
      kind: 'otp',
      request_id: 'int_secret',
      message: 'Your OTP is 123456 and password is hunter2',
      schema: {
        properties: {
          otp: { const: '123456' },
          password: { const: 'hunter2' },
          token: { const: 'access-token-secret' },
          cookie: { const: 'session-cookie-secret' },
        },
      },
      data: { raw: 'raw connector data', answer: 'submitted interaction answer' },
    },
  });
  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    '123456',
    'hunter2',
    'access-token-secret',
    'session-cookie-secret',
    'raw connector data',
    'submitted interaction answer',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
  assert.equal(payload.url, '/dashboard/runs/run_secret');
  assert.equal(payload.interaction_id, 'int_secret');
});

test('web push send failures mark subscriptions without blocking successful fallback work', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/gone'), {});
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/ok'), {});

  const sent = [];
  await fanoutPendingInteractionWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    interaction: { kind: 'manual_action', request_id: 'int_manual' },
    connectorDisplayName: 'Manual connector',
    ownerSubjectId: 'owner_local',
    runId: 'run_manual',
    log: { warn() {} },
    sender: async (subscription, payload) => {
      sent.push(payload);
      if (subscription.endpoint.endsWith('/gone')) {
        const err = new Error('Gone');
        err.statusCode = 410;
        throw err;
      }
    },
  });

  assert.equal(sent.length, 2);
  const active = await store.list('owner_local');
  assert.equal(active.length, 1);
  assert.equal(active[0].endpoint, 'https://push.example.invalid/sub/ok');
  assert.equal(active[0].last_success_at !== null, true);
});

test('web push fanout is scoped to the interaction owner subject', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/local'), {});
  await store.upsert('owner_other', sampleSubscription('https://push.example.invalid/sub/other'), {});

  const endpoints = [];
  await fanoutPendingInteractionWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    interaction: { kind: 'manual_action', request_id: 'int_manual' },
    connectorDisplayName: 'Manual connector',
    ownerSubjectId: 'owner_local',
    runId: 'run_manual',
    log: { warn() {} },
    sender: async (subscription) => {
      endpoints.push(subscription.endpoint);
    },
  });

  assert.deepEqual(endpoints, ['https://push.example.invalid/sub/local']);
  assert.equal((await store.list('owner_local'))[0].last_success_at !== null, true);
  assert.equal((await store.list('owner_other'))[0].last_success_at, null);
});

test('SQLite WebPushSubscriptionStore persists owner-scoped subscription state', async () => {
  initDb();
  try {
    await runWebPushSubscriptionStoreConformance(() => createSqliteWebPushSubscriptionStore(), 'sqlite');
  } finally {
    closeDb();
  }
});

test(
  'Postgres WebPushSubscriptionStore conforms when PDPP_TEST_POSTGRES_URL is set',
  { skip: !process.env.PDPP_TEST_POSTGRES_URL },
  async () => {
    const endpointPattern = 'https://push.example.invalid/sub/postgres-%';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
    try {
      await postgresQuery('DELETE FROM web_push_subscriptions WHERE endpoint LIKE $1', [endpointPattern]);
      await runWebPushSubscriptionStoreConformance(() => createPostgresWebPushSubscriptionStore(), 'postgres');
    } finally {
      await postgresQuery('DELETE FROM web_push_subscriptions WHERE endpoint LIKE $1', [endpointPattern]);
      await closePostgresStorage();
    }
  },
);

test('web push subscriptions persist across reference server restarts', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-web-push-persist-'));
  const dbPath = join(tmpDir, 'pdpp.sqlite');
  const webPushConfig = {
    enabled: true,
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: 'mailto:test@example.invalid',
    unavailableReason: null,
  };

  let server = null;
  try {
    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      webPushConfig,
    });
    let asUrl = `http://localhost:${server.asPort}`;
    const create = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        subscription: sampleSubscription('https://push.example.invalid/sub/persisted'),
        platform: 'test-platform',
      }),
    });
    assert.equal(create.status, 201);
    await closeServer(server);
    closeDb();

    server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
      webPushConfig,
    });
    asUrl = `http://localhost:${server.asPort}`;
    const list = await fetch(`${asUrl}/_ref/web-push/subscriptions`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(list.status, 200);
    const body = await list.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].endpoint, 'https://push.example.invalid/sub/persisted');
    assert.equal(body.data[0].platform, 'test-platform');
  } finally {
    if (server) {
      await closeServer(server);
    }
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('controller keeps ntfy and Web Push as independent best-effort notification channels', async () => {
  const src = await readFile(new URL('../runtime/controller.ts', import.meta.url), 'utf8');
  assert.match(src, /void fireNtfy\(/);
  assert.match(src, /void fireWebPush\(/);
  assert.match(src, /ntfy fire for run .* failed/);
  assert.match(src, /web push fire for run .* failed/);
});
