// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import {
  deleteAllRecordsForConnector,
  getRecord as getRecordUntyped,
  ingestRecord,
  listAllStreams,
  queryRecords as queryRecordsUntyped,
} from "../server/records.ts";
import { lexicalIndexBackfillForManifest as lexicalIndexBackfillForManifestUntyped } from "../server/search.ts";
import { buildSemanticSearchPlanForGrant as buildSemanticSearchPlanForGrantUntyped } from "../server/search-semantic.ts";

// queryRecords/getRecord/lexicalIndexBackfillForManifest are imported from
// checkJs:false JS. Their `manifest` parameters are either inferred as the
// literal `null` (from a `manifest = null` default) or omitted entirely
// from the inferred destructured-object type (no default at all), so a
// real manifest object never satisfies either signature. These wrappers
// restate the real contracts, verified against the source bodies.
interface QueryRecordsResult {
  data: Array<{ data: { subject?: string } }>;
  next_changes_since?: string | null;
}

type QueryRecordsFn = (
  storageTarget: unknown,
  stream: string,
  grant: unknown,
  requestParams: Record<string, unknown>,
  manifest: unknown
) => Promise<QueryRecordsResult>;

const queryRecords = queryRecordsUntyped as QueryRecordsFn;

interface GetRecordResult {
  data: { subject?: string };
}

type GetRecordFn = (
  storageTarget: unknown,
  stream: string,
  recordId: string,
  grant: unknown,
  manifest: unknown
) => Promise<GetRecordResult>;

const getRecord = getRecordUntyped as GetRecordFn;

type LexicalIndexBackfillForManifestFn = (input: { manifest: unknown }) => Promise<unknown>;

const lexicalIndexBackfillForManifest = lexicalIndexBackfillForManifestUntyped as LexicalIndexBackfillForManifestFn;

interface SemanticSearchPlanEntry {
  candidateRecordKeys?: string[];
  connectorInstanceId?: string;
}

interface SemanticSearchPlanInput {
  compiledFilter?: unknown;
  connectorId?: string;
  connectorInstanceId?: string;
  grant: unknown;
  manifest: unknown;
  streamsFilter: string[] | null;
}

// buildSemanticSearchPlanForGrant is imported from checkJs:false JS. Its
// destructured params (connectorId/connectorInstanceId) default to `null`,
// which TS infers as exactly `null | undefined`, rejecting real string
// arguments; its return is a union across branches, so `connectorInstanceId`/
// `candidateRecordKeys` are only present on some entries -- both restated
// here from the source body rather than suppressed. The real inferred
// function type and this restated type don't overlap enough for a direct
// function-value cast, so the call itself is typed instead: arguments
// widened to `unknown` (always assignable) and the return narrowed via a
// single-hop cast to the type above.
function buildSemanticSearchPlanForGrant(input: SemanticSearchPlanInput): SemanticSearchPlanEntry[] {
  const untyped = buildSemanticSearchPlanForGrantUntyped as (input: unknown) => unknown;
  return untyped(input) as SemanticSearchPlanEntry[];
}

const CONNECTOR_ID = "instance-records";
const SPOTIFY_REGISTRY_CONNECTOR_ID = "https://registry.pdpp.dev/connectors/spotify";
const SPOTIFY_CONNECTOR_KEY = "spotify";
const WORK_INSTANCE_ID = "cin_test_records_work";
const PERSONAL_INSTANCE_ID = "cin_test_records_personal";
const STREAM = "messages";

const grant = {
  streams: [{ fields: ["id", "subject"], name: STREAM }],
};

const manifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Instance Records",
  protocol_version: "0.1.0",
  streams: [
    {
      name: STREAM,
      primary_key: ["id"],
      query: { search: { lexical_fields: ["subject"], semantic_fields: ["subject"] } },
      schema: {
        properties: {
          id: { type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject"],
        type: "object",
      },
    },
  ],
  version: "1.0.0",
};

function setup() {
  initDb();
}

function teardown() {
  closeDb();
}

function target(connectorInstanceId: string): { connector_id: string; connector_instance_id: string } {
  return {
    connector_id: CONNECTOR_ID,
    connector_instance_id: connectorInstanceId,
  };
}

function upsert(subject: string) {
  return {
    data: {
      id: "same-key",
      subject,
    },
    emitted_at: "2026-05-18T12:00:00.000Z",
    key: "same-key",
    stream: STREAM,
  };
}

test("records with the same connector type, stream, and key are isolated by connector instance", async () => {
  setup();
  try {
    await registerConnector(manifest);
    const work = target(WORK_INSTANCE_ID);
    const personal = target(PERSONAL_INSTANCE_ID);

    await ingestRecord(work, upsert("work account"));
    await ingestRecord(personal, upsert("personal account"));
    await ingestRecord(work, upsert("work account updated"));

    interface LiveRecordRow {
      connector_instance_id: string;
      record_json: string;
      version: number;
    }

    const liveRows = getDb()
      .prepare(
        `SELECT connector_instance_id, record_json, version
           FROM records
          WHERE connector_id = ? AND stream = ? AND record_key = ?
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM, "same-key") as LiveRecordRow[];

    assert.equal(liveRows.length, 2);
    assert.deepEqual(
      liveRows.map((row) => [row.connector_instance_id, JSON.parse(row.record_json).subject, row.version]),
      [
        [PERSONAL_INSTANCE_ID, "personal account", 1],
        [WORK_INSTANCE_ID, "work account updated", 2],
      ]
    );

    interface CounterRow {
      connector_instance_id: string;
      max_version: number;
    }

    const counters = getDb()
      .prepare(
        `SELECT connector_instance_id, max_version
           FROM version_counter
          WHERE connector_id = ? AND stream = ?
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM) as CounterRow[];

    assert.deepEqual(
      counters.map((row) => [row.connector_instance_id, row.max_version]),
      [
        [PERSONAL_INSTANCE_ID, 1],
        [WORK_INSTANCE_ID, 2],
      ]
    );

    const workChanges = await queryRecords(work, STREAM, grant, { changes_since: "beginning" }, manifest);
    const personalChanges = await queryRecords(personal, STREAM, grant, { changes_since: "beginning" }, manifest);

    assert.deepEqual(
      workChanges.data.map((row) => row.data.subject),
      ["work account updated"]
    );
    assert.deepEqual(
      personalChanges.data.map((row) => row.data.subject),
      ["personal account"]
    );
    assert.notEqual(workChanges.next_changes_since, personalChanges.next_changes_since);

    const workRecord = await getRecord(work, STREAM, "same-key", grant, manifest);
    const personalRecord = await getRecord(personal, STREAM, "same-key", grant, manifest);

    assert.equal(workRecord.data.subject, "work account updated");
    assert.equal(personalRecord.data.subject, "personal account");

    await lexicalIndexBackfillForManifest({
      manifest: { ...manifest, storage_binding: { connector_instance_id: WORK_INSTANCE_ID } },
    });
    await lexicalIndexBackfillForManifest({
      manifest: { ...manifest, storage_binding: { connector_instance_id: PERSONAL_INSTANCE_ID } },
    });

    interface LexicalIndexRow {
      connector_instance_id: string;
      field: string;
      record_key: string;
      text: string;
    }

    const lexicalRows = getDb()
      .prepare(
        `SELECT connector_instance_id, record_key, field, text
          FROM lexical_search_index
          WHERE connector_id = ? AND stream = ? AND record_key = ?
            AND connector_instance_id IN (?, ?)
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM, "same-key", PERSONAL_INSTANCE_ID, WORK_INSTANCE_ID) as LexicalIndexRow[];

    assert.deepEqual(
      lexicalRows.map((row) => [row.connector_instance_id, row.record_key, row.field, row.text]),
      [
        [PERSONAL_INSTANCE_ID, "same-key", "subject", "personal account"],
        [WORK_INSTANCE_ID, "same-key", "subject", "work account updated"],
      ]
    );

    interface LexicalMetaRow {
      connector_instance_id: string;
      fields_fingerprint: string;
    }

    const lexicalMeta = getDb()
      .prepare(
        `SELECT connector_instance_id, fields_fingerprint
          FROM lexical_search_meta
          WHERE connector_id = ? AND stream = ?
            AND connector_instance_id IN (?, ?)
          ORDER BY connector_instance_id`
      )
      .all(CONNECTOR_ID, STREAM, PERSONAL_INSTANCE_ID, WORK_INSTANCE_ID) as LexicalMetaRow[];

    assert.deepEqual(
      lexicalMeta.map((row) => [row.connector_instance_id, row.fields_fingerprint]),
      [
        [PERSONAL_INSTANCE_ID, '["subject"]'],
        [WORK_INSTANCE_ID, '["subject"]'],
      ]
    );
  } finally {
    teardown();
  }
});

test("record storage canonicalizes URL-shaped first-party connector ids at the storage boundary", async () => {
  setup();
  try {
    await ingestRecord(SPOTIFY_REGISTRY_CONNECTOR_ID, {
      data: { id: "artist_owner_top_1", name: "Nils Frahm" },
      emitted_at: "2026-04-23T10:00:00.000Z",
      key: "artist_owner_top_1",
      stream: "top_artists",
    });

    const stored = getDb().prepare("SELECT connector_id, stream, record_key FROM records").all();
    assert.deepEqual(stored, [
      {
        connector_id: SPOTIFY_CONNECTOR_KEY,
        record_key: "artist_owner_top_1",
        stream: "top_artists",
      },
    ]);

    const canonicalStreams = (await listAllStreams(SPOTIFY_CONNECTOR_KEY)) as Array<{ name: string }>;
    const urlAliasStreams = (await listAllStreams(SPOTIFY_REGISTRY_CONNECTOR_ID)) as Array<{ name: string }>;
    assert.deepEqual(
      canonicalStreams.map((stream) => stream.name),
      ["top_artists"]
    );
    assert.deepEqual(
      urlAliasStreams.map((stream) => stream.name),
      ["top_artists"]
    );
  } finally {
    teardown();
  }
});

test("semantic candidate planning scans connector instance namespace, not connector type namespace", async () => {
  setup();
  try {
    await registerConnector(manifest);
    const work = target(WORK_INSTANCE_ID);
    const personal = target(PERSONAL_INSTANCE_ID);

    await ingestRecord(work, upsert("work account"));
    await ingestRecord(personal, upsert("personal account"));

    const plan = buildSemanticSearchPlanForGrant({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: WORK_INSTANCE_ID,
      grant: {
        streams: [
          {
            fields: ["id", "subject"],
            name: STREAM,
            resources: ["same-key"],
            time_range: {
              since: "2026-05-18T00:00:00.000Z",
              until: "2026-05-19T00:00:00.000Z",
            },
          },
        ],
      },
      manifest,
      streamsFilter: null,
    });

    assert.deepEqual(
      plan.map((entry) => entry.connectorInstanceId),
      [WORK_INSTANCE_ID]
    );
    assert.deepEqual(
      plan.map((entry) => entry.candidateRecordKeys),
      [["same-key"]]
    );
  } finally {
    teardown();
  }
});

test("manifest reset cleanup leaves rows outside discovered record instance namespaces intact", async () => {
  setup();
  try {
    await registerConnector(manifest);
    await ingestRecord(target(WORK_INSTANCE_ID), upsert("work account"));

    const db = getDb();
    db.prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES(?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      CONNECTOR_ID,
      PERSONAL_INSTANCE_ID,
      STREAM,
      "orphan-change",
      1,
      JSON.stringify({ id: "orphan-change" }),
      "2026-05-18T12:00:00.000Z"
    );
    db.prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `blob_sha256_${"a".repeat(64)}`,
      CONNECTOR_ID,
      PERSONAL_INSTANCE_ID,
      STREAM,
      "orphan-change",
      "text/plain",
      1,
      "a".repeat(64),
      Buffer.from("x")
    );
    db.prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, ?)`
    ).run(`blob_sha256_${"a".repeat(64)}`, CONNECTOR_ID, PERSONAL_INSTANCE_ID, STREAM, "orphan-change", "@record");

    const result = await deleteAllRecordsForConnector(CONNECTOR_ID);

    assert.equal(result.deletedCount, 1);
    assert.deepEqual(result.streams, [STREAM]);
    const workRecords = db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?")
      .get(WORK_INSTANCE_ID);
    const personalChanges = db
      .prepare("SELECT COUNT(*) AS n FROM record_changes WHERE connector_instance_id = ?")
      .get(PERSONAL_INSTANCE_ID);
    const personalBindings = db
      .prepare("SELECT COUNT(*) AS n FROM blob_bindings WHERE connector_instance_id = ?")
      .get(PERSONAL_INSTANCE_ID);
    assert.ok(workRecords && personalChanges && personalBindings, "aggregate queries return their count rows");
    assert.equal(workRecords.n, 0);
    assert.equal(personalChanges.n, 1);
    assert.equal(personalBindings.n, 1);
  } finally {
    teardown();
  }
});
