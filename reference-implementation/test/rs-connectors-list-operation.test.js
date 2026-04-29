/**
 * Operation-level behavior tests for `rs.connectors.list`.
 *
 * Pins the envelope discriminator, dependency-order preservation, the
 * `connector_list` query-shape data block, and the disclosure totals
 * (`connector_count`, `stream_count`) computed from the items. Host-mounted
 * parity (Fastify route emitting equivalent events) is covered by the
 * existing route/contract tests.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeConnectorsList } from '../operations/rs-connectors-list/index.ts';

function makeItem(connectorId, overrides = {}) {
  return {
    object: 'connector',
    source: { binding_kind: 'connector', connector_id: connectorId },
    stream_count: 0,
    streams: [],
    connector_id: connectorId,
    ...overrides,
  };
}

test('rs.connectors.list wraps dependency output in {object: list, data}', async () => {
  const items = [makeItem('a'), makeItem('b')];
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => items,
    },
  );
  assert.equal(result.envelope.object, 'list');
  assert.deepEqual(result.envelope.data, items);
});

test('rs.connectors.list preserves dependency order without sorting', async () => {
  const items = [makeItem('z'), makeItem('a'), makeItem('m')];
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => items,
    },
  );
  assert.deepEqual(
    result.envelope.data.map((item) => item.connector_id),
    ['z', 'a', 'm'],
  );
});

test('rs.connectors.list does not mutate the dependency array', async () => {
  const items = [makeItem('a'), makeItem('b')];
  const snapshot = items.slice();
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => items,
    },
  );
  assert.deepEqual(items, snapshot);
  assert.notStrictEqual(result.envelope.data, items);
});

test('rs.connectors.list emits the connector_list query-shape data block', async () => {
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => [],
    },
  );
  assert.deepEqual(result.queryData, { query_shape: 'connector_list' });
});

test('rs.connectors.list computes connector_count and stream_count totals', async () => {
  const items = [
    makeItem('a', { stream_count: 2 }),
    makeItem('b', { stream_count: 5 }),
    makeItem('c', { stream_count: 0 }),
  ];
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => items,
    },
  );
  assert.equal(result.disclosureTotals.connector_count, 3);
  assert.equal(result.disclosureTotals.stream_count, 7);
});

test('rs.connectors.list propagates the dependency source descriptor', async () => {
  const source = { binding_kind: 'provider_native', provider_id: 'native_provider' };
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => source,
      listConnectorItems: () => [],
    },
  );
  assert.deepEqual(result.sourceDescriptor, source);
});

test('rs.connectors.list propagates a null source descriptor verbatim', async () => {
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => [],
    },
  );
  assert.equal(result.sourceDescriptor, null);
});

test('rs.connectors.list awaits dependency promises', async () => {
  let resolved = false;
  const result = await executeConnectorsList(
    { actor: { kind: 'client', subject_id: 's', client_id: 'c', grant_id: 'g' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve([makeItem('async', { stream_count: 4 })]);
          }),
        ),
    },
  );
  assert.equal(resolved, true);
  assert.equal(result.envelope.data.length, 1);
  assert.equal(result.disclosureTotals.stream_count, 4);
});

test('rs.connectors.list yields zeroed totals when dependency returns empty', async () => {
  const result = await executeConnectorsList(
    { actor: { kind: 'owner', subject_id: 'sub_1' } },
    {
      getSourceDescriptor: () => null,
      listConnectorItems: () => [],
    },
  );
  assert.deepEqual(result.envelope, { object: 'list', data: [] });
  assert.equal(result.disclosureTotals.connector_count, 0);
  assert.equal(result.disclosureTotals.stream_count, 0);
});
