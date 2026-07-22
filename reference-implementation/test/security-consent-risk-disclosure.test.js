// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Regression tests for the harden-reference-auth-surfaces P1 follow-up
// "consent-risk disclosure invariants" (§8). Pins:
//
//   1. A wildcard stream request (`streams: [{ name: '*' }]`) is rendered as
//      an explicit "all streams" disclosure on the hosted consent page, not
//      as a bare `*`. When the source manifest is known, the resolved stream
//      count and stream names appear in the rendered HTML.
//   2. A request with `access_mode: "continuous"` and no explicit retention
//      bound surfaces a distinct continuous-access risk affordance and an
//      explicit "no expiry" disclosure.
//   3. An `ai_training` request submitted without affirmative consent is
//      rejected with a typed PDPP error envelope (`error.code` set, status
//      4xx), not as a generic 500.
//
// Spec: openspec/changes/harden-reference-auth-surfaces/specs/
//       reference-implementation-architecture/spec.md
//       (Requirement: "Hosted consent UI SHALL disclose effective access risk")

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
  return { status: resp.status, body };
}

async function withHarness(fn) {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
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

async function initiate(asUrl, spotifyManifest, overrides = {}) {
  const body = {
    client_id: 'concert_recommendation_app',
    authorization_details: [
      {
        type: 'https://pdpp.org/data-access',
        source: { kind: 'connector', id: spotifyManifest.connector_id },
        purpose_code: 'https://pdpp.org/purpose/personalization',
        purpose_description: 'Consent risk disclosure regression',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
        ...overrides,
      },
    ],
  };
  const resp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (resp.status !== 201) {
    throw new Error(`PAR failed (${resp.status}): ${await resp.text()}`);
  }
  return resp.json();
}

test('security: consent-risk disclosure invariants', async (t) => {
  await t.test('wildcard stream request renders an explicit "all streams" disclosure with resolved names and count', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        streams: [{ name: '*' }],
        access_mode: 'single_use',
      });
      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const html = await consentResp.text();

      // The HTML SHALL NOT render a bare `*` as a stream name.
      assert.equal(
        html.includes('<span class="hosted-ui-stream-name">*</span>'),
        false,
        'consent HTML rendered a bare `*` as if it were a precise stream name',
      );

      // The HTML SHALL indicate that all streams for the source are in scope.
      const lower = html.toLowerCase();
      assert.ok(
        lower.includes('all streams'),
        'consent HTML SHALL include an explicit "all streams" disclosure',
      );

      // The resolved stream count and resolved stream names SHALL appear when
      // the source manifest is known.
      assert.ok(
        html.includes(`(${spotifyManifest.streams.length})`),
        `consent HTML SHALL include the resolved stream count (${spotifyManifest.streams.length})`,
      );
      for (const stream of spotifyManifest.streams) {
        assert.ok(
          html.includes(`<span class="hosted-ui-stream-name">${stream.name}</span>`),
          `consent HTML SHALL include resolved stream name "${stream.name}"`,
        );
      }
    });
  });

  await t.test('continuous-access request renders a distinct long-lived-access warning with no-expiry disclosure', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        access_mode: 'continuous',
        // No retention block — this is the no-expiry case.
        streams: [{ name: 'top_artists', view: 'basic' }],
      });
      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(par.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const html = await consentResp.text();
      const lower = html.toLowerCase();

      assert.ok(
        lower.includes('continuous access'),
        'consent HTML SHALL include a distinct continuous-access affordance',
      );
      assert.ok(
        lower.includes('no explicit expiry'),
        'consent HTML SHALL state that the requested access has no explicit expiry when no retention bound is present',
      );
      // The affordance SHALL be a distinct visual block, not just a key/value row.
      assert.ok(
        html.includes('class="hosted-ui-warning"'),
        'consent HTML SHALL render the continuous-access warning as a distinct affordance',
      );
    });
  });

  await t.test('ai_training request without affirmative consent fails with a typed PDPP error envelope', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const par = await initiate(asUrl, spotifyManifest, {
        purpose_code: 'https://pdpp.org/purpose/ai_training',
        purpose_description: 'Training a recommendation model',
        access_mode: 'continuous',
        streams: [{ name: 'top_artists', view: 'basic' }],
      });

      const resp = await fetchJson(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_uri: par.request_uri,
          subject_id: 'owner_local',
          // Deliberately omit ai_training_consented.
        }),
      });

      assert.notEqual(resp.status, 500, 'response SHALL NOT be a generic 500');
      assert.ok(resp.status >= 400 && resp.status < 500, `expected 4xx, got ${resp.status}`);
      assert.equal(typeof resp.body?.error, 'object', 'response SHALL be a PDPP error envelope');
      assert.equal(typeof resp.body?.error?.code, 'string', 'PDPP error envelope SHALL carry an error.code');
      assert.notEqual(
        resp.body?.error?.code,
        'api_error',
        'PDPP error envelope SHALL carry a typed code, not the generic api_error fallback',
      );
      assert.equal(typeof resp.body?.error?.message, 'string');
      assert.match(
        resp.body.error.message,
        /ai_training/i,
        'PDPP error message SHALL identify the ai_training consent requirement',
      );
    });
  });
});
