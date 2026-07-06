import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideConnectorSummariesCacheRead,
  connectorSummariesCacheKey,
} from '../server/ref-control.ts';
import { closeDb, initDb } from '../server/db.js';

// Mutation-killing complement for the connector-summaries stale-while-revalidate
// cache READ decision (`decideConnectorSummariesCacheRead`) and its cache KEY
// projection (`connectorSummariesCacheKey`). Both are pure read-model helpers:
// the read decision maps (cache entry, now) → one of four actions; the key maps
// (controller, run-inclusion) → a stable namespacing string.
//
// The existing operation test pins the five happy-path decisions and the
// SQLite-store-identity dimension of the key. This file adds the boundary
// arithmetic (strict `>` at freshUntil/staleUntil == now), the otherwise-
// untested "fully stale but a refresh is already in flight → await_refresh"
// arm, and the full controller × run-depth key matrix. No DB is needed for the
// decision cases; the key cases use an in-memory SQLite store like the existing
// suite.

function entry(overrides = {}) {
  return {
    freshUntil: 0,
    generation: 1,
    staleUntil: 0,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// decideConnectorSummariesCacheRead — boundary arithmetic (strict `>`)
// --------------------------------------------------------------------------

test('freshUntil boundary is strict: fresh only while freshUntil > now, equal falls through to stale', () => {
  const e = entry({ value: [], freshUntil: 1000, staleUntil: 2000 });
  // now strictly before freshUntil → fresh.
  assert.equal(decideConnectorSummariesCacheRead(e, 999), 'return_fresh');
  // now EXACTLY at freshUntil → NOT fresh; still within stale window → stale-refresh.
  assert.equal(decideConnectorSummariesCacheRead(e, 1000), 'return_stale_refresh');
  // one tick past → still stale.
  assert.equal(decideConnectorSummariesCacheRead(e, 1001), 'return_stale_refresh');
});

test('staleUntil boundary is strict: stale only while staleUntil > now, equal falls through to compute', () => {
  const e = entry({ value: [], freshUntil: 900, staleUntil: 2000 });
  assert.equal(decideConnectorSummariesCacheRead(e, 1999), 'return_stale_refresh');
  // EXACTLY at staleUntil → no longer stale; no in-flight promise → compute.
  assert.equal(decideConnectorSummariesCacheRead(e, 2000), 'compute');
  assert.equal(decideConnectorSummariesCacheRead(e, 2001), 'compute');
});

// --------------------------------------------------------------------------
// The two arms of the terminal ternary (fully stale, value present)
// --------------------------------------------------------------------------

test('fully expired value WITH an in-flight refresh awaits it (not a redundant recompute)', () => {
  // value present but past both windows; a refresh promise is already running →
  // await it rather than launching a second compute.
  const e = entry({
    value: [],
    freshUntil: 100,
    staleUntil: 200,
    promise: Promise.resolve([]),
  });
  assert.equal(decideConnectorSummariesCacheRead(e, 1000), 'await_refresh');
});

test('fully expired value with NO in-flight refresh computes', () => {
  const e = entry({ value: [], freshUntil: 100, staleUntil: 200 });
  assert.equal(decideConnectorSummariesCacheRead(e, 1000), 'compute');
});

// --------------------------------------------------------------------------
// No-value entries and undefined entry
// --------------------------------------------------------------------------

test('missing entry computes; a value-less entry awaits its refresh when one is pending', () => {
  // No entry at all → compute.
  assert.equal(decideConnectorSummariesCacheRead(undefined, 1000), 'compute');
  // Entry exists but has no value yet AND a refresh is pending → await it
  // (fresh/stale windows are never consulted because there is no value).
  assert.equal(
    decideConnectorSummariesCacheRead(
      entry({ freshUntil: 9999, staleUntil: 9999, promise: Promise.resolve([]) }),
      1000
    ),
    'await_refresh'
  );
  // Entry exists, no value, no pending refresh → compute (even with a future window).
  assert.equal(
    decideConnectorSummariesCacheRead(entry({ freshUntil: 9999, staleUntil: 9999 }), 1000),
    'compute'
  );
});

// --------------------------------------------------------------------------
// connectorSummariesCacheKey — the controller × run-depth matrix
// --------------------------------------------------------------------------

test('cache key encodes controller presence and run-inclusion depth distinctly', () => {
  try {
    initDb(':memory:');

    // Controller presence flips the middle segment.
    const noController = connectorSummariesCacheKey(null, { includeRunSummaries: true });
    const withController = connectorSummariesCacheKey({}, { includeRunSummaries: true });
    assert.match(noController, /:no-controller:/);
    assert.match(withController, /:controller:/);
    assert.notEqual(noController, withController);

    // Run-depth segment: default/true → deep, false → shallow, singleton → singleton-active.
    assert.match(connectorSummariesCacheKey(null, {}), /:deep-runs$/);
    assert.match(connectorSummariesCacheKey(null, { includeRunSummaries: true }), /:deep-runs$/);
    assert.match(connectorSummariesCacheKey(null, { includeRunSummaries: false }), /:shallow-runs$/);
    assert.match(
      connectorSummariesCacheKey(null, { includeRunSummaries: 'singleton-active' }),
      /:singleton-active-runs$/
    );

    // The three run-depths under the same controller state are mutually distinct.
    const deep = connectorSummariesCacheKey(null, { includeRunSummaries: true });
    const shallow = connectorSummariesCacheKey(null, { includeRunSummaries: false });
    const singleton = connectorSummariesCacheKey(null, { includeRunSummaries: 'singleton-active' });
    assert.equal(new Set([deep, shallow, singleton]).size, 3, 'all three run-depths yield distinct keys');
  } finally {
    closeDb();
  }
});

test('cache key uses the storage identity as its leading segment (sqlite here)', () => {
  try {
    initDb(':memory:');
    const key = connectorSummariesCacheKey(null, {});
    assert.match(key, /^sqlite:/, 'storage backend identity leads the key');
    // Structure is <storage-identity>:<controller>:<run-depth>. The sqlite
    // storage identity is itself `sqlite:<path>:<gen>`, so assert the shape by
    // its documented controller + run-depth SUFFIX rather than a raw segment
    // count (the identity contains its own colons).
    assert.match(key, /:no-controller:deep-runs$/);
  } finally {
    closeDb();
  }
});
