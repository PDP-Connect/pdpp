/**
 * Unit coverage for the UNTESTED connector-key normalization + catalog
 * classification helpers in `server/connection-setup-plan.ts`. These shape how
 * the reference resolves a connector's canonical key from a manifest/registry
 * id and gate proven-lifecycle / supported-collector / browser-bound behavior.
 * None were covered by name (only `canonicalConnectorKey` was used incidentally
 * by other tests, never asserted directly).
 *
 * Contracts pinned:
 *   - canonicalConnectorKey: trims, and strips the
 *     `https://registry.pdpp.org/connectors/<key>/` first-party registry prefix
 *     (and a trailing slash) down to the bare key.
 *   - connectorKeyFromManifest: connector_key → connector_id → explicit fallback
 *     → null; canonicalized; blanks skipped.
 *   - enrollmentKeyForCanonicalKey: identity except `claude-code` → `claude_code`.
 *   - displayNameForConnector: manifest.display_name → manifest.name → the key.
 *   - isProviderAuthLifecycleProven / isStaticSecretLiveProven: allowlist
 *     membership over the CANONICAL key (so a registry-URL id still matches).
 *   - isSupportedLocalCollectorConnector: membership over the ENROLLMENT key
 *     (so `claude-code` matches `claude_code`); non-string => false.
 *   - isSupportedBrowserCollectorConnector / isBrowserBoundConnector: membership
 *     over the canonical key; non-string => false.
 *
 * Pure classification over frozen allowlists — no DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalConnectorKey,
  connectorKeyFromManifest,
  enrollmentKeyForCanonicalKey,
  displayNameForConnector,
  isProviderAuthLifecycleProven,
  isStaticSecretLiveProven,
  isSupportedLocalCollectorConnector,
  isSupportedBrowserCollectorConnector,
  isBrowserBoundConnector,
} from '../server/connection-setup-plan.ts';

// --- canonicalConnectorKey --------------------------------------------------

test('canonicalConnectorKey: trims and strips the first-party registry prefix + trailing slash', () => {
  assert.equal(canonicalConnectorKey('gmail'), 'gmail', 'bare key unchanged');
  assert.equal(canonicalConnectorKey('  gmail  '), 'gmail', 'trims surrounding whitespace');
  assert.equal(
    canonicalConnectorKey('https://registry.pdpp.org/connectors/gmail'),
    'gmail',
    'strips registry prefix',
  );
  assert.equal(
    canonicalConnectorKey('  https://registry.pdpp.org/connectors/github/  '),
    'github',
    'strips prefix + trailing slash after trimming',
  );
  assert.equal(
    canonicalConnectorKey('https://example.com/other/thing'),
    'https://example.com/other/thing',
    'non-first-party url is left intact',
  );
});

// --- connectorKeyFromManifest -----------------------------------------------

test('connectorKeyFromManifest: prefers connector_key, canonicalized', () => {
  assert.equal(connectorKeyFromManifest({ connector_key: '  gmail  ', connector_id: 'other' }), 'gmail');
  assert.equal(
    connectorKeyFromManifest({ connector_key: 'https://registry.pdpp.org/connectors/slack' }),
    'slack',
    'connector_key is canonicalized',
  );
});

test('connectorKeyFromManifest: falls back connector_id -> explicit fallback -> null', () => {
  assert.equal(connectorKeyFromManifest({ connector_id: 'github' }), 'github', 'uses connector_id');
  assert.equal(connectorKeyFromManifest({ connector_key: '   ' }, 'slack'), 'slack', 'blank key => fallback arg');
  assert.equal(connectorKeyFromManifest({}), null, 'nothing => null');
  assert.equal(connectorKeyFromManifest({}, null), null, 'null fallback => null');
});

// --- enrollmentKeyForCanonicalKey -------------------------------------------

test('enrollmentKeyForCanonicalKey: maps claude-code to claude_code, else identity', () => {
  assert.equal(enrollmentKeyForCanonicalKey('claude-code'), 'claude_code', 'the one special case');
  assert.equal(
    enrollmentKeyForCanonicalKey('https://registry.pdpp.org/connectors/claude-code'),
    'claude_code',
    'canonicalizes first, then maps',
  );
  assert.equal(enrollmentKeyForCanonicalKey('codex'), 'codex', 'other keys unchanged');
  assert.equal(enrollmentKeyForCanonicalKey('gmail'), 'gmail');
});

// --- displayNameForConnector ------------------------------------------------

test('displayNameForConnector: display_name -> name -> the key', () => {
  assert.equal(displayNameForConnector('gmail', { display_name: 'Gmail Mail', name: 'GM' }), 'Gmail Mail');
  assert.equal(displayNameForConnector('gmail', { name: 'GM' }), 'GM', 'falls back to name');
  assert.equal(displayNameForConnector('gmail', { display_name: '   ' }), 'gmail', 'blank display_name => key');
  assert.equal(displayNameForConnector('gmail', null), 'gmail', 'no manifest => key');
});

// --- isProviderAuthLifecycleProven ------------------------------------------

test('isProviderAuthLifecycleProven: allowlist membership over the canonical key', () => {
  assert.equal(isProviderAuthLifecycleProven('test_provider'), true, 'allowlisted');
  assert.equal(
    isProviderAuthLifecycleProven('https://registry.pdpp.org/connectors/test_provider'),
    true,
    'registry-url id still matches via canonicalization',
  );
  assert.equal(isProviderAuthLifecycleProven('gmail'), false, 'gmail is not lifecycle-proven');
});

// --- isStaticSecretLiveProven -----------------------------------------------

test('isStaticSecretLiveProven: gmail/github/slack proven; others not', () => {
  assert.equal(isStaticSecretLiveProven('gmail'), true);
  assert.equal(isStaticSecretLiveProven('github'), true);
  assert.equal(isStaticSecretLiveProven('slack'), true);
  assert.equal(isStaticSecretLiveProven('amazon'), false, 'amazon is not static-secret-proven');
  assert.equal(
    isStaticSecretLiveProven('  github  '),
    true,
    'canonicalization trims before the membership check',
  );
});

// --- isSupportedLocalCollectorConnector -------------------------------------

test('isSupportedLocalCollectorConnector: membership over the ENROLLMENT key', () => {
  assert.equal(isSupportedLocalCollectorConnector('claude_code'), true, 'direct enrollment key');
  // The canonical key `claude-code` maps to the enrollment key `claude_code`,
  // so the hyphenated form must ALSO be recognized.
  assert.equal(isSupportedLocalCollectorConnector('claude-code'), true, 'hyphenated form via enrollment mapping');
  assert.equal(isSupportedLocalCollectorConnector('codex'), true);
  assert.equal(isSupportedLocalCollectorConnector('amazon'), false, 'browser connector is not a local collector');
  assert.equal(isSupportedLocalCollectorConnector(null), false, 'null => false');
  assert.equal(isSupportedLocalCollectorConnector(undefined), false, 'undefined => false');
});

// --- isSupportedBrowserCollectorConnector -----------------------------------

test('isSupportedBrowserCollectorConnector: amazon only; canonical-key based', () => {
  assert.equal(isSupportedBrowserCollectorConnector('amazon'), true);
  assert.equal(
    isSupportedBrowserCollectorConnector('https://registry.pdpp.org/connectors/amazon'),
    true,
    'registry-url id matches',
  );
  assert.equal(isSupportedBrowserCollectorConnector('claude_code'), false, 'local collector is not browser');
  assert.equal(isSupportedBrowserCollectorConnector(null), false);
});

// --- isBrowserBoundConnector ------------------------------------------------

test('isBrowserBoundConnector: recognizes the browser-bound allowlist, rejects others', () => {
  for (const key of ['amazon', 'chase', 'chatgpt', 'reddit', 'usaa']) {
    assert.equal(isBrowserBoundConnector(key), true, `${key} is browser-bound`);
  }
  assert.equal(isBrowserBoundConnector('gmail'), false, 'gmail (static-secret) is not browser-bound');
  assert.equal(isBrowserBoundConnector('codex'), false, 'codex (local) is not browser-bound');
  assert.equal(isBrowserBoundConnector(null), false, 'null => false');
  assert.equal(
    isBrowserBoundConnector('https://registry.pdpp.org/connectors/chatgpt'),
    true,
    'registry-url id matches via canonicalization',
  );
});
