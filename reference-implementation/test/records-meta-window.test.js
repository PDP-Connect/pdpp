// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `meta.window` bounded record-list aggregate — section 2 of
 * `complete-explorer-slvp-ideal`.
 *
 * Proves the read contract's optional `meta.window` object:
 *
 *   - `window=exact` returns `meta.window.total` and logical min/max
 *     (`earliest_at`/`latest_at`) over the visible filtered rows, sourced from
 *     the stream's `consent_time_field` (NOT the storage ingest `emitted_at`);
 *   - the window reflects the WHOLE filtered, grant-scoped corpus before
 *     pagination, so `limit=1` still reports the full bounds;
 *   - filters, time-range, and grant projection narrow `total` and the bounds;
 *   - absence / `window=none` omits `meta.window`;
 *   - a stream with no declared `consent_time_field` emits `total` without
 *     timestamps (never substituting `emitted_at`);
 *   - missing/unparseable timestamp values are excluded from min/max;
 *   - an empty filtered corpus emits `{ total: 0 }` with no timestamps;
 *   - a `changes_since` read does not carry `meta.window`;
 *   - an invalid `window` value is rejected with the typed invalid-query
 *     discipline used for `count`;
 *   - multi-connection fan-in merges all-present windows (sum / min / max) and
 *     omits the merged window when any binding cannot produce one.
 *
 * These exercise the SQLite reference path and the in-process fan-in merge
 * directly via `queryRecords` / `queryRecordsAcrossBindings`, mirroring
 * `storage-fan-in-read-contract.test.js`. These exercise the SQLite reference
 * path; Postgres now computes `meta.window` to parity (see
 * computePostgresRecordWindow in postgres-records.js), and that parity is
 * pinned by `record-window-count-parity.test.js`.
 *
 * Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"The record-list read MAY expose bounded window aggregate metadata").
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import {
  ingestRecord,
  queryRecords,
  queryRecordsAcrossBindings,
} from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { resolveFanInBindings } from '../server/connection-identity.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'meta-window';
const STREAM = 'messages';
const INSTANCE_A = 'cin_window_account_a';
const INSTANCE_B = 'cin_window_account_b';

// A stream whose logical time lives in `received_at` (consent_time_field) and
// whose `amount` field is range-filterable, so a filter can narrow the corpus.
const baseManifest = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Meta-window Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      cursor_field: 'received_at',
      consent_time_field: 'received_at',
      schema: {
        type: 'object',
        required: ['id', 'subject', 'received_at'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
          amount: { type: 'integer' },
          received_at: { type: 'string', format: 'date-time' },
        },
      },
      query: {
        range_filters: { amount: ['gte', 'lte'], received_at: ['gte', 'lte'] },
        aggregations: { count: true },
      },
    },
  ],
};

// A second connector whose stream declares NO consent_time_field, to prove the
// total-without-timestamps honesty rule.
const NO_TIME_CONNECTOR_ID = 'meta-window-no-time';
const NO_TIME_INSTANCE = 'cin_window_no_time';
const noTimeManifest = {
  protocol_version: '0.1.0',
  connector_id: NO_TIME_CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'No-time Test Connector',
  capabilities: { human_interaction: [] },
  streams: [
    {
      name: STREAM,
      primary_key: ['id'],
      schema: {
        type: 'object',
        required: ['id', 'subject'],
        properties: {
          id: { type: 'string' },
          subject: { type: 'string' },
        },
      },
    },
  ],
};

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'subject', 'amount', 'received_at'] }],
};

function target(connectorId, instanceId) {
  return { connector_id: connectorId, connector_instance_id: instanceId };
}

function recordPayload(id, subject, receivedAt, amount) {
  const data = { id, subject };
  if (receivedAt != null) data.received_at = receivedAt;
  if (amount != null) data.amount = amount;
  return { stream: STREAM, key: id, data, emitted_at: receivedAt || '2026-05-30T00:00:00.000Z' };
}

async function seedInstance(connectorId, instanceId, displayName, bindingKey) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: bindingKey,
    sourceBinding: { account: bindingKey },
    createdAt: now,
    updatedAt: now,
  });
}

async function withSeededDb(testFn, { records } = {}) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(CONNECTOR_ID, INSTANCE_A, 'Account A', 'a@example.com');
    const seed = records || [
      // received_at is intentionally NOT chronological vs ingest order so the
      // min/max logic is exercised over the logical field, not arrival order.
      recordPayload('rec-1', 'second', '2024-06-15T08:00:00.000Z', 100),
      recordPayload('rec-2', 'earliest', '2020-01-01T00:00:00.000Z', 200),
      recordPayload('rec-3', 'latest', '2026-05-29T18:42:11.000Z', 300),
    ];
    for (const r of seed) {
      await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), r);
    }
    await testFn();
  } finally {
    closeDb();
  }
}

// ─── total + logical bounds ──────────────────────────────────────────────────

test('window=exact returns total and logical min/max over visible filtered rows', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact' },
      baseManifest,
    );
    assert.ok(response.meta, 'meta is present');
    assert.deepEqual(response.meta.window, {
      total: 3,
      earliest_at: '2020-01-01T00:00:00.000Z',
      latest_at: '2026-05-29T18:42:11.000Z',
    });
  });
});

test('window bounds come from consent_time_field, not the storage emitted_at', async () => {
  await withSeededDb(async () => {
    // emitted_at for every record diverges from received_at (set far in the
    // future). The window MUST reflect the logical received_at bounds.
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact' },
      baseManifest,
    );
    // The bounds are the received_at range; if the window used emitted_at it
    // would report the future 2099 ingest stamp instead.
    assert.equal(response.meta.window.earliest_at, '2020-01-01T00:00:00.000Z');
    assert.equal(response.meta.window.latest_at, '2021-01-01T00:00:00.000Z');
  }, {
    records: [
      // received_at older than emitted_at; if the window used emitted_at it
      // would report the future ingest stamp instead.
      { stream: STREAM, key: 'rec-1', data: { id: 'rec-1', subject: 'a', received_at: '2020-01-01T00:00:00.000Z' }, emitted_at: '2099-01-01T00:00:00.000Z' },
      { stream: STREAM, key: 'rec-2', data: { id: 'rec-2', subject: 'b', received_at: '2021-01-01T00:00:00.000Z' }, emitted_at: '2099-01-01T00:00:00.000Z' },
    ],
  });
});

// ─── page independence ───────────────────────────────────────────────────────

test('limit=1 still reports the full filtered corpus window', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact', limit: '1' },
      baseManifest,
    );
    assert.equal(response.data.length, 1, 'page is bounded to one record');
    assert.equal(response.has_more, true, 'more pages remain');
    assert.deepEqual(response.meta.window, {
      total: 3,
      earliest_at: '2020-01-01T00:00:00.000Z',
      latest_at: '2026-05-29T18:42:11.000Z',
    }, 'window describes the whole corpus, not the page');
  });
});

// ─── filter / time-range / grant narrowing ───────────────────────────────────

test('a request filter narrows total and tightens the window bounds', async () => {
  await withSeededDb(async () => {
    // amount >= 200 keeps rec-2 (2020) and rec-3 (2026); drops rec-1 (2024).
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact', filter: { amount: { gte: '200' } } },
      baseManifest,
    );
    assert.equal(response.meta.window.total, 2);
    assert.equal(response.meta.window.earliest_at, '2020-01-01T00:00:00.000Z');
    assert.equal(response.meta.window.latest_at, '2026-05-29T18:42:11.000Z');
  });
});

test('a grant time_range narrows total and tightens the window bounds', async () => {
  await withSeededDb(async () => {
    const narrowedGrant = {
      streams: [{
        name: STREAM,
        fields: ['id', 'subject', 'amount', 'received_at'],
        time_range: { since: '2023-01-01T00:00:00.000Z' },
      }],
    };
    // received_at >= 2023 keeps rec-1 (2024) and rec-3 (2026); drops rec-2 (2020).
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      narrowedGrant,
      { window: 'exact' },
      baseManifest,
    );
    assert.equal(response.meta.window.total, 2);
    assert.equal(response.meta.window.earliest_at, '2024-06-15T08:00:00.000Z');
    assert.equal(response.meta.window.latest_at, '2026-05-29T18:42:11.000Z');
  });
});

test('a grant resources constraint narrows total and bounds', async () => {
  await withSeededDb(async () => {
    const scopedGrant = {
      streams: [{
        name: STREAM,
        fields: ['id', 'subject', 'amount', 'received_at'],
        resources: ['rec-2'],
      }],
    };
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      scopedGrant,
      { window: 'exact' },
      baseManifest,
    );
    assert.deepEqual(response.meta.window, {
      total: 1,
      earliest_at: '2020-01-01T00:00:00.000Z',
      latest_at: '2020-01-01T00:00:00.000Z',
    });
  });
});

// ─── honest omission ─────────────────────────────────────────────────────────

test('absence of the window param omits meta.window', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      {},
      baseManifest,
    );
    assert.equal(response.meta?.window, undefined, 'no window when not requested');
  });
});

test('window=none omits meta.window', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'none' },
      baseManifest,
    );
    assert.equal(response.meta?.window, undefined, 'window=none means omit');
  });
});

test('an empty filtered corpus emits total:0 with no timestamps', async () => {
  await withSeededDb(async () => {
    // amount >= 9999 matches nothing.
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact', filter: { amount: { gte: '9999' } } },
      baseManifest,
    );
    assert.deepEqual(response.meta.window, { total: 0 });
    assert.equal(response.meta.window.earliest_at, undefined);
    assert.equal(response.meta.window.latest_at, undefined);
  });
});

test('a stream with no consent_time_field emits total without timestamps', async () => {
  initDb();
  try {
    await registerConnector(noTimeManifest);
    await seedInstance(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE, 'No-time Account', 'n@example.com');
    await ingestRecord(target(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE), { stream: STREAM, key: 'r1', data: { id: 'r1', subject: 'x' } });
    await ingestRecord(target(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE), { stream: STREAM, key: 'r2', data: { id: 'r2', subject: 'y' } });
    const noTimeGrant = { streams: [{ name: STREAM, fields: ['id', 'subject'] }] };
    const response = await queryRecords(
      target(NO_TIME_CONNECTOR_ID, NO_TIME_INSTANCE),
      STREAM,
      noTimeGrant,
      { window: 'exact' },
      noTimeManifest,
    );
    assert.deepEqual(response.meta.window, { total: 2 }, 'total without timestamps');
  } finally {
    closeDb();
  }
});

test('missing/unparseable consent_time_field values are excluded from min/max', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact' },
      baseManifest,
    );
    // rec-with-bad-time has an unparseable received_at; it counts toward total
    // but not toward the bounds. rec-no-time has no received_at at all.
    assert.equal(response.meta.window.total, 4);
    assert.equal(response.meta.window.earliest_at, '2020-01-01T00:00:00.000Z');
    assert.equal(response.meta.window.latest_at, '2024-06-15T08:00:00.000Z');
  }, {
    records: [
      recordPayload('rec-good-1', 'a', '2020-01-01T00:00:00.000Z', 10),
      recordPayload('rec-good-2', 'b', '2024-06-15T08:00:00.000Z', 20),
      { stream: STREAM, key: 'rec-bad-time', data: { id: 'rec-bad-time', subject: 'c', received_at: 'not-a-date' }, emitted_at: '2026-01-01T00:00:00.000Z' },
      { stream: STREAM, key: 'rec-no-time', data: { id: 'rec-no-time', subject: 'd' }, emitted_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
});

test('a corpus where every visible row lacks a parseable time emits total only', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { window: 'exact' },
      baseManifest,
    );
    assert.deepEqual(response.meta.window, { total: 2 });
  }, {
    records: [
      { stream: STREAM, key: 'r1', data: { id: 'r1', subject: 'a', received_at: 'nope' }, emitted_at: '2026-01-01T00:00:00.000Z' },
      { stream: STREAM, key: 'r2', data: { id: 'r2', subject: 'b' }, emitted_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
});

// ─── changes_since ───────────────────────────────────────────────────────────

test('a changes_since read with window=exact is rejected (no corpus window on a delta feed)', async () => {
  await withSeededDb(async () => {
    await assert.rejects(
      () => queryRecords(
        target(CONNECTOR_ID, INSTANCE_A),
        STREAM,
        grant,
        { window: 'exact', changes_since: 'beginning' },
        baseManifest,
      ),
      (err) => err.code === 'invalid_request' && /window/.test(err.message),
      'window is a list-only param, rejected on the changes feed like count',
    );
  });
});

test('a plain changes_since read carries no meta.window', async () => {
  await withSeededDb(async () => {
    const response = await queryRecords(
      target(CONNECTOR_ID, INSTANCE_A),
      STREAM,
      grant,
      { changes_since: 'beginning' },
      baseManifest,
    );
    assert.equal(response.object, 'list');
    assert.equal(response.meta?.window, undefined, 'changes feed never carries a window');
  });
});

// ─── invalid value ───────────────────────────────────────────────────────────

test('an invalid window value is rejected with the typed invalid-query discipline', async () => {
  await withSeededDb(async () => {
    await assert.rejects(
      () => queryRecords(
        target(CONNECTOR_ID, INSTANCE_A),
        STREAM,
        grant,
        { window: 'approx' },
        baseManifest,
      ),
      (err) => err.code === 'invalid_request' && /window must be one of/.test(err.message),
    );
  });
});

// ─── multi-connection fan-in ─────────────────────────────────────────────────

async function withDualWindowDb(testFn, { recordsB } = {}) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(CONNECTOR_ID, INSTANCE_A, 'Account A', 'a@example.com');
    await seedInstance(CONNECTOR_ID, INSTANCE_B, 'Account B', 'b@example.com');
    await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), recordPayload('a-1', 'a-old', '2021-01-01T00:00:00.000Z', 10));
    await ingestRecord(target(CONNECTOR_ID, INSTANCE_A), recordPayload('a-2', 'a-new', '2023-01-01T00:00:00.000Z', 20));
    const bSeed = recordsB || [
      recordPayload('b-1', 'b-old', '2019-06-01T00:00:00.000Z', 30),
      recordPayload('b-2', 'b-new', '2026-01-01T00:00:00.000Z', 40),
    ];
    for (const r of bSeed) await ingestRecord(target(CONNECTOR_ID, INSTANCE_B), r);
    await testFn();
  } finally {
    closeDb();
  }
}

test('fan-in merges all-present windows: total sums, bounds are global min/max', async () => {
  await withDualWindowDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { window: 'exact' }, baseManifest);
    assert.deepEqual(response.meta.window, {
      total: 4,
      earliest_at: '2019-06-01T00:00:00.000Z', // global min (from B)
      latest_at: '2026-01-01T00:00:00.000Z', // global max (from B)
    });
  });
});

test('fan-in omits the merged window when one binding cannot produce bounds', async () => {
  await withDualWindowDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { window: 'exact' }, baseManifest);
    // Binding B has only timestamp-less rows ⇒ its window is { total } with no
    // bounds ⇒ the merged window must omit bounds (all-or-omit on timestamps).
    assert.equal(response.meta.window.total, 4, 'totals still sum');
    assert.equal(response.meta.window.earliest_at, undefined, 'bounds omitted when a binding lacks them');
    assert.equal(response.meta.window.latest_at, undefined);
  }, {
    recordsB: [
      { stream: STREAM, key: 'b-1', data: { id: 'b-1', subject: 'x' }, emitted_at: '2026-01-01T00:00:00.000Z' },
      { stream: STREAM, key: 'b-2', data: { id: 'b-2', subject: 'y' }, emitted_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
});

test('fan-in single-binding path passes meta.window through unchanged', async () => {
  await withSeededDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    assert.equal(bindings.length, 1);
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, { window: 'exact' }, baseManifest);
    assert.deepEqual(response.meta.window, {
      total: 3,
      earliest_at: '2020-01-01T00:00:00.000Z',
      latest_at: '2026-05-29T18:42:11.000Z',
    });
  });
});

test('fan-in without the window param omits meta.window', async () => {
  await withDualWindowDb(async () => {
    const { bindings } = await resolveFanInBindings({
      ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      connectorId: CONNECTOR_ID,
    });
    const response = await queryRecordsAcrossBindings(bindings, STREAM, grant, {}, baseManifest);
    assert.equal(response.meta?.window, undefined);
  });
});
