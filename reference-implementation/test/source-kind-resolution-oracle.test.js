import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SourceKindResolutionError,
  resolveEnrolledSourceKind,
  sourceKindFromManifestBindings,
} from '../server/routes/connector-source-kind.ts';

function manifest(bindings) {
  return { runtime_requirements: { bindings } };
}

test('BASELINE: sourceKindFromManifestBindings derives source kind from manifest bindings', () => {
  assert.equal(sourceKindFromManifestBindings(manifest({ filesystem: {} })), 'local_device');
  assert.equal(sourceKindFromManifestBindings(manifest({ browser: {} })), 'browser_collector');
  assert.equal(sourceKindFromManifestBindings(manifest({ filesystem: {}, browser: {} })), 'local_device');
});

test('resolveEnrolledSourceKind returns the manifest-derived source kind for absent or matching requests', () => {
  const filesystemManifest = manifest({ filesystem: {} });
  const browserManifest = manifest({ browser: {} });

  assert.equal(
    resolveEnrolledSourceKind({
      connectorId: 'filesystem-connector',
      manifest: filesystemManifest,
      requestedSourceKind: null,
    }),
    'local_device',
  );
  assert.equal(
    resolveEnrolledSourceKind({
      connectorId: 'browser-connector',
      manifest: browserManifest,
      requestedSourceKind: undefined,
    }),
    'browser_collector',
  );
  assert.equal(
    resolveEnrolledSourceKind({
      connectorId: 'browser-connector',
      manifest: browserManifest,
      requestedSourceKind: 'browser_collector',
    }),
    'browser_collector',
  );
});

test('resolveEnrolledSourceKind rejects a requested source kind that contradicts the manifest', () => {
  assert.throws(
    () =>
      resolveEnrolledSourceKind({
        connectorId: 'browser-connector',
        manifest: manifest({ browser: {} }),
        requestedSourceKind: 'local_device',
      }),
    (err) => {
      assert.ok(err instanceof SourceKindResolutionError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'source_kind');
      return true;
    },
  );
});

test('resolveEnrolledSourceKind rejects manifests with no resolvable source binding', () => {
  assert.throws(
    () =>
      resolveEnrolledSourceKind({
        connectorId: 'unbound-connector',
        manifest: manifest({ network: {} }),
      }),
    (err) => {
      assert.ok(err instanceof SourceKindResolutionError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'connector_id');
      return true;
    },
  );
});
