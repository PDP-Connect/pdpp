// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  __buildPostgresFilterClauseForTest,
  __buildPostgresGrantVisibilityForTest,
} from "../server/postgres-records.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  aggregateRecords as aggregateRecordsUntyped,
  getRecordFieldWindow as getRecordFieldWindowUntyped,
  getRecord as getRecordUntyped,
  ingestRecord,
  queryRecords as queryRecordsUntyped,
} from "../server/records.ts";

type ManifestLike = Record<string, unknown>;

interface RecordItem {
  data?: Record<string, unknown>;
  expanded?: Record<string, { data: RecordItem[]; has_more: boolean }>;
  id: string;
}

interface RecordList {
  data: RecordItem[];
}

interface AggregateResult {
  filtered_record_count: number;
  value: number;
}

interface FieldWindowResult {
  window: { text: string };
}

const queryRecords = queryRecordsUntyped as (
  storageTarget: string,
  stream: string,
  grant: unknown,
  params: Record<string, unknown>,
  manifest: ManifestLike
) => Promise<RecordList>;

const getRecord = getRecordUntyped as (
  storageTarget: string,
  stream: string,
  key: string,
  grant: unknown,
  manifest: ManifestLike,
  params?: Record<string, unknown>
) => Promise<RecordItem>;

const aggregateRecords = aggregateRecordsUntyped as (
  storageTarget: string,
  stream: string,
  grant: unknown,
  params: Record<string, unknown>,
  manifest: ManifestLike
) => Promise<AggregateResult>;

const getRecordFieldWindow = getRecordFieldWindowUntyped as (
  storageTarget: string,
  stream: string,
  key: string,
  fieldPath: string,
  grant: unknown,
  manifest: ManifestLike,
  params: Record<string, unknown>
) => Promise<FieldWindowResult>;

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const POSTGRES_EVENT_TIME_EXPR = /record_json->>'event-time'/;
const POSTGRES_FILTER_DOT_EXPR = /record_json->>'filter\.key'/;
const POSTGRES_QUOTED_EXPR = /record_json->>'say"when'/;
const POSTGRES_UNICODE_JSON_EXPR = /record_json->'時刻'/;
const POSTGRES_UNICODE_TEXT_EXPR = /record_json->>'時刻'/;

test("Postgres SQL builders use literal JSON keys for filter and temporal fields", () => {
  const manifestStream = {
    name: "parents",
    query: { range_filters: { "event-time": ["gte"] } },
    schema: {
      properties: {
        "event-time": { format: "date-time", type: "string" },
        "filter.key": { type: "string" },
        'say"when': { type: "string" },
      },
    },
  };
  const filter = __buildPostgresFilterClauseForTest(
    { "event-time": { gte: "2026-01-02T00:00:00.000Z" }, "filter.key": "include", 'say"when': "literal" },
    { fields: ["event-time", "filter.key", 'say"when'], name: "parents" } as never,
    manifestStream as never
  );
  assert.match(filter.clause, POSTGRES_EVENT_TIME_EXPR);
  assert.match(filter.clause, POSTGRES_FILTER_DOT_EXPR);
  assert.match(filter.clause, POSTGRES_QUOTED_EXPR);

  const temporal = __buildPostgresGrantVisibilityForTest({
    name: "children",
    time_constraint: { field: "時刻", since: "2026-01-02T00:00:00.000Z" },
  } as never);
  assert.match(temporal.whereParts.join(" "), POSTGRES_UNICODE_JSON_EXPR);
  assert.match(temporal.whereParts.join(" "), POSTGRES_UNICODE_TEXT_EXPR);
});

function fixture(suffix: string) {
  const connectorId = `field_name_parity_${suffix}`;
  const parentStream = "parents";
  const childStream = "children";
  const parentFields = ["id.with.dot", "event-time", 'say"when', "filter.key", "Unicode 名"];
  const childFields = ["child-id", "child.time", "時刻", "parent.id", 'child "quote"'];
  const manifest: ManifestLike = {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Field-name records parity",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        consent_time_field: 'say"when',
        cursor_field: "event-time",
        name: parentStream,
        primary_key: ["id.with.dot"],
        query: {
          aggregations: { count: true },
          expand: [{ default_limit: 10, max_limit: 10, name: "children" }],
        },
        relationships: [{ cardinality: "has_many", foreign_key: "parent.id", name: "children", stream: childStream }],
        schema: {
          properties: {
            "event-time": { format: "date-time", type: "string" },
            "filter.key": { type: "string" },
            "id.with.dot": { type: "string" },
            'say"when': { format: "date-time", type: "string" },
            "Unicode 名": { type: "string" },
          },
          required: ["id.with.dot"],
          type: "object",
        },
        selection: { fields: true, resources: false },
        semantics: "mutable_state",
      },
      {
        consent_time_field: "時刻",
        cursor_field: "child.time",
        name: childStream,
        primary_key: ["child-id"],
        schema: {
          properties: {
            'child "quote"': { type: "string" },
            "child-id": { type: "string" },
            "child.time": { format: "date-time", type: "string" },
            "parent.id": { type: "string" },
            時刻: { format: "date-time", type: "string" },
          },
          required: ["child-id", "parent.id"],
          type: "object",
        },
        selection: { fields: true, resources: false },
        semantics: "mutable_state",
      },
    ],
    version: "1.0.0",
  };
  const grant = {
    streams: [
      {
        fields: parentFields,
        name: parentStream,
        time_constraint: { field: 'say"when', since: "2026-01-02T00:00:00.000Z" },
      },
      {
        fields: childFields,
        name: childStream,
        time_constraint: {
          field: "時刻",
          since: "2026-01-02T00:00:00.000Z",
          until: "2026-01-03T00:00:00.000Z",
        },
      },
    ],
  };
  return { childStream, connectorId, grant, manifest, parentStream };
}

async function seedAndAssert(suffix: string): Promise<void> {
  const { childStream, connectorId, grant, manifest, parentStream } = fixture(suffix);
  await registerConnector(manifest);

  await ingestRecord(connectorId, {
    data: {
      "event-time": "2026-01-02T00:00:00.000Z",
      "filter.key": "include",
      "id.with.dot": "parent-1",
      'say"when': "2026-01-02T00:00:00.000Z",
      "Unicode 名": "Unicode field window payload",
    },
    key: "parent-1",
    stream: parentStream,
  });
  await ingestRecord(connectorId, {
    data: {
      "event-time": "2026-01-01T00:00:00.000Z",
      "filter.key": "exclude",
      "id.with.dot": "parent-2",
      'say"when': "2026-01-01T00:00:00.000Z",
      "Unicode 名": "outside parent temporal grant",
    },
    key: "parent-2",
    stream: parentStream,
  });
  await ingestRecord(connectorId, {
    data: {
      'child "quote"': "visible expanded child",
      "child-id": "child-1",
      "child.time": "2026-01-02T12:00:00.000Z",
      "parent.id": "parent-1",
      時刻: "2026-01-02T12:00:00.000Z",
    },
    key: "child-1",
    stream: childStream,
  });
  await ingestRecord(connectorId, {
    data: {
      'child "quote"': "outside expanded child temporal grant",
      "child-id": "child-2",
      "child.time": "2026-01-03T00:00:00.000Z",
      "parent.id": "parent-1",
      時刻: "2026-01-03T00:00:00.000Z",
    },
    key: "child-2",
    stream: childStream,
  });

  const list = await queryRecords(
    connectorId,
    parentStream,
    grant,
    { expand: "children", filter: { "filter.key": "include" }, limit: 10, sort: "event-time" },
    manifest
  );
  assert.deepEqual(
    list.data.map((row) => row.id),
    ["parent-1"]
  );
  const [listParent] = list.data;
  assert.ok(listParent);
  assert.equal(listParent.data?.['say"when'], "2026-01-02T00:00:00.000Z");
  assert.equal(listParent.data?.["Unicode 名"], "Unicode field window payload");
  const listChildren = listParent.expanded?.children;
  assert.ok(listChildren);
  assert.deepEqual(
    listChildren.data.map((row) => row.id),
    ["child-1"]
  );
  assert.equal(listChildren.data[0]?.data?.['child "quote"'], "visible expanded child");

  const detail = await getRecord(connectorId, parentStream, "parent-1", grant, manifest, { expand: "children" });
  assert.equal(detail.data?.["id.with.dot"], "parent-1");
  const detailChildren = detail.expanded?.children;
  assert.ok(detailChildren);
  assert.deepEqual(
    detailChildren.data.map((row) => row.id),
    ["child-1"]
  );

  const changes = await queryRecords(
    connectorId,
    parentStream,
    grant,
    { changes_since: "beginning", filter: { "filter.key": "include" } },
    manifest
  );
  assert.deepEqual(
    changes.data.map((row) => row.id),
    ["parent-1"]
  );

  const aggregate = await aggregateRecords(
    connectorId,
    parentStream,
    grant,
    { filter: { "filter.key": "include" }, metric: "count" },
    manifest
  );
  assert.equal(aggregate.filtered_record_count, 1);
  assert.equal(aggregate.value, 1);

  const fieldWindow = await getRecordFieldWindow(connectorId, parentStream, "parent-1", "Unicode 名", grant, manifest, {
    limit_chars: 100,
  });
  assert.equal(fieldWindow.window.text, "Unicode field window payload");
}

test("SQLite record paths accept literal top-level JSON property names", async () => {
  initDb(":memory:");
  try {
    await seedAndAssert(`sqlite_${Date.now()}`);
  } finally {
    closeDb();
  }
});

if (POSTGRES_URL) {
  test("Postgres record paths accept literal top-level JSON property names", async () => {
    const suffix = `postgres_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const { connectorId } = fixture(suffix);
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await seedAndAssert(suffix);
    } finally {
      try {
        await postgresQuery("DELETE FROM record_changes WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM version_counter WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    }
  });
} else {
  test("Postgres record-field-name parity (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // The test body above runs unchanged when a live test database is configured.
  });
}
