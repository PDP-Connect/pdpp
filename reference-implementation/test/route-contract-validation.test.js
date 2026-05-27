/**
 * Acceptance tests for runtime route-contract validation.
 *
 * Spec: openspec/changes/wire-route-contract-validation/specs/
 *   reference-implementation-architecture/spec.md
 *
 * These tests exercise the transport-owned validation boundary so
 * failures point at the wiring, not at protocol logic.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createApp } from '../server/transport.js';
import {
  applyRequestValidation,
  isResponseCanary,
  isRequestValidationEnforced,
  listResponseCanaryOperations,
  listRequestValidationAllowlist,
} from '../server/contract-validation.js';
import { publicManifests } from '@pdpp/reference-contract';

// ─── Adapter unit checks ────────────────────────────────────────────────

test('the request-validation allowlist is empty by default to preserve handler-owned diagnostics', () => {
  const allowlist = listRequestValidationAllowlist();
  assert.equal(
    allowlist.length,
    0,
    'request-validation allowlist must start empty until per-route handler-shape proof exists',
  );
  assert.equal(isRequestValidationEnforced('registerDynamicClient'), false);
  assert.equal(isRequestValidationEnforced('createPushedAuthorizationRequest'), false);
  assert.equal(isRequestValidationEnforced('refRunInteraction'), false);
});

test('the response canary names stable discovery operations', () => {
  const canary = listResponseCanaryOperations();
  assert.ok(canary.includes('getRsDiscoveryIndex'));
  assert.ok(canary.includes('getAsDiscoveryIndex'));
  assert.equal(isResponseCanary('getRsDiscoveryIndex'), true);
  assert.equal(isResponseCanary('listConnectors'), false);
});

test('applyRequestValidation produces an OAuth-shaped envelope for OAuth manifests', () => {
  // `registerDynamicClient` declares `pdpp/common/OAuthError` at 400.
  // applyRequestValidation must use the OAuth envelope keyed on that
  // manifest, even though the route is not yet on the allowlist —
  // membership controls *when* validation runs, the manifest's
  // declared 400 controls *what shape* the failure takes.
  const manifest = publicManifests.find((m) => m.id === 'registerDynamicClient');
  assert.ok(manifest, 'expected registerDynamicClient manifest in @pdpp/reference-contract');

  const captured = { status: 0, body: null, headers: {} };
  const res = {
    status(code) {
      captured.status = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    getHeader(name) {
      return captured.headers[name];
    },
  };

  const req = {
    body: { application_type: 42 }, // `application_type` schema requires a non-empty string
    headers: {},
    params: {},
    query: {},
  };

  const responded = applyRequestValidation({ manifest, req, res });
  assert.equal(responded, true);
  assert.equal(captured.status, 400);
  assert.equal(captured.body.error, 'invalid_request');
  assert.equal(typeof captured.body.error_description, 'string');
  assert.ok(captured.body.error_description.length > 0);
  assert.equal(typeof captured.body.request_id, 'string');
  assert.ok(captured.body.request_id.length > 0);
});

test('applyRequestValidation produces a PDPP-shaped envelope for PDPP manifests', async () => {
  // Pick any manifest whose declared 400 response is PDPP-shaped
  // (`$id: 'pdpp/common/PdppError'`). The adapter must pick the PDPP
  // envelope based on that declaration, not the OAuth envelope.
  const { referenceManifests } = await import('@pdpp/reference-contract');
  const all = [...publicManifests, ...referenceManifests];
  const pdppManifest = all.find(
    (m) =>
      m.responses?.['400']?.schema?.$id === 'pdpp/common/PdppError'
      && (m.request?.body?.schema || m.request?.params || m.request?.query),
  );
  assert.ok(
    pdppManifest,
    'expected at least one reference-contract manifest declaring pdpp/common/PdppError at 400',
  );

  const captured = { status: 0, body: null, headers: {} };
  const res = {
    status(code) {
      captured.status = code;
      return res;
    },
    json(body) {
      captured.body = body;
      return res;
    },
    setHeader(name, value) {
      captured.headers[name] = value;
    },
    getHeader(name) {
      return captured.headers[name];
    },
  };

  // Force a validation failure. Most PDPP-shaped manifests have an
  // object body with `additionalProperties: false`, so a `__pdpp_invalid`
  // property triggers a failure. If the manifest has no body, falsify
  // params/query instead.
  let req;
  if (pdppManifest.request?.body?.schema) {
    req = { body: { __pdpp_invalid: true }, headers: {}, params: {}, query: {} };
  } else if (pdppManifest.request?.params) {
    req = {
      body: undefined,
      headers: {},
      params: { __pdpp_invalid: 42 },
      query: {},
    };
  } else {
    req = {
      body: undefined,
      headers: {},
      params: {},
      query: { __pdpp_invalid: 42 },
    };
  }

  const responded = applyRequestValidation({ manifest: pdppManifest, req, res });
  assert.equal(responded, true, 'expected validation to fail and respond');
  assert.equal(captured.status, 400);
  assert.ok(captured.body.error, 'PDPP envelope must carry an .error object');
  assert.equal(captured.body.error.type, 'invalid_request_error');
  assert.equal(captured.body.error.code, 'invalid_request');
  assert.equal(typeof captured.body.error.message, 'string');
  assert.equal(typeof captured.body.error.request_id, 'string');
});

// ─── Route registration ─────────────────────────────────────────────────

test('route registration throws when {contract} names an unknown reference-contract operation id', () => {
  const app = createApp();
  assert.throws(
    () =>
      app.get(
        '/transport-coverage-canary',
        { contract: 'definitelyNotARealOperationId' },
        (_req, res) => {
          res.json({});
        },
      ),
    /Unknown reference-contract operation id/,
    'expected route registration to throw on an unknown contract op id',
  );
});

// ─── Response canary ────────────────────────────────────────────────────

test('canary route fails closed when its response payload violates the contract', async () => {
  // Use createApp() directly to register a synthetic handler bound to a
  // real canary operation id (`getRsDiscoveryIndex`). The handler
  // intentionally returns a payload missing the required `links`
  // field — the response canary in the transport must replace that
  // body with a 500 `internal_contract_error` envelope.
  const app = createApp();
  app.get(
    '/canary-bad-rs-discovery',
    { contract: 'getRsDiscoveryIndex' },
    (_req, res) => {
      res.json({
        object: 'pdpp_discovery_index',
        role: 'resource_server',
        resource_name: 'PDPP Reference',
        reference_revision: 'dev',
      });
    },
  );
  await app.fastify.ready();

  const reply = await app.fastify.inject({
    method: 'GET',
    url: '/canary-bad-rs-discovery',
  });

  assert.equal(reply.statusCode, 500, 'invalid canary response must fail closed at 500');
  const body = JSON.parse(reply.body);
  assert.equal(body.error?.code, 'internal_contract_error');
  assert.equal(typeof body.error?.request_id, 'string');
  assert.ok(body.error.request_id.length > 0);
  // The offending payload's identifying fields must not appear in the
  // body — the transport replaced the body, not augmented it.
  assert.equal(body.role, undefined);
  assert.equal(body.resource_name, undefined);
});

test('canary route sends the original payload byte-for-byte when validation passes', async () => {
  const app = createApp();
  const goodPayload = {
    object: 'pdpp_discovery_index',
    role: 'resource_server',
    resource_name: 'PDPP Reference',
    links: {
      well_known: '/.well-known/oauth-protected-resource',
      schema: '/v1/schema',
      core_query_base: '/v1',
      connectors: '/v1/connectors',
    },
    reference_revision: 'dev',
  };
  app.get(
    '/canary-good-rs-discovery',
    { contract: 'getRsDiscoveryIndex' },
    (_req, res) => {
      res.json(goodPayload);
    },
  );
  await app.fastify.ready();

  const reply = await app.fastify.inject({
    method: 'GET',
    url: '/canary-good-rs-discovery',
  });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(JSON.parse(reply.body), goodPayload);
});

test('non-canary JSON response is not transformed even when it would violate the manifest', async () => {
  // `listConnectors` is annotated but not in the canary allowlist. The
  // transport must not coerce or strip its response, even if the
  // payload would have failed the declared response schema — response
  // enforcement is opt-in.
  const app = createApp();
  const drift = {
    object: 'list',
    surprise: 'should pass through',
    data: [],
    has_more: false,
  };
  app.get(
    '/non-canary-listconnectors',
    { contract: 'listConnectors' },
    (_req, res) => {
      res.json(drift);
    },
  );
  await app.fastify.ready();

  const reply = await app.fastify.inject({
    method: 'GET',
    url: '/non-canary-listconnectors',
    headers: { authorization: 'Bearer fake-token-for-shape-test' },
  });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(JSON.parse(reply.body), drift);
});

test('redirects, 204 responses, and string payloads are not run through canary validation', async () => {
  const app = createApp();

  app.get(
    '/canary-redirect',
    { contract: 'getRsDiscoveryIndex' },
    (_req, res) => {
      res.redirect(302, 'https://example.test/elsewhere');
    },
  );

  app.get(
    '/canary-empty',
    { contract: 'getRsDiscoveryIndex' },
    (_req, res) => {
      res.status(204).send();
    },
  );

  app.get(
    '/canary-text',
    { contract: 'getRsDiscoveryIndex' },
    (_req, res) => {
      res.status(200).send('not-json');
    },
  );

  await app.fastify.ready();

  const redirect = await app.fastify.inject({ method: 'GET', url: '/canary-redirect' });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, 'https://example.test/elsewhere');

  const empty = await app.fastify.inject({ method: 'GET', url: '/canary-empty' });
  assert.equal(empty.statusCode, 204);

  const text = await app.fastify.inject({ method: 'GET', url: '/canary-text' });
  assert.equal(text.statusCode, 200);
  assert.equal(text.body, 'not-json');
});

// ─── Operation boundary ─────────────────────────────────────────────────

test('operation modules do not import the reference-contract runtime', async () => {
  const { discoverOperationModules, assertOperationBoundary } = await import(
    './helpers/operation-boundary.js'
  );
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const modules = discoverOperationModules(repoRoot);
  assert.ok(modules.length > 0, 'expected at least one operation module');
  for (const mod of modules) {
    const source = readFileSync(mod.absPath, 'utf8');
    assertOperationBoundary(source, mod.relPath);
  }
});
