// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres expand hydration parity tests (env-gated).
 *
 * Verifies that the Postgres records backend implements the same
 * grant-scoped one-hop parent → child relationship expansion contract
 * the SQLite backend implements in `records.ts#hydrateExpandedRelations`.
 *
 * Environment gate:
 *   - When `PDPP_TEST_POSTGRES_URL` is set, each scenario provisions a
 *     fresh Postgres database/schema state via `initPostgresStorage` /
 *     `closePostgresStorage` and exercises the public
 *     `queryRecords` / `getRecord` API end-to-end against Postgres.
 *   - When unset, this file registers one skipped test so the suite
 *     still acknowledges the proof exists.
 *
 * Spec: openspec/changes/add-postgres-expand-hydration/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  closePostgresStorage,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from "../server/postgres-storage.ts";
import { getRecord as _getRecord, queryRecords as _queryRecords, ingestRecord } from "../server/records.ts";

type ManifestLike = Record<string, unknown>;
interface ExpandedRelation {
  data: { id: string; data?: Record<string, unknown> }[];
  has_more: boolean;
  id?: string;
  object: string;
  stream?: string;
}
interface ResponseItem {
  data?: Record<string, unknown>;
  expanded?: Record<string, ExpandedRelation | null>;
  id: string;
}
interface RecordList {
  data: ResponseItem[];
  object: string;
}
function queryRecords(
  storageTarget: unknown,
  stream: unknown,
  grant: unknown,
  params: unknown,
  manifest: ManifestLike
): Promise<RecordList> {
  return _queryRecords(
    storageTarget as never,
    stream as never,
    grant as never,
    params as never,
    manifest as never
  ) as Promise<RecordList>;
}
function getRecord(
  storageTarget: unknown,
  stream: unknown,
  key: unknown,
  grant: unknown,
  manifest: ManifestLike,
  params: unknown
): Promise<ResponseItem> {
  return _getRecord(
    storageTarget as never,
    stream as never,
    key as never,
    grant as never,
    manifest as never,
    params as never
  ) as Promise<ResponseItem>;
}

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  test("postgres expand hydration parity", async (t) => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_expand_${suffix}`;
    const parentStream = "saved_tracks";
    const childStream = "recently_played";
    const metadataStream = "track_metadata";

    const manifest: ManifestLike = {
      capabilities: { human_interaction: [] },
      connector_id: connectorId,
      display_name: "Postgres Expand Hydration Test",
      protocol_version: "0.1.0",
      streams: [
        {
          consent_time_field: "saved_at",
          cursor_field: "saved_at",
          name: parentStream,
          primary_key: ["id"],
          query: {
            expand: [{ default_limit: 10, max_limit: 50, name: "recently_played" }, { name: "metadata" }],
          },
          relationships: [
            {
              cardinality: "has_many",
              foreign_key: "track_id",
              name: "recently_played",
              stream: childStream,
            },
            {
              cardinality: "has_one",
              foreign_key: "track_id",
              name: "metadata",
              stream: metadataStream,
            },
          ],
          schema: {
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              saved_at: { format: "date-time", type: "string" },
            },
            required: ["id"],
            type: "object",
          },
          selection: { fields: true, resources: false },
        },
        {
          consent_time_field: "played_at",
          cursor_field: "played_at",
          name: childStream,
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              played_at: { format: "date-time", type: "string" },
              track_id: { type: "string" },
              track_name: { type: "string" },
            },
            required: ["id", "track_id"],
            type: "object",
          },
          selection: { fields: true, resources: false },
        },
        {
          consent_time_field: "updated_at",
          cursor_field: "updated_at",
          name: metadataStream,
          primary_key: ["id"],
          schema: {
            properties: {
              id: { type: "string" },
              isrc: { type: "string" },
              note: { type: "string" },
              track_id: { type: "string" },
              updated_at: { format: "date-time", type: "string" },
            },
            required: ["id", "track_id"],
            type: "object",
          },
          selection: { fields: true, resources: false },
        },
      ],
      version: "1.0.0",
    };

    const grantWithChild = {
      streams: [
        { fields: ["id", "name", "saved_at"], name: parentStream },
        { fields: ["id", "track_id", "played_at"], name: childStream },
      ],
    };

    const grantWithoutChild = {
      streams: [{ fields: ["id", "name", "saved_at"], name: parentStream }],
    };

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    t.after(async () => {
      // Clean up our records / record_changes / version_counter rows for
      // this connector so parallel runs don't leak. We do not drop schema
      // because other suites may share the connection.
      try {
        await postgresQuery(
          `DELETE FROM record_changes WHERE connector_id = $1;
           DELETE FROM records WHERE connector_id = $1;
           DELETE FROM version_counter WHERE connector_id = $1;
           DELETE FROM connector_instances WHERE connector_id = $1;
           DELETE FROM connectors WHERE connector_id = $1;`,
          [connectorId]
        );
      } catch {
        /* intentional: cleanup is best-effort */
      }
      await closePostgresStorage();
      closeDb();
    });

    await registerConnector(manifest);

    await ingestRecord(connectorId, {
      data: {
        id: "track_1",
        name: "Track 1",
        saved_at: "2026-02-01T00:00:00Z",
      },
      key: "track_1",
      stream: parentStream,
    });
    await ingestRecord(connectorId, {
      data: {
        id: "track_2",
        name: "Track 2",
        saved_at: "2026-02-02T00:00:00Z",
      },
      key: "track_2",
      stream: parentStream,
    });
    await Promise.all(
      [
        { id: "play_1", played_at: "2026-02-02T00:00:00Z", track_id: "track_1", track_name: "Track 1" },
        { id: "play_2", played_at: "2026-02-03T00:00:00Z", track_id: "track_1", track_name: "Track 1" },
        { id: "play_3", played_at: "2026-02-04T00:00:00Z", track_id: "track_1", track_name: "Track 1" },
        { id: "play_4", played_at: "2026-02-05T00:00:00Z", track_id: "track_2", track_name: "Track 2" },
      ].map((play) => ingestRecord(connectorId, { data: play, key: play.id, stream: childStream }))
    );
    // Seed one metadata row per track for has_one coverage. track_1 has a
    // record; track_2 deliberately has no metadata so we can prove the
    // has_one path returns `null` for missing children.
    await ingestRecord(connectorId, {
      data: {
        id: "meta_1",
        isrc: "USRC17600001",
        note: "note that should be projected away",
        track_id: "track_1",
        updated_at: "2026-02-10T00:00:00Z",
      },
      key: "meta_1",
      stream: metadataStream,
    });

    await t.test("Postgres backend is active for these assertions", () => {
      assert.equal(isPostgresStorageBackend(), true, "Postgres backend should be active");
    });

    await t.test("list endpoint hydrates has_many with per-parent has_more and child grant projection", async () => {
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithChild,
        { expand: "recently_played", expand_limit: { recently_played: 1 }, order: "asc" },
        manifest
      );
      assert.equal(result.object, "list");
      assert.equal(result.data.length, 2);
      const track1 = result.data.find((row: { id: string }) => row.id === "track_1");
      assert.ok(track1, "track_1 should be present");
      assert.ok(track1.expanded?.recently_played, "expanded.recently_played should exist on track_1");
      assert.equal(track1.expanded.recently_played.object, "list");
      assert.equal(track1.expanded.recently_played.has_more, true);
      assert.equal(track1.expanded.recently_played.data.length, 1);
      const [child] = track1.expanded.recently_played.data;
      assert.ok(child, "first child should be present");
      assert.equal(child.id, "play_1");
      assert.deepEqual(Object.keys(child.data || {}).sort(), ["id", "played_at", "track_id"]);
      assert.ok(!("track_name" in (child.data || {})));

      const track2 = result.data.find((row: { id: string }) => row.id === "track_2");
      assert.ok(track2, "track_2 should be present");
      assert.ok(track2.expanded?.recently_played, "expanded.recently_played should exist on track_2");
      assert.equal(track2.expanded.recently_played.has_more, false);
      assert.equal(track2.expanded.recently_played.data.length, 1);
      assert.equal(track2.expanded.recently_played.data[0]?.id, "play_4");
    });

    await t.test("list endpoint hydrates the default limit when expand_limit is omitted", async () => {
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithChild,
        { expand: "recently_played", order: "asc" },
        manifest
      );
      const track1 = result.data.find((row: { id: string }) => row.id === "track_1");
      assert.ok(track1, "track_1 should be present");
      assert.ok(track1.expanded?.recently_played, "track_1 expanded.recently_played must exist");
      // 3 children for track_1, default_limit=10, so all 3 fit without has_more.
      assert.equal(track1.expanded.recently_played.data.length, 3);
      assert.equal(track1.expanded.recently_played.has_more, false);
      assert.deepEqual(
        track1.expanded.recently_played.data.map((c: { id: string }) => c.id),
        ["play_1", "play_2", "play_3"]
      );
    });

    await t.test("detail endpoint hydrates the same expansion shape", async () => {
      const detail = await getRecord(connectorId, parentStream, "track_1", grantWithChild, manifest, {
        expand: "recently_played",
        expand_limit: { recently_played: 2 },
      });
      assert.equal(detail.id, "track_1");
      assert.ok(detail.expanded?.recently_played);
      assert.equal(detail.expanded.recently_played.has_more, true);
      assert.equal(detail.expanded.recently_played.data.length, 2);
      assert.deepEqual(
        detail.expanded.recently_played.data.map((c: { id: string }) => c.id),
        ["play_1", "play_2"]
      );
    });

    await t.test("insufficient_scope when child stream is not in grant", async () => {
      await assert.rejects(
        () => queryRecords(connectorId, parentStream, grantWithoutChild, { expand: "recently_played" }, manifest),
        (err: { code: string }) => err.code === "insufficient_scope"
      );
    });

    await t.test("invalid_expand on unsupported relation", async () => {
      await assert.rejects(
        () => queryRecords(connectorId, parentStream, grantWithChild, { expand: "not_a_relation" }, manifest),
        (err: { code: string }) => err.code === "invalid_expand"
      );
    });

    await t.test("invalid_expand when combined with changes_since", async () => {
      await assert.rejects(
        () =>
          queryRecords(
            connectorId,
            parentStream,
            grantWithChild,
            { changes_since: "beginning", expand: "recently_played" },
            manifest
          ),
        (err: { code: string }) => err.code === "invalid_expand"
      );
    });

    await t.test("invalid_expand when expand_limit exceeds max_limit", async () => {
      await assert.rejects(
        () =>
          queryRecords(
            connectorId,
            parentStream,
            grantWithChild,
            { expand: "recently_played", expand_limit: { recently_played: 9999 } },
            manifest
          ),
        (err: { code: string }) => err.code === "invalid_expand"
      );
    });

    await t.test("list endpoint hydrates has_one with grant-projected child or null when no match", async () => {
      const grantWithMetadata = {
        streams: [
          { fields: ["id", "name", "saved_at"], name: parentStream },
          { fields: ["id", "track_id", "played_at"], name: childStream },
          { fields: ["id", "track_id", "isrc", "updated_at"], name: metadataStream },
        ],
      };
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithMetadata,
        { expand: "metadata", order: "asc" },
        manifest
      );
      const track1 = result.data.find((row: { id: string }) => row.id === "track_1");
      assert.ok(track1, "track_1 should be present");
      assert.ok(track1.expanded, "track_1.expanded must be present");
      assert.ok("metadata" in track1.expanded, "has_one expansion key must be present");
      const meta1 = track1.expanded.metadata;
      assert.ok(meta1 && meta1.object === "record", "has_one must hydrate a single record (not a list envelope)");
      assert.equal(meta1.id, "meta_1");
      assert.equal(meta1.stream, metadataStream);
      assert.deepEqual(
        Object.keys(meta1.data || {}).sort(),
        ["id", "isrc", "track_id", "updated_at"],
        "has_one child must be projected through the child grant fields"
      );
      assert.ok(!("note" in (meta1.data || {})), "fields outside child grant must not leak");

      const track2 = result.data.find((row: { id: string }) => row.id === "track_2");
      assert.ok(track2, "track_2 should be present");
      assert.ok(track2.expanded, "track_2.expanded must be present");
      assert.ok("metadata" in track2.expanded, "has_one key must be present even when no match");
      assert.equal(
        track2.expanded.metadata,
        null,
        "has_one must surface null (not omitted) when there is no matching child"
      );
    });

    await t.test("invalid_expand when expand_limit is sent for a has_one relation", async () => {
      const grantWithMetadata = {
        streams: [
          { fields: ["id", "name", "saved_at"], name: parentStream },
          { fields: ["id", "track_id", "isrc", "updated_at"], name: metadataStream },
        ],
      };
      await assert.rejects(
        () =>
          queryRecords(
            connectorId,
            parentStream,
            grantWithMetadata,
            { expand: "metadata", expand_limit: { metadata: 2 } },
            manifest
          ),
        (err: { code: string }) => err.code === "invalid_expand"
      );
    });

    await t.test("child grant time_constraint narrows expansion children in SQL", async () => {
      // play_1=2026-02-02, play_2=2026-02-03, play_3=2026-02-04, play_4=2026-02-05.
      // Narrow the child grant to [2026-02-03, 2026-02-05) → play_2 and play_3
      // only for track_1; track_2 (play_4 at 2026-02-05) is `until`-excluded.
      const grantWithTimeConstraint = {
        streams: [
          { fields: ["id", "name", "saved_at"], name: parentStream },
          {
            fields: ["id", "track_id", "played_at"],
            name: childStream,
            time_constraint: {
              field: "played_at",
              since: "2026-02-03T00:00:00Z",
              until: "2026-02-05T00:00:00Z",
            },
          },
        ],
      };
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithTimeConstraint,
        { expand: "recently_played", order: "asc" },
        manifest
      );
      const track1 = result.data.find((row: { id: string }) => row.id === "track_1");
      assert.ok(track1, "track_1 should be present");
      assert.ok(track1.expanded?.recently_played, "track_1 should still have expansion list");
      assert.deepEqual(
        track1.expanded.recently_played.data.map((c: { id: string }) => c.id),
        ["play_2", "play_3"],
        "only children inside the frozen grant time_constraint should appear"
      );
      assert.equal(track1.expanded.recently_played.has_more, false);

      const track2 = result.data.find((row: { id: string }) => row.id === "track_2");
      assert.ok(track2, "track_2 should be present");
      assert.ok(track2.expanded?.recently_played, "track_2 should have expansion list");
      assert.equal(
        track2.expanded.recently_played.data.length,
        0,
        "track_2 has only play_4 at the until boundary, which must be excluded by `until` (half-open)"
      );
      assert.equal(track2.expanded.recently_played.has_more, false);
    });

    await t.test("child grant resources narrows expansion children to allowed record keys", async () => {
      const grantWithResources = {
        streams: [
          { fields: ["id", "name", "saved_at"], name: parentStream },
          {
            fields: ["id", "track_id", "played_at"],
            name: childStream,
            resources: ["play_1", "play_3"],
          },
        ],
      };
      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithResources,
        { expand: "recently_played", order: "asc" },
        manifest
      );
      const track1 = result.data.find((row: { id: string }) => row.id === "track_1");
      assert.ok(track1, "track_1 should be present");
      assert.ok(track1.expanded?.recently_played, "track_1 must have expansion list");
      assert.deepEqual(
        track1.expanded.recently_played.data.map((c: { id: string }) => c.id),
        ["play_1", "play_3"],
        "only resource-allowed children should appear in the expansion"
      );
      assert.equal(track1.expanded.recently_played.has_more, false);

      const track2 = result.data.find((row: { id: string }) => row.id === "track_2");
      assert.ok(track2, "track_2 should be present");
      assert.ok(track2.expanded?.recently_played, "track_2 must have expansion list");
      assert.equal(
        track2.expanded.recently_played.data.length,
        0,
        "track_2's only child (play_4) is not in the resources allowlist"
      );
    });

    await t.test("cross-connector-instance isolation: children from another instance are not visible", async () => {
      const otherInstance = {
        connector_id: connectorId,
        connector_instance_id: `cin_${suffix}_isolation`,
      };
      // Seed a play row in a different connector instance that points to
      // the same parent FK. It must NOT appear in the expansion.
      await ingestRecord(otherInstance, {
        data: {
          id: "play_iso",
          played_at: "2026-02-06T00:00:00Z",
          track_id: "track_1",
          track_name: "Cross instance leak",
        },
        key: "play_iso",
        stream: childStream,
      });

      const result = await queryRecords(
        connectorId,
        parentStream,
        grantWithChild,
        { expand: "recently_played", order: "asc" },
        manifest
      );
      const track1 = result.data.find((row: { id: string }) => row.id === "track_1");
      assert.ok(track1, "track_1 should be present");
      assert.ok(track1.expanded?.recently_played, "track_1 must have expansion list");
      assert.equal(track1.expanded.recently_played.data.length, 3);
      assert.ok(
        track1.expanded.recently_played.data.every((c: { id: string }) => c.id !== "play_iso"),
        "cross-connector-instance child must not leak into expansion"
      );
    });
  });
} else {
  test("postgres expand hydration parity (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    // skip
  });
}
