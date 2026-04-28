// Regression tests for the P0 device-code-exposure fix.
//
// Pins five invariants:
//   1. /_ref/approvals never echoes the live device_code as approval_id.
//   2. /_ref/approvals consent entries do not echo the live device_code via
//      `request_uri` (which embeds it). user_code is also stripped.
//   3. /_ref/traces/<traceId> for a pending consent does not echo the
//      device_code or user_code.
//   4. /_ref/traces/<traceId> for a pending owner-device flow does not
//      echo the device_code or user_code.
//   5. The dashboard's `approval_id` based approve flow round-trips for
//      both consent and owner-device kinds without ever exposing the
//      live device_code via a public read surface.
//
// Spec: openspec/changes/harden-reference-auth-surfaces/specs/
//       reference-implementation-architecture/spec.md (§7 follow-up).
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
  const text = await resp.text();
  try { body = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: resp.status, body, raw: text };
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

async function startConsentPar(asUrl, spotifyManifest) {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'concert_recommendation_app',
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          connector_id: spotifyManifest.connector_id,
          purpose_code: 'https://pdpp.org/purpose/personalization',
          purpose_description: 'Device-code-exposure regression smoke',
          access_mode: 'continuous',
          streams: [{ name: 'top_artists', view: 'basic' }],
        },
      ],
    }),
  });
  assert.equal(resp.status, 201);
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  const body = await resp.json();
  return { ...body, trace_id: traceId };
}

async function startOwnerDeviceFlow(asUrl, clientId = 'cli_longview') {
  const resp = await fetch(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  assert.equal(resp.status, 200);
  return resp.json();
}

test('security: device-code exposure on _ref read surfaces', async (t) => {
  await t.test('/_ref/approvals never echoes device_code, request_uri, or user_code', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const consentPar = await startConsentPar(asUrl, spotifyManifest);
      const device = await startOwnerDeviceFlow(asUrl);

      const { status, body, raw } = await fetchJson(`${asUrl}/_ref/approvals`);
      assert.equal(status, 200);
      assert.equal(body.object, 'list');

      // The consent-flow `device_code` is the second segment of the
      // request_uri returned by PAR. The owner-device flow returns it
      // directly. Neither value SHALL appear anywhere in the response
      // body — not as approval_id, not in request_uri, not in any
      // grant_preview field.
      const consentDeviceCode = consentPar.request_uri.replace(
        /^urn:pdpp:pending-consent:/,
        ''
      );
      assert.ok(consentDeviceCode.length > 0);
      assert.ok(!raw.includes(consentDeviceCode), 'consent device_code leaked into _ref/approvals body');
      assert.ok(!raw.includes(device.device_code), 'owner-device device_code leaked into _ref/approvals body');
      assert.ok(!raw.includes(device.user_code), 'owner-device user_code leaked into _ref/approvals body');

      // Spot-check that the projected approval_id is not the device_code.
      for (const entry of body.data) {
        assert.notEqual(entry.approval_id, consentDeviceCode);
        assert.notEqual(entry.approval_id, device.device_code);
        assert.equal(entry.request_uri, null, `${entry.kind} request_uri must be null`);
        assert.equal(entry.user_code, null, `${entry.kind} user_code must be null`);
        assert.ok(typeof entry.approval_id === 'string' && entry.approval_id.length > 0);
      }

      // Both kinds present.
      const consentEntry = body.data.find((e) => e.kind === 'consent');
      const deviceEntry = body.data.find((e) => e.kind === 'owner_device');
      assert.ok(consentEntry, 'expected a consent entry');
      assert.ok(deviceEntry, 'expected an owner_device entry');
    });
  });

  await t.test('/_ref/traces/:traceId redacts device_code and user_code on pending_consent events', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const consentPar = await startConsentPar(asUrl, spotifyManifest);
      const consentDeviceCode = consentPar.request_uri.replace(
        /^urn:pdpp:pending-consent:/,
        ''
      );
      const traceId = consentPar.trace_id;
      assert.ok(traceId, 'PAR did not return trace_id header');

      const { status, body, raw } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(traceId)}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data));
      const submitted = body.data.find((e) => e.event_type === 'request.submitted' && e.object_type === 'pending_consent');
      assert.ok(submitted, 'expected a request.submitted event for pending_consent');

      // The live device_code SHALL NOT appear as object_id, and the
      // user_code SHALL NOT appear in the data payload.
      assert.notEqual(submitted.object_id, consentDeviceCode);
      assert.equal(submitted.object_id, '<redacted-device-code>');
      assert.ok(!raw.includes(consentDeviceCode), 'device_code leaked into trace body');

      if (submitted.data && typeof submitted.data === 'object' && 'user_code' in submitted.data) {
        assert.equal(submitted.data.user_code, '<redacted-bearer>');
      }
    });
  });

  await t.test('/_ref/traces/:traceId redacts device_code and user_code on owner_device_auth events', async () => {
    await withHarness(async ({ asUrl }) => {
      const device = await startOwnerDeviceFlow(asUrl);
      // Look up the device flow's trace via the spine search helper.
      const tracesResp = await fetchJson(`${asUrl}/_ref/traces`);
      assert.equal(tracesResp.status, 200);
      assert.ok(Array.isArray(tracesResp.body.data) && tracesResp.body.data.length > 0);

      // Find the trace that corresponds to the owner-device-auth flow by
      // probing each trace's events.
      let matched = null;
      for (const summary of tracesResp.body.data) {
        const id = summary.id || summary.trace_id;
        if (!id) continue;
        const { body } = await fetchJson(`${asUrl}/_ref/traces/${encodeURIComponent(id)}`);
        const owner = body?.data?.find?.((e) => e.object_type === 'owner_device_auth');
        if (owner) {
          matched = { id, body, owner };
          break;
        }
      }
      assert.ok(matched, 'expected a trace with an owner_device_auth event');

      const raw = JSON.stringify(matched.body);
      assert.ok(!raw.includes(device.device_code), 'owner-device device_code leaked into trace body');
      assert.ok(!raw.includes(device.user_code), 'owner-device user_code leaked into trace body');
      assert.equal(matched.owner.object_id, '<redacted-device-code>');
      if (matched.owner.data && typeof matched.owner.data === 'object' && 'user_code' in matched.owner.data) {
        assert.equal(matched.owner.data.user_code, '<redacted-bearer>');
      }
    });
  });

  await t.test('approve-by-approval_id round-trips for consent', async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const consentPar = await startConsentPar(asUrl, spotifyManifest);
      const consentDeviceCode = consentPar.request_uri.replace(
        /^urn:pdpp:pending-consent:/,
        ''
      );

      const { body: approvals } = await fetchJson(`${asUrl}/_ref/approvals`);
      const consentEntry = approvals.data.find((e) => e.kind === 'consent');
      assert.ok(consentEntry);

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approval_id: consentEntry.approval_id, subject_id: 'owner_local' }),
      });
      assert.equal(approveResp.status, 200);
      const approveBody = await approveResp.json();
      assert.ok(approveBody.grant_id);
      assert.ok(approveBody.token);

      // Sanity: the live device_code never surfaced through the public
      // read path (we proved that already in the prior tests, but this
      // test confirms the alternate approve path does not require it).
      assert.ok(consentDeviceCode.length > 0);
      assert.ok(!JSON.stringify(approvals).includes(consentDeviceCode));
    });
  });

  await t.test('approve-by-approval_id round-trips for owner_device', async () => {
    await withHarness(async ({ asUrl }) => {
      const device = await startOwnerDeviceFlow(asUrl);
      const { body: approvals } = await fetchJson(`${asUrl}/_ref/approvals`);
      const deviceEntry = approvals.data.find((e) => e.kind === 'owner_device');
      assert.ok(deviceEntry);

      const approveResp = await fetch(`${asUrl}/device/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          approval_id: deviceEntry.approval_id,
          subject_id: 'owner_local',
        }).toString(),
      });
      assert.equal(approveResp.status, 200);

      // Token can now be exchanged using the device_code the *client*
      // received from device_authorization (it never came from a public
      // read surface).
      const tokenResp = await fetch(`${asUrl}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: device.device_code,
          client_id: 'cli_longview',
        }).toString(),
      });
      assert.equal(tokenResp.status, 200);
      const tokenBody = await tokenResp.json();
      assert.ok(tokenBody.access_token);
    });
  });
});
