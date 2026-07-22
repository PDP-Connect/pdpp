// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Content-negotiated AS/RS root landing pages.
 *
 * Spec: openspec/changes/split-public-site-and-operator-console
 *
 * Pins three behaviors:
 *   (a) Accept: application/json returns the existing discovery JSON.
 *   (b) Accept: text/html returns the operator landing page (200, text/html,
 *       contains the configured console origin and the well-known link).
 *   (c) clients with no Accept header keep the legacy JSON default (no
 *       silent UA-sniff redirect to HTML).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { startServer } from '../server/index.js';
import {
  resolveConsoleOriginForLanding,
  servedRootLandingIfBrowser,
  __testOnly,
} from '../server/reference-root-landing.ts';

const CONSOLE_ORIGIN = 'http://console.test.local:9999';

async function closeServer(server) {
  try {
    server.schedulerManager?.stop?.();
  } catch {}
  try {
    server.abortStartupBackfill?.('test shutdown');
  } catch {}
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const backfillDone = server.startupBackfillDone
    ? new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        Promise.resolve(server.startupBackfillDone)
          .catch(() => {})
          .finally(() => {
            clearTimeout(timer);
            resolve();
          });
      })
    : Promise.resolve();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
    backfillDone,
    server.controller?.drainActiveRuns
      ? server.controller.drainActiveRuns(1000).catch(() => {})
      : Promise.resolve(),
  ]);
}

async function withServer(fn) {
  const previousReferenceOrigin = process.env.PDPP_REFERENCE_ORIGIN;
  process.env.PDPP_REFERENCE_ORIGIN = CONSOLE_ORIGIN;
  const server = await startServer({
    asPort: 0,
    rsPort: 0,
    quiet: true,
    dbPath: ':memory:',
    autoEnrollEligibleSchedules: false,
    ignoreAmbientPublicUrls: true,
    skipBackfill: true,
  });
  try {
    const asAddress = server.asServer.address();
    const rsAddress = server.rsServer.address();
    const asUrl = `http://127.0.0.1:${asAddress.port}`;
    const rsUrl = `http://127.0.0.1:${rsAddress.port}`;
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
    if (previousReferenceOrigin === undefined) {
      delete process.env.PDPP_REFERENCE_ORIGIN;
    } else {
      process.env.PDPP_REFERENCE_ORIGIN = previousReferenceOrigin;
    }
  }
}

// ─── unit: negotiation helper ────────────────────────────────────────────

test('servedRootLandingIfBrowser falls through when no Accept header is set', () => {
  const req = { headers: {}, query: {}, accepts: () => false };
  const sent = { status: null, body: null, headers: {} };
  const res = {
    setHeader(k, v) { sent.headers[k] = v; },
    send(b) { sent.body = b; },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    role: 'authorization_server',
    providerName: 'Test',
    referenceRevision: 'rev',
  });
  assert.equal(handled, false);
  assert.equal(sent.body, null);
});

test('servedRootLandingIfBrowser falls through for explicit ?format=json', () => {
  const req = {
    headers: { accept: 'text/html' },
    query: { format: 'json' },
    accepts: () => 'html',
  };
  const sent = { body: null };
  const res = {
    setHeader() {},
    send(b) { sent.body = b; },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    role: 'authorization_server',
    providerName: 'Test',
    referenceRevision: 'rev',
  });
  assert.equal(handled, false);
});

test('servedRootLandingIfBrowser falls through for Accept: */* (curl default)', () => {
  const req = {
    headers: { accept: '*/*' },
    query: {},
    accepts: () => 'html',
  };
  const sent = { body: null };
  const res = {
    setHeader() {},
    send(b) { sent.body = b; },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    role: 'authorization_server',
    providerName: 'Test',
    referenceRevision: 'rev',
  });
  assert.equal(handled, false);
});

test('servedRootLandingIfBrowser renders HTML for Accept: text/html', () => {
  const req = {
    headers: { accept: 'text/html' },
    query: {},
    accepts: (types) => (types.includes('html') ? 'html' : false),
  };
  const sent = { headers: {}, body: null };
  const res = {
    setHeader(k, v) { sent.headers[k] = v; },
    send(b) { sent.body = b; },
  };
  const handled = servedRootLandingIfBrowser(req, res, {
    role: 'authorization_server',
    providerName: 'Test Provider',
    referenceRevision: 'rev-abc',
    consoleOrigin: CONSOLE_ORIGIN,
  });
  assert.equal(handled, true);
  assert.equal(sent.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(sent.headers['X-Robots-Tag'], 'noindex, nofollow');
  assert.match(sent.body, /<!DOCTYPE html>/);
  assert.match(sent.body, /Test Provider/);
  assert.match(sent.body, new RegExp(CONSOLE_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(sent.body, /\.well-known\/oauth-authorization-server/);
});

test('servedRootLandingIfBrowser advertises RS well-known on RS landing', () => {
  const req = {
    headers: { accept: 'text/html' },
    query: {},
    accepts: (types) => (types.includes('html') ? 'html' : false),
  };
  const sent = { body: null };
  const res = {
    setHeader() {},
    send(b) { sent.body = b; },
  };
  servedRootLandingIfBrowser(req, res, {
    role: 'resource_server',
    providerName: 'Test',
    referenceRevision: 'rev',
    consoleOrigin: CONSOLE_ORIGIN,
  });
  assert.match(sent.body, /\.well-known\/oauth-protected-resource/);
});

test('resolveConsoleOriginForLanding prefers explicit > env > default', () => {
  assert.equal(
    resolveConsoleOriginForLanding({
      consoleOrigin: 'http://explicit.test',
      env: { PDPP_REFERENCE_ORIGIN: 'http://from-env.test' },
    }),
    'http://explicit.test',
  );
  assert.equal(
    resolveConsoleOriginForLanding({
      env: { PDPP_REFERENCE_ORIGIN: 'http://from-env.test' },
    }),
    'http://from-env.test',
  );
  assert.equal(
    resolveConsoleOriginForLanding({ env: {} }),
    'http://localhost:3002',
  );
});

test('renderRootLanding output is escaped HTML containing expected anchors', () => {
  const html = __testOnly.renderRootLanding({
    role: 'authorization_server',
    providerName: 'Test <Provider>',
    referenceRevision: 'rev-1',
    consoleOrigin: CONSOLE_ORIGIN,
  });
  assert.match(html, /Test &lt;Provider&gt;/);
  assert.doesNotMatch(html, /<Provider>/);
});

// ─── integration: real AS/RS server ──────────────────────────────────────

test('AS root returns JSON for Accept: application/json (byte-identical envelope)', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(asUrl + '/', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /application\/json/);
    const body = await resp.json();
    assert.equal(body.object, 'pdpp_discovery_index');
    assert.equal(body.role, 'authorization_server');
    assert.equal(
      body.links.well_known_authorization_server,
      '/.well-known/oauth-authorization-server',
    );
  });
});

test('AS root returns HTML for Accept: text/html and advertises the console origin', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(asUrl + '/', { headers: { Accept: 'text/html' } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /text\/html/);
    const body = await resp.text();
    assert.match(body, /<!DOCTYPE html>/i);
    assert.ok(body.includes(CONSOLE_ORIGIN), 'landing should reference configured console origin');
    assert.match(body, /\.well-known\/oauth-authorization-server/);
  });
});

test('AS root keeps the legacy JSON default for clients sending no Accept header', async () => {
  await withServer(async ({ asUrl }) => {
    // node:http with no Accept header
    const resp = await fetch(asUrl + '/', { headers: { Accept: '' } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /application\/json/);
  });
});

test('RS root returns JSON for Accept: application/json (byte-identical envelope)', async () => {
  await withServer(async ({ rsUrl }) => {
    const resp = await fetch(rsUrl + '/', {
      headers: { Accept: 'application/json' },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /application\/json/);
    const body = await resp.json();
    assert.equal(body.object, 'pdpp_discovery_index');
    assert.equal(body.role, 'resource_server');
  });
});

test('RS root returns HTML for Accept: text/html and advertises the console origin', async () => {
  await withServer(async ({ rsUrl }) => {
    const resp = await fetch(rsUrl + '/', { headers: { Accept: 'text/html' } });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /text\/html/);
    const body = await resp.text();
    assert.match(body, /<!DOCTYPE html>/i);
    assert.ok(body.includes(CONSOLE_ORIGIN));
    assert.match(body, /\.well-known\/oauth-protected-resource/);
  });
});

test('AS root explicit ?format=json overrides Accept: text/html and returns JSON', async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(asUrl + '/?format=json', {
      headers: { Accept: 'text/html' },
    });
    assert.equal(resp.status, 200);
    assert.match(resp.headers.get('content-type') || '', /application\/json/);
    const body = await resp.json();
    assert.equal(body.object, 'pdpp_discovery_index');
  });
});
