// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { getRecord as getRecordUntyped, ingestRecord, queryRecords as queryRecordsUntyped } from "../server/records.ts";

interface StorageTarget {
  connector_id: string;
  connector_instance_id: string;
}
type Manifest = Parameters<typeof registerConnector>[0];
interface ExpandedList {
  data: ResponseRecord[];
  has_more: boolean;
  object: "list";
}
interface ResponseRecord {
  data: Record<string, unknown>;
  expanded?: Record<string, ExpandedList | null>;
  id: string;
}
interface RecordList {
  data: ResponseRecord[];
}

function queryRecords(
  storageTarget: StorageTarget,
  stream: string,
  grant: unknown,
  params: Record<string, unknown>,
  manifest: Manifest
): Promise<RecordList> {
  return queryRecordsUntyped(storageTarget, stream, grant as never, params, manifest as never) as Promise<RecordList>;
}

function getRecord(
  storageTarget: StorageTarget,
  stream: string,
  key: string,
  grant: unknown,
  manifest: Manifest,
  params: Record<string, unknown>
): Promise<ResponseRecord> {
  return getRecordUntyped(
    storageTarget,
    stream,
    key,
    grant as never,
    manifest as never,
    params
  ) as Promise<ResponseRecord>;
}

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

function manifestFor(connectorId: string, includeNewRequiredFields: boolean): Manifest {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorId,
    display_name: "Expansion Instance Authorization Test",
    manifest_uri: `https://sources.example/${connectorId}`,
    protocol_version: "0.1.0",
    streams: [
      {
        name: "parents",
        primary_key: ["id"],
        query: {
          expand: [{ default_limit: 10, max_limit: 20, name: "children" }, { name: "featured_child" }],
        },
        relationships: [
          {
            cardinality: "has_many",
            foreign_key: "parent_id",
            name: "children",
            stream: "children",
          },
          {
            cardinality: "has_one",
            foreign_key: "parent_id",
            name: "featured_child",
            stream: "children",
          },
        ],
        schema: {
          properties: {
            id: { type: "string" },
            newly_required_parent: { type: "string" },
            parent_id: { type: "string" },
            title: { type: "string" },
          },
          required: includeNewRequiredFields ? ["id", "newly_required_parent"] : ["id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
      {
        name: "children",
        primary_key: ["id"],
        schema: {
          properties: {
            "event-time": { format: "date-time", type: "string" },
            id: { type: "string" },
            newly_required_child: { type: "string" },
            parent_id: { type: "string" },
            visible: { type: "string" },
          },
          required: includeNewRequiredFields ? ["id", "parent_id", "newly_required_child"] : ["id", "parent_id"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: includeNewRequiredFields ? "2.0.0" : "1.0.0",
  } as Manifest;
}

async function seed(targetA: StorageTarget, targetB: StorageTarget): Promise<void> {
  await ingestRecord(targetA, {
    data: { id: "parent-1", newly_required_parent: "must not widen client output", title: "Parent" },
    key: "parent-1",
    stream: "parents",
  });
  await ingestRecord(targetA, {
    data: {
      "event-time": "2025-12-31T00:00:00Z",
      id: "child-before-window",
      newly_required_child: "must not widen client output",
      parent_id: "parent-1",
      visible: "before",
    },
    key: "child-before-window",
    stream: "children",
  });
  await ingestRecord(targetA, {
    data: {
      "event-time": "2026-02-01T00:00:00Z",
      id: "child-allowed",
      newly_required_child: "must not widen client output",
      parent_id: "parent-1",
      visible: "allowed",
    },
    key: "child-allowed",
    stream: "children",
  });
  await ingestRecord(targetA, {
    data: {
      "event-time": "2026-02-02T00:00:00Z",
      id: "child-outside-resource-set",
      newly_required_child: "must not widen client output",
      parent_id: "parent-1",
      visible: "not selected",
    },
    key: "child-outside-resource-set",
    stream: "children",
  });
  await ingestRecord(targetB, {
    data: {
      "event-time": "2026-02-03T00:00:00Z",
      id: "child-on-b",
      newly_required_child: "B",
      parent_id: "parent-1",
      visible: "other connection",
    },
    key: "child-on-b",
    stream: "children",
  });
}

async function runAuthorizationScenario(backend: "sqlite" | "postgres"): Promise<void> {
  const suffix = `${backend}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const connectorId = `expand_instance_${suffix}`;
  const instanceA = `cin_${suffix}_a`;
  const instanceB = `cin_${suffix}_b`;
  const targetA = { connector_id: connectorId, connector_instance_id: instanceA };
  const targetB = { connector_id: connectorId, connector_instance_id: instanceB };
  const originalManifest = manifestFor(connectorId, false);
  const manifest = manifestFor(connectorId, true);

  initDb(":memory:");
  if (backend === "postgres") {
    assert.ok(POSTGRES_URL, "PostgreSQL URL must be configured");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  }

  try {
    await registerConnector(originalManifest);
    await seed(targetA, targetB);

    // The grants below represent authorization resolved against v1. The
    // current declaration then adds required fields before either backend
    // serves those frozen grants.
    await registerConnector(manifest);

    const wrongChildInstanceGrant = {
      streams: [
        { fields: ["id", "title"], instance_ids: [instanceA], name: "parents" },
        { fields: ["id", "parent_id", "visible"], instance_ids: [instanceB], name: "children" },
      ],
    };
    await assert.rejects(
      () => queryRecords(targetA, "parents", wrongChildInstanceGrant, { expand: "children" }, manifest),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string; param?: string }).code === "connection_not_found" &&
        (error as Error & { code?: string; param?: string }).param === "connection_id"
    );
    await assert.rejects(
      () => queryRecords(targetA, "parents", wrongChildInstanceGrant, { expand: "featured_child" }, manifest),
      (error: unknown) =>
        error instanceof Error &&
        (error as Error & { code?: string; param?: string }).code === "connection_not_found" &&
        (error as Error & { code?: string; param?: string }).param === "connection_id"
    );

    const closedGrant = {
      streams: [
        { fields: ["id", "title"], instance_ids: [instanceA], name: "parents" },
        {
          fields: ["id", "parent_id", "visible"],
          instance_ids: [instanceA],
          name: "children",
          resources: ["child-allowed"],
          time_constraint: { field: "event-time", since: "2026-01-01T00:00:00Z" },
        },
      ],
    };
    const page = await queryRecords(targetA, "parents", closedGrant, { expand: "children" }, manifest);
    assert.equal(page.data.length, 1);
    const [parent] = page.data;
    assert.ok(parent);
    assert.deepEqual(parent.data, { id: "parent-1", title: "Parent" });
    const children = parent.expanded?.children;
    assert.ok(children);
    assert.equal(children.object, "list");
    assert.equal(children.has_more, false);
    assert.deepEqual(
      children.data.map((row: { data: unknown; id: string }) => [row.id, row.data]),
      [["child-allowed", { id: "child-allowed", parent_id: "parent-1", visible: "allowed" }]]
    );

    const detail = await getRecord(targetA, "parents", "parent-1", closedGrant, manifest, {
      expand: "children",
    });
    assert.deepEqual(detail.data, { id: "parent-1", title: "Parent" });
    const detailChildren = detail.expanded?.children;
    assert.ok(detailChildren);
    assert.deepEqual(
      detailChildren.data.map((row: { data: unknown; id: string }) => [row.id, row.data]),
      [["child-allowed", { id: "child-allowed", parent_id: "parent-1", visible: "allowed" }]]
    );

    // Owner grants omit instance_ids. They retain unrestricted self-read
    // behavior, including fields in the current manifest declaration.
    const ownerGrant = { streams: [{ name: "parents" }, { name: "children" }] };
    const ownerPage = await queryRecords(targetA, "parents", ownerGrant, { expand: "children" }, manifest);
    const [ownerParent] = ownerPage.data;
    assert.ok(ownerParent);
    assert.equal(ownerParent.data.newly_required_parent, "must not widen client output");
    const ownerChildren = ownerParent.expanded?.children;
    assert.ok(ownerChildren);
    assert.equal(ownerChildren.data.length, 3);
    const [ownerChild] = ownerChildren.data;
    assert.ok(ownerChild);
    assert.equal(ownerChild.data.newly_required_child, "must not widen client output");
  } finally {
    if (backend === "postgres") {
      try {
        await postgresQuery("DELETE FROM record_changes WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM records WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM version_counter WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [connectorId]);
        await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
      } finally {
        await closePostgresStorage();
      }
    }
    closeDb();
  }
}

test("SQLite expand enforces child instance scope and frozen declaration fields", async () => {
  await runAuthorizationScenario("sqlite");
});

test("PostgreSQL expand enforces child instance scope and frozen declaration fields", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL is not set",
}, async () => {
  await runAuthorizationScenario("postgres");
});
