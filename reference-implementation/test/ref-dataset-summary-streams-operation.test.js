// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `ref.dataset.summary.streams`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that:
 *   - the response envelope carries `object: 'dataset_summary_streams'`
 *     and every per-row field;
 *   - the `connector_id` filter is trimmed and treated as `null` when
 *     empty, then forwarded to the host's `listStreams` call;
 *   - NULL record-time bounds are surfaced as `null` rather than being
 *     zero-filled;
 *   - `dirty_record_time_bounds` is coerced to a boolean;
 *   - dependencies may return promises (operation awaits them);
 *   - the operation module obeys the shared operation-boundary rule
 *     (no Fastify, raw DB, sandbox, or `process.env` imports).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { executeRefDatasetSummaryStreams } from '../operations/ref-dataset-summary-streams/index.ts';
import { assertOperationBoundary } from './helpers/operation-boundary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf8');
}

function baselineRow(overrides = {}) {
  return {
    connector_id: 'gmail',
    stream: 'messages',
    record_count: 3,
    record_json_bytes: 120,
    earliest_ingested_at: '2026-01-01T00:00:00.000Z',
    latest_ingested_at: '2026-05-01T00:00:00.000Z',
    earliest_record_time: '2025-12-01T00:00:00.000Z',
    latest_record_time: '2026-04-30T00:00:00.000Z',
    consent_time_field: 'created_at',
    dirty_record_time_bounds: false,
    computed_at: '2026-05-19T12:00:00.000Z',
    ...overrides,
  };
}

function baselineMetadata(overrides = {}) {
  return {
    computed_at: '2026-05-19T12:00:00.000Z',
    state: 'fresh',
    stale_since: null,
    rebuild_status: 'idle',
    last_error: null,
    source_high_watermark: 'rebuilt:42',
    ...overrides,
  };
}

test('ref.dataset.summary.streams returns the dataset_summary_streams envelope with every per-row field', async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      listStreams: () => [baselineRow()],
      getProjectionMetadata: () => baselineMetadata(),
    },
  );

  assert.equal(envelope.object, 'dataset_summary_streams');
  assert.equal(envelope.filters.connector_id, null);
  assert.equal(envelope.streams.length, 1);
  const [row] = envelope.streams;
  assert.equal(row.connector_id, 'gmail');
  assert.equal(row.stream, 'messages');
  assert.equal(row.record_count, 3);
  assert.equal(row.record_json_bytes, 120);
  assert.equal(row.earliest_ingested_at, '2026-01-01T00:00:00.000Z');
  assert.equal(row.latest_ingested_at, '2026-05-01T00:00:00.000Z');
  assert.equal(row.earliest_record_time, '2025-12-01T00:00:00.000Z');
  assert.equal(row.latest_record_time, '2026-04-30T00:00:00.000Z');
  assert.equal(row.consent_time_field, 'created_at');
  assert.equal(row.dirty_record_time_bounds, false);
  assert.equal(row.computed_at, '2026-05-19T12:00:00.000Z');
  assert.deepEqual(envelope.projection, baselineMetadata());
});

test('ref.dataset.summary.streams forwards a trimmed connector_id filter to listStreams', async () => {
  let received = null;
  await executeRefDatasetSummaryStreams(
    { connector_id: '  gmail  ' },
    {
      listStreams: (input) => {
        received = input;
        return [];
      },
      getProjectionMetadata: () => baselineMetadata(),
    },
  );

  assert.deepEqual(received, { connectorId: 'gmail' });
});

test('ref.dataset.summary.streams treats an empty connector_id as null', async () => {
  let received = null;
  const envelope = await executeRefDatasetSummaryStreams(
    { connector_id: '   ' },
    {
      listStreams: (input) => {
        received = input;
        return [];
      },
      getProjectionMetadata: () => baselineMetadata(),
    },
  );

  assert.deepEqual(received, { connectorId: null });
  assert.equal(envelope.filters.connector_id, null);
  assert.deepEqual(envelope.streams, []);
});

test('ref.dataset.summary.streams surfaces NULL record-time bounds as null rather than zero-filling', async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      listStreams: () => [
        baselineRow({
          earliest_record_time: null,
          latest_record_time: null,
          consent_time_field: null,
        }),
        baselineRow({
          stream: 'threads',
          earliest_record_time: '',
          latest_record_time: undefined,
        }),
      ],
      getProjectionMetadata: () => baselineMetadata(),
    },
  );

  assert.equal(envelope.streams[0].earliest_record_time, null);
  assert.equal(envelope.streams[0].latest_record_time, null);
  assert.equal(envelope.streams[0].consent_time_field, null);
  assert.equal(envelope.streams[1].earliest_record_time, null);
  assert.equal(envelope.streams[1].latest_record_time, null);
});

test('ref.dataset.summary.streams coerces dirty_record_time_bounds to a boolean', async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      listStreams: () => [
        baselineRow({ dirty_record_time_bounds: 1 }),
        baselineRow({ stream: 'threads', dirty_record_time_bounds: 0 }),
        baselineRow({ stream: 'labels', dirty_record_time_bounds: true }),
      ],
      getProjectionMetadata: () => baselineMetadata(),
    },
  );

  assert.equal(envelope.streams[0].dirty_record_time_bounds, true);
  assert.equal(envelope.streams[1].dirty_record_time_bounds, false);
  assert.equal(envelope.streams[2].dirty_record_time_bounds, true);
});

test('ref.dataset.summary.streams awaits async dependencies', async () => {
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      listStreams: async () => [baselineRow()],
      getProjectionMetadata: async () => baselineMetadata({ state: 'stale' }),
    },
  );
  assert.equal(envelope.streams.length, 1);
  assert.equal(envelope.projection.state, 'stale');
});

test('ref.dataset.summary.streams passes the projection-metadata block through unchanged', async () => {
  const metadata = baselineMetadata({
    state: 'rebuilding',
    stale_since: '2026-05-20T00:00:00.000Z',
    rebuild_status: 'running',
    last_error: null,
  });
  const envelope = await executeRefDatasetSummaryStreams(
    {},
    {
      listStreams: () => [],
      getProjectionMetadata: () => metadata,
    },
  );
  assert.deepEqual(envelope.projection, metadata);
});

test('ref.dataset.summary.streams operation has no host or storage concretes', () => {
  const rel = 'reference-implementation/operations/ref-dataset-summary-streams/index.ts';
  assertOperationBoundary(read(rel), rel);
});
