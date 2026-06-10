/**
 * Operation-level tests for `rs.streams.list`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response is built from the dependency's stream summaries verbatim;
 *   - the source descriptor flows from the dependency to the output;
 *   - `query.received`-shaped data populates `query_shape: 'stream_list'`;
 *   - client actors propagate `stream_count_limit` for instrumentation;
 *   - owner actors do NOT introduce a `stream_count_limit` field.
 *
 * These tests serve as the regression baseline for the operation's
 * behavior. Host-mounted parity is covered by the existing `pdpp.test.js`
 * (native) and `apps/site/.../routes.test.ts` (sandbox) suites.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { executeStreamsList } from '../operations/rs-streams-list/index.ts';

test('rs.streams.list returns the dependency summaries unchanged', async () => {
  const summaries = [
    { object: 'stream', name: 'pay_statements', record_count: 3, last_updated: '2026-03-31T00:00:00Z' },
    { object: 'stream', name: 'equity_grants', record_count: 0, last_updated: null },
  ];
  const sourceDescriptor = { kind: 'connector', id: 'acme_payroll' };

  const result = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: 'subj_1' } },
    {
      listSummaries: () => Promise.resolve(summaries),
      getSourceDescriptor: () => sourceDescriptor,
    },
  );

  assert.deepEqual(result.streams, summaries);
  assert.deepEqual(result.sourceDescriptor, sourceDescriptor);
  assert.deepEqual(result.queryData, { query_shape: 'stream_list' });
});

test('rs.streams.list propagates client stream_count_limit to queryData', async () => {
  const result = await executeStreamsList(
    {
      actor: {
        kind: 'client',
        subject_id: 'subj_1',
        client_id: 'client_x',
        grant_id: 'grant_y',
        stream_count_limit: 2,
      },
    },
    {
      listSummaries: () => Promise.resolve([]),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'c' }),
    },
  );

  assert.equal(result.queryData.query_shape, 'stream_list');
  assert.equal(result.queryData.stream_count_limit, 2);
});

test('rs.streams.list owner queryData has no stream_count_limit key', async () => {
  const result = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: 's' } },
    {
      listSummaries: () => Promise.resolve([]),
      getSourceDescriptor: () => ({ kind: 'provider_native', id: 'p' }),
    },
  );

  assert.equal('stream_count_limit' in result.queryData, false);
});

test('rs.streams.list propagates a null stream_count_limit when grant.streams is absent', async () => {
  const result = await executeStreamsList(
    {
      actor: {
        kind: 'client',
        subject_id: 's',
        client_id: 'c',
        grant_id: 'g',
        stream_count_limit: null,
      },
    },
    {
      listSummaries: () => Promise.resolve([]),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'c' }),
    },
  );

  assert.equal(result.queryData.stream_count_limit, null);
});

test('rs.streams.list preserves connection identity fields populated by the host adapter', async () => {
  // Multi-connection deployments emit one summary per (stream, connection_id).
  // The operation does not invent or transform identity — it just preserves
  // whatever the host adapter's listSummaries() returns, so callers can
  // attribute and disambiguate. Owned by
  //   openspec/changes/expose-connection-identity-on-public-read.
  const summaries = [
    {
      object: 'stream',
      name: 'orders',
      record_count: 12,
      last_updated: '2026-05-01T12:00:00Z',
      connection_id: 'cin_aaa',
      display_name: 'peregrine Amazon',
      connector_instance_id: 'cin_aaa',
    },
    {
      object: 'stream',
      name: 'orders',
      record_count: 7,
      last_updated: '2026-05-22T08:00:00Z',
      connection_id: 'cin_bbb',
      display_name: 'vivid fish Amazon',
      connector_instance_id: 'cin_bbb',
    },
  ];

  const result = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: 'subj_1' } },
    {
      listSummaries: () => Promise.resolve(summaries),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'amazon' }),
    },
  );

  assert.deepEqual(result.streams, summaries);
  const labels = result.streams.map((entry) => entry.display_name);
  assert.deepEqual(labels, ['peregrine Amazon', 'vivid fish Amazon']);
  const placeholderPattern = /^legacy$|^default_account$|legacy \(pre-header\)/;
  for (const entry of result.streams) {
    assert.equal(
      placeholderPattern.test(entry.display_name),
      false,
      `display_name must not be a storage placeholder, got ${entry.display_name}`,
    );
  }
});

test('rs.streams.list supports owner-wide catalogs with no single source descriptor', async () => {
  const summaries = [
    {
      object: 'stream',
      name: 'attachments',
      record_count: 1,
      last_updated: '2026-05-31T00:00:00Z',
      connector_id: 'gmail',
      source: { kind: 'connector', id: 'gmail' },
    },
  ];

  const result = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: 'owner_1' } },
    {
      listSummaries: () => Promise.resolve(summaries),
      getSourceDescriptor: () => null,
    },
  );

  assert.equal(result.sourceDescriptor, null);
  assert.deepEqual(result.streams, summaries);
});

test('rs.streams.list accepts an optional connection_id input without altering passthrough semantics', async () => {
  // The operation does not enforce the filter — that lives in the host
  // adapter's `listSummaries` wiring. But the field MUST flow through
  // without breaking existing callers that omit it.
  const captured = { passes: 0 };
  const summaries = [
    {
      object: 'stream',
      name: 'orders',
      record_count: 3,
      last_updated: null,
      connection_id: 'cin_aaa',
      display_name: 'peregrine Amazon',
    },
  ];

  const omitted = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: 'subj_1' } },
    {
      listSummaries: () => {
        captured.passes += 1;
        return Promise.resolve(summaries);
      },
      getSourceDescriptor: () => ({ kind: 'connector', id: 'amazon' }),
    },
  );
  const filtered = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: 'subj_1' }, connection_id: 'cin_aaa' },
    {
      listSummaries: () => {
        captured.passes += 1;
        return Promise.resolve(summaries);
      },
      getSourceDescriptor: () => ({ kind: 'connector', id: 'amazon' }),
    },
  );

  assert.equal(captured.passes, 2);
  assert.deepEqual(omitted.streams, summaries);
  assert.deepEqual(filtered.streams, summaries);
});

test('rs.streams.list awaits dependency promises', async () => {
  let resolved = false;
  const result = await executeStreamsList(
    { actor: { kind: 'owner', subject_id: null } },
    {
      listSummaries: () =>
        new Promise((r) =>
          setImmediate(() => {
            resolved = true;
            r([]);
          }),
        ),
      getSourceDescriptor: () => ({ kind: 'connector', id: 'x' }),
    },
  );

  assert.equal(resolved, true);
  assert.deepEqual(result.streams, []);
});
