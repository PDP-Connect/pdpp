/**
 * Unit coverage for UNTESTED pure read-model builders in `server/metadata.ts`:
 *
 *   1. Owner-agent control-surface projections (the single-source-of-truth
 *      catalog → discovery/capability shapes):
 *        - buildOwnerAgentControlSurface: the `/v1/owner/control` capability
 *          document. Every action carries family/status/reason; a `supported`
 *          family resolves method + absolute URL from the trusted RS base, and
 *          any non-supported family projects `method: null, url: null` so an
 *          agent never probes a 404. The surface catalog keeps the literal
 *          `{connection_id}` placeholder unsubstituted.
 *        - buildOwnerConnectionSupportedActions: the per-connection
 *          `supported_actions` array — the INSTANCE-scoped subset only (surface
 *          families excluded), with the `{connection_id}` placeholder replaced by
 *          the URL-ENCODED concrete id for supported instance actions.
 *      Both project from the SAME catalog so the two surfaces cannot disagree.
 *
 *   2. Request-origin / public-URL helpers:
 *        - stripTrailingSlash, resolveRequestPublicUrl (x-forwarded-host/proto →
 *          host → protocol; first CSV entry), isLocalOrPrivateRequestOrigin
 *          (loopback + RFC1918 + link-local), protectedResourceMetadataUrlForResource
 *          (well-known path derivation; root path collapses to ""),
 *          shouldUseDirectRequestOrigin (explicit loopback URL but non-loopback
 *          request origin and no forwarded origin).
 *
 * Pure — the only import is `node:net` isIP. No DB, no server, no fixtures. A
 * tiny request duck-type shim stands in for Express/Fastify.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOwnerAgentControlSurface,
  buildOwnerConnectionSupportedActions,
  stripTrailingSlash,
  resolveRequestPublicUrl,
  isLocalOrPrivateRequestOrigin,
  protectedResourceMetadataUrlForResource,
  shouldUseDirectRequestOrigin,
} from '../server/metadata.ts';

// Minimal request shim: get(headerName) is case-insensitive; protocol is the
// scheme Express/Fastify would report.
function req(headers = {}, protocol = 'https') {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { protocol, get: (name) => lower[name.toLowerCase()] };
}

// --- buildOwnerAgentControlSurface ------------------------------------------

test('buildOwnerAgentControlSurface: envelope identity + entrypoint derived from the trusted base', () => {
  const surface = buildOwnerAgentControlSurface({ resource: 'https://rs.example.com/' });
  assert.equal(surface.object, 'owner_agent_control_surface');
  assert.equal(surface.scope, 'reference_implementation');
  assert.equal(surface.mcp_owner_bearer_rejected, true);
  // trailing slash on the base is normalized before URL derivation.
  assert.equal(surface.entrypoint, 'https://rs.example.com/v1/owner/control', `entrypoint: ${surface.entrypoint}`);
});

test('buildOwnerAgentControlSurface: a supported family resolves method + absolute URL', () => {
  const surface = buildOwnerAgentControlSurface({ resource: 'https://rs.example.com' });
  const list = surface.actions.find((a) => a.family === 'list_connections');
  assert.equal(list.status, 'supported');
  assert.equal(list.method, 'GET');
  assert.equal(list.url, 'https://rs.example.com/v1/owner/connections', `url: ${list.url}`);
});

test('buildOwnerAgentControlSurface: an owner_mediated family projects method:null, url:null', () => {
  const surface = buildOwnerAgentControlSurface({ resource: 'https://rs.example.com' });
  const cancel = surface.actions.find((a) => a.family === 'cancel_run');
  assert.equal(cancel.status, 'owner_mediated');
  assert.equal(cancel.method, null, 'owner_mediated must not advertise a method');
  assert.equal(cancel.url, null, 'owner_mediated must not advertise a URL');
  assert.ok(typeof cancel.reason === 'string' && cancel.reason.length > 0, 'still carries a reason');
});

test('buildOwnerAgentControlSurface: the surface catalog keeps the {connection_id} placeholder literal', () => {
  const surface = buildOwnerAgentControlSurface({ resource: 'https://rs.example.com' });
  const run = surface.actions.find((a) => a.family === 'run_connection');
  assert.equal(run.status, 'supported');
  assert.equal(
    run.url,
    'https://rs.example.com/v1/owner/connections/{connection_id}/run',
    `surface url must keep the placeholder: ${run.url}`,
  );
});

// --- buildOwnerConnectionSupportedActions -----------------------------------

test('buildOwnerConnectionSupportedActions: returns only instance-scoped families, no surface families', () => {
  const actions = buildOwnerConnectionSupportedActions({
    connectionId: 'cin_1',
    resource: 'https://rs.example.com',
  });
  const families = actions.map((a) => a.family);
  // Surface families must be absent.
  for (const surfaceOnly of [
    'discover_control_capabilities',
    'list_connector_templates',
    'list_connections',
    'initiate_connection',
    'manage_event_subscriptions',
  ]) {
    assert.equal(families.includes(surfaceOnly), false, `${surfaceOnly} is surface-only and must be excluded`);
  }
  // A representative instance family is present.
  assert.equal(families.includes('run_connection'), true, 'run_connection is instance-scoped');
});

test('buildOwnerConnectionSupportedActions: supported instance action substitutes the URL-ENCODED id', () => {
  const actions = buildOwnerConnectionSupportedActions({
    connectionId: 'cin_ab/cd', // slash must be percent-encoded in the path
    resource: 'https://rs.example.com',
  });
  const run = actions.find((a) => a.family === 'run_connection');
  assert.equal(run.status, 'supported');
  assert.equal(
    run.url,
    'https://rs.example.com/v1/owner/connections/cin_ab%2Fcd/run',
    `url must carry the encoded id and no literal placeholder: ${run.url}`,
  );
  assert.equal(run.url.includes('{connection_id}'), false, 'placeholder must be gone');
});

test('buildOwnerConnectionSupportedActions: an owner_mediated instance family stays method:null, url:null', () => {
  const actions = buildOwnerConnectionSupportedActions({
    connectionId: 'cin_1',
    resource: 'https://rs.example.com',
  });
  const cancel = actions.find((a) => a.family === 'cancel_run');
  assert.equal(cancel.status, 'owner_mediated');
  assert.equal(cancel.method, null);
  assert.equal(cancel.url, null, 'no URL substitution for a non-supported family');
});

// --- stripTrailingSlash -----------------------------------------------------

test('stripTrailingSlash: removes one or more trailing slashes, leaves the rest', () => {
  assert.equal(stripTrailingSlash('https://x.com/'), 'https://x.com');
  assert.equal(stripTrailingSlash('https://x.com///'), 'https://x.com');
  assert.equal(stripTrailingSlash('https://x.com/path'), 'https://x.com/path', 'inner slashes untouched');
  assert.equal(stripTrailingSlash('https://x.com'), 'https://x.com', 'no trailing slash unchanged');
});

// --- resolveRequestPublicUrl ------------------------------------------------

test('resolveRequestPublicUrl: prefers x-forwarded-host/proto', () => {
  assert.equal(
    resolveRequestPublicUrl(req({ 'x-forwarded-host': 'pub.example.com', 'x-forwarded-proto': 'https' }, 'http')),
    'https://pub.example.com',
    'forwarded host+proto win over req.protocol',
  );
});

test('resolveRequestPublicUrl: falls back to host header + req.protocol', () => {
  assert.equal(resolveRequestPublicUrl(req({ host: 'h.example.com' }, 'http')), 'http://h.example.com');
});

test('resolveRequestPublicUrl: takes the first entry of a comma-separated forwarded host', () => {
  assert.equal(
    resolveRequestPublicUrl(req({ 'x-forwarded-host': 'a.example.com, b.example.com' })),
    'https://a.example.com',
    'only the first forwarded host is used',
  );
});

// --- isLocalOrPrivateRequestOrigin ------------------------------------------

test('isLocalOrPrivateRequestOrigin: true for loopback and RFC1918/link-local hosts', () => {
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: '127.0.0.1:3000' }, 'http')), true, 'loopback');
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: 'localhost:8080' }, 'http')), true, 'localhost');
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: '10.1.2.3' }, 'http')), true, '10/8');
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: '192.168.0.5' }, 'http')), true, '192.168/16');
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: '169.254.1.1' }, 'http')), true, 'link-local');
});

test('isLocalOrPrivateRequestOrigin: false for a public host', () => {
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: 'example.com' })), false, 'public host');
  assert.equal(isLocalOrPrivateRequestOrigin(req({ host: '8.8.8.8' })), false, 'public IP');
});

// --- protectedResourceMetadataUrlForResource --------------------------------

test('protectedResourceMetadataUrlForResource: root path collapses to no path suffix', () => {
  assert.equal(
    protectedResourceMetadataUrlForResource('https://rs.example.com/'),
    'https://rs.example.com/.well-known/oauth-protected-resource',
    'a root "/" resource path collapses to empty',
  );
});

test('protectedResourceMetadataUrlForResource: preserves a sub-path and query', () => {
  assert.equal(
    protectedResourceMetadataUrlForResource('https://rs.example.com/v1/data?x=1'),
    'https://rs.example.com/.well-known/oauth-protected-resource/v1/data?x=1',
  );
});

// --- shouldUseDirectRequestOrigin -------------------------------------------

test('shouldUseDirectRequestOrigin: true when explicit URL is loopback but the request origin is public', () => {
  assert.equal(
    shouldUseDirectRequestOrigin(req({ host: 'pub.example.com' }), 'http://localhost:3000'),
    true,
    'explicit loopback + public request + no forwarded origin => use direct',
  );
});

test('shouldUseDirectRequestOrigin: false without an explicit URL, or with a forwarded origin, or non-loopback explicit', () => {
  assert.equal(
    shouldUseDirectRequestOrigin(req({ host: 'pub.example.com' }), null),
    false,
    'no explicit URL => false',
  );
  assert.equal(
    shouldUseDirectRequestOrigin(req({ 'x-forwarded-host': 'pub.example.com' }), 'http://localhost:3000'),
    false,
    'a forwarded origin present => false',
  );
  assert.equal(
    shouldUseDirectRequestOrigin(req({ host: 'pub.example.com' }), 'https://real.example.com'),
    false,
    'non-loopback explicit URL => false',
  );
});
