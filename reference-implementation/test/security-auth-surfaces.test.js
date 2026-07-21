// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the harden-reference-auth-surfaces change.
//
// Pins four invariants:
//   1. /_ref/grants/<id>/timeline never echoes spine_events.token_id back.
//   2. /_ref/runs/<id>/timeline never echoes spine_events.token_id back.
//   3. POST /grants/<id>/revoke requires owner-or-grant-bound bearer auth.
//   4. AS responses carry the X-Frame-Options + CSP frame-ancestors headers.
//
// Spec: openspec/changes/harden-reference-auth-surfaces/specs/
//       reference-implementation-architecture/spec.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';

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

async function issueOwnerToken(asUrl, subjectId = 'owner_local') {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
}

async function approveSpotifyGrant(asUrl, spotifyManifest, subjectId = 'owner_local') {
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
          purpose_description: 'Auth-surface regression smoke',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        },
      ],
    }),
  });
  if (initResp.status !== 201) {
    const errBody = await initResp.text();
    throw new Error(`PAR failed (${initResp.status}): ${errBody}`);
  }
  const initiate = await initResp.json();
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
  });
  assert.equal(approveResp.status, 200);
  return approveResp.json();
}

async function withHarness(fn) {
  const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'));
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
    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

test('security: harden reference auth surfaces', async (t) => {
  await t.test('grant timeline never echoes token_id', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const { status, body } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`,
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data), 'timeline returns events');
      assert.ok(body.data.length > 0, 'timeline has at least one event');
      for (const ev of body.data) {
        assert.ok(!('token_id' in ev), `timeline event ${ev.event_id} unexpectedly carries token_id`);
      }
      // The exact bearer string MUST NOT appear anywhere in the response body.
      const raw = JSON.stringify(body);
      assert.equal(
        raw.includes(approval.token),
        false,
        'response body unexpectedly contains the live bearer string',
      );
    });
  });

  await t.test('grant timeline redacts object_id on token.issued events', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const { body } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`,
      );
      const tokenEvents = body.data.filter((ev) => ev.object_type === 'token');
      assert.ok(tokenEvents.length > 0, 'expected at least one token-typed event on the grant timeline');
      for (const ev of tokenEvents) {
        assert.equal(
          ev.object_id,
          '<redacted-token-id>',
          `event ${ev.event_id} object_id was not redacted`,
        );
      }
    });
  });

  await t.test('timeline projection does not touch other event fields', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const { body } = await fetchJson(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`,
      );
      // Pick an event whose object_type is NOT 'token' (e.g. 'grant'); its
      // object_id, grant_id, client_id, and `data` payload SHALL be unchanged.
      const nonTokenEvent = body.data.find((ev) => ev.object_type !== 'token');
      assert.ok(nonTokenEvent, 'timeline should include at least one non-token event');
      assert.notEqual(
        nonTokenEvent.object_id,
        '<redacted-token-id>',
        'non-token events SHALL NOT have their object_id redacted',
      );
      assert.equal(
        nonTokenEvent.grant_id,
        approval.grant.grant_id,
        'grant_id SHALL be returned unchanged',
      );
      assert.equal(
        typeof nonTokenEvent.data,
        'object',
        'event data payload SHALL be present and unchanged',
      );
    });
  });

  await t.test('revoke without Authorization header is rejected', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      assert.equal(resp.status, 401);
      const body = await resp.json();
      assert.equal(body.error?.code, 'authentication_error');

      // The grant SHALL remain unchanged. Use a fresh introspect call to prove it.
      const introResp = await fetch(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: approval.token }),
      });
      const intro = await introResp.json();
      assert.equal(intro.active, true, 'grant should still be active after rejected revoke');
    });
  });

  await t.test('revoke with the grant\'s own client bearer succeeds', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${approval.token}`,
        },
      });
      assert.equal(resp.status, 200);
      const body = await resp.json();
      assert.equal(body.revoked, true);
    });
  });

  await t.test('revoke with a client bearer bound to a different grant is rejected', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const a = await approveSpotifyGrant(asUrl, spotifyManifest);
      const b = await approveSpotifyGrant(asUrl, spotifyManifest);
      assert.notEqual(a.grant.grant_id, b.grant.grant_id);
      // Try to revoke A using B's bearer.
      const resp = await fetch(`${asUrl}/grants/${a.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${b.token}`,
        },
      });
      assert.equal(resp.status, 403);
      const body = await resp.json();
      assert.equal(body.error?.code, 'permission_error');

      // A should still be active.
      const introResp = await fetch(`${asUrl}/introspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: a.token }),
      });
      const intro = await introResp.json();
      assert.equal(intro.active, true, 'grant A should still be active after cross-grant revoke attempt');
    });
  });

  await t.test('revoke with an owner bearer succeeds for any grant', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const ownerToken = await issueOwnerToken(asUrl);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
      });
      assert.equal(resp.status, 200);
      const body = await resp.json();
      assert.equal(body.revoked, true);
    });
  });

  await t.test('revoke with an unknown bearer is rejected as 401', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer this-is-not-a-real-token',
        },
      });
      assert.equal(resp.status, 401);
      const body = await resp.json();
      assert.equal(body.error?.code, 'authentication_error');
    });
  });

  await t.test('AS responses carry clickjacking-defense headers', async () => {
    await withHarness(async ({ asUrl }) => {
      // HTML page (owner-login is always reachable, regardless of placeholder
      // owner-auth being on or off).
      const htmlResp = await fetch(`${asUrl}/owner/login`);
      assert.equal(htmlResp.headers.get('x-frame-options'), 'DENY');
      assert.equal(htmlResp.headers.get('content-security-policy'), "frame-ancestors 'none'");

      // JSON endpoint also carries them (harmless, defense-in-depth).
      const jsonResp = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
      assert.equal(jsonResp.headers.get('x-frame-options'), 'DENY');
      assert.equal(jsonResp.headers.get('content-security-policy'), "frame-ancestors 'none'");
    });
  });
});
