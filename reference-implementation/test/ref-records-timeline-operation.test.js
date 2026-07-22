// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level behavior tests for `ref.records.timeline`.
 *
 * Pins:
 *   - the `{object: 'list', data, meta}` envelope shape;
 *   - input normalization (limit clamp/default, order/timestamp_mode
 *     defaults, null-by-default filters, blank-string -> null);
 *   - that the operation slices `data` to the effective limit and
 *     leaves the dependency's pre-clip ordering untouched;
 *   - that the operation passes the normalized input through to the
 *     `collectEntries` capability so a future substrate change does not
 *     have to also re-shape the operation contract.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { executeRefRecordsTimeline } from '../operations/ref-records-timeline/index.ts';

function entry(overrides = {}) {
  return {
    object: 'timeline_entry',
    connector_id: 'demo',
    stream: 'tracks',
    id: 'rec_1',
    emitted_at: '2026-04-01T00:00:00Z',
    version: 1,
    data: {},
    semantic_timestamp: null,
    display_timestamp: '2026-04-01T00:00:00Z',
    ...overrides,
  };
}

test('ref.records.timeline emits the {list, data, meta} envelope with defaults applied', async () => {
  let capturedInput = null;
  const envelope = await executeRefRecordsTimeline(
    {},
    {
      collectEntries: (input) => {
        capturedInput = input;
        return [];
      },
    },
  );
  assert.equal(envelope.object, 'list');
  assert.deepEqual(envelope.data, []);
  assert.deepEqual(envelope.meta, {
    bounded: true,
    ordering: 'semantic_or_emitted desc',
    limit: 50,
    timestamp_mode: 'native',
    filters: { connector_id: null, stream: null, since: null, until: null },
  });
  assert.deepEqual(capturedInput, {
    connectorId: null,
    stream: null,
    since: null,
    until: null,
    limit: 50,
    order: 'desc',
    timestampMode: 'native',
  });
});

test('ref.records.timeline normalizes order/timestampMode to the allowed enum values', async () => {
  const envelope = await executeRefRecordsTimeline(
    { order: 'asc', timestampMode: 'emitted' },
    { collectEntries: () => [] },
  );
  assert.equal(envelope.meta.ordering, 'semantic_or_emitted asc');
  assert.equal(envelope.meta.timestamp_mode, 'emitted');
});

test('ref.records.timeline coerces unknown order/timestamp_mode to defaults (desc, native)', async () => {
  const envelope = await executeRefRecordsTimeline(
    { order: 'sideways', timestampMode: 'ingest' },
    { collectEntries: () => [] },
  );
  assert.equal(envelope.meta.ordering, 'semantic_or_emitted desc');
  assert.equal(envelope.meta.timestamp_mode, 'native');
});

test('ref.records.timeline trims string filters and treats blanks as null', async () => {
  let captured = null;
  const envelope = await executeRefRecordsTimeline(
    { connectorId: '  spotify ', stream: '   ', since: '', until: '2026-04-30' },
    {
      collectEntries: (input) => {
        captured = input;
        return [];
      },
    },
  );
  assert.equal(envelope.meta.filters.connector_id, 'spotify');
  assert.equal(envelope.meta.filters.stream, null);
  assert.equal(envelope.meta.filters.since, null);
  assert.equal(envelope.meta.filters.until, '2026-04-30');
  assert.deepEqual(captured.connectorId, 'spotify');
  assert.equal(captured.stream, null);
});

test('ref.records.timeline clamps non-positive or non-finite limit to the default of 50', async () => {
  for (const raw of [0, -1, NaN, Infinity, null, undefined]) {
    const envelope = await executeRefRecordsTimeline(
      { limit: raw },
      { collectEntries: () => [] },
    );
    assert.equal(envelope.meta.limit, 50, `raw=${raw}`);
  }
});

test('ref.records.timeline floors fractional positive limits', async () => {
  const envelope = await executeRefRecordsTimeline(
    { limit: 7.9 },
    { collectEntries: () => [] },
  );
  assert.equal(envelope.meta.limit, 7);
});

test('ref.records.timeline slices data to the effective limit but preserves pre-clip ordering', async () => {
  const entries = [
    entry({ id: 'rec_a' }),
    entry({ id: 'rec_b' }),
    entry({ id: 'rec_c' }),
    entry({ id: 'rec_d' }),
  ];
  const envelope = await executeRefRecordsTimeline(
    { limit: 2 },
    { collectEntries: () => entries },
  );
  assert.equal(envelope.data.length, 2);
  assert.equal(envelope.data[0].id, 'rec_a');
  assert.equal(envelope.data[1].id, 'rec_b');
});

test('ref.records.timeline does not mutate the dependency entries array', async () => {
  const entries = [entry({ id: 'rec_a' }), entry({ id: 'rec_b' })];
  const snapshot = entries.slice();
  const envelope = await executeRefRecordsTimeline(
    { limit: 1 },
    { collectEntries: () => entries },
  );
  assert.notStrictEqual(envelope.data, entries);
  assert.deepEqual(entries, snapshot);
});

test('ref.records.timeline awaits dependency promises', async () => {
  let resolved = false;
  const envelope = await executeRefRecordsTimeline(
    { limit: 5 },
    {
      collectEntries: () =>
        new Promise((resolve) =>
          setImmediate(() => {
            resolved = true;
            resolve([entry({ id: 'rec_async' })]);
          }),
        ),
    },
  );
  assert.equal(resolved, true);
  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].id, 'rec_async');
});
