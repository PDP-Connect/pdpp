// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createECDH, randomBytes } from 'node:crypto';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

import { closeDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { createPinnedHttpsAgent, resolveAllowedAddresses } from '../server/ssrf-guard.js';
import {
  WEB_PUSH_SEND_TIMEOUT_MS,
  buildAssistancePushPayload,
  buildPendingInteractionPushPayload,
  buildTestPushPayload,
  classifyInteractionSensitivity,
  classifyPushFanoutOutcome,
  createMemoryWebPushSubscriptionStore,
  createPostgresWebPushSubscriptionStore,
  createSqliteWebPushSubscriptionStore,
  defaultSendNotification,
  fanoutAssistanceWebPush,
  fanoutEscalationWebPush,
  fanoutPendingInteractionWebPush,
  fanoutTestWebPush,
  guardWebPushEndpoint,
  resolveWebPushModuleApi,
  shouldFanoutAssistanceProgress,
} from '../server/web-push-notifications.js';

const TEST_PASSWORD = 'web-push-owner-test-password';
const VAPID_PUBLIC = 'BAabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcd';
const VAPID_PRIVATE = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';

// Real VAPID keypair (web-push's own generateVAPIDKeys(), not a placeholder
// string) — required for the production-seam tests below, which drive the
// real web-push library end-to-end and need setVapidDetails to pass its
// genuine format validation. Generated once at module load.
const REAL_VAPID_KEYS = resolveWebPushModuleApi(await import('web-push')).generateVAPIDKeys();
const VAPID_PUBLIC_REAL = REAL_VAPID_KEYS.publicKey;
const VAPID_PRIVATE_REAL = REAL_VAPID_KEYS.privateKey;

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

function sampleSubscription(endpoint = 'https://push.example.invalid/sub/one', keys = { p256dh: 'public-key-material', auth: 'auth-secret' }) {
  return { endpoint, keys };
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

// --- SSRF guard: owner-supplied Web Push endpoint (tmp/workstreams/ssrf-terra-final-0717.md P1) ---
//
// `guardWebPushEndpoint` is the send-time SSRF guard `defaultSendNotification`
// calls before ever invoking `web-push`'s `sendNotification`. These tests
// exercise that guard directly — the smallest concept-correct seam for
// proving the SSRF properties (block-before-send, bounded validated-address
// resolution, a real pinned `https.Agent` returned on success) without
// touching VAPID/encryption, which the existing mocked-`sender` tests above
// and below already cover unchanged.

test('guardWebPushEndpoint blocks a non-public endpoint before any send is attempted', async () => {
  const guard = await guardWebPushEndpoint('https://push.example.invalid/sub/one', {
    dnsLookupImpl: async () => [{ address: '169.254.169.254' }],
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /non-public address 169\.254\.169\.254/);
});

test('guardWebPushEndpoint blocks the Terra P1 false-pass addresses for Web Push endpoints too', async () => {
  for (const ip of ['192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1']) {
    const guard = await guardWebPushEndpoint('https://push.example.invalid/sub/one', {
      dnsLookupImpl: async () => [{ address: ip }],
    });
    assert.equal(guard.ok, false, `${ip} must be blocked`);
  }
});

test('guardWebPushEndpoint blocks a non-https endpoint', async () => {
  const guard = await guardWebPushEndpoint('http://push.example.invalid/sub/one');
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /https scheme/);
});

test('guardWebPushEndpoint fails closed on an oversized DNS answer (bounded fallback)', async () => {
  const addrs = Array.from({ length: 128 }, (_, i) => ({ address: `8.8.8.${i % 255}` }));
  const guard = await guardWebPushEndpoint('https://push.example.invalid/sub/one', {
    dnsLookupImpl: async () => addrs,
  });
  assert.equal(guard.ok, false);
  assert.match(guard.reason, /exceeding the bound/);
});

test('guardWebPushEndpoint allows a public endpoint and returns a pinned https.Agent bound to the validated address (falsifiable, real socket)', async () => {
  // A real https.Agent (not a mock) whose createConnection dials only the
  // literal validated address — proved by spying on node:tls's connect
  // (what the pinned agent calls directly for TLS) with an endpoint hostname
  // that cannot itself resolve (.invalid TLD).
  const https = await import('node:https');

  const originalConnect = tls.connect;
  const dialedHosts = [];
  tls.connect = function spiedTlsConnect(opts, ...rest) {
    dialedHosts.push(opts && opts.host);
    return originalConnect.call(this, opts, ...rest);
  };

  try {
    const guard = await guardWebPushEndpoint('https://rebind-webpush-proof.invalid/sub/one', {
      // Simulates the address that passed the SSRF check (a stand-in for a
      // real public address; the allow/block decision is already covered by
      // the tests above with the real classifier).
      dnsLookupImpl: async () => [{ address: '127.0.0.1' }],
      isGlobalUnicastAddressImpl: () => true,
    });
    assert.equal(guard.ok, true);
    assert.equal(typeof guard.agent.createConnection, 'function');

    // Drive a real request through the returned agent (nothing needs to be
    // listening — the assertion is about the dialed address, not a full
    // round trip).
    await new Promise((resolve) => {
      const req = https.request(
        {
          hostname: 'rebind-webpush-proof.invalid',
          port: 44300,
          path: '/',
          method: 'POST',
          agent: guard.agent,
          timeout: 2000,
        },
        () => resolve(),
      );
      req.on('error', () => resolve());
      req.on('timeout', () => {
        req.destroy();
        resolve();
      });
      req.end();
    });

    assert.deepEqual(
      dialedHosts,
      ['127.0.0.1'],
      'the pinned https.Agent must dial the validated IP literal, never the original unresolvable hostname',
    );
    guard.agent.destroy();
  } finally {
    tls.connect = originalConnect;
  }
});

test('createPinnedHttpsAgent is a real https.Agent instance (required by web-push\'s instanceof check)', async () => {
  const https = await import('node:https');
  const agent = createPinnedHttpsAgent(['127.0.0.1']);
  assert.equal(agent instanceof https.Agent, true);
  agent.destroy();
});

// --- defaultSendNotification: production-seam tests (tmp/workstreams/ssrf-sol-final-0717.md P2) ---
//
// The tests above exercise `guardWebPushEndpoint` directly — the smallest
// concept-correct seam for the allow/block decision, and sufficient to prove
// that in isolation. They do NOT prove the production sender
// (`defaultSendNotification`, the function actually wired as `sender` in
// every fanout call site) forwards the guard's pinned agent and timeout to
// the real `web-push` library, preserves SNI/VAPID correctness, or cleans up
// the agent on every outcome — Sol's review found exactly this gap and
// required closing it with a BEHAVIORAL mutant (a variant that still exports
// and runs, but silently skips using the guard/agent/timeout), not a
// missing-export import failure (reverting the whole file, which merely
// proves the export didn't exist yet, proves nothing about a regression that
// keeps the export but weakens its behavior).
//
// These tests drive `defaultSendNotification` itself against a real local
// HTTPS server (self-signed cert) and real VAPID/subscription key material
// generated via Node's own crypto.createECDH/generateVAPIDKeys (not
// hand-crafted fixtures — the standard API any real caller would use), so
// the full production code path — guard, agent construction, `web-push`'s
// own request building, VAPID header generation — runs for real. A thin
// spy wrapper around the real `web-push` module (calls straight through to
// it; does not reimplement or approximate anything) records the exact
// options `defaultSendNotification` passed, which is what proves forwarding
// without weakening the oracle to "did the mock get called."

function generateSelfSignedCertForWebPush() {
  const dir = mkdtempSync(join(tmpdir(), 'web-push-cert-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=web-push-seam-test.invalid'],
      { stdio: ['ignore', 'ignore', 'ignore'] },
    );
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Real ECDH subscriber keys (crypto.createECDH), not reverse-engineered
// bytes — this is the standard Node API a real browser subscription's
// p256dh/auth would be validated the same way against.
function generateRealSubscriptionKeys() {
  const ecdh = createECDH('prime256v1');
  const p256dh = ecdh.generateKeys().toString('base64url');
  const auth = randomBytes(16).toString('base64url');
  return { p256dh, auth };
}

async function withSelfSignedWebPushServer(handler, fn) {
  const cert = generateSelfSignedCertForWebPush();
  const server = https.createServer({ key: cert.key, cert: cert.cert }, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/**
 * Wraps the REAL `web-push` module: every call passes straight through to
 * the real implementation (so VAPID headers, encryption, and request
 * building are all genuinely exercised), while recording the exact
 * `sendNotification` options object `defaultSendNotification` passed. This
 * is what makes the test prove forwarding rather than merely proving a
 * mock was invoked.
 */
async function spyOnRealWebPush() {
  const real = resolveWebPushModuleApi(await import('web-push'));
  const calls = [];
  return {
    calls,
    module: {
      setVapidDetails: (...args) => real.setVapidDetails(...args),
      sendNotification: (subscription, payload, options) => {
        calls.push({ subscription, payload, options });
        return real.sendNotification(subscription, payload, options);
      },
    },
  };
}

/**
 * A test-only `guardWebPushEndpointImpl` that runs the REAL allow/block
 * decision (`resolveAllowedAddresses`, with DNS/classifier injected so no
 * real network resolution is needed) and builds a pinned agent with
 * `rejectUnauthorized: false` — the only difference from production
 * `guardWebPushEndpoint`, needed because these tests' HTTPS server uses a
 * throwaway self-signed cert (real TLS handshake, real cert chain
 * validation would otherwise fail on that alone, unrelated to anything this
 * change is testing). The guard decision logic itself, and the pinning
 * mechanism, are the real production code — only the agent's TLS trust
 * option differs from what `guardWebPushEndpoint` passes.
 */
function testGuardWithSelfSignedTrust(resolvedAddress) {
  return async (endpoint) => {
    const parsed = new URL(endpoint);
    const resolved = await resolveAllowedAddresses(parsed.hostname, {
      dnsLookupImpl: async () => [{ address: resolvedAddress }],
      isGlobalUnicastAddressImpl: () => true,
    });
    if (!resolved.ok) return { ok: false, reason: `test guard: ${resolved.kind}` };
    return { ok: true, agent: createPinnedHttpsAgent(resolved.addresses, { rejectUnauthorized: false }) };
  };
}

test('defaultSendNotification blocks before ever calling into the web-push library (production seam, real guard)', async () => {
  const webPushModule = await import('web-push');
  const realApi = resolveWebPushModuleApi(webPushModule);
  let sendNotificationCalled = false;
  const spyModule = {
    setVapidDetails: (...args) => realApi.setVapidDetails(...args),
    sendNotification: (...args) => {
      sendNotificationCalled = true;
      return realApi.sendNotification(...args);
    },
  };
  const keys = generateRealSubscriptionKeys();
  const config = { subject: 'mailto:test@example.invalid', publicKey: VAPID_PUBLIC_REAL, privateKey: VAPID_PRIVATE_REAL };

  await assert.rejects(
    () =>
      defaultSendNotification(sampleSubscription('https://blocked.invalid/sub/one', keys), { hello: 'world' }, config, {
        guardWebPushEndpointImpl: async () => ({ ok: false, reason: 'endpoint host blocked.invalid resolves to a non-public address 169.254.169.254' }),
        webPushModuleImpl: spyModule,
      }),
    /Web Push send blocked/,
  );
  assert.equal(sendNotificationCalled, false, 'web-push.sendNotification must never be called when the guard blocks');
});

test('defaultSendNotification forwards the pinned agent and the exact send timeout to the real web-push call, and preserves SNI/VAPID (production seam, real socket + real crypto)', async () => {
  await withSelfSignedWebPushServer(
    (req, res) => {
      res.writeHead(201, { Location: `https://web-push-seam-test.invalid${req.url}/receipt` });
      res.end();
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/seam`, keys);
      const config = { subject: 'mailto:test@example.invalid', publicKey: VAPID_PUBLIC_REAL, privateKey: VAPID_PRIVATE_REAL };
      const spy = await spyOnRealWebPush();

      const originalTlsConnect = tls.connect;
      const dialedHosts = [];
      tls.connect = function spiedTlsConnect(opts, ...rest) {
        dialedHosts.push({ host: opts && opts.host, servername: opts && opts.servername });
        return originalTlsConnect.call(this, opts, ...rest);
      };

      try {
        const result = await defaultSendNotification(subscription, { hello: 'world' }, config, {
          guardWebPushEndpointImpl: testGuardWithSelfSignedTrust('127.0.0.1'),
          webPushModuleImpl: spy.module,
        });

        assert.equal(result.statusCode, 201, 'the real web-push call must reach the real server and get a real response');
        assert.equal(spy.calls.length, 1, 'defaultSendNotification must call web-push.sendNotification exactly once');

        const forwarded = spy.calls[0].options;
        assert.equal(typeof forwarded.agent, 'object', 'the pinned agent must be forwarded');
        assert.equal(forwarded.agent instanceof https.Agent, true);
        assert.equal(forwarded.timeout, WEB_PUSH_SEND_TIMEOUT_MS, 'the exact configured send timeout must be forwarded');

        // VAPID: the real library generated a real Authorization header from
        // the real config — this only succeeds if setVapidDetails/getVapidHeaders
        // ran for real (a broken/bypassed VAPID path would throw before this).
        assert.match(spy.calls[0].payload, /./, 'payload was encrypted (non-empty ciphertext), proving the real encryption path ran');

        // SNI continuity: the pinned agent dialed the literal validated IP
        // (127.0.0.1), but presented the ORIGINAL hostname as TLS SNI — proving
        // address pinning did not silently break certificate/SNI behavior.
        assert.equal(dialedHosts.length >= 1, true);
        assert.equal(dialedHosts[0].host, '127.0.0.1', 'must dial the validated literal address');
        assert.equal(dialedHosts[0].servername, 'web-push-seam-test.invalid', 'must present the original hostname as SNI');
      } finally {
        tls.connect = originalTlsConnect;
      }
    },
  );
});

test('defaultSendNotification destroys the pinned agent on success (production seam, real socket)', async () => {
  await withSelfSignedWebPushServer(
    (_req, res) => {
      res.writeHead(201);
      res.end();
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/cleanup-success`, keys);
      const config = { subject: 'mailto:test@example.invalid', publicKey: VAPID_PUBLIC_REAL, privateKey: VAPID_PRIVATE_REAL };
      let destroyCallCount = 0;
      const spy = await spyOnRealWebPush();
      const observingModule = {
        setVapidDetails: spy.module.setVapidDetails,
        sendNotification: (subscription_, payload, options) => {
          const originalDestroy = options.agent.destroy.bind(options.agent);
          options.agent.destroy = (...args) => {
            destroyCallCount += 1;
            return originalDestroy(...args);
          };
          return spy.module.sendNotification(subscription_, payload, options);
        },
      };

      await defaultSendNotification(subscription, { hello: 'world' }, config, {
        guardWebPushEndpointImpl: testGuardWithSelfSignedTrust('127.0.0.1'),
        webPushModuleImpl: observingModule,
      });

      assert.equal(destroyCallCount, 1, 'the pinned agent\'s destroy() must be called exactly once after a successful send');
    },
  );
});

test('defaultSendNotification destroys the pinned agent on a rejected/error send (production seam, real socket)', async () => {
  await withSelfSignedWebPushServer(
    (req) => {
      // Accept the TLS handshake, then abort mid-request — a real error,
      // not a mocked rejection.
      req.socket.destroy();
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/cleanup-error`, keys);
      const config = { subject: 'mailto:test@example.invalid', publicKey: VAPID_PUBLIC_REAL, privateKey: VAPID_PRIVATE_REAL };
      let destroyCallCount = 0;
      const spy = await spyOnRealWebPush();
      const observingModule = {
        setVapidDetails: spy.module.setVapidDetails,
        sendNotification: (subscription_, payload, options) => {
          const originalDestroy = options.agent.destroy.bind(options.agent);
          options.agent.destroy = (...args) => {
            destroyCallCount += 1;
            return originalDestroy(...args);
          };
          return spy.module.sendNotification(subscription_, payload, options);
        },
      };

      await assert.rejects(() =>
        defaultSendNotification(subscription, { hello: 'world' }, config, {
          guardWebPushEndpointImpl: testGuardWithSelfSignedTrust('127.0.0.1'),
          webPushModuleImpl: observingModule,
        }),
      );

      assert.equal(destroyCallCount, 1, 'the pinned agent\'s destroy() must be called exactly once after a failed send');
    },
  );
});

test('defaultSendNotification bounds a hanging endpoint with the configured timeout and destroys the agent (deterministic hanging-transport coverage)', async () => {
  // A server that accepts the connection and TLS handshake but never
  // responds and never closes — a genuine hang, not a simulated one.
  await withSelfSignedWebPushServer(
    () => {
      // Intentionally do nothing: never call res.end(), never destroy the
      // socket. The only thing that can end this request is the timeout
      // defaultSendNotification configures.
    },
    async (port) => {
      const keys = generateRealSubscriptionKeys();
      const subscription = sampleSubscription(`https://web-push-seam-test.invalid:${port}/sub/hang`, keys);
      const config = { subject: 'mailto:test@example.invalid', publicKey: VAPID_PUBLIC_REAL, privateKey: VAPID_PRIVATE_REAL };
      let destroyCallCount = 0;
      const spy = await spyOnRealWebPush();
      const observingModule = {
        setVapidDetails: spy.module.setVapidDetails,
        sendNotification: (subscription_, payload, options) => {
          const originalDestroy = options.agent.destroy.bind(options.agent);
          options.agent.destroy = (...args) => {
            destroyCallCount += 1;
            return originalDestroy(...args);
          };
          return spy.module.sendNotification(subscription_, payload, options);
        },
      };

      const start = Date.now();
      await assert.rejects(
        () =>
          defaultSendNotification(subscription, { hello: 'world' }, config, {
            guardWebPushEndpointImpl: testGuardWithSelfSignedTrust('127.0.0.1'),
            webPushModuleImpl: observingModule,
          }),
        /timeout|Socket timeout/i,
      );
      const elapsedMs = Date.now() - start;

      assert.equal(
        elapsedMs < WEB_PUSH_SEND_TIMEOUT_MS + 5_000,
        true,
        `send must be bounded near the configured timeout (${WEB_PUSH_SEND_TIMEOUT_MS}ms), took ${elapsedMs}ms`,
      );
      assert.equal(destroyCallCount, 1, 'the pinned agent\'s destroy() must be called exactly once after a timed-out send, not leaked');
    },
  );
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
  assert.equal(payload.url, '/syncs/run_secret');
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

  assert.equal(payload.url, '/syncs/run_scheduled');
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

  assert.equal(payload.url, '/syncs/run_manual/stream?interaction_id=int_manual');
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
  assert.equal(payload.url, '/syncs/run_assist');
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
  const src = await readFile(new URL('../runtime/scheduler/run-executor.ts', import.meta.url), 'utf8');
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

test('test notification Web Push payload carries no secrets and routes to the overview', () => {
  const payload = buildTestPushPayload();
  assert.equal(payload.type, 'pdpp.test_notification');
  assert.equal(payload.url, '/');
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

test('fanoutEscalationWebPush: rendered verdict channel suppresses non-attention pushes', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/calm-verdict'), {});
  let sendCount = 0;

  const result = await fanoutEscalationWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    connectorDisplayName: 'ChatGPT',
    ownerSubjectId: 'owner_local',
    reason: 'needs_attention',
    renderedVerdict: {
      channel: 'calm',
      required_actions: [
        {
          audience: 'owner',
          satisfied_when: { kind: 'credential_present_and_unrejected' },
        },
      ],
    },
    log: { warn() {} },
    sender: async () => {
      sendCount += 1;
    },
  });

  assert.deepEqual(result, { attempted: 0, sent: 0, unavailable: false, suppressed: true });
  assert.equal(sendCount, 0);
});

test('fanoutEscalationWebPush: rendered attention verdict sends to owner subscriptions', async () => {
  const store = createMemoryWebPushSubscriptionStore();
  await store.upsert('owner_local', sampleSubscription('https://push.example.invalid/sub/attention-verdict'), {});
  const sent = [];

  const result = await fanoutEscalationWebPush({
    config: {
      enabled: true,
      publicKey: VAPID_PUBLIC,
      privateKey: VAPID_PRIVATE,
      subject: 'mailto:test@example.invalid',
    },
    store,
    connectorDisplayName: 'Gmail',
    ownerSubjectId: 'owner_local',
    reason: 'needs_attention',
    connectionUrl: '/sources/cin_gmail',
    renderedVerdict: {
      channel: 'attention',
      required_actions: [
        {
          audience: 'owner',
          satisfied_when: { kind: 'credential_present_and_unrejected' },
        },
      ],
    },
    log: { warn() {} },
    sender: async (subscription, payload) => {
      sent.push({ endpoint: subscription.endpoint, payload });
    },
  });

  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.type, 'pdpp.escalation');
  assert.equal(sent[0].payload.url, '/sources/cin_gmail');
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
