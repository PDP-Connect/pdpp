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
  buildAssistancePushPayload,
  buildPendingInteractionPushPayload,
  buildTestPushPayload,
  classifyInteractionSensitivity,
  classifyPushFanoutOutcome,
  createMemoryWebPushSubscriptionStore,
  createPostgresWebPushSubscriptionStore,
  createSqliteWebPushSubscriptionStore,
  fanoutAssistanceWebPush,
  fanoutPendingInteractionWebPush,
  fanoutTestWebPush,
  resolveWebPushModuleApi,
  shouldFanoutAssistanceProgress,
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

test('web-push module normalization supports CommonJS default import shape', async () => {
  const actualModule = await import('web-push');
  const actualApi = resolveWebPushModuleApi(actualModule);
  assert.equal(typeof actualApi.setVapidDetails, 'function');
  assert.equal(typeof actualApi.sendNotification, 'function');

  const api = { setVapidDetails() {}, sendNotification() {} };
  assert.equal(resolveWebPushModuleApi(api), api);
  assert.equal(resolveWebPushModuleApi({ default: api }), api);
});

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

test('scheduled interaction Web Push payload can route to durable run context instead of transient stream', () => {
  const payload = buildPendingInteractionPushPayload({
    runId: 'run_scheduled',
    connectorDisplayName: 'Scheduled connector',
    routeTo: 'run',
    interaction: {
      kind: 'manual_action',
      request_id: 'int_scheduled',
      message: 'Log in manually',
    },
  });

  assert.equal(payload.url, '/dashboard/runs/run_scheduled');
  assert.equal(payload.interaction_id, 'int_scheduled');
});

test('manual run Web Push payload still routes manual_action interactions to the stream', () => {
  const payload = buildPendingInteractionPushPayload({
    runId: 'run_manual',
    connectorDisplayName: 'Manual connector',
    interaction: {
      kind: 'manual_action',
      request_id: 'int_manual',
    },
  });

  assert.equal(payload.url, '/dashboard/runs/run_manual/stream?interaction_id=int_manual');
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

test('shouldFanoutAssistanceProgress accepts only nonblocking owner-action ASSISTANCE messages', () => {
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_1',
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
      message: 'Approve the push in your phone app.',
    }),
    true,
  );
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'ASSISTANCE',
      owner_action: 'provide_value',
      progress_posture: 'blocked',
      response_contract: 'none',
    }),
    true,
  );
  // INTERACTION still flows through brokerInteraction → fireWebPush, not here.
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'INTERACTION',
      owner_action: 'act_elsewhere',
      progress_posture: 'blocked',
      response_contract: 'none',
    }),
    false,
  );
  // Non-attention assistance (e.g. pure timeline narration) MUST NOT push.
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'ASSISTANCE',
      owner_action: 'none',
      progress_posture: 'running',
      response_contract: 'none',
    }),
    false,
  );
  // Missing owner_action MUST NOT push — the predicate must require a
  // declared owner_action string before fanning out, not just reject the
  // sentinel "none". A malformed/incomplete connector message that omits
  // owner_action would otherwise silently ring the owner's phone.
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'ASSISTANCE',
      progress_posture: 'running',
      response_contract: 'none',
    }),
    false,
  );
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'ASSISTANCE',
      owner_action: null,
      progress_posture: 'running',
      response_contract: 'none',
    }),
    false,
  );
  // response_required is handled by the blocking interaction broker.
  assert.equal(
    shouldFanoutAssistanceProgress({
      type: 'ASSISTANCE',
      owner_action: 'provide_value',
      progress_posture: 'blocked',
      response_contract: 'response_required',
    }),
    false,
  );
  // Ordinary progress ticks must not push.
  assert.equal(
    shouldFanoutAssistanceProgress({ type: 'log', message: 'doing things' }),
    false,
  );
  assert.equal(shouldFanoutAssistanceProgress(null), false);
});

test('assistance Web Push payload routes to the run page and omits raw assistance text', () => {
  const payload = buildAssistancePushPayload({
    runId: 'run_assist',
    connectorDisplayName: 'ChatGPT',
    assistance: {
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_secret_42',
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
      // Connector free text and any future fields must NOT appear in the
      // push payload — locked screens are an untrusted surface.
      message: 'Approve the ChatGPT push notification — code 482913.',
      sensitivity: 'non_secret',
    },
  });

  assert.equal(payload.type, 'pdpp.assistance_requested');
  assert.equal(payload.url, '/dashboard/runs/run_assist');
  assert.equal(payload.assistance_request_id, 'asst_secret_42');
  assert.equal(payload.owner_action, 'act_elsewhere');
  assert.equal(payload.notification_tier, 'action_required');
  assert.equal(payload.response_contract, 'none');

  const serialized = JSON.stringify(payload);
  for (const forbidden of [
    '482913',
    'Approve the ChatGPT push notification',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `assistance payload leaked ${forbidden}`);
  }
});

test('assistance Web Push fanout targets the owner and surfaces failures as marked subscriptions', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/assist-local'), {});
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/assist-gone'), {});
  await store.upsert('owner_other', sampleSubscription('https://push.example.invalid/sub/assist-other'), {});

  const sent = [];
  const result = await fanoutAssistanceWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    assistance: {
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_1',
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
    },
    connectorDisplayName: 'ChatGPT',
    ownerSubjectId: 'owner_local',
    runId: 'run_assist',
    log: { warn() {} },
    sender: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, type: payload.type });
      if (subscription.endpoint.endsWith('/assist-gone')) {
        const err = new Error('Gone');
        err.statusCode = 410;
        throw err;
      }
    },
  });

  assert.equal(result.attempted, 2);
  assert.equal(result.sent, 1);
  assert.equal(result.unavailable, false);
  assert.equal(
    sent.every((entry) => entry.type === 'pdpp.assistance_requested'),
    true,
  );
  assert.equal(
    sent.some((entry) => entry.endpoint === 'https://push.example.invalid/sub/assist-other'),
    false,
    'assistance fanout must remain scoped to the owning subject',
  );
  const active = await store.list('owner_local');
  assert.equal(active.length, 1);
  assert.equal(active[0].endpoint, 'https://push.example.invalid/sub/assist-local');
});

test('assistance Web Push fanout reports unavailable when VAPID is unconfigured', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/assist-noop'), {});

  const result = await fanoutAssistanceWebPush({
    config: { enabled: false, publicKey: null, privateKey: null, subject: 'mailto:test@example.invalid' },
    store,
    assistance: {
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_x',
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
    },
    connectorDisplayName: 'ChatGPT',
    ownerSubjectId: 'owner_local',
    runId: 'run_assist_unavail',
    log: { warn() {} },
    sender: async () => {
      throw new Error('sender should not be invoked when VAPID is disabled');
    },
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, unavailable: true });
});

test('manual-run controller progress handler fans out assistance Web Push without forwarding raw assistance text', async () => {
  // Smallest-surface end-to-end check that the controller's manual-run
  // onProgress wiring actually invokes the assistance fanout for qualifying
  // ASSISTANCE messages, ignores ordinary progress, and never echoes
  // connector-supplied prose. We assert against the controller source rather
  // than spinning the full controller; this matches the existing
  // "controller keeps ntfy and Web Push as independent best-effort
  // notification channels" assertion style.
  const src = await readFile(new URL('../runtime/controller.ts', import.meta.url), 'utf8');
  // Manual-run onProgress is no longer a no-op.
  assert.equal(
    /onProgress: \(\) => \{\s*\/\/ no-op; progress is persisted via the event spine, not this callback\.\s*\},/.test(src),
    false,
    'manual-run onProgress must wire ASSISTANCE fanout, not stay a no-op',
  );
  // It must filter by the documented predicate.
  assert.match(src, /shouldFanoutAssistanceProgressMessage\(msg\)/);
  // And it must invoke fireAssistanceWebPush — not fireWebPush — for ASSISTANCE
  // via the detachControllerTask helper that replaced bare `void` swallows.
  assert.match(src, /detachControllerTask\(\s*fireAssistanceWebPush\(\{/);
  // The fanout helper must thread runId/ownerSubjectId from controller scope.
  assert.match(
    src,
    /fireAssistanceWebPush\([\s\S]*?ownerSubjectId,[\s\S]*?runId,/,
    'fireAssistanceWebPush must receive ownerSubjectId and runId from the manual-run scope',
  );
});

test('controller keeps ntfy and Web Push as independent best-effort notification channels', async () => {
  const src = await readFile(new URL('../runtime/controller.ts', import.meta.url), 'utf8');
  // Each channel is invoked through detachControllerTask so failures do not
  // affect interaction resolution (the prior `void fireXxx(...)` form was
  // replaced when controller-fanout cleanups landed).
  assert.match(src, /detachControllerTask\(\s*fireNtfy\(/);
  assert.match(src, /detachControllerTask\(\s*fireWebPush\(/);
  assert.match(src, /ntfy fire for run .* failed/);
  assert.match(src, /web push fire for run .* failed/);
});

test('scheduler interactions carry run context needed for server-side Web Push fanout', async () => {
  const src = await readFile(new URL('../runtime/scheduler.ts', import.meta.url), 'utf8');
  assert.match(src, /onStarted: \(run\) =>/);
  assert.match(src, /connector_display_name: connectorDisplayName/);
  assert.match(src, /run_id:\s*runId/);
});

test('reference scheduler Web Push fanout uses the server subscription store and owner subject', async () => {
  const src = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(src, /fanoutPendingInteractionWebPush/);
  assert.match(src, /webPushSubscriptionStore: webPushStore/);
  assert.match(src, /ownerSubjectId: ownerAuthSubjectId/);
  assert.match(src, /store: webPushSubscriptionStore/);
  assert.match(src, /routeTo: 'run'/);
});

test('test notification Web Push payload carries no secrets and routes to /dashboard', () => {
  const payload = buildTestPushPayload();
  assert.equal(payload.type, 'pdpp.test_notification');
  assert.equal(payload.url, '/dashboard');
  assert.equal(typeof payload.title, 'string');
  assert.equal(typeof payload.body, 'string');
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['password', 'cookie', 'token', 'otp', 'answer', 'credential', 'secret']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test('test Web Push fanout is scoped to the requesting owner subject', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/test-local'), {});
  await store.upsert('owner_other', sampleSubscription('https://push.example.invalid/sub/test-other'), {});

  const endpoints = [];
  const result = await fanoutTestWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    ownerSubjectId: 'owner_local',
    log: { warn() {} },
    sender: async (subscription, payload) => {
      assert.equal(payload.type, 'pdpp.test_notification');
      endpoints.push(subscription.endpoint);
    },
  });

  assert.deepEqual(endpoints, ['https://push.example.invalid/sub/test-local']);
  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(result.unavailable, false);
});

test('test Web Push fanout reports unavailable when VAPID is not configured', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/test-unavail'), {});

  const result = await fanoutTestWebPush({
    config: { enabled: false, publicKey: null, privateKey: null, subject: 'mailto:test@example.invalid' },
    store,
    ownerSubjectId: 'owner_local',
    log: { warn() {} },
    sender: async () => {
      throw new Error('sender should not be invoked when VAPID is disabled');
    },
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, unavailable: true });
});

test('POST /_ref/web-push/test requires owner session when owner auth is enabled', async () => {
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
      const response = await fetch(`${asUrl}/_ref/web-push/test`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      assert.equal(response.status, 401);
    },
  );
});

test('POST /_ref/web-push/test returns 503 when VAPID is unconfigured', async () => {
  await withServer(
    {
      webPushSubscriptionStore: createMemoryWebPushSubscriptionStore(),
      webPushConfig: {
        enabled: false,
        publicKey: null,
        privateKey: null,
        subject: 'mailto:test@example.invalid',
        unavailableReason: 'VAPID public/private keys are not configured',
      },
    },
    async ({ asUrl }) => {
      const response = await fetch(`${asUrl}/_ref/web-push/test`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      assert.equal(response.status, 503);
    },
  );
});

// ─── 5.4 / 5.6 policy: push is a delivery channel, not state ───────────────

test('classifyInteractionSensitivity defaults to secret for unknown kinds', () => {
  assert.equal(classifyInteractionSensitivity('otp'), 'secret');
  assert.equal(classifyInteractionSensitivity('credentials'), 'secret');
  assert.equal(classifyInteractionSensitivity('manual_action'), 'external');
  assert.equal(classifyInteractionSensitivity('something_new'), 'secret');
  assert.equal(classifyInteractionSensitivity(undefined), 'secret');
  assert.equal(classifyInteractionSensitivity(''), 'secret');
});

test('pending interaction payload is frozen so spreads cannot leak connector free text', () => {
  const payload = buildPendingInteractionPushPayload({
    runId: 'run_frozen',
    connectorDisplayName: 'Bank',
    interaction: {
      kind: 'otp',
      request_id: 'int_frozen',
      message: 'one-time code is 482913',
      schema: { properties: { otp: { const: '482913' } } },
      data: { answer: '482913' },
    },
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(payload.interaction_sensitivity, 'secret');
  // The frozen payload exposes only the safelisted keys.
  assert.deepEqual(
    [...Object.keys(payload)].sort(),
    [
      'body',
      'connector_display_name',
      'interaction_id',
      'interaction_kind',
      'interaction_sensitivity',
      'run_id',
      'timestamp',
      'title',
      'type',
      'url',
    ],
  );
});

test('manual browser verification (manual_action) classifies as external, not secret', () => {
  const payload = buildPendingInteractionPushPayload({
    runId: 'run_verify',
    connectorDisplayName: 'Source',
    interaction: {
      kind: 'manual_action',
      request_id: 'int_verify',
      message: 'Visit https://provider.example/verify and click Continue',
    },
  });
  assert.equal(payload.interaction_sensitivity, 'external');
  assert.equal(payload.body, 'A connector needs you to take an action.');
  const serialized = JSON.stringify(payload);
  for (const forbidden of ['provider.example', 'verify']) {
    // "verify" appears in the run id segment; check the body only.
    if (forbidden === 'verify') continue;
    assert.equal(serialized.includes(forbidden), false, `payload leaked ${forbidden}`);
  }
});

test('re-consent kind defaults to secret and produces no connector copy', () => {
  // We have not classified `re_consent` explicitly — the default-secret
  // policy means the body stays maximally generic, even if connectors
  // start emitting this kind tomorrow.
  const payload = buildPendingInteractionPushPayload({
    runId: 'run_reconsent',
    connectorDisplayName: 'ChatGPT',
    interaction: {
      kind: 're_consent',
      request_id: 'int_reconsent',
      message: 'Click Re-grant on the provider page (your scope ABCDE expired)',
    },
  });
  assert.equal(payload.interaction_sensitivity, 'secret');
  assert.equal(payload.body, 'A connector needs owner input.');
  assert.equal(JSON.stringify(payload).includes('ABCDE'), false);
});

test('assistance payload is frozen and never carries assistance.message text', () => {
  const payload = buildAssistancePushPayload({
    runId: 'run_assist_frozen',
    connectorDisplayName: 'ChatGPT',
    assistance: {
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_frozen',
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
      message: 'Approve the prompt — code 991122',
      data: { answer: 'secret-answer' },
    },
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(JSON.stringify(payload).includes('991122'), false);
  assert.equal(JSON.stringify(payload).includes('secret-answer'), false);
});

test('failed push delivery updates subscription metadata without changing higher-level attention state', async () => {
  // This test stands in for the "push is a delivery channel, not state" policy
  // at the runtime level: invoking a push fanout that fails must update the
  // subscription store (delivery metadata) but must not have side effects on
  // any caller-owned state. We assert this by capturing a snapshot of an
  // out-of-band "attention" object and proving it is byte-equal afterwards.
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/state-test'), {});

  const attentionLikeState = Object.freeze({
    attention_id: 'att_99',
    connection_id: 'conn_99',
    lifecycle: 'open',
    sensitivity: 'non_secret',
  });
  const before = JSON.stringify(attentionLikeState);

  const result = await fanoutPendingInteractionWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    interaction: { kind: 'manual_action', request_id: 'int_state_test' },
    connectorDisplayName: 'Connector',
    ownerSubjectId: 'owner_local',
    runId: 'run_state_test',
    log: { warn() {} },
    sender: async () => {
      const err = new Error('upstream temporarily unavailable');
      err.statusCode = 500;
      throw err;
    },
  });

  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 0);
  // Failure recorded on the subscription, but the subscription is NOT revoked
  // (500 is transient, not 404/410).
  const visible = (await store.list('owner_local', { activeOnly: false }))[0];
  assert.equal(visible.last_failure_reason, 'upstream temporarily unavailable');
  assert.equal(visible.revoked_at, null);
  // Out-of-band state is unaffected — push delivery never mutates it.
  assert.equal(JSON.stringify(attentionLikeState), before);
});

test('410 Gone revokes the subscription but still leaves out-of-band state untouched', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/gone-test'), {});

  const attentionLikeState = Object.freeze({ lifecycle: 'open' });
  const before = JSON.stringify(attentionLikeState);

  await fanoutAssistanceWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    assistance: {
      type: 'ASSISTANCE',
      assistance_request_id: 'asst_gone',
      owner_action: 'act_elsewhere',
      progress_posture: 'running',
      response_contract: 'none',
    },
    connectorDisplayName: 'ChatGPT',
    ownerSubjectId: 'owner_local',
    runId: 'run_gone_test',
    log: { warn() {} },
    sender: async () => {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    },
  });

  const stillActive = await store.list('owner_local');
  assert.equal(stillActive.length, 0, 'subscription is revoked after 410');
  assert.equal(JSON.stringify(attentionLikeState), before);
});

// ─── classifyPushFanoutOutcome ────────────────────────────────────────────

test('classifyPushFanoutOutcome: VAPID unavailable -> suppressed/channel_unavailable', () => {
  assert.deepEqual(
    classifyPushFanoutOutcome({ attempted: 0, sent: 0, unavailable: true }),
    { state: 'suppressed', reason: 'channel_unavailable' },
  );
});

test('classifyPushFanoutOutcome: policy-suppressed (quiet hours, etc.) -> suppressed/policy_suppressed', () => {
  assert.deepEqual(
    classifyPushFanoutOutcome({ attempted: 0, sent: 0, suppressed: true, unavailable: false }),
    { state: 'suppressed', reason: 'policy_suppressed' },
  );
});

test('classifyPushFanoutOutcome: no opted-in channel -> suppressed/no_opted_in_channel', () => {
  assert.deepEqual(
    classifyPushFanoutOutcome({ attempted: 0, sent: 0, unavailable: false }),
    { state: 'suppressed', reason: 'no_opted_in_channel' },
  );
});

test('classifyPushFanoutOutcome: at least one accepted -> sent', () => {
  assert.deepEqual(
    classifyPushFanoutOutcome({ attempted: 2, sent: 1, unavailable: false }),
    { state: 'sent', reason: null },
  );
});

test('classifyPushFanoutOutcome: every subscription rejected -> failed with transport reason', () => {
  const result = classifyPushFanoutOutcome({
    attempted: 2,
    sent: 0,
    unavailable: false,
    failureReasons: ['410 gone', 'timeout'],
  });
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /transport:/);
  assert.match(result.reason, /410 gone/);
});

test('classifyPushFanoutOutcome: malformed result -> failed/no_result', () => {
  assert.deepEqual(classifyPushFanoutOutcome(null), { state: 'failed', reason: 'no_result' });
  assert.deepEqual(classifyPushFanoutOutcome('unexpected'), { state: 'failed', reason: 'no_result' });
});

test('fanoutPendingInteractionWebPush: recordOutcome callback fires with suppressed when VAPID is unavailable', async () => {
  // Force VAPID-disabled config so the fanout short-circuits to the
  // `unavailable: true` branch. The outcome callback must STILL be
  // invoked so the durable attention row sees notification_state set —
  // silent suppression is the failure mode this contract prevents.
  const outcomes = [];
  await fanoutPendingInteractionWebPush({
    config: { enabled: false, publicKey: null, privateKey: null, subject: 'mailto:x@y' },
    store: createMemoryWebPushSubscriptionStore(),
    sender: async () => {
      throw new Error('sender should not be called when VAPID is disabled');
    },
    interaction: {
      request_id: 'int_outcome_a',
      run_id: 'run_outcome_a',
      kind: 'manual_action',
    },
    connectorDisplayName: 'Test',
    ownerSubjectId: 'owner_a',
    runId: 'run_outcome_a',
    log: { warn() {}, info() {} },
    recordOutcome: async (entry) => {
      outcomes.push(entry);
    },
  });
  assert.deepEqual(outcomes, [{ state: 'suppressed', reason: 'channel_unavailable' }]);
});
