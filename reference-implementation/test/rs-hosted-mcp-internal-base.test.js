// F1 wiring regression — the hosted-MCP package adapter must forward its
// child-grant self-calls to the configured INTERNAL resource-server base,
// while the advertised `resource`, discovery metadata, and
// `mcpServerOptions.providerUrl` stay the PUBLIC origin.
//
// Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
//
// Background (F1): `handleHostedMcp` built the child RsClient fetch base from
// `resolvePublicUrl(...)` (the public origin). A server-internal PATCH
// self-call therefore hairpinned through the external edge that 405s PATCH,
// so package-token `update_event_subscription` returned a typed `http_405`.
// The fix passes the internal base (`referenceTopology.rsInternalUrl`, env
// `PDPP_RS_URL`, default `http://localhost:7663`) to `createPackageRsClient`
// as the child fetch base, falling back to the public resource when no
// internal base is configured. Advertised identity stays public.
//
// This test drives `handleHostedMcp` through `mountRsHostedMcp` against a
// hand-built fake app + context. It captures the `providerUrl` that reaches
// `createPackageRsClient` and the `providerUrl` advertised on
// `mcpServerOptions`. PRE-fix both equal the public resource (this test fails
// on `assertEqual(internal)`); POST-fix the child base is the internal base
// and the advertised value remains public.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mountRsHostedMcp } from '../server/routes/rs-hosted-mcp.ts';

const PUBLIC_RESOURCE = 'https://pdpp.test';      // advertised; edge 405s PATCH
const INTERNAL_BASE = 'http://localhost:7663';    // configured internal RS base

// Minimal fake app that records the handlers mounted for each verb so the test
// can invoke the final handler (`handleHostedMcp`) directly, skipping the auth
// middleware chain (auth posture is exercised by hosted-mcp-oauth.test.js).
function makeFakeApp() {
  const routes = {};
  const register = (verb) => (path, ...handlers) => {
    routes[`${verb} ${path}`] = handlers;
    return app;
  };
  const app = { get: register('get'), post: register('post'), delete: register('delete'), routes };
  return app;
}

// Fake request mirroring the shape rs-hosted-mcp.ts consumes. With a
// non-loopback `explicitResource` and no x-forwarded-* headers, resolvePublicUrl
// returns the explicit URL verbatim — a deterministic public origin.
function makePackageRequest() {
  return {
    protocol: 'https',
    get(name) {
      const lc = name.toLowerCase();
      if (lc === 'host') return 'pdpp.test';
      return undefined;
    },
    headers: { authorization: 'Bearer pkg_inbound_token', host: 'pdpp.test' },
    method: 'POST',
    path: '/mcp',
    raw: { url: '/mcp' },
    tokenInfo: { pdpp_token_kind: 'mcp_package', grant_package_id: 'gp_1' },
  };
}

function makeFakeResponse() {
  return {
    locals: {},
    statusCode: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    send() {},
    end() {},
  };
}

// Build a context whose `createPackageRsClient` records the providerUrl it
// receives, and whose `handleStreamableHttpRequest` records the providerUrl it
// is advertised. `internalResource` is the fix's injected internal base.
function makeContext({ internalResource }) {
  const seen = { childProviderUrl: null, advertisedProviderUrl: null };
  return {
    seen,
    ctx: {
      explicitResource: PUBLIC_RESOURCE,
      internalResource,
      trustedMetadataHosts: null,
      referenceRevision: 'test-rev',
      async getGrantPackageAccess() {
        return {
          members: [
            { grantId: 'grant_A', accessToken: 'tok_A' },
            { grantId: 'grant_B', accessToken: 'tok_B' },
          ],
        };
      },
      createPackageRsClient({ providerUrl }) {
        seen.childProviderUrl = providerUrl;
        return { __fakePackageRsClient: true };
      },
      async handleStreamableHttpRequest(_request, options) {
        seen.advertisedProviderUrl = options.providerUrl;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      pdppError(res, status, code, message) {
        res.status(status).send({ error: { code, message } });
      },
      requireToken: (_req, _res, next) => next(),
      requireClientOrMcpPackage: (_req, _res, next) => next(),
    },
  };
}

async function driveHandler({ internalResource }) {
  const app = makeFakeApp();
  const { ctx, seen } = makeContext({ internalResource });
  mountRsHostedMcp(app, ctx);
  // The handler is the last entry in the mounted chain for POST /mcp.
  const chain = app.routes['post /mcp'];
  const handler = chain[chain.length - 1];
  const res = makeFakeResponse();
  await handler(makePackageRequest(), res);
  return seen;
}

test('F1 wiring: package adapter forwards child self-calls to the internal base; advertised stays public', async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE });
  // Child RsClient fetch base is the INTERNAL base (the fix).
  assert.equal(seen.childProviderUrl, INTERNAL_BASE, 'child RsClient fetch base must be the internal RS base');
  // Advertised providerUrl on the MCP server stays the PUBLIC origin.
  assert.equal(seen.advertisedProviderUrl, PUBLIC_RESOURCE, 'advertised providerUrl must remain the public origin');
});

test('F1 wiring fallback: with no internal base configured, child self-calls fall back to the public resource', async () => {
  const seenNull = await driveHandler({ internalResource: null });
  assert.equal(seenNull.childProviderUrl, PUBLIC_RESOURCE, 'fallback: child base is the public resource when internal base is unset');
  assert.equal(seenNull.advertisedProviderUrl, PUBLIC_RESOURCE, 'advertised providerUrl remains public in the fallback path');

  const seenUndef = await driveHandler({ internalResource: undefined });
  assert.equal(seenUndef.childProviderUrl, PUBLIC_RESOURCE, 'fallback: undefined internal base also yields the public resource');
});
