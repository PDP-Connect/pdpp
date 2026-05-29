/**
 * MCP-layer end-to-end proof for client event subscriptions.
 *
 * Proves that an AI-agent client can subscribe to PDPP events and receive a
 * minimal notification flow without hand-rolling verifier logic — the exact
 * acceptance target for the ri-event-subscription-e2e-client workstream.
 *
 * Every subscription operation is driven through the MCP JSON-RPC tool layer
 * (`tools/call` against /mcp) using a real AS+RS (in-memory SQLite). A local
 * HTTP receiver completes the verification handshake so the subscription
 * transitions from `pending_verification` to `active` under normal delivery
 * timing.
 *
 * Covered path:
 *   discover_event_subscription_capabilities
 *   → create_event_subscription (callback_url → receiver)
 *   → receiver echoes challenge → subscription becomes active
 *   → send_test_event → receiver gets pdpp.subscription.test
 *   → list_event_subscriptions → entry present with status active
 *   → get_event_subscription → subscription detail matches
 *   → delete_event_subscription → subscription removed
 *   → list_event_subscriptions → empty after delete
 *
 * This test does NOT exercise the changes_since read path (that lives in
 * client-event-subscriptions-e2e.test.js and depends on the read-route family
 * work tracked separately).
 */

import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

function startTestServer() {
  return startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
  });
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: resp.status, body };
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

async function registerSpotify(asUrl) {
  const manifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(status, 201);
  return manifest;
}

async function registerAuthCodeClient(asUrl) {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP subscription e2e test client',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      token_endpoint_auth_method: 'none',
    }),
  });
  assert.equal(status, 201);
  return body;
}

async function completeOauthCodeFlow({ asUrl, client, manifest }) {
  const verifier = randomBytes(32).toString('base64url');
  const authorizationDetails = [
    {
      type: 'https://pdpp.org/data-access',
      source: { kind: 'connector', id: manifest.connector_id },
      purpose_code: 'https://pdpp.org/purpose/personal_ai_assistant',
      purpose_description: 'MCP subscription e2e test',
      access_mode: 'continuous',
      streams: [{ name: '*' }],
    },
  ];
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', client.client_id);
  authorizeUrl.searchParams.set('redirect_uri', 'https://client.example/callback');
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('state', 'state-e2e');
  authorizeUrl.searchParams.set('code_challenge', pkceChallenge(verifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('authorization_details', JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorizeResp.status, 302);
  const consentUrl = new URL(authorizeResp.headers.get('location'), asUrl);
  const requestUri = consentUrl.searchParams.get('request_uri');
  assert.ok(requestUri);

  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_uri: requestUri, subject_id: 'owner_mcp_e2e' }).toString(),
  });
  assert.equal(approveResp.status, 302);
  const callback = new URL(approveResp.headers.get('location'));
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(status, 200);
  return body.access_token;
}

async function postMcpJson(rsUrl, token, message) {
  const resp = await fetch(`${rsUrl}/mcp`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });
  const body = await resp.json();
  return { status: resp.status, body };
}

async function mcpInitialize(rsUrl, token) {
  const resp = await postMcpJson(rsUrl, token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } },
  });
  assert.equal(resp.status, 200);
}

async function mcpCallTool(rsUrl, token, name, args, id = 10) {
  const resp = await postMcpJson(rsUrl, token, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  assert.equal(resp.status, 200, `tools/call ${name} returned HTTP ${resp.status}`);
  return resp.body;
}

/** Start a minimal local receiver that echoes verification challenges. */
function startReceiver() {
  const events = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const record = { method: req.method, url: req.url, headers: { ...req.headers }, body };
        events.push(record);
        let payload = null;
        try { payload = JSON.parse(body); } catch {}
        record.payload = payload;
        if (payload?.type === 'pdpp.subscription.verify') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ challenge: payload.data?.challenge }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/webhook`,
        events,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function waitForEvent(receiver, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = receiver.events.find(predicate);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting for receiver event');
}

function verifyStandardWebhooksSignature(secret, headers, body) {
  const id = headers['webhook-id'];
  const ts = headers['webhook-timestamp'];
  const sig = headers['webhook-signature'];
  if (!id || !ts || !sig) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64')}`;
  return sig.split(/\s+/).some((token) => token === expected);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('agent can subscribe to PDPP events and receive a minimal notification flow via MCP tools', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const receiver = await startReceiver();

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const accessToken = await completeOauthCodeFlow({ asUrl, client, manifest });

    await mcpInitialize(rsUrl, accessToken);

    // Step 1: discover capabilities — agent learns supported event types,
    // signing profile, and verification handshake before creating a subscription.
    const discoverResult = await mcpCallTool(rsUrl, accessToken, 'discover_event_subscription_capabilities', {}, 2);
    assert.equal(discoverResult.result?.isError, undefined, 'discover must not be an error');
    // discover_event_subscription_capabilities places the capability block in
    // structuredContent.capability (not structuredContent.data.capabilities).
    const cap = discoverResult.result?.structuredContent?.capability;
    assert.ok(cap?.supported, 'client_event_subscriptions must be advertised as supported');
    assert.equal(cap.signing.profile, 'standard-webhooks', 'signing profile');
    assert.equal(cap.verification.handshake, 'post_with_challenge_echo', 'verification handshake');
    assert.ok(cap.event_types.includes('pdpp.records.changed'), 'event types include records.changed');

    // Step 2: create a subscription — callback URL points at the local receiver.
    const createResult = await mcpCallTool(rsUrl, accessToken, 'create_event_subscription', {
      callback_url: receiver.url,
    }, 3);
    assert.equal(createResult.result?.isError, undefined, 'create must not be an error');
    const createData = createResult.result?.structuredContent?.data;
    const subscriptionId = createData?.subscription_id;
    const secret = createData?.secret;
    assert.ok(subscriptionId, 'create must return a subscription_id');
    assert.ok(secret?.startsWith('whsec_'), `secret must use Standard Webhooks prefix; got ${secret}`);

    // Step 3: receiver echoes the verification challenge; subscription transitions active.
    const verifyEvent = await waitForEvent(
      receiver,
      (e) => e.payload?.type === 'pdpp.subscription.verify',
    );
    assert.equal(verifyEvent.payload.data.subscription_id, subscriptionId);
    assert.ok(
      verifyStandardWebhooksSignature(secret, verifyEvent.headers, verifyEvent.body),
      'verify event signature must validate',
    );
    // Allow delivery worker to process the echo response.
    await new Promise((r) => setTimeout(r, 50));

    // Step 4: get subscription — confirm status is active.
    const getResult = await mcpCallTool(rsUrl, accessToken, 'get_event_subscription', {
      subscription_id: subscriptionId,
    }, 4);
    assert.equal(getResult.result?.isError, undefined, 'get must not be an error');
    const subDetail = getResult.result?.structuredContent?.data;
    assert.equal(subDetail?.status, 'active', `expected active, got ${subDetail?.status}`);
    assert.equal(subDetail?.subscription_id, subscriptionId);

    // Step 5: send_test_event — agent confirms the delivery path works without
    // waiting for real record ingestion.
    const testResult = await mcpCallTool(rsUrl, accessToken, 'send_test_event', {
      subscription_id: subscriptionId,
    }, 5);
    assert.equal(testResult.result?.isError, undefined, 'send_test_event must not be an error');
    const testEventId = testResult.result?.structuredContent?.data?.event_id;
    assert.ok(testEventId, 'send_test_event must return an event_id');

    // Receiver must receive and correctly verify the signed test event.
    const testHit = await waitForEvent(
      receiver,
      (e) => e.payload?.type === 'pdpp.subscription.test',
    );
    assert.equal(testHit.payload.data.subscription_id, subscriptionId);
    assert.ok(
      verifyStandardWebhooksSignature(secret, testHit.headers, testHit.body),
      'test event signature must validate',
    );
    // CloudEvents 1.0 structured-mode content-type.
    assert.equal(
      testHit.headers['content-type'],
      'application/cloudevents+json; charset=utf-8',
    );
    // Projection safety: no record body in hint envelope.
    assert.equal('record' in testHit.payload.data, false);
    assert.equal('record_json' in testHit.payload.data, false);

    // Step 6: list_event_subscriptions — subscription appears in the list.
    const listResult = await mcpCallTool(rsUrl, accessToken, 'list_event_subscriptions', {}, 6);
    assert.equal(listResult.result?.isError, undefined, 'list must not be an error');
    const listData = listResult.result?.structuredContent?.data;
    const entries = Array.isArray(listData) ? listData : listData?.subscriptions ?? listData?.data ?? [];
    const found = entries.find((e) => e.subscription_id === subscriptionId);
    assert.ok(found, `subscription ${subscriptionId} must appear in list`);

    // Step 7: delete_event_subscription — cleanup.
    const deleteResult = await mcpCallTool(rsUrl, accessToken, 'delete_event_subscription', {
      subscription_id: subscriptionId,
    }, 7);
    assert.equal(deleteResult.result?.isError, undefined, 'delete must not be an error');

    // List is empty after delete.
    const listAfter = await mcpCallTool(rsUrl, accessToken, 'list_event_subscriptions', {}, 8);
    const afterEntries = (() => {
      const d = listAfter.result?.structuredContent?.data;
      return Array.isArray(d) ? d : d?.subscriptions ?? d?.data ?? [];
    })();
    const stillPresent = afterEntries.find((e) => e.subscription_id === subscriptionId);
    assert.equal(stillPresent, undefined, 'deleted subscription must not appear in list');
  } finally {
    await receiver.close();
    await closeServer(server);
  }
});

test('agent: update_event_subscription can disable and re-enable an active subscription', async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const receiver = await startReceiver();

  try {
    const manifest = await registerSpotify(asUrl);
    const client = await registerAuthCodeClient(asUrl);
    const accessToken = await completeOauthCodeFlow({ asUrl, client, manifest });

    await mcpInitialize(rsUrl, accessToken);

    const createResult = await mcpCallTool(rsUrl, accessToken, 'create_event_subscription', {
      callback_url: receiver.url,
    }, 11);
    const { subscription_id: subId, secret } = createResult.result?.structuredContent?.data ?? {};
    assert.ok(subId);
    assert.ok(secret?.startsWith('whsec_'));

    // Wait for verify event; echo lets it go active.
    await waitForEvent(receiver, (e) => e.payload?.type === 'pdpp.subscription.verify');
    await new Promise((r) => setTimeout(r, 50));

    // Disable.
    const disableResult = await mcpCallTool(rsUrl, accessToken, 'update_event_subscription', {
      subscription_id: subId,
      enabled: false,
    }, 12);
    assert.equal(disableResult.result?.isError, undefined);
    // PATCH /v1/event-subscriptions/:id returns { subscription: {...}, secret? }
    const disabledSub = disableResult.result?.structuredContent?.data?.subscription;
    assert.equal(disabledSub?.status, 'disabled', `expected disabled, got ${disabledSub?.status}`);

    // Re-enable.
    const enableResult = await mcpCallTool(rsUrl, accessToken, 'update_event_subscription', {
      subscription_id: subId,
      enabled: true,
    }, 13);
    assert.equal(enableResult.result?.isError, undefined);
    const enabledSub = enableResult.result?.structuredContent?.data?.subscription;
    assert.equal(enabledSub?.status, 'active', `expected active, got ${enabledSub?.status}`);

    // Rotate secret — new secret returned, distinct from original.
    const rotateResult = await mcpCallTool(rsUrl, accessToken, 'update_event_subscription', {
      subscription_id: subId,
      rotate_secret: true,
    }, 14);
    assert.equal(rotateResult.result?.isError, undefined);
    const newSecret = rotateResult.result?.structuredContent?.data?.secret;
    assert.ok(newSecret?.startsWith('whsec_'), `rotated secret must use Standard Webhooks prefix; got ${newSecret}`);
    assert.notEqual(newSecret, secret, 'rotated secret must differ from original');
  } finally {
    await receiver.close();
    await closeServer(server);
  }
});
