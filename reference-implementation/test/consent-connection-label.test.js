/**
 * Source-level invariant test for the public consent surface's connection
 * labels.
 *
 * Closes the render-test gap tracked in
 *   openspec/changes/expose-connection-identity-on-public-read (Sections 5 + 8)
 * by executing the pure label mapper that builds `ConsentCardConnection[]`
 * props before the consent card renders. The mapper lives in the public-site
 * app (`apps/site/src/lib/consent-connection-label.ts`); this suite lives in
 * `reference-implementation/test/**` because that is the only test tree the
 * standard suites discover (`reference-implementation/scripts/run-tests.js`)
 * and the reference-implementation CI workflow already triggers on
 * `apps/site/**`. Node strips the TS types and executes the module directly,
 * so this is a behavioral test of the mapper, not a string match.
 *
 * The gated invariant: the consent card SHALL NOT render a storage placeholder
 * (`legacy`, `default_account`, `legacy (pre-header)`), a connector registry
 * URL, a `local-device:` binding, or the bare `connection_id`. When the owner
 * has not named a connection, the label SHALL be an owner-meaningful
 * `<Connector> · account N`. Owner-set names SHALL be preserved verbatim.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildConsentCardConnections,
  deriveConnectionDisplayName,
  formatConnectorName,
  isPlaceholderConnectionLabel,
} from '../../apps/site/src/lib/consent-connection-label.ts';

// A placeholder / URL / device-binding label MUST be rejected as not
// owner-meaningful, mirroring the operator console's `isFallbackConnectionLabel`
// rule so both split surfaces share one definition of "needs a real name".
test('isPlaceholderConnectionLabel rejects absent, placeholder, URL, and bare-type labels', () => {
  assert.equal(isPlaceholderConnectionLabel('gmail', null), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', ''), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', '   '), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', 'legacy'), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', 'default_account'), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', 'legacy (pre-header)'), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', 'https://registry.pdpp.org/connectors/gmail'), true);
  assert.equal(isPlaceholderConnectionLabel('claude_code', 'local-device:laptop:claude_code'), true);
  // Bare connector type, any casing, carries no per-connection meaning.
  assert.equal(isPlaceholderConnectionLabel('gmail', 'gmail'), true);
  assert.equal(isPlaceholderConnectionLabel('gmail', 'Gmail'), true);
  assert.equal(isPlaceholderConnectionLabel('claude_code', 'Claude Code'), true);
});

test('isPlaceholderConnectionLabel accepts owner-meaningful labels', () => {
  assert.equal(isPlaceholderConnectionLabel('gmail', 'Personal Gmail'), false);
  assert.equal(isPlaceholderConnectionLabel('amazon', 'Shared Amazon'), false);
  assert.equal(isPlaceholderConnectionLabel('claude_code', 'peregrine Claude Code'), false);
});

test('formatConnectorName humanizes the connector key', () => {
  assert.equal(formatConnectorName('gmail'), 'Gmail');
  assert.equal(formatConnectorName('claude_code'), 'Claude Code');
  assert.equal(formatConnectorName('amazon'), 'Amazon');
  assert.equal(formatConnectorName(''), 'Connection');
});

test('deriveConnectionDisplayName preserves owner-set names verbatim', () => {
  assert.equal(
    deriveConnectionDisplayName({ connector: 'gmail', displayName: 'Personal Gmail', ordinal: 1, groupSize: 2 }),
    'Personal Gmail',
  );
});

test('deriveConnectionDisplayName mints <Connector> · account N for never-renamed connections in a group', () => {
  assert.equal(
    deriveConnectionDisplayName({ connector: 'gmail', displayName: null, ordinal: 2, groupSize: 2 }),
    'Gmail · account 2',
  );
  assert.equal(
    deriveConnectionDisplayName({ connector: 'gmail', displayName: 'legacy', ordinal: 1, groupSize: 3 }),
    'Gmail · account 1',
  );
});

test('deriveConnectionDisplayName omits the disambiguator for a lone connection', () => {
  assert.equal(
    deriveConnectionDisplayName({ connector: 'gmail', displayName: null, ordinal: 1, groupSize: 1 }),
    'Gmail',
  );
  // …but a real owner label on a lone connection is still preserved.
  assert.equal(
    deriveConnectionDisplayName({ connector: 'gmail', displayName: 'Personal Gmail', ordinal: 1, groupSize: 1 }),
    'Personal Gmail',
  );
});

test('buildConsentCardConnections derives a label per connection and carries the stable id', () => {
  const connections = buildConsentCardConnections('gmail', [
    { connectionId: 'cin_personal', displayName: 'Personal Gmail' },
    { connectionId: 'cin_work', displayName: 'https://registry.pdpp.org/connectors/gmail' },
  ]);

  assert.deepEqual(connections, [
    { id: 'cin_personal', displayName: 'Personal Gmail' },
    { id: 'cin_work', displayName: 'Gmail · account 2' },
  ]);
});

// The load-bearing invariant: whatever the storage layer carried, NO rendered
// label is a placeholder, a URL, a device binding, or the raw connection_id.
test('buildConsentCardConnections never renders a placeholder, URL, or connection_id as the label', () => {
  const raw = [
    { connectionId: 'cin_aaa', displayName: 'legacy' },
    { connectionId: 'cin_bbb', displayName: 'default_account' },
    { connectionId: 'cin_ccc', displayName: 'legacy (pre-header)' },
    { connectionId: 'cin_ddd', displayName: 'https://registry.pdpp.org/connectors/gmail' },
    { connectionId: 'cin_eee', displayName: 'local-device:laptop:gmail' },
    { connectionId: 'cin_fff', displayName: null },
    { connectionId: 'cin_ggg', displayName: 'gmail' },
    { connectionId: 'cin_hhh', displayName: 'Personal Gmail' },
  ];
  const connections = buildConsentCardConnections('gmail', raw);

  const placeholderPattern = /^legacy$|^default_account$|legacy \(pre-header\)|registry\.pdpp\.org|^local-device:/;
  for (const [index, connection] of connections.entries()) {
    assert.equal(
      placeholderPattern.test(connection.displayName),
      false,
      `rendered label must not be a storage placeholder/URL, got "${connection.displayName}"`,
    );
    // The opaque connection_id is a stable selector, never the human label.
    assert.notEqual(
      connection.displayName,
      raw[index].connectionId,
      'connection_id must not be rendered as the label',
    );
    assert.equal(connection.id, raw[index].connectionId, 'stable id is preserved for telemetry/dedupe');
    assert.ok(connection.displayName.trim().length > 0, 'every connection has a non-empty label');
  }

  // The one owner-set label is preserved exactly; the rest fall back to the
  // owner-meaningful `Gmail · account N` form.
  assert.equal(connections.at(-1).displayName, 'Personal Gmail');
  assert.ok(connections.slice(0, -1).every((c) => /^Gmail · account \d+$/.test(c.displayName)));
});
