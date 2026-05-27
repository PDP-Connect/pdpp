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

// ─── Allowlisted request validation (Task 4.1, 4.2) ─────────────────────
//
// Production REQUEST_VALIDATION_ALLOWLIST is empty so existing
// handler-owned diagnostics remain authoritative. We use the test-only
// `__requestValidationAllowlistForTest` injection on createApp() to
// enroll a real manifest for the duration of the test. That exercises
// the same transport wiring production would use; it never enables
// enforcement live.

test('allowlisted contract route rejects a malformed PATCH body before the handler mutates state with a PDPP-shaped envelope', async () => {
  // `refSetConnectionDisplayName` declares its 400 response as the PDPP
  // envelope (`pdpp/common/PdppError`). Its body schema requires a
  // non-empty `display_name` string with `additionalProperties: false`.
  // We enroll the op id, register a route, and confirm the handler is
  // never reached and the response shape matches the manifest.
  let handlerCalls = 0;
  const app = createApp({
    __requestValidationAllowlistForTest: ['refSetConnectionDisplayName'],
  });
  app.patch(
    '/canary-set-display-name/:connectorInstanceId',
    { contract: 'refSetConnectionDisplayName' },
    (_req, res) => {
      handlerCalls += 1;
      res.json({ object: 'should-never-be-reached' });
    },
  );
  await app.fastify.ready();

  const reply = await app.fastify.inject({
    method: 'PATCH',
    url: '/canary-set-display-name/conn_test_1',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ display_name: '' }), // violates minLength: 1
  });

  assert.equal(reply.statusCode, 400, `expected 400, got ${reply.statusCode}`);
  assert.equal(handlerCalls, 0, 'handler must not run when request validation rejects the input');
  const body = JSON.parse(reply.body);
  // PDPP envelope shape — manifest-shaped because the manifest declares
  // `pdpp/common/PdppError` at 400.
  assert.ok(body.error, 'PDPP envelope must carry an .error object');
  assert.equal(body.error.type, 'invalid_request_error');
  assert.equal(body.error.code, 'invalid_request');
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  assert.equal(typeof body.error.request_id, 'string');
  assert.ok(body.error.request_id.length > 0);
});

test('allowlisted OAuth-manifest route rejects a malformed body with an OAuth-shaped envelope', async () => {
  // `registerDynamicClient` declares its 400 response as the OAuth
  // envelope (`pdpp/common/OAuthError`). The adapter must pick the
  // OAuth shape from the manifest even though the route handler is
  // synthetic.
  let handlerCalls = 0;
  const app = createApp({
    __requestValidationAllowlistForTest: ['registerDynamicClient'],
  });
  app.post(
    '/canary-register-dynamic-client',
    { contract: 'registerDynamicClient' },
    (_req, res) => {
      handlerCalls += 1;
      res.json({});
    },
  );
  await app.fastify.ready();

  const reply = await app.fastify.inject({
    method: 'POST',
    url: '/canary-register-dynamic-client',
    headers: { 'content-type': 'application/json' },
    // `application_type` must be a non-empty string per
    // NonEmptyStringSchema — a number violates the schema.
    payload: JSON.stringify({ application_type: 42, client_name: 'Bad Shape' }),
  });

  assert.equal(reply.statusCode, 400);
  assert.equal(handlerCalls, 0, 'handler must not run when request validation rejects the input');
  const body = JSON.parse(reply.body);
  // OAuth envelope: top-level `error` is a code string, not an object.
  assert.equal(body.error, 'invalid_request');
  assert.equal(typeof body.error_description, 'string');
  assert.ok(body.error_description.length > 0);
  assert.equal(typeof body.request_id, 'string');
  assert.ok(body.request_id.length > 0);
});

test('allowlisted route runs route-level auth middleware BEFORE request validation', async () => {
  // Auth-then-validation ordering: a route mounted with both an auth
  // middleware and `{ contract }` must reject unauthenticated callers
  // with the auth failure, not the contract-validation failure, even
  // when the body would also fail validation.
  let handlerCalls = 0;
  let validationReached = false;

  const app = createApp({
    __requestValidationAllowlistForTest: ['refSetConnectionDisplayName'],
  });

  // Synthetic auth gate that responds 401 with a distinctive code so
  // we can prove this branch ran instead of the validator's
  // `invalid_request` branch. Auth is registered as middleware, so
  // the transport runs it BEFORE the contract-validation middleware
  // appended by the allowlist enrollment.
  const requireAuth = (req, res, next) => {
    if (!req.headers?.authorization) {
      res.status(401).json({
        error: {
          type: 'authentication_error',
          code: 'unauthenticated',
          message: 'auth required',
          request_id: 'req_auth_test',
        },
      });
      return;
    }
    next();
  };

  // Wrap the validator's input so we can detect it firing. We can't
  // observe the real applyRequestValidation directly, but if the body
  // is malformed AND the handler is never called AND we see a 401, we
  // know validation did not run.
  app.patch(
    '/canary-auth-ordering/:connectorInstanceId',
    { contract: 'refSetConnectionDisplayName' },
    requireAuth,
    (_req, res) => {
      handlerCalls += 1;
      validationReached = true;
      res.json({ object: 'should-never-be-reached' });
    },
  );
  await app.fastify.ready();

  // Unauthenticated + malformed body. Auth must short-circuit first.
  const reply = await app.fastify.inject({
    method: 'PATCH',
    url: '/canary-auth-ordering/conn_test_2',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ display_name: '' }),
  });

  assert.equal(
    reply.statusCode,
    401,
    `expected 401 from auth middleware, got ${reply.statusCode} — request validation must not preempt auth`,
  );
  assert.equal(handlerCalls, 0);
  assert.equal(validationReached, false);
  const body = JSON.parse(reply.body);
  assert.equal(body.error?.code, 'unauthenticated');
  assert.notEqual(body.error?.code, 'invalid_request');
});

test('allowlisted route accepts a well-formed body and reaches the handler', async () => {
  // Positive control: prove that enrollment doesn't break the happy
  // path. A valid body should reach the handler unchanged.
  let receivedBody = null;
  const app = createApp({
    __requestValidationAllowlistForTest: ['refSetConnectionDisplayName'],
  });
  app.patch(
    '/canary-accepts-valid/:connectorInstanceId',
    { contract: 'refSetConnectionDisplayName' },
    (req, res) => {
      receivedBody = req.body;
      res.json({ ok: true });
    },
  );
  await app.fastify.ready();

  const reply = await app.fastify.inject({
    method: 'PATCH',
    url: '/canary-accepts-valid/conn_test_3',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ display_name: 'My Connection' }),
  });

  assert.equal(reply.statusCode, 200);
  assert.deepEqual(receivedBody, { display_name: 'My Connection' });
});

test('the test-only allowlist injection does not leak across createApp instances', async () => {
  // Two apps, only one enrolls the op id. The non-enrolled instance
  // must NOT enforce validation — proves the override is per-app, not
  // process-global, and that the production shared allowlist is
  // untouched.
  let unenrolledHandlerCalls = 0;
  const unenrolled = createApp(); // no override
  unenrolled.patch(
    '/canary-not-enrolled/:connectorInstanceId',
    { contract: 'refSetConnectionDisplayName' },
    (_req, res) => {
      unenrolledHandlerCalls += 1;
      res.json({ object: 'reached' });
    },
  );
  await unenrolled.fastify.ready();

  const reply = await unenrolled.fastify.inject({
    method: 'PATCH',
    url: '/canary-not-enrolled/conn_test_4',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ display_name: '' }), // would fail validation if enrolled
  });

  // Validation did not run, so the handler reached. The handler is
  // a synthetic stub that returns 200 — what matters is the request
  // wasn't preempted with a 400 invalid_request envelope.
  assert.equal(reply.statusCode, 200);
  assert.equal(unenrolledHandlerCalls, 1);
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
