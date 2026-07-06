// Pure, no-DB unit tests for the source-descriptor decision tables in
// server/source-descriptor.js. These functions translate grant/manifest/query
// shapes into the canonical {kind,id} source descriptor and read-scope binding
// used throughout owner + client read paths. The precedence order (grant.source
// beats storage_binding beats null; provider_native beats connector) and the
// "requires BOTH kind and id" guards are the mutation surface. None of these
// pure functions had by-name assertions (only incidental string mentions).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildClientSourceDescriptor,
  buildSourceDescriptor,
  getOwnerTokenSubjectId,
  resolveGrantStorageBinding,
  resolveNativeManifest,
  resolveNativeStorageBinding,
  resolveSingleConnectorIdQueryValue,
} from '../server/source-descriptor.js';

// --- buildSourceDescriptor: kind decision table (requires kind AND id) --------

test('buildSourceDescriptor: provider_native binding with id yields provider_native descriptor', () => {
  assert.deepEqual(
    buildSourceDescriptor({ kind: 'provider_native', id: 'gmail' }),
    { kind: 'provider_native', id: 'gmail' },
  );
});

test('buildSourceDescriptor: connector binding with id yields connector descriptor', () => {
  assert.deepEqual(
    buildSourceDescriptor({ kind: 'connector', id: 'amazon' }),
    { kind: 'connector', id: 'amazon' },
  );
});

test('buildSourceDescriptor: missing id yields null even with a valid kind', () => {
  assert.equal(buildSourceDescriptor({ kind: 'provider_native' }), null);
  assert.equal(buildSourceDescriptor({ kind: 'connector', id: '' }), null, 'empty id is falsy -> null');
});

test('buildSourceDescriptor: unknown kind yields null', () => {
  assert.equal(buildSourceDescriptor({ kind: 'mystery', id: 'x' }), null);
  assert.equal(buildSourceDescriptor(null), null);
  assert.equal(buildSourceDescriptor(undefined), null);
});

test('buildSourceDescriptor: provider_native takes precedence is irrelevant per-call, but connector path is distinct', () => {
  // A binding cannot be both; assert connector kind does NOT get relabeled native.
  const d = buildSourceDescriptor({ kind: 'connector', id: 'spotify' });
  assert.equal(d.kind, 'connector');
  assert.notEqual(d.kind, 'provider_native');
});

// --- resolveGrantStorageBinding ----------------------------------------------

test('resolveGrantStorageBinding: returns binding only when connector_id present', () => {
  const binding = { connector_id: 'gmail', extra: 1 };
  assert.deepEqual(resolveGrantStorageBinding({ grant_storage_binding: binding }), binding);
  assert.equal(resolveGrantStorageBinding({ grant_storage_binding: {} }), null, 'no connector_id -> null');
  assert.equal(resolveGrantStorageBinding({}), null);
  assert.equal(resolveGrantStorageBinding(null), null);
});

// --- buildClientSourceDescriptor: grant.source beats storage_binding ----------

test('buildClientSourceDescriptor: grant.source wins over storage_binding', () => {
  const tokenInfo = {
    grant: { source: { kind: 'provider_native', id: 'native-provider' } },
    grant_storage_binding: { connector_id: 'fallback-connector' },
  };
  assert.deepEqual(
    buildClientSourceDescriptor(tokenInfo),
    { kind: 'provider_native', id: 'native-provider' },
    'grant.source must take precedence over storage binding',
  );
});

test('buildClientSourceDescriptor: falls back to storage_binding connector when no grant.source', () => {
  const tokenInfo = { grant_storage_binding: { connector_id: 'fallback-connector' } };
  assert.deepEqual(
    buildClientSourceDescriptor(tokenInfo),
    { kind: 'connector', id: 'fallback-connector' },
  );
});

test('buildClientSourceDescriptor: null when neither grant.source nor storage binding present', () => {
  assert.equal(buildClientSourceDescriptor({}), null);
  assert.equal(buildClientSourceDescriptor({ grant: { source: { kind: 'connector' } } }), null, 'source without id -> null -> fall through -> null');
});

// --- resolveNativeManifest / resolveNativeStorageBinding ----------------------

test('resolveNativeManifest: passes through opts.nativeManifest or null', () => {
  const manifest = { provider_id: 'p' };
  assert.equal(resolveNativeManifest({ nativeManifest: manifest }), manifest);
  assert.equal(resolveNativeManifest({}), null);
  assert.equal(resolveNativeManifest(), null);
});

test('resolveNativeStorageBinding: extracts connector_id from native manifest storage_binding', () => {
  assert.deepEqual(
    resolveNativeStorageBinding({ nativeManifest: { storage_binding: { connector_id: 'nc' } } }),
    { connector_id: 'nc' },
  );
  assert.equal(
    resolveNativeStorageBinding({ nativeManifest: { storage_binding: {} } }),
    null,
    'no connector_id -> null',
  );
  assert.equal(resolveNativeStorageBinding({}), null);
});

// --- getOwnerTokenSubjectId: default fallback ---------------------------------

test('getOwnerTokenSubjectId: uses tokenInfo.subject_id when present', () => {
  assert.equal(getOwnerTokenSubjectId({ tokenInfo: { subject_id: 'sub-42' } }), 'sub-42');
});

test('getOwnerTokenSubjectId: falls back to the default owner subject id when absent', () => {
  const fallback = getOwnerTokenSubjectId({});
  const fallback2 = getOwnerTokenSubjectId({ tokenInfo: {} });
  assert.equal(typeof fallback, 'string');
  assert.ok(fallback.length > 0, 'default subject id must be a non-empty string');
  assert.equal(fallback, fallback2, 'both empty-token cases resolve to the same default');
  // the fallback must NOT equal an explicit subject id, proving the branch matters
  assert.notEqual(getOwnerTokenSubjectId({ tokenInfo: { subject_id: 'explicit' } }), fallback);
});

// --- resolveSingleConnectorIdQueryValue: trim + non-string guard --------------

test('resolveSingleConnectorIdQueryValue: trims whitespace to a value', () => {
  assert.equal(resolveSingleConnectorIdQueryValue('  gmail  '), 'gmail');
  assert.equal(resolveSingleConnectorIdQueryValue('spotify'), 'spotify');
});

test('resolveSingleConnectorIdQueryValue: non-string or blank yields null (rejects arrays)', () => {
  assert.equal(resolveSingleConnectorIdQueryValue(['a', 'b']), null, 'array (repeated query param) -> null');
  assert.equal(resolveSingleConnectorIdQueryValue('   '), null, 'whitespace-only -> null');
  assert.equal(resolveSingleConnectorIdQueryValue(''), null);
  assert.equal(resolveSingleConnectorIdQueryValue(undefined), null);
  assert.equal(resolveSingleConnectorIdQueryValue(42), null, 'number -> null');
});
