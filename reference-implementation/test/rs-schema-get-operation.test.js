/**
 * Operation-level tests for `rs.schema.get`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response is built from the dependency's connector items verbatim;
 *   - bearer projection is operation-owned and varies by actor kind;
 *   - the source descriptor flows from the dependency to the output (and
 *     `null` is preserved verbatim — this matches the historical native
 *     behavior for the owner-with-multiple-registered-connectors branch);
 *   - `query.received`-shaped data is `query_shape: 'schema'`;
 *   - aggregate counts (`connector_count`, `stream_count`) are derived
 *     from the dependency's connector items.
 *
 * These tests are the regression baseline for the operation's behavior.
 * Host-mounted parity is covered by `query-contract.test.js` (native) and
 * the sandbox `_demo/routes.test.ts` suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSchemaGet } from '../operations/rs-schema-get/index.ts';

const ownerActor = { kind: 'owner', subject_id: 'subj_1' };
const clientActor = {
  kind: 'client',
  subject_id: 'subj_1',
  client_id: 'client_x',
  grant_id: 'grant_y',
};

function makeConnectorItem(connectorId, streamCount) {
  const streams = [];
  for (let i = 0; i < streamCount; i += 1) {
    streams.push({ object: 'stream_metadata', name: `${connectorId}_stream_${i}` });
  }
  return {
    object: 'connector',
    source: { kind: 'connector', id: connectorId },
    connector_id: connectorId,
    stream_count: streams.length,
    streams,
  };
}

test('rs.schema.get returns the dependency connector items verbatim under owner', async () => {
  const items = [makeConnectorItem('acme_payroll', 2), makeConnectorItem('quill_health', 1)];
  const sourceDescriptor = { kind: 'provider_native', id: 'pdpp.local' };

  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      listConnectorItems: () => Promise.resolve(items),
      getSourceDescriptor: () => sourceDescriptor,
    },
  );

  assert.equal(result.response.object, 'schema');
  assert.deepEqual(result.response.bearer, { token_kind: 'owner', scope: 'owner' });
  assert.equal(result.response.connectors, items, 'connector items pass through verbatim');
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, { query_shape: 'schema' });
  assert.deepEqual(result.counts, { connector_count: 2, stream_count: 3 });
});

test('rs.schema.get projects client bearer with grant_id and client_id when present', async () => {
  const result = await executeSchemaGet(
    { actor: clientActor },
    {
      listConnectorItems: () => Promise.resolve([makeConnectorItem('acme_payroll', 1)]),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'acme_payroll' }),
    },
  );

  assert.deepEqual(result.response.bearer, {
    token_kind: 'client',
    scope: 'grant',
    grant_id: 'grant_y',
    client_id: 'client_x',
  });
});

test('rs.schema.get omits grant_id/client_id from client bearer when null', async () => {
  const result = await executeSchemaGet(
    {
      actor: {
        kind: 'client',
        subject_id: null,
        client_id: null,
        grant_id: null,
      },
    },
    {
      listConnectorItems: () => Promise.resolve([]),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'acme_payroll' }),
    },
  );

  assert.deepEqual(result.response.bearer, { token_kind: 'client', scope: 'grant' });
  assert.equal('grant_id' in result.response.bearer, false);
  assert.equal('client_id' in result.response.bearer, false);
});

test('rs.schema.get propagates a null source descriptor verbatim (multi-connector owner branch)', async () => {
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      listConnectorItems: () =>
        Promise.resolve([makeConnectorItem('a', 1), makeConnectorItem('b', 0)]),
      getSourceDescriptor: () => null,
    },
  );

  assert.equal(result.sourceDescriptor, null);
  assert.deepEqual(result.counts, { connector_count: 2, stream_count: 1 });
});

test('rs.schema.get returns empty connector array unchanged', async () => {
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      listConnectorItems: () => Promise.resolve([]),
      getSourceDescriptor: () => null,
    },
  );

  assert.deepEqual(result.response.connectors, []);
  assert.deepEqual(result.counts, { connector_count: 0, stream_count: 0 });
});

test('rs.schema.get awaits async dependency promises', async () => {
  let resolved = false;
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      listConnectorItems: () =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r([makeConnectorItem('c', 1)]);
          }),
        ),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'c' }),
    },
  );

  assert.equal(resolved, true);
  assert.equal(result.response.connectors.length, 1);
});

test('rs.schema.get derives stream_count from connector items, not from the response shape', async () => {
  // The aggregate stream_count must follow `stream_count` on each connector
  // item rather than `streams.length`. The two are equal in the natural
  // case, but the operation contract relies on `stream_count` because the
  // native item builder may project a `streams` array that excludes
  // ungranted streams while keeping `stream_count` honest.
  const result = await executeSchemaGet(
    { actor: ownerActor },
    {
      listConnectorItems: () =>
        Promise.resolve([
          {
            object: 'connector',
            source: { kind: 'connector', id: 'x' },
            connector_id: 'x',
            stream_count: 5,
            streams: [], // intentionally inconsistent: count is the source of truth
          },
        ]),
      getSourceDescriptor: () => null,
    },
  );

  assert.equal(result.counts.stream_count, 5);
});
