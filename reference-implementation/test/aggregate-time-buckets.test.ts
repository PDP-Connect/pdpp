const TOP_LEVEL_REGEX_1 = /granularity is required/;
const TOP_LEVEL_REGEX_2 = /granularity must be one of/;
const TOP_LEVEL_REGEX_3 = /granularity is only supported with group_by_time/;
const TOP_LEVEL_REGEX_4 = /time_zone is only supported with group_by_time/;
const TOP_LEVEL_REGEX_5 = /cannot be combined/;
const TOP_LEVEL_REGEX_6 = /Unknown time_zone/;
const TOP_LEVEL_REGEX_7 = /count_distinct does not support grouping/;
const TOP_LEVEL_REGEX_8 = /field is required for count_distinct/;
const TOP_LEVEL_REGEX_9 = /not declared for 'occurred_at'/;
const TOP_LEVEL_REGEX_10 = /not declared for 'occurred_at'/;
const TOP_LEVEL_REGEX_11 = /group_by_time entry 'sender' must be a string field with format date or date-time/;
const TOP_LEVEL_REGEX_12 = /count_distinct references unknown field 'nope'/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Aggregate time-bucket + count_distinct + other_count contract tests.
 *
 * Exercises the canonical read-contract aggregation extension promoted from
 * `design-notes/read-contract-aggregation-design-2026-05-28.md` and specced in
 * `openspec/changes/add-aggregate-time-buckets-and-distinct` and
 * `openspec/changes/add-aggregate-other-rollup`:
 *
 *   - scalar group_by unchanged (regression);
 *   - group_by_time day bucketing, time_zone default + echo, explicit zone,
 *     null/unparseable bucket, granularity required/forbidden/invalid-unit
 *     rejection, single grouping dimension rejection;
 *   - exact count_distinct with null excluded and approximate=false, plus
 *     undeclared/ungranted distinct field rejection;
 *   - manifest validation of group_by_time / count_distinct declarations;
 *   - other_count explicit rollup for truncated group_by and group_by_time.
 *
 * These call the storage-layer `aggregateRecords` directly (the same path the
 * `rs.streams.aggregate` operation wires its `aggregate` dependency to),
 * mirroring `storage-fan-in-read-contract.test.js`. This keeps the assertions
 * deterministic and independent of the HTTP owner-read connection-resolution
 * layer.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/performance/noNamespaceImport: namespace import is required to exercise module surface
import * as authModule from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
// biome-ignore lint/performance/noNamespaceImport: namespace import is required to exercise module surface
import * as recordsModule from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "agg-time-buckets";
const STREAM = "events";
const INSTANCE = "cin_agg_time_buckets";

interface AggregationsDeclaration {
  count?: boolean;
  count_distinct?: readonly string[];
  group_by?: readonly string[];
  group_by_time?: readonly string[];
  [key: string]: unknown;
}

function manifestWith(aggregations: AggregationsDeclaration) {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_ID,
    display_name: "Aggregate Time Buckets Test Connector",
    manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
    protocol_version: "0.1.0",
    streams: [
      {
        consent_time_field: "occurred_at",
        cursor_field: "occurred_at",
        name: STREAM,
        primary_key: ["id"],
        query: { aggregations },
        schema: {
          properties: {
            id: { type: "string" },
            occurred_at: { format: "date-time", type: ["string", "null"] },
            sender: { type: ["string", "null"] },
          },
          required: ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
}

// `server/auth.ts` and `server/records.js` are untyped legacy JS:
// `registerConnector`'s `manifest` parameter and `aggregateRecords`'s
// `storageTarget` parameter are both inferred as bare `null` (TS infers JS
// parameter types purely from same-file call sites, and neither function has
// one), and `aggregateRecords`'s return type is under-inferred to only the
// base response fields present in the initial object literal — the
// conditionally-assigned `groups` / `other_count` / `limit` / `value` fields
// added later in the function body never widen it. Re-declare the real call
// shapes locally and cast the imports, per the established untyped-JS-import
// pattern (see `connector-instances-acceptance.test.ts`).
interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}

type IngestRecordFn = (
  storageTarget: StorageTarget,
  record: { data: Record<string, unknown>; emitted_at: string; key: string; stream: string }
) => Promise<unknown>;

type RegisterConnectorFn = (manifest: object) => Promise<unknown>;

// biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
async function aggregateRecords(
  storageTarget: StorageTarget,
  stream: string,
  // biome-ignore lint/suspicious/noShadow: fixture terminology mirrors the protocol field name
  grant: { streams: Array<{ fields: string[]; name: string }> },
  requestParams: Record<string, unknown>,
  manifest: ReturnType<typeof manifestWith>
) {
  return recordsModule.aggregateRecords(storageTarget, stream, grant, requestParams, { streams: manifest.streams });
}
const ingestRecord = recordsModule.ingestRecord as IngestRecordFn;
const registerConnector = authModule.registerConnector as RegisterConnectorFn;

const FULL_AGGREGATIONS = {
  count: true,
  count_distinct: ["sender"],
  group_by: ["sender"],
  group_by_time: ["occurred_at"],
};

const grant = {
  streams: [{ fields: ["id", "sender", "occurred_at"], name: STREAM }],
};

function target() {
  return { connector_id: CONNECTOR_ID, connector_instance_id: INSTANCE };
}

function recordPayload(id: string, sender: string | null, occurredAt: string | null) {
  return {
    data: { id, occurred_at: occurredAt, sender },
    emitted_at: occurredAt || "2026-01-01T00:00:00.000Z",
    key: id,
    stream: STREAM,
  };
}

async function seedInstance() {
  const store = createSqliteConnectorInstanceStore();
  const now = "2026-01-01T00:00:00.000Z";
  await store.upsert({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE,
    createdAt: now,
    displayName: "Account",
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: "a@example.com" },
    sourceBindingKey: "a@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

interface SampleRecord {
  id: string;
  occurred_at: string | null;
  sender: string | null;
}

async function withSeeded(
  records: readonly SampleRecord[],
  testFn: () => Promise<void>,
  { aggregations = FULL_AGGREGATIONS }: { aggregations?: AggregationsDeclaration } = {}
) {
  initDb();
  try {
    await registerConnector(manifestWith(aggregations));
    await seedInstance();
    for (const r of records) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      await ingestRecord(target(), recordPayload(r.id, r.sender, r.occurred_at));
    }
    await testFn();
  } finally {
    closeDb();
  }
}

const SAMPLE = [
  { id: "e1", occurred_at: "2026-05-01T08:00:00Z", sender: "alice" },
  { id: "e2", occurred_at: "2026-05-01T20:30:00Z", sender: "alice" },
  { id: "e3", occurred_at: "2026-05-02T01:00:00Z", sender: "bob" },
  { id: "e4", occurred_at: "2026-05-03T12:00:00Z", sender: "bob" },
  { id: "e5", occurred_at: null, sender: null },
];

test("scalar group_by is unchanged (count-desc, key-asc) and carries null additive fields", async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        group_by: "sender",
        limit: "10",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.equal(res.object, "aggregation");
    assert.equal(res.group_by, "sender");
    assert.equal(res.group_by_time, null);
    assert.equal(res.granularity, null);
    assert.equal(res.time_zone, null);
    assert.equal(res.approximate, false);
    // alice=2, bob=2, null=1 -> count desc, then key asc among ties.
    assert.deepEqual(res.groups, [
      { count: 2, key: "alice" },
      { count: 2, key: "bob" },
      { count: 1, key: null },
    ]);
    // All 3 groups fit within limit=10; other_count is 0 (no truncation).
    assert.equal(res.other_count, 0);
  });
});

test("group_by_time buckets by UTC day by default, echoes UTC, and orders ascending", async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        granularity: "day",
        group_by_time: "occurred_at",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.equal(res.group_by_time, "occurred_at");
    assert.equal(res.granularity, "day");
    assert.equal(res.time_zone, "UTC");
    assert.equal(res.approximate, false);
    assert.deepEqual(res.groups, [
      { count: 2, key: "2026-05-01" },
      { count: 1, key: "2026-05-02" },
      { count: 1, key: "2026-05-03" },
      { count: 1, key: null },
    ]);
    // 4 buckets fit within default limit; other_count is 0.
    assert.equal(res.other_count, 0);
  });
});

test("group_by_time honors an explicit IANA time_zone for bucket boundaries", async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        granularity: "day",
        group_by_time: "occurred_at",
        metric: "count",
        time_zone: "America/New_York",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.equal(res.time_zone, "America/New_York");
    // In America/New_York (UTC-4 in May): e1 08:00Z -> 04:00 (May 1),
    // e2 20:30Z -> 16:30 (May 1), e3 2026-05-02T01:00Z -> 2026-05-01T21:00
    // (May 1), e4 2026-05-03T12:00Z -> 08:00 (May 3). So May 1 = 3, May 3 = 1.
    assert.deepEqual(res.groups, [
      { count: 3, key: "2026-05-01" },
      { count: 1, key: "2026-05-03" },
      { count: 1, key: null },
    ]);
  });
});

test("group_by_time month/week/year buckets are calendar-correct", async () => {
  const records = [
    { id: "m1", occurred_at: "2026-01-05T00:00:00Z", sender: "x" }, // Mon week of Jan 5
    { id: "m2", occurred_at: "2026-01-08T00:00:00Z", sender: "x" }, // same ISO week (starts Jan 5)
    { id: "m3", occurred_at: "2026-02-20T00:00:00Z", sender: "x" },
    { id: "m4", occurred_at: "2027-03-01T00:00:00Z", sender: "x" },
  ];
  await withSeeded(records, async () => {
    const month = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        granularity: "month",
        group_by_time: "occurred_at",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.deepEqual(month.groups, [
      { count: 2, key: "2026-01-01" },
      { count: 1, key: "2026-02-01" },
      { count: 1, key: "2027-03-01" },
    ]);
    const week = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        granularity: "week",
        group_by_time: "occurred_at",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    // Jan 5 2026 is a Monday; Jan 5 and Jan 8 share that ISO week.
    assert.ok(week.groups, "week response has groups");
    const [firstWeekGroup] = week.groups;
    assert.ok(firstWeekGroup, "week response has at least one group");
    assert.equal(firstWeekGroup.key, "2026-01-05");
    assert.equal(firstWeekGroup.count, 2);
    const year = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        granularity: "year",
        group_by_time: "occurred_at",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.deepEqual(year.groups, [
      { count: 3, key: "2026-01-01" },
      { count: 1, key: "2027-01-01" },
    ]);
  });
});

test("group_by_time rejects missing, forbidden, and invalid granularity", async () => {
  await withSeeded(SAMPLE, async () => {
    const manifest = manifestWith(FULL_AGGREGATIONS);
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            group_by_time: "occurred_at",
            metric: "count",
          },
          manifest
        ),
      TOP_LEVEL_REGEX_1
    );
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            granularity: "fortnight",
            group_by_time: "occurred_at",
            metric: "count",
          },
          manifest
        ),
      TOP_LEVEL_REGEX_2
    );
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            granularity: "day",
            metric: "count",
          },
          manifest
        ),
      TOP_LEVEL_REGEX_3
    );
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            metric: "count",
            time_zone: "UTC",
          },
          manifest
        ),
      TOP_LEVEL_REGEX_4
    );
  });
});

test("group_by and group_by_time together are rejected (single dimension)", async () => {
  await withSeeded(SAMPLE, async () => {
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            granularity: "day",
            group_by: "sender",
            group_by_time: "occurred_at",
            metric: "count",
          },
          manifestWith(FULL_AGGREGATIONS)
        ),
      TOP_LEVEL_REGEX_5
    );
  });
});

test("group_by_time rejects an unknown time zone", async () => {
  await withSeeded(SAMPLE, async () => {
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            granularity: "day",
            group_by_time: "occurred_at",
            metric: "count",
            time_zone: "Mars/Olympus",
          },
          manifestWith(FULL_AGGREGATIONS)
        ),
      TOP_LEVEL_REGEX_6
    );
  });
});

test("count_distinct counts distinct non-null values exactly with approximate=false", async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        field: "sender",
        metric: "count_distinct",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.equal(res.metric, "count_distinct");
    assert.equal(res.field, "sender");
    assert.equal(res.approximate, false);
    // alice, bob -> 2 distinct; null is not counted.
    assert.equal(res.value, 2);
    assert.equal(res.filtered_record_count, 5);
  });
});

test("count_distinct rejects grouping and undeclared/ungranted fields", async () => {
  await withSeeded(SAMPLE, async () => {
    const manifest = manifestWith(FULL_AGGREGATIONS);
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            field: "sender",
            group_by: "sender",
            metric: "count_distinct",
          },
          manifest
        ),
      TOP_LEVEL_REGEX_7
    );
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            metric: "count_distinct",
          },
          manifest
        ),
      TOP_LEVEL_REGEX_8
    );
    // Declared for group_by/group_by_time but NOT for count_distinct.
    const partial = manifestWith({ count: true, count_distinct: ["sender"] });
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            field: "occurred_at",
            metric: "count_distinct",
          },
          partial
        ),
      TOP_LEVEL_REGEX_9
    );
  });
});

test("group_by_time requires a declared time-bucketable field", async () => {
  await withSeeded(SAMPLE, async () => {
    // group_by_time NOT declared at all.
    const noTime = manifestWith({ count: true, group_by: ["sender"] });
    await assert.rejects(
      () =>
        aggregateRecords(
          target(),
          STREAM,
          grant,
          {
            granularity: "day",
            group_by_time: "occurred_at",
            metric: "count",
          },
          noTime
        ),
      TOP_LEVEL_REGEX_10
    );
  });
});

test("manifest validation accepts valid group_by_time / count_distinct declarations", async () => {
  initDb();
  try {
    await registerConnector(
      manifestWith({
        count: true,
        count_distinct: ["sender", "occurred_at"],
        group_by_time: ["occurred_at"],
      })
    );
  } finally {
    closeDb();
  }
});

test("manifest validation rejects a non-date group_by_time field", async () => {
  initDb();
  try {
    await assert.rejects(
      () => registerConnector(manifestWith({ count: true, group_by_time: ["sender"] })),
      TOP_LEVEL_REGEX_11
    );
  } finally {
    closeDb();
  }
});

test("manifest validation rejects an unknown count_distinct field", async () => {
  initDb();
  try {
    await assert.rejects(
      () => registerConnector(manifestWith({ count: true, count_distinct: ["nope"] })),
      TOP_LEVEL_REGEX_12
    );
  } finally {
    closeDb();
  }
});

test("group_by other_count is the sum of counts for groups beyond limit", async () => {
  // 3 distinct senders (alice=2, bob=2, null=1). limit=2 returns top 2;
  // other_count should be the count from the 3rd group (null=1).
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        group_by: "sender",
        limit: "2",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.equal(res.limit, 2);
    assert.ok(res.groups, "response has groups");
    assert.equal(res.groups.length, 2);
    // Top 2 by count-desc: alice=2, bob=2
    assert.deepEqual(res.groups, [
      { count: 2, key: "alice" },
      { count: 2, key: "bob" },
    ]);
    // Truncated: null=1. other_count = 1.
    assert.equal(res.other_count, 1);
  });
});

test("group_by other_count is 0 when all groups fit within limit", async () => {
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        group_by: "sender",
        limit: "100",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.ok(res.groups, "response has groups");
    assert.equal(res.groups.length, 3);
    assert.equal(res.other_count, 0);
  });
});

test("group_by_time other_count covers buckets truncated by limit", async () => {
  // SAMPLE has 4 buckets (3 UTC day buckets + 1 null). limit=2 returns only
  // the first 2 ascending; other_count is the sum of the remaining buckets.
  await withSeeded(SAMPLE, async () => {
    const res = await aggregateRecords(
      target(),
      STREAM,
      grant,
      {
        granularity: "day",
        group_by_time: "occurred_at",
        limit: "2",
        metric: "count",
      },
      manifestWith(FULL_AGGREGATIONS)
    );
    assert.equal(res.limit, 2);
    assert.ok(res.groups, "response has groups");
    assert.equal(res.groups.length, 2);
    // First 2 ascending: 2026-05-01=2, 2026-05-02=1
    assert.deepEqual(res.groups, [
      { count: 2, key: "2026-05-01" },
      { count: 1, key: "2026-05-02" },
    ]);
    // Truncated: 2026-05-03=1, null=1. other_count = 1+1 = 2.
    assert.equal(res.other_count, 2);
  });
});
