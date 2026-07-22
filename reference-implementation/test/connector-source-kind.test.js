// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the manifest-derived connector-instance source-kind resolver
// shared by the device-exporter enroll routes. Pins the four decision-table
// rows from add-browser-collector-enrollment-primitive design Decision 2:
//   filesystem        -> local_device
//   browser           -> browser_collector
//   contradiction     -> typed reject
//   no/empty binding  -> typed reject (never default)

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

test('filesystem binding resolves to local_device', () => {
  assert.equal(
    resolveEnrolledSourceKind({ connectorId: 'codex', manifest: manifest({ filesystem: { required: true } }) }),
    'local_device',
  );
});

test('browser binding (no filesystem) resolves to browser_collector', () => {
  assert.equal(
    resolveEnrolledSourceKind({
      connectorId: 'amazon',
      manifest: manifest({ network: { required: true }, browser: { required: true } }),
    }),
    'browser_collector',
  );
});

test('filesystem wins over browser when a manifest declares both', () => {
  // Defensive precedence mirroring classifyConnectorIntentModality; no current
  // manifest declares both, but the resolver must be deterministic.
  assert.equal(
    resolveEnrolledSourceKind({
      connectorId: 'hybrid',
      manifest: manifest({ filesystem: { required: true }, browser: { required: true } }),
    }),
    'local_device',
  );
});

test('a contradicting requested source kind is rejected with a typed error', () => {
  assert.throws(
    () =>
      resolveEnrolledSourceKind({
        connectorId: 'amazon',
        manifest: manifest({ browser: { required: true } }),
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

test('a matching requested source kind is accepted', () => {
  assert.equal(
    resolveEnrolledSourceKind({
      connectorId: 'amazon',
      manifest: manifest({ browser: { required: true } }),
      requestedSourceKind: 'browser_collector',
    }),
    'browser_collector',
  );
});

test('a connector with neither binding is rejected, never defaulted', () => {
  assert.throws(
    () => resolveEnrolledSourceKind({ connectorId: 'github', manifest: manifest({ network: { required: true } }) }),
    (err) => {
      assert.ok(err instanceof SourceKindResolutionError);
      assert.equal(err.code, 'invalid_request');
      assert.equal(err.param, 'connector_id');
      return true;
    },
  );
});

test('a null/absent manifest is rejected, never defaulted', () => {
  assert.throws(
    () => resolveEnrolledSourceKind({ connectorId: 'unknown', manifest: null }),
    SourceKindResolutionError,
  );
  assert.equal(sourceKindFromManifestBindings(null), null);
  assert.equal(sourceKindFromManifestBindings(manifest(null)), null);
  assert.equal(sourceKindFromManifestBindings(manifest({})), null);
});
