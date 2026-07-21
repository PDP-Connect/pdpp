// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * W6 transport-layer tests — assert that the reference server is running on
 * native Fastify and that every `@pdpp/reference-contract` route manifest is
 * registered directly on a real Fastify route, not only reached via
 * middleware.
 *
 * These tests don't exercise PDPP protocol behavior (the rest of the test
 * suite already covers that). They exist to keep the literal W6 acceptance
 * bar observable from CI:
 *
 *   - the transport is Fastify (no Express compat shim)
 *   - every public + /_ref operation in `@pdpp/reference-contract` is
 *     attached to its corresponding Fastify route with a real schema and a
 *     `config.pdppContractOp` tag
 *   - routes without a contract-package manifest correctly have no schema
 *     auto-attached
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { publicManifests, referenceManifests } from '@pdpp/reference-contract';
import { createApp } from '../server/transport.js';
import { startServer } from '../server/index.js';

const ALL_MANIFESTS = [...publicManifests, ...referenceManifests];

function collectRegisteredSchemas(app) {
  const captured = [];
  app.fastify.addHook('onRoute', (opts) => {
    captured.push({
      method: opts.method,
      url: opts.url,
      hasSchema: !!opts.schema,
      schemaKinds: opts.schema
        ? Object.keys(opts.schema).filter((k) => k !== 'summary' && k !== 'tags' && k !== 'operationId')
        : [],
      pdppContractOp: opts.config?.pdppContractOp || null,
    });
  });
  return captured;
}

test('createApp() is native Fastify — no express middleware stack', () => {
  const app = createApp();
  assert.ok(app.fastify, 'createApp should expose the underlying fastify instance');
  // Fastify servers expose `.hasRoute(...)` and `.printRoutes()`; Express
  // apps do not. This asserts we're really on Fastify rather than a shim.
  assert.equal(typeof app.fastify.hasRoute, 'function');
  assert.equal(typeof app.fastify.printRoutes, 'function');
});

test('routes declared with { contract } carry the contract-package schema directly on the Fastify route', async () => {
  const app = createApp();
  const captured = collectRegisteredSchemas(app);

  app.post('/_ref/connectors/:connectorId/run', { contract: 'refRunConnector' },
    async (_req, res) => res.json({ ok: true }));
  app.put('/_ref/connectors/:connectorId/schedule', { contract: 'refPutConnectorSchedule' },
    async (_req, res) => res.json({ ok: true }));
  app.post('/no-contract-route', async (_req, res) => res.json({ ok: true }));

  await app.fastify.ready();

  const runRoute = captured.find((r) => r.url === '/_ref/connectors/:connectorId/run' && r.method === 'POST');
  assert.ok(runRoute, 'run route registered');
  assert.ok(runRoute.hasSchema, 'run route carries a Fastify schema');
  assert.ok(runRoute.schemaKinds.includes('params'), 'run route schema includes params');
  assert.equal(runRoute.pdppContractOp, 'refRunConnector', 'config.pdppContractOp names the manifest id');

  const scheduleRoute = captured.find((r) => r.url === '/_ref/connectors/:connectorId/schedule' && r.method === 'PUT');
  assert.ok(scheduleRoute, 'schedule route registered');
  assert.ok(scheduleRoute.hasSchema);
  assert.ok(scheduleRoute.schemaKinds.includes('body'), 'schedule upsert carries a body schema');
  assert.equal(scheduleRoute.pdppContractOp, 'refPutConnectorSchedule');

  const plainRoute = captured.find((r) => r.url === '/no-contract-route' && r.method === 'POST');
  assert.ok(plainRoute);
  assert.equal(plainRoute.hasSchema, false, 'routes without { contract } get no auto-attached schema');
  assert.equal(plainRoute.pdppContractOp, null);
});

test('unknown contract operation ids fail fast at registration time', () => {
  const app = createApp();
  // After wire-route-contract-validation: the error message names the
  // route's method and path alongside the offending operation id so an
  // operator can locate the bad annotation without reading the stack.
  assert.throws(
    () => app.post('/bogus', { contract: 'notARealOp' }, async (_req, res) => res.json({})),
    /Unknown reference-contract operation id for POST \/bogus: notARealOp/,
  );
});

// ─── Full-manifest coverage against the live reference server ──────────────
//
// The supervisor's W6 re-review flagged that attaching `{ contract }` to two
// example routes isn't enough — every manifest in `@pdpp/reference-contract`
// must be wired to its corresponding Fastify-backed route. These two tests
// boot the real server and assert coverage:
//
// 1. every manifest path + method is known to at least one Fastify instance
// 2. every manifest's operation id appears as `contractOp` on a registered
//    transport-level route (which means `{ contract: 'opId' }` was passed
//    when the route was declared)

test('every @pdpp/reference-contract manifest matches a live Fastify route on the reference server', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  try {
    const asFastify = server.asServer.__pdppFastify;
    const rsFastify = server.rsServer.__pdppFastify;
    assert.ok(asFastify, 'AS Fastify instance exposed on server.__pdppFastify');
    assert.ok(rsFastify, 'RS Fastify instance exposed on server.__pdppFastify');

    const missing = [];
    for (const manifest of ALL_MANIFESTS) {
      const fastifyPath = curlyToColonPath(manifest.path);
      const method = manifest.method.toUpperCase();
      const inAs = asFastify.hasRoute({ method, url: fastifyPath });
      const inRs = rsFastify.hasRoute({ method, url: fastifyPath });
      if (!inAs && !inRs) {
        missing.push(`${manifest.method} ${manifest.path} (id=${manifest.id})`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `every contract-package manifest must have a matching Fastify route.\nMissing:\n  ${missing.join('\n  ')}`,
    );
    assert.ok(ALL_MANIFESTS.length >= 24, `expected at least 24 manifests, have ${ALL_MANIFESTS.length}`);
  } finally {
    server.asServer.close();
    server.rsServer.close();
  }
});

test('every @pdpp/reference-contract manifest is declared via { contract: "opId" } at registration time', async () => {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  try {
    // `server/transport.js` records `{method, url, contractOp}` for every
    // route it registers, and attaches the list to the raw http.Server at
    // listen() time. Union AS + RS registries to get the full inventory.
    const asRoutes = server.asServer.__pdppRegisteredRoutes || [];
    const rsRoutes = server.rsServer.__pdppRegisteredRoutes || [];
    const allRoutes = [...asRoutes, ...rsRoutes];
    assert.ok(allRoutes.length > 0, 'transport should have registered at least one route');

    const declaredOps = new Set(
      allRoutes
        .filter((r) => r.contractOp)
        .map((r) => r.contractOp),
    );

    const missing = [];
    const duplicates = [];
    for (const manifest of ALL_MANIFESTS) {
      if (!declaredOps.has(manifest.id)) {
        missing.push(`${manifest.method} ${manifest.path} (id=${manifest.id})`);
      }
    }

    // Also catch duplicate bindings — the same contract op declared on more
    // than one route. That would indicate we bound the same manifest twice
    // by accident.
    const seen = new Map();
    for (const r of allRoutes) {
      if (!r.contractOp) continue;
      if (seen.has(r.contractOp)) {
        duplicates.push(`${r.contractOp} is bound on both ${seen.get(r.contractOp)} and ${r.method} ${r.url}`);
      }
      seen.set(r.contractOp, `${r.method} ${r.url}`);
    }

    assert.deepEqual(
      missing,
      [],
      `every contract manifest must be declared with { contract: 'opId' } on its route handler.\nMissing bindings:\n  ${missing.join('\n  ')}`,
    );
    assert.deepEqual(
      duplicates,
      [],
      `no contract op should be bound to more than one route.\nDuplicates:\n  ${duplicates.join('\n  ')}`,
    );

    // Every manifest must resolve to exactly one route binding. Cross-check
    // the count so a future accidental change doesn't quietly shrink the
    // coverage set.
    assert.equal(
      declaredOps.size,
      ALL_MANIFESTS.length,
      `expected ${ALL_MANIFESTS.length} distinct declared contract ops, got ${declaredOps.size}`,
    );
  } finally {
    server.asServer.close();
    server.rsServer.close();
  }
});

// Fastify's `hasRoute` expects the URL in its `:param` path-template form.
// Manifests use `{param}` curly-brace form (matching PDPP spec wire shape).
// Convert curly braces to colons, preserving parameter names verbatim so any
// name disagreement between a manifest and the server surfaces as a route
// miss instead of silently normalizing away. The historical blob_id vs
// blobId case (resolved 2026-04-22; see
// design-notes/blob-id-param-naming-2026-04-22.md) was exactly this class of
// bug.
function curlyToColonPath(path) {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, ':$1');
}
