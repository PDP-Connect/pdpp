/**
 * Operation-level behavior tests for `ref.connectors.list`.
 *
 * Pins the envelope discriminator, that the operation passes through the
 * dependency's order without re-sorting, and that the operation does not
 * mutate the dependency's array.
 *
 * Host-mounted parity (Fastify route returning the same envelope) is
 * covered by the existing connector/control-plane tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefConnectorsList } from '../operations/ref-connectors-list/index.ts';
import { isPublicReferenceConnector } from '../server/ref-control.ts';

function makeItem(connectorId, overrides = {}) {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    manifest_version: '1.0.0',
    streams: [],
    total_records: 0,
    freshness: { status: 'unknown' },
    refresh_policy: null,
    schedule: null,
    last_run: null,
    last_successful_run: null,
    ...overrides,
  };
}

test('ref.connectors.list wraps dependency output in {object: list, data}', async () => {
  const items = [makeItem('a'), makeItem('b')];
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => items,
  });
  assert.equal(envelope.object, 'list');
  assert.deepEqual(envelope.data, items);
});

test('ref.connectors.list preserves dependency order', async () => {
  const items = [makeItem('z'), makeItem('a'), makeItem('m')];
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => items,
  });
  assert.deepEqual(
    envelope.data.map((item) => item.connector_id),
    ['z', 'a', 'm'],
  );
});

test('ref.connectors.list does not mutate the dependency array', async () => {
  const items = [makeItem('a'), makeItem('b')];
  const snapshot = items.slice();
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => items,
  });
  assert.deepEqual(items, snapshot);
  assert.notStrictEqual(envelope.data, items);
});

test('ref.connectors.list awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () =>
      new Promise((resolve) =>
        setImmediate(() => {
          resolved = true;
          resolve([makeItem('async')]);
        }),
      ),
  });
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
});

test('ref.connectors.list yields empty envelope when dependency returns empty', async () => {
  const envelope = await executeRefConnectorsList({
    listConnectorSummaries: () => [],
  });
  assert.deepEqual(envelope, { object: 'list', data: [] });
});

test('reference connector catalog hides manifest opt-outs', () => {
  assert.equal(
    isPublicReferenceConnector(
      { connector_id: 'https://registry.pdpp.org/connectors/spotify', manifest: '{}' },
      {
        connector_id: 'https://registry.pdpp.org/connectors/spotify',
        capabilities: {
          public_listing: {
            listed: false,
            status: 'unproven',
          },
        },
      },
    ),
    false,
  );
});

test('reference connector catalog hides stub and stream-test connector registrations', () => {
  for (const connectorId of [
    'manual_action_stub',
    'https://registry.pdpp.org/connectors/manual-action-stub',
    'https://registry.pdpp.org/connectors/stream-test-stub',
  ]) {
    assert.equal(
      isPublicReferenceConnector({ connector_id: connectorId, manifest: '{}' }, { connector_id: connectorId }),
      false,
      `${connectorId} must not appear in the user-facing reference connector catalog`,
    );
  }
});
