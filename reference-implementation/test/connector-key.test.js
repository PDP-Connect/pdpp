/**
 * Unit tests for the canonical connector-key helpers.
 *
 * These pin the first-party allowlist, the URL→key normalization, the
 * legacy local-collector alias mapping, and the fail-closed posture for
 * unknown third-party identifiers. Subsequent migration / runtime slices
 * depend on this mapping being stable, so each known input shape gets an
 * explicit assertion.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalConnectorKey,
  canonicalConnectorKeyFromManifest,
  connectorKeyFromRegistryUrl,
  firstPartyConnectorKeys,
  isInternalConnectorId,
  isConnectorKey,
  isLegacyLocalAlias,
  isRegistryUrlConnectorId,
  legacyLocalAliasMap,
  nativeConnectorKeys,
} from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = resolve(
  __dirname,
  '..',
  '..',
  'packages',
  'polyfill-connectors',
  'manifests',
);
const REFERENCE_MANIFESTS_DIR = resolve(__dirname, '..', 'manifests');

const REGISTRY_PREFIX = 'https://registry.pdpp.org/connectors/';

test('connectorKeyFromRegistryUrl returns the canonical slug for every first-party URL', () => {
  for (const key of firstPartyConnectorKeys()) {
    assert.equal(
      connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}${key}`),
      key,
      `expected ${key} round-trip`,
    );
  }
});

test('connectorKeyFromRegistryUrl rejects non-first-party / malformed URLs', () => {
  // Slug not in the allowlist — fail closed.
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}fictional`), null);
  // Wrong host or scheme.
  assert.equal(connectorKeyFromRegistryUrl('http://registry.pdpp.org/connectors/gmail'), null);
  assert.equal(connectorKeyFromRegistryUrl('https://other.example/connectors/gmail'), null);
  // Extra path segments / query / fragment.
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail/extra`), null);
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail?x=1`), null);
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail#frag`), null);
  // Empty / non-string.
  assert.equal(connectorKeyFromRegistryUrl(''), null);
  assert.equal(connectorKeyFromRegistryUrl('   '), null);
  assert.equal(connectorKeyFromRegistryUrl(null), null);
  assert.equal(connectorKeyFromRegistryUrl(undefined), null);
  assert.equal(connectorKeyFromRegistryUrl(42), null);
});

test('connectorKeyFromRegistryUrl tolerates one trailing slash', () => {
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail/`), 'gmail');
  // Two trailing slashes look like an extra empty segment — reject.
  assert.equal(connectorKeyFromRegistryUrl(`${REGISTRY_PREFIX}gmail//`), null);
});

test('canonicalConnectorKey accepts a bare first-party slug', () => {
  for (const key of firstPartyConnectorKeys()) {
    assert.equal(canonicalConnectorKey(key), key);
  }
});

test('canonicalConnectorKey accepts native bare slugs', () => {
  for (const key of nativeConnectorKeys()) {
    assert.equal(canonicalConnectorKey(key), key);
  }
});

test('canonicalConnectorKey maps legacy snake_case local aliases to canonical hyphenated keys', () => {
  // Pin the exact alias set so a silent expansion of the legacy table
  // (which would create new owner-visible aliases) breaks the test.
  assert.deepEqual(legacyLocalAliasMap(), {
    claude_code: 'claude-code',
    codex: 'codex',
  });
  assert.equal(canonicalConnectorKey('claude_code'), 'claude-code');
  assert.equal(canonicalConnectorKey('codex'), 'codex');
  assert.equal(isLegacyLocalAlias('claude_code'), true);
  assert.equal(isLegacyLocalAlias('codex'), true);
  assert.equal(isLegacyLocalAlias('gmail'), false);
  assert.equal(isLegacyLocalAlias(''), false);
});

test('canonicalConnectorKey accepts URL-shaped first-party ids', () => {
  for (const key of firstPartyConnectorKeys()) {
    assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}${key}`), key);
  }
});

test('isConnectorKey accepts operational keys and rejects URLs', () => {
  assert.equal(isConnectorKey('gmail'), true);
  assert.equal(isConnectorKey('claude-code'), true);
  assert.equal(isConnectorKey('northstar_hr_native'), true);
  assert.equal(isConnectorKey(`${REGISTRY_PREFIX}gmail`), false);
  assert.equal(isConnectorKey(''), false);
  assert.equal(isConnectorKey('  '), false);
  assert.equal(isConnectorKey('bad/key'), false);
  assert.equal(isConnectorKey(null), false);
});

test('canonicalConnectorKey fails closed on unknown URLs and arbitrary strings', () => {
  // The reference must NOT silently promote an unknown registry URL into
  // a canonical first-party key — custom connectors have to declare their
  // own key explicitly (per OpenSpec design §3).
  assert.equal(canonicalConnectorKey(`${REGISTRY_PREFIX}unknown-thing`), null);
  assert.equal(canonicalConnectorKey('https://other.example/connectors/gmail'), null);
  // Bare strings that look like keys but are not in any allowlist.
  assert.equal(canonicalConnectorKey('custom_provider'), null);
  assert.equal(canonicalConnectorKey('unknown'), null);
  // Whitespace / empty / non-string.
  assert.equal(canonicalConnectorKey('   '), null);
  assert.equal(canonicalConnectorKey(''), null);
  assert.equal(canonicalConnectorKey(null), null);
  assert.equal(canonicalConnectorKey(undefined), null);
  assert.equal(canonicalConnectorKey({}), null);
});

test('canonicalConnectorKey trims surrounding whitespace before lookup', () => {
  assert.equal(canonicalConnectorKey('  gmail  '), 'gmail');
  assert.equal(canonicalConnectorKey('\tclaude_code\n'), 'claude-code');
});

test('isRegistryUrlConnectorId reports the URL shape regardless of allowlist membership', () => {
  assert.equal(isRegistryUrlConnectorId(`${REGISTRY_PREFIX}gmail`), true);
  // Unknown slug still looks like a registry URL — true.
  assert.equal(isRegistryUrlConnectorId(`${REGISTRY_PREFIX}unknown`), true);
  assert.equal(isRegistryUrlConnectorId('gmail'), false);
  assert.equal(isRegistryUrlConnectorId('https://other.example/connectors/gmail'), false);
  assert.equal(isRegistryUrlConnectorId(null), false);
});

test('canonicalConnectorKeyFromManifest reads polyfill-style top-level connector_id', () => {
  const manifest = {
    connector_id: `${REGISTRY_PREFIX}gmail`,
    display_name: 'Gmail',
    streams: [],
  };
  assert.equal(canonicalConnectorKeyFromManifest(manifest), 'gmail');
});

test('canonicalConnectorKeyFromManifest prefers explicit connector_key', () => {
  const manifest = {
    connector_key: 'custom-source',
    manifest_uri: 'https://example.test/manifests/custom-source',
    connector_id: `${REGISTRY_PREFIX}gmail`,
    display_name: 'Custom Source',
    streams: [],
  };
  assert.equal(canonicalConnectorKeyFromManifest(manifest), 'custom-source');
});

test('canonicalConnectorKeyFromManifest rejects invalid explicit connector_key', () => {
  assert.equal(
    canonicalConnectorKeyFromManifest({
      connector_key: `${REGISTRY_PREFIX}gmail`,
      manifest_uri: `${REGISTRY_PREFIX}gmail`,
      streams: [],
    }),
    null,
  );
});

test('canonicalConnectorKeyFromManifest falls back to storage_binding.connector_id', () => {
  // Native reference manifest shape (`reference-implementation/manifests/
  // northstar-hr.json`).
  const manifest = {
    provider_id: 'northstar_hr',
    storage_binding: { connector_id: 'northstar_hr_native' },
    streams: [],
  };
  assert.equal(canonicalConnectorKeyFromManifest(manifest), 'northstar_hr_native');
});

test('canonicalConnectorKeyFromManifest returns null for unrecognized manifests', () => {
  assert.equal(canonicalConnectorKeyFromManifest(null), null);
  assert.equal(canonicalConnectorKeyFromManifest({}), null);
  assert.equal(
    canonicalConnectorKeyFromManifest({ connector_id: 'https://other.example/x' }),
    null,
  );
  assert.equal(
    canonicalConnectorKeyFromManifest({ storage_binding: { connector_id: 'custom_thing' } }),
    null,
  );
});

// -------- Allowlist parity with shipped manifests --------
//
// These tests guard against drift between the in-code allowlist and the
// shipped JSON manifests: if a new polyfill / reference manifest is added
// (or removed) without updating `connector-key.js`, the test fails loudly
// rather than silently dropping the new connector to `null`.

function readShippedConnectorKeys(dir) {
  const keys = new Set();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const raw = readFileSync(join(dir, name), 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      continue;
    }
    const explicitKey = typeof manifest.connector_key === 'string' ? manifest.connector_key.trim() : '';
    if (explicitKey) {
      keys.add(explicitKey);
      continue;
    }
    const topLevel = typeof manifest.connector_id === 'string' ? manifest.connector_id.trim() : '';
    if (topLevel.startsWith(REGISTRY_PREFIX)) {
      let tail = topLevel.slice(REGISTRY_PREFIX.length);
      if (tail.endsWith('/')) tail = tail.slice(0, -1);
      if (tail && !tail.includes('/')) {
        keys.add(tail);
        continue;
      }
    }
    const nativeBinding = manifest?.storage_binding?.connector_id;
    if (typeof nativeBinding === 'string' && nativeBinding.trim()) {
      keys.add(nativeBinding.trim());
    }
  }
  return keys;
}

function readRegistryBackedManifests(dir) {
  const manifests = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const raw = readFileSync(join(dir, name), 'utf8');
    let manifest;
    try {
      manifest = JSON.parse(raw);
    } catch {
      continue;
    }
    const connectorId = typeof manifest.connector_id === 'string' ? manifest.connector_id.trim() : '';
    if (!connectorId.startsWith(REGISTRY_PREFIX)) continue;
    manifests.push({ name, manifest, connectorId });
  }
  return manifests;
}

test('registry-backed first-party manifests declare connector_key and manifest_uri', () => {
  for (const dir of [POLYFILL_MANIFESTS_DIR, REFERENCE_MANIFESTS_DIR]) {
    for (const { name, manifest, connectorId } of readRegistryBackedManifests(dir)) {
      const key = connectorKeyFromRegistryUrl(connectorId);
      assert.ok(key, `${name} must use a known first-party registry URI`);
      assert.equal(manifest.connector_key, key, `${name} must declare canonical connector_key`);
      assert.equal(manifest.manifest_uri, connectorId, `${name} must preserve registry URI as manifest_uri`);
    }
  }
});

test('allowlist covers every shipped polyfill-connectors manifest', () => {
  const shipped = readShippedConnectorKeys(POLYFILL_MANIFESTS_DIR);
  const known = new Set([...firstPartyConnectorKeys(), ...nativeConnectorKeys()]);
  const missing = [...shipped].filter((key) => !known.has(key)).sort();
  assert.deepEqual(
    missing,
    [],
    `polyfill manifests reference unknown canonical keys: ${missing.join(', ')}`,
  );
});

test('allowlist covers every shipped reference-implementation manifest', () => {
  const shipped = readShippedConnectorKeys(REFERENCE_MANIFESTS_DIR);
  const known = new Set([...firstPartyConnectorKeys(), ...nativeConnectorKeys()]);
  const missing = [...shipped].filter((key) => !known.has(key)).sort();
  assert.deepEqual(
    missing,
    [],
    `reference manifests reference unknown canonical keys: ${missing.join(', ')}`,
  );
});

test('isInternalConnectorId identifies test/stub/internal connector ids', () => {
  // All known internal marker substrings must match.
  assert.equal(isInternalConnectorId('manual_action_stub'), true);
  assert.equal(isInternalConnectorId('manual-action-stub'), true);
  assert.equal(isInternalConnectorId('stream-test-stub'), true);
  assert.equal(isInternalConnectorId('stream-test-stub-picker-regression'), true);
  assert.equal(isInternalConnectorId('pg_runtime_gmail'), true);
  assert.equal(isInternalConnectorId('pg_canonical_test'), true);
  assert.equal(isInternalConnectorId('pg_expand_records'), true);
  assert.equal(isInternalConnectorId('pg_lexical_backfill_1780426329141_34951'), true);
  // First-party and native canonical keys must NOT match.
  assert.equal(isInternalConnectorId('gmail'), false);
  assert.equal(isInternalConnectorId('spotify'), false);
  assert.equal(isInternalConnectorId('claude-code'), false);
  assert.equal(isInternalConnectorId('northstar_hr_native'), false);
  // Empty/non-string inputs must fail open (return false, not throw).
  assert.equal(isInternalConnectorId(null), false);
  assert.equal(isInternalConnectorId(undefined), false);
  assert.equal(isInternalConnectorId(''), false);
  assert.equal(isInternalConnectorId(42), false);
});
