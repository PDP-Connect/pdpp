/**
 * Aggregate time-bucket + count_distinct contract tests.
 *
 * Exercises the canonical read-contract aggregation extension promoted from
 * `design-notes/read-contract-aggregation-design-2026-05-28.md` and specced in
 * `openspec/changes/add-aggregate-time-buckets-and-distinct`:
 *
 *   - scalar group_by unchanged (regression);
 *   - group_by_time day bucketing, time_zone default + echo, explicit zone,
 *     null/unparseable bucket, granularity required/forbidden/invalid-unit
 *     rejection, single grouping dimension rejection;
 *   - exact count_distinct with null excluded and approximate=false, plus
 *     undeclared/ungranted distinct field rejection;
 *   - manifest validation of group_by_time / count_distinct declarations.
 *
 * These call the storage-layer `aggregateRecords` directly (the same path the
 * `rs.streams.aggregate` operation wires its `aggregate` dependency to),
 * mirroring `storage-fan-in-read-contract.test.js`. This keeps the assertions
 * deterministic and independent of the HTTP owner-read connection-resolution
 * layer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { aggregateRecords, ingestRecord } from '../server/records.js';
import { registerConnector } from '../server/auth.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/agg-time-buckets';
const STREAM = 'events';
const INSTANCE = 'cin_agg_time_buckets';

function manifestWith(aggregations) {
  return {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Aggregate Time Buckets Test Connector',
    capabilities: { human_interaction: [] },
    streams: [
      {
        name: STREAM,
        primary_key: ['id'],
        cursor_field: 'occurred_at',
        consent_time_field: 'occurred_at',
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            sender: { type: ['string', 'null'] },
            occurred_at: { type: ['string', 'null'], format: 'date-time' },
          },
        },
        query: { aggregations },
      },
    ],
  };
}

const FULL_AGGREGATIONS = {
  count: true,
  group_by: ['sender'],
  group_by_time: ['occurred_at'],
  count_distinct: ['sender'],
};

const grant = {
  streams: [{ name: STREAM, fields: ['id', 'sender', 'occurred_at'] }],
};

function target() {
  return { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE };
}

function recordPayload(id, sender, occurredAt) {
  return {
    stream: STREAM,
    key: id,
    data: { id, sender, occurred_at: occurredAt },
    emitted_at: occurredAt || '2026-01-01T00:00:00.000Z',
  };
}

async function seedInstance() {
  const store = createSqliteConnectorInstanceStore();
  const now = '2026-01-01T00:00:00.000Z';
  await store.upsert({
    connectorInstanceId: INSTANCE,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    connectorId: CONNECTOR_ID,
    displayName: 'Account',
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: 'a@example.com',
    sourceBinding: { account: 'a@example.com' },
    createdAt: now,
    updatedAt: now,
  });
}

async function withSeeded(records, testFn, { aggregations = FULL_AGGREGATIONS } = {}) {
  initDb();
  try {
    await registerConnector(manifestWith(aggregations));
    await seedInstance();
    for (const r of records) {
      await ingestRecord(target(), recordPayload(r.id, r.sender, r.occurred_at));
    }
    await testFn();
  } finally {
    closeDb();
  }
}

const SAMPLE = [
  { id: 'e1', sender: 'alice', occurred_at: '2026-05-01T08:00:00Z' },
  { id: 'e2', sender: 'alice', occurred_at: '2026-05-01T20:30:00Z' },
  { id: 'e3', sender: 'bob', occurred_at: '2026-05-02T01:00:00Z' },
  { id: 'e4', sender: 'bob', occurred_at: '2026-05-03T12:00:00Z' },
  { id: 'e5', sender: null, occurred_at: null },
];

test('scalar group_by is unchanged (count-desc, key-asc) and carries null additive fields', async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count',
      group_by: 'sender',
      limit: '10',
    }, manifestWith(FULL_AGGREGATIONS));
    assert.equal(res.object, 'aggregation');
    assert.equal(res.group_by, 'sender');
    assert.equal(res.group_by_time, null);
    assert.equal(res.granularity, null);
    assert.equal(res.time_zone, null);
    assert.equal(res.approximate, false);
    // alice=2, bob=2, null=1 -> count desc, then key asc among ties.
    assert.deepEqual(res.groups, [
      { key: 'alice', count: 2 },
      { key: 'bob', count: 2 },
      { key: null, count: 1 },
    ]);
  });
});

test('group_by_time buckets by UTC day by default, echoes UTC, and orders ascending', async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count',
      group_by_time: 'occurred_at',
      granularity: 'day',
    }, manifestWith(FULL_AGGREGATIONS));
    assert.equal(res.group_by_time, 'occurred_at');
    assert.equal(res.granularity, 'day');
    assert.equal(res.time_zone, 'UTC');
    assert.equal(res.approximate, false);
    assert.deepEqual(res.groups, [
      { key: '2026-05-01', count: 2 },
      { key: '2026-05-02', count: 1 },
      { key: '2026-05-03', count: 1 },
      { key: null, count: 1 },
    ]);
  });
});

test('group_by_time honors an explicit IANA time_zone for bucket boundaries', async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count',
      group_by_time: 'occurred_at',
      granularity: 'day',
      time_zone: 'America/New_York',
    }, manifestWith(FULL_AGGREGATIONS));
    assert.equal(res.time_zone, 'America/New_York');
    // In America/New_York (UTC-4 in May): e1 08:00Z -> 04:00 (May 1),
    // e2 20:30Z -> 16:30 (May 1), e3 2026-05-02T01:00Z -> 2026-05-01T21:00
    // (May 1), e4 2026-05-03T12:00Z -> 08:00 (May 3). So May 1 = 3, May 3 = 1.
    assert.deepEqual(res.groups, [
      { key: '2026-05-01', count: 3 },
      { key: '2026-05-03', count: 1 },
      { key: null, count: 1 },
    ]);
  });
});

test('group_by_time month/week/year buckets are calendar-correct', async () => {
  const records = [
    { id: 'm1', sender: 'x', occurred_at: '2026-01-05T00:00:00Z' }, // Mon week of Jan 5
    { id: 'm2', sender: 'x', occurred_at: '2026-01-08T00:00:00Z' }, // same ISO week (starts Jan 5)
    { id: 'm3', sender: 'x', occurred_at: '2026-02-20T00:00:00Z' },
    { id: 'm4', sender: 'x', occurred_at: '2027-03-01T00:00:00Z' },
  ];
  await withSeeded(records, async () => {
    const month = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count', group_by_time: 'occurred_at', granularity: 'month',
    }, manifestWith(FULL_AGGREGATIONS));
    assert.deepEqual(month.groups, [
      { key: '2026-01-01', count: 2 },
      { key: '2026-02-01', count: 1 },
      { key: '2027-03-01', count: 1 },
    ]);
    const week = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count', group_by_time: 'occurred_at', granularity: 'week',
    }, manifestWith(FULL_AGGREGATIONS));
    // Jan 5 2026 is a Monday; Jan 5 and Jan 8 share that ISO week.
    assert.equal(week.groups[0].key, '2026-01-05');
    assert.equal(week.groups[0].count, 2);
    const year = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count', group_by_time: 'occurred_at', granularity: 'year',
    }, manifestWith(FULL_AGGREGATIONS));
    assert.deepEqual(year.groups, [
      { key: '2026-01-01', count: 3 },
      { key: '2027-01-01', count: 1 },
    ]);
  });
});

test('group_by_time rejects missing, forbidden, and invalid granularity', async () => {
  await withSeeded(SAMPLE, async () => {
    const manifest = manifestWith(FULL_AGGREGATIONS);
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', group_by_time: 'occurred_at',
      }, manifest),
      /granularity is required/,
    );
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', group_by_time: 'occurred_at', granularity: 'fortnight',
      }, manifest),
      /granularity must be one of/,
    );
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', granularity: 'day',
      }, manifest),
      /granularity is only supported with group_by_time/,
    );
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', time_zone: 'UTC',
      }, manifest),
      /time_zone is only supported with group_by_time/,
    );
  });
});

test('group_by and group_by_time together are rejected (single dimension)', async () => {
  await withSeeded(SAMPLE, async () => {
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', group_by: 'sender', group_by_time: 'occurred_at', granularity: 'day',
      }, manifestWith(FULL_AGGREGATIONS)),
      /cannot be combined/,
    );
  });
});

test('group_by_time rejects an unknown time zone', async () => {
  await withSeeded(SAMPLE, async () => {
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', group_by_time: 'occurred_at', granularity: 'day', time_zone: 'Mars/Olympus',
      }, manifestWith(FULL_AGGREGATIONS)),
      /Unknown time_zone/,
    );
  });
});

test('count_distinct counts distinct non-null values exactly with approximate=false', async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(target(), STREAM, grant, {
      metric: 'count_distinct',
      field: 'sender',
    }, manifestWith(FULL_AGGREGATIONS));
    assert.equal(res.metric, 'count_distinct');
    assert.equal(res.field, 'sender');
    assert.equal(res.approximate, false);
    // alice, bob -> 2 distinct; null is not counted.
    assert.equal(res.value, 2);
    assert.equal(res.filtered_record_count, 5);
  });
});

test('count_distinct rejects grouping and undeclared/ungranted fields', async () => {
  await withSeeded(SAMPLE, async () => {
    const manifest = manifestWith(FULL_AGGREGATIONS);
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count_distinct', field: 'sender', group_by: 'sender',
      }, manifest),
      /count_distinct does not support grouping/,
    );
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count_distinct',
      }, manifest),
      /field is required for count_distinct/,
    );
    // Declared for group_by/group_by_time but NOT for count_distinct.
    const partial = manifestWith({ count: true, count_distinct: ['sender'] });
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count_distinct', field: 'occurred_at',
      }, partial),
      /not declared for 'occurred_at'/,
    );
  });
});

test('group_by_time requires a declared time-bucketable field', async () => {
  await withSeeded(SAMPLE, async () => {
    // group_by_time NOT declared at all.
    const noTime = manifestWith({ count: true, group_by: ['sender'] });
    await assert.rejects(
      () => aggregateRecords(target(), STREAM, grant, {
        metric: 'count', group_by_time: 'occurred_at', granularity: 'day',
      }, noTime),
      /not declared for 'occurred_at'/,
    );
  });
});

test('manifest validation accepts valid group_by_time / count_distinct declarations', async () => {
  initDb();
  try {
    await registerConnector(manifestWith({
      count: true,
      group_by_time: ['occurred_at'],
      count_distinct: ['sender', 'occurred_at'],
    }));
  } finally {
    closeDb();
  }
});

test('manifest validation rejects a non-date group_by_time field', async () => {
  initDb();
  try {
    await assert.rejects(
      () => registerConnector(manifestWith({ count: true, group_by_time: ['sender'] })),
      /group_by_time entry 'sender' must be a string field with format date or date-time/,
    );
  } finally {
    closeDb();
  }
});

test('manifest validation rejects an unknown count_distinct field', async () => {
  initDb();
  try {
    await assert.rejects(
      () => registerConnector(manifestWith({ count: true, count_distinct: ['nope'] })),
      /count_distinct references unknown field 'nope'/,
    );
  } finally {
    closeDb();
  }
});
