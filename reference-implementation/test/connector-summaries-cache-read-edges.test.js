import test from 'node:test';
import assert from 'node:assert/strict';

import { decideConnectorSummariesCacheRead, connectorSummariesCacheKey } from '../server/ref-control.ts';
import { closeDb, initDb } from '../server/db.js';

// Mutation-killing complement for the connector-summaries in-flight-
// coalescing READ decision (`decideConnectorSummariesCacheRead`) and its
// cache KEY projection (`connectorSummariesCacheKey`). Both are pure
// read-model helpers: the read decision maps a cache entry → one of two
// actions (no time-relative fresh/stale value window — see design.md
// "Central consumer and cache boundary"; the central observation barrier
// inside `loadConnectorSummaryProjectionDeps` already reconciles on every
// read, so a resolved cached value can never legitimately be served); the
// key maps (controller, run-inclusion) → a stable namespacing string.
//
// The key-matrix tests are unchanged from the pre-removal contract — the
// removal only touched the value-caching layer, not cache-key derivation.

function entry(overrides = {}) {
  return {
    generation: 1,
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// decideConnectorSummariesCacheRead — pure in-flight coalescing
// --------------------------------------------------------------------------

test('no entry, or an entry with no in-flight promise, always computes', () => {
  assert.equal(decideConnectorSummariesCacheRead(undefined), 'compute');
  assert.equal(decideConnectorSummariesCacheRead(entry()), 'compute');
});

test('an entry with an in-flight promise is awaited, never recomputed', () => {
  const e = entry({ promise: Promise.resolve([]) });
  assert.equal(decideConnectorSummariesCacheRead(e), 'await_refresh');
});

test('the decision never depends on elapsed time — there is no fresh/stale value window to expire', () => {
  // The old contract took a `now` timestamp and could return `return_fresh`/
  // `return_stale_refresh` for an entry with no in-flight promise, purely
  // from elapsed time. The new decision function takes ONLY the entry — an
  // entry with a value and no promise (a shape the type no longer even
  // allows to persist across a resolved compute; see
  // `refreshConnectorSummariesCache`, which deletes its entry on settle)
  // still computes, proving no time-relative state can make it return
  // anything but `compute` short of an active in-flight promise.
  assert.equal(decideConnectorSummariesCacheRead(entry({ generation: 999 })), 'compute');
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

test('dynamic allocator cache keys are scoped by allocator identity, with legacy controllers isolated', () => {
  try {
    initDb(':memory:');
    const allocatorA = { getBrowserSurfaceRuntimeAllocatorScopeId: () => 'neko-a' };
    const allocatorAShared = { getBrowserSurfaceRuntimeAllocatorScopeId: () => 'neko-a' };
    const allocatorB = { getBrowserSurfaceRuntimeAllocatorScopeId: () => 'neko-b' };
    const legacyOne = {};
    const legacyTwo = {};

    assert.equal(
      connectorSummariesCacheKey(allocatorA, {}),
      connectorSummariesCacheKey(allocatorAShared, {}),
      'the same declared allocator scope shares its single-flight'
    );
    assert.notEqual(connectorSummariesCacheKey(allocatorA, {}), connectorSummariesCacheKey(allocatorB, {}));
    assert.notEqual(
      connectorSummariesCacheKey(legacyOne, {}),
      connectorSummariesCacheKey(legacyTwo, {}),
      'undeclared scopes fail closed to controller-instance isolation'
    );
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
