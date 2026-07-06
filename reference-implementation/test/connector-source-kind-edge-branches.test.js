/**
 * Supplementary mutation-killing coverage for the edge branches of
 * `server/routes/connector-source-kind.ts` the main test leaves open:
 *
 *   - sourceKindFromManifestBindings: the `typeof bindings === "object"`
 *     guard against a non-object bindings value, an array bindings value
 *     (an object, but Object.hasOwn('filesystem'/'browser') is false), and a
 *     manifest with no runtime_requirements at all.
 *   - resolveEnrolledSourceKind: the `requestedSourceKind != null` guard —
 *     an explicit null / undefined requested kind is accepted (not treated
 *     as a contradiction) and returns the manifest-derived kind.
 *
 * Source-binding classification only (no auth/grant logic); no source change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveEnrolledSourceKind,
  sourceKindFromManifestBindings,
} from '../server/routes/connector-source-kind.ts';

test('sourceKindFromManifestBindings returns null for a non-object bindings value', () => {
  assert.equal(sourceKindFromManifestBindings({ runtime_requirements: { bindings: 'filesystem' } }), null);
  assert.equal(sourceKindFromManifestBindings({ runtime_requirements: { bindings: 42 } }), null);
});

test('sourceKindFromManifestBindings returns null for array bindings without an own filesystem/browser key', () => {
  // An array is an object, but the resolver keys off own-property names, not
  // element values, so a list of strings resolves to no binding.
  assert.equal(sourceKindFromManifestBindings({ runtime_requirements: { bindings: ['filesystem', 'browser'] } }), null);
});

test('sourceKindFromManifestBindings returns null when runtime_requirements is absent', () => {
  assert.equal(sourceKindFromManifestBindings({}), null);
  assert.equal(sourceKindFromManifestBindings({ runtime_requirements: {} }), null);
});

test('resolveEnrolledSourceKind accepts an explicitly null/undefined requested source kind', () => {
  const browserManifest = { runtime_requirements: { bindings: { browser: { required: true } } } };
  assert.equal(
    resolveEnrolledSourceKind({ connectorId: 'amazon', manifest: browserManifest, requestedSourceKind: null }),
    'browser_collector',
  );
  assert.equal(
    resolveEnrolledSourceKind({ connectorId: 'amazon', manifest: browserManifest, requestedSourceKind: undefined }),
    'browser_collector',
  );
  const fsManifest = { runtime_requirements: { bindings: { filesystem: { required: true } } } };
  assert.equal(
    resolveEnrolledSourceKind({ connectorId: 'codex', manifest: fsManifest }),
    'local_device',
  );
});
