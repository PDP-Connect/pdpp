// Regression tests for the harden-consent-token-handoff change.
//
// Pins the invariants:
//   1. The HTML branch of POST /consent/approve never embeds the bearer.
//   2. The HTML branch DOES embed an opaque cex_… exchange code.
//   3. POST /consent/exchange redeems the code once and returns
//      { grant_id, token, grant }.
//   4. A second redemption attempt fails with a 4xx PDPP error envelope and
//      does not leak the bearer.
//   5. An expired code fails with a 4xx PDPP error envelope.
//   6. An unknown code fails with a 4xx PDPP error envelope.
//   7. The JSON branch of POST /consent/approve still returns the bearer in
//      its JSON body.
//
// Spec: openspec/changes/harden-consent-token-handoff/specs/
//       reference-implementation-architecture/spec.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import { createConsentExchangeCode, consumeConsentExchangeCode } from '../server/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) => new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000);
    srv.close(() => { if (!settled) { settled = true; clearTimeout(t); resolve(); } });
  });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  let body = null;
  try { body = await resp.json(); } catch { /* non-json */ }
  return { status: resp.status, body, headers: Object.fromEntries(resp.headers.entries()) };
}

async function initiateGrantRequest(asUrl, spotifyManifest) {
  const initResp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'concert_recommendation_app',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          source: { kind: 'connector', id: spotifyManifest.connector_id },
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Consent token handoff regression',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        },
      ],
    }),
  });
  if (initResp.status !== 201) {
    throw new Error(`PAR failed (${initResp.status}): ${await initResp.text()}`);
  }
  return initResp.json();
}

async function withHarness(fn) {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:' });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(spotifyManifest),
    });
    assert.equal(registerResp.status, 201);
    await fn({ asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

test('security: harden consent token handoff', async (t) => {
  await t.test('HTML approve does not embed the bearer; JSON approve still returns it', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      // First, get a token via the JSON branch (this is the established
      // programmatic contract used by the dashboard and every test).
      const initiateForJson = await initiateGrantRequest(asUrl, spotifyManifest);
      const jsonResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request_uri: initiateForJson.request_uri, subject_id: 'owner_local' }),
      });
      assert.equal(jsonResp.status, 200);
      const jsonBody = await jsonResp.json();
      assert.equal(typeof jsonBody.token, 'string', 'JSON branch SHALL still return the bearer');
      assert.ok(jsonBody.token.length > 0);
      assert.equal(typeof jsonBody.grant_id, 'string');
      assert.equal(typeof jsonBody.grant, 'object');
      assert.equal(jsonBody.code, undefined, 'JSON branch SHALL NOT include an exchange code');

      // Now drive a fresh approval through the HTML branch.
      const initiateForHtml = await initiateGrantRequest(asUrl, spotifyManifest);
      const htmlResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Negotiate HTML explicitly; the route uses
          // req.is('application/json') || req.accepts(['html','json']) === 'json'
          // to choose JSON, so we explicitly say HTML here.
          Accept: 'text/html',
        },
        body: new URLSearchParams({
          request_uri: initiateForHtml.request_uri,
          subject_id: 'owner_local',
        }).toString(),
      });
      assert.equal(htmlResp.status, 200);
      const htmlText = await htmlResp.text();
      assert.ok(htmlText.includes('<html'), 'HTML branch SHALL render an HTML document');
      // The bearer minted for the JSON approval is unrelated to this approval,
      // but the bearer minted for THIS approval must not appear anywhere.
      // Mint a second JSON approval to discover the bearer for the HTML one?
      // No — by construction we have already issued the HTML grant; we can
      // verify by inspecting the page for the exchange code, redeeming it,
      // and then asserting the redeemed bearer is not present in the original
      // HTML body.
      const codeMatch = htmlText.match(/cex_[0-9a-f]{64}/);
      assert.ok(codeMatch, 'HTML body SHALL embed a cex_… exchange code');
      const code = codeMatch[0];

      // Redeem and confirm we got a bearer.
      const exchangeResp = await fetch(`${asUrl}/consent/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      assert.equal(exchangeResp.status, 200);
      const exchangeBody = await exchangeResp.json();
      assert.equal(typeof exchangeBody.token, 'string');
      assert.ok(exchangeBody.token.length > 0);
      assert.equal(typeof exchangeBody.grant_id, 'string');
      assert.equal(typeof exchangeBody.grant, 'object');

      // The bearer the HTML approval ultimately bound to its grant SHALL NOT
      // appear in the HTML response body.
      assert.equal(
        htmlText.includes(exchangeBody.token),
        false,
        'HTML approval body unexpectedly contains the live bearer string',
      );

      // Defense-in-depth: the prior JSON-branch bearer also SHALL NOT appear
      // in the HTML body.
      assert.equal(htmlText.includes(jsonBody.token), false);

      // The redeemed bearer SHALL introspect as active for the same grant.
      const introResp = await fetch(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: exchangeBody.token }),
      });
      const intro = await introResp.json();
      assert.equal(intro.active, true);
      assert.equal(intro.grant_id, exchangeBody.grant_id);
    });
  });

  await t.test('a consumed exchange code cannot be redeemed again', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const htmlResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html',
        },
        body: new URLSearchParams({
          request_uri: initiate.request_uri,
          subject_id: 'owner_local',
        }).toString(),
      });
      const htmlText = await htmlResp.text();
      const code = htmlText.match(/cex_[0-9a-f]{64}/)[0];

      // First redemption succeeds.
      const first = await fetch(`${asUrl}/consent/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      assert.equal(first.status, 200);
      const firstBody = await first.json();
      assert.ok(firstBody.token.length > 0);

      // Second redemption fails; bearer SHALL NOT appear in the failure body.
      const second = await fetchJson(`${asUrl}/consent/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      assert.ok(second.status >= 400 && second.status < 500, `expected 4xx, got ${second.status}`);
      assert.equal(typeof second.body?.error?.code, 'string', 'failure SHALL be a PDPP error envelope');
      assert.equal(JSON.stringify(second.body).includes(firstBody.token), false);
    });
  });

  await t.test('an unknown exchange code is rejected', async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetchJson(`${asUrl}/consent/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'cex_does_not_exist' }),
      });
      assert.ok(resp.status >= 400 && resp.status < 500);
      assert.equal(typeof resp.body?.error?.code, 'string');
    });
  });

  await t.test('a missing code is rejected with 400', async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetchJson(`${asUrl}/consent/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(resp.status, 400);
      assert.equal(resp.body?.error?.code, 'invalid_request');
    });
  });

  // Direct unit-level coverage of the in-memory store: TTL expiry. We use the
  // exported helpers so we do not need to mock time inside the HTTP route.
  await t.test('expired exchange codes are not redeemable', () => {
    const fakeGrant = { grant_id: 'grt_test', client: { client_id: 'cli_test' } };
    const code = createConsentExchangeCode({
      grantId: 'grt_test',
      token: 'tok_for_expiry_test',
      grant: fakeGrant,
      ttlMs: 1, // immediate expiry
    });
    // Wait one tick past TTL.
    return new Promise((resolve) => setTimeout(() => {
      const result = consumeConsentExchangeCode(code);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'expired');
      resolve();
    }, 5));
  });
});
