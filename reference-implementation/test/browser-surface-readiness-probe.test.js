import test from 'node:test';
import assert from 'node:assert/strict';

import {
  probeBrowserSurfaceReadinessOverHttp,
  createDefaultBrowserSurfaceReadinessProbe,
} from '../runtime/browser-surface-readiness.ts';

// Mutation-killing tests for the browser-surface READINESS PROBE — a derived
// verdict projection with ZERO prior coverage. It maps a surface + the sequence
// of CDP HTTP responses onto one of five typed, machine-actionable failure codes
// (or ok), which the controller uses to avoid burning a one-shot OTP against a
// dead surface. Every branch is a load-bearing classification.
//
// The probe takes an injected `fetchImpl`, so the whole state machine is pure
// and deterministic here: a fake fetch keyed by URL suffix drives each stage to
// its success or failure code. No network, no DB.

const READY_SURFACE = Object.freeze({
  surface_id: 'srf_1',
  health: 'ready',
  cdp_url: 'http://neko.local:9222',
});

const TIMEOUT = 5000;

/** A usable DevTools page target. */
function pageTarget(id = 'T1') {
  return { id, type: 'page', url: 'https://example.com', webSocketDebuggerUrl: `ws://neko/${id}` };
}

/**
 * Build a fake fetch that answers each CDP endpoint. `routes` maps a URL
 * substring → { status?, json?, throw?, aborted? }. Unmatched URLs 404.
 */
function fakeFetch(routes) {
  return async (url) => {
    for (const [needle, spec] of Object.entries(routes)) {
      if (url.includes(needle)) {
        if (spec.throw) {
          throw spec.throw;
        }
        const status = spec.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => {
            if (spec.malformed) throw new SyntaxError('Unexpected token');
            return spec.json;
          },
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** The happy-path route table: version → list → new → close all succeed. */
function happyRoutes(over = {}) {
  return {
    'json/version': { json: { Browser: 'Chrome/120', webSocketDebuggerUrl: 'ws://neko/browser' } },
    'json/list': { json: [pageTarget('T1'), pageTarget('T2')] },
    'json/new': { json: pageTarget('T3') },
    'json/close': { json: null },
    ...over,
  };
}

// --------------------------------------------------------------------------
// Surface-shape validation (before any HTTP)
// --------------------------------------------------------------------------

test('surface health other than ready → browser_surface_not_ready without any fetch', async () => {
  let fetched = false;
  const spy = async () => { fetched = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const r = await probeBrowserSurfaceReadinessOverHttp({ ...READY_SURFACE, health: 'starting' }, spy, TIMEOUT);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'browser_surface_not_ready');
  assert.equal(fetched, false, 'a not-ready surface must not be probed over HTTP');
});

test('missing or non-http cdp_url → browser_surface_not_ready', async () => {
  const noUrl = await probeBrowserSurfaceReadinessOverHttp({ ...READY_SURFACE, cdp_url: '' }, fakeFetch({}), TIMEOUT);
  assert.equal(noUrl.code, 'browser_surface_not_ready');

  const wsScheme = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: 'ws://neko.local:9222' },
    fakeFetch({}),
    TIMEOUT
  );
  assert.equal(wsScheme.code, 'browser_surface_not_ready', 'a ws:// scheme is not an http CDP base');

  const garbage = await probeBrowserSurfaceReadinessOverHttp(
    { ...READY_SURFACE, cdp_url: 'not a url' },
    fakeFetch({}),
    TIMEOUT
  );
  assert.equal(garbage.code, 'browser_surface_not_ready', 'an unparseable url is not-ready');
});

// --------------------------------------------------------------------------
// Happy path
// --------------------------------------------------------------------------

test('all four stages succeed → ok with page-target count and browser version', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fakeFetch(happyRoutes()), TIMEOUT);
  assert.equal(r.ok, true);
  assert.equal(r.pageTargetCount, 2, 'counts only the /json/list page targets');
  assert.equal(r.browserVersion, 'Chrome/120');
});

test('ok without a Browser string omits browserVersion (never fabricated)', async () => {
  const routes = happyRoutes({ 'json/version': { json: { webSocketDebuggerUrl: 'ws://neko/browser' } } });
  const r = await probeBrowserSurfaceReadinessOverHttp(READY_SURFACE, fakeFetch(routes), TIMEOUT);
  assert.equal(r.ok, true);
  assert.ok(!('browserVersion' in r), 'no Browser field → no browserVersion key');
});

// --------------------------------------------------------------------------
// /json/version failure modes
// --------------------------------------------------------------------------

test('version endpoint HTTP error → browser_surface_cdp_disconnected', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/version': { status: 500, json: {} } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_cdp_disconnected');
});

test('version payload missing webSocketDebuggerUrl → browser_surface_cdp_disconnected', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/version': { json: { Browser: 'Chrome/120' } } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_cdp_disconnected');
});

test('version network throw (not aborted) → browser_surface_cdp_unreachable', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/version': { throw: new TypeError('ECONNREFUSED') } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_cdp_unreachable');
});

test('version malformed JSON → browser_surface_cdp_disconnected', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/version': { malformed: true, json: {} } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_cdp_disconnected');
});

// --------------------------------------------------------------------------
// /json/list failure modes → page-stale classification
// --------------------------------------------------------------------------

test('list not an array → browser_surface_cdp_disconnected', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/list': { json: { not: 'an array' } } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_cdp_disconnected');
});

test('list empty → browser_surface_page_stale (zero targets)', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/list': { json: [] } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_page_stale');
  assert.match(r.detail, /zero targets/);
});

test('list has targets but none usable (devtools:// + wrong type) → browser_surface_page_stale', async () => {
  const unusable = [
    { id: 'x', type: 'page', url: 'devtools://devtools/inspector.html', webSocketDebuggerUrl: 'ws://neko/x' },
    { id: 'y', type: 'background_page', url: 'https://ok', webSocketDebuggerUrl: 'ws://neko/y' },
    { id: '', type: 'page', url: 'https://ok', webSocketDebuggerUrl: 'ws://neko/z' }, // empty id
    { type: 'page', url: 'https://ok', webSocketDebuggerUrl: 'ws://neko/w' }, // missing id
    { id: 'q', type: 'page', url: 'https://ok' }, // missing ws url
  ];
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/list': { json: unusable } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_page_stale');
  assert.match(r.detail, /none are usable/);
});

// --------------------------------------------------------------------------
// /json/new (smoke target) failure
// --------------------------------------------------------------------------

test('new target returns a non-usable target → browser_surface_page_stale', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/new': { json: { id: 'T3', type: 'other' } } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_page_stale');
});

test('close endpoint HTTP error after a good new target → browser_surface_cdp_disconnected', async () => {
  const r = await probeBrowserSurfaceReadinessOverHttp(
    READY_SURFACE,
    fakeFetch(happyRoutes({ 'json/close': { status: 404, json: null } })),
    TIMEOUT
  );
  assert.equal(r.code, 'browser_surface_cdp_disconnected');
});

// --------------------------------------------------------------------------
// Probe factory validation
// --------------------------------------------------------------------------

test('createDefaultBrowserSurfaceReadinessProbe rejects a non-positive-integer timeout', () => {
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 0 }), /positive integer/);
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: -5 }), /positive integer/);
  assert.throws(() => createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 1.5 }), /positive integer/);
  // A valid timeout + injected fetch yields a working probe.
  const probe = createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 1000, fetchImpl: fakeFetch(happyRoutes()) });
  assert.equal(typeof probe.probe, 'function');
});

test('the injected probe drives the happy path end-to-end', async () => {
  const probe = createDefaultBrowserSurfaceReadinessProbe({ timeoutMs: 1000, fetchImpl: fakeFetch(happyRoutes()) });
  const r = await probe.probe(READY_SURFACE);
  assert.equal(r.ok, true);
  assert.equal(r.pageTargetCount, 2);
});
