// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PR102 SourceDeclaration field references are non-empty strings that name
 * literal top-level schema.properties keys. They are not JavaScript or SQL
 * identifiers. These integration-focused regressions cover each local
 * consumer in this lane with representative hyphen, dot, quote, and Unicode
 * names.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reconcileDirtyDatasetSummaryRecordTimeBounds } from "../server/dataset-summary-read-model.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { computeIngestSemanticTime, getManifestConsentTimeField } from "../server/record-ingest-semantic-time.ts";
import { collectRecordsTimelineEntries } from "../server/ref-control.ts";

const FIELD_NAMES = ["event-time", "occurred.at", 'said "when"', "時刻"] as const;
const AUTHORED_AT = "2026-02-03T04:05:06.000Z";
const EMITTED_AT = "2026-03-04T05:06:07.000Z";

async function withTempDb<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-source-field-names-"));
  try {
    initDb(join(dir, "pdpp.sqlite"));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
}

function storeManifest(connectorId: string, streams: readonly Record<string, unknown>[]): void {
  getDb()
    .prepare(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES (?, ?, ?)`
    )
    .run(
      connectorId,
      JSON.stringify({
        connector_id: connectorId,
        display_name: connectorId,
        protocol_version: "0.1",
        streams,
        version: "1",
      }),
      EMITTED_AT
    );
}

function streamManifest(name: string, field: string): Record<string, unknown> {
  return {
    consent_time_field: field,
    name,
    primary_key: "id",
    schema: {
      properties: {
        id: { type: "string" },
        [field]: { format: "date-time", type: "string" },
      },
      required: ["id"],
      type: "object",
    },
  };
}

test("semantic ingest resolves arbitrary literal consent_time_field names", () =>
  withTempDb(() => {
    for (const [index, field] of FIELD_NAMES.entries()) {
      const connectorId = `ingest-field-${index}`;
      const stream = `events-${index}`;
      storeManifest(connectorId, [streamManifest(stream, field)]);

      assert.equal(getManifestConsentTimeField(connectorId, stream), field);
      assert.equal(
        computeIngestSemanticTime(connectorId, stream, { [field]: AUTHORED_AT, id: String(index) }, EMITTED_AT),
        AUTHORED_AT,
        field
      );
    }
  }));

test("dataset-summary reconciliation forwards arbitrary literal consent_time_field names", () =>
  withTempDb(async () => {
    const insert = getDb().prepare(
      `INSERT INTO dataset_summary_stream_projection(
         connector_id,
         stream,
         record_count,
         record_json_bytes,
         consent_time_field,
         dirty_record_time_bounds,
         computed_at
       ) VALUES (?, ?, 1, 1, ?, 1, ?)`
    );
    for (const [index, field] of FIELD_NAMES.entries()) {
      insert.run("summary-fields", `events-${index}`, field, EMITTED_AT);
    }

    const observed: string[] = [];
    const result = await reconcileDirtyDatasetSummaryRecordTimeBounds({
      getStreamRecordTimeBounds(_connectorId, _stream, field) {
        observed.push(field);
        return { earliest: AUTHORED_AT, latest: AUTHORED_AT };
      },
    });

    assert.deepEqual(result, { deferred: 0, reconciled: FIELD_NAMES.length, residual: 0 });
    assert.deepEqual(
      observed.sort((left, right) => left.localeCompare(right)),
      [...FIELD_NAMES].sort((left, right) => left.localeCompare(right))
    );
  }));

test("reference timeline reads arbitrary literal consent_time_field names through bound JSON paths", () =>
  withTempDb(async () => {
    const connectorId = "timeline-fields";
    const streams = FIELD_NAMES.map((field, index) => streamManifest(`events-${index}`, field));
    storeManifest(connectorId, streams);

    const insert = getDb().prepare(
      `INSERT INTO records(
         connector_id,
         connector_instance_id,
         stream,
         record_key,
         record_json,
         emitted_at,
         semantic_time
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const [index, field] of FIELD_NAMES.entries()) {
      insert.run(
        connectorId,
        connectorId,
        `events-${index}`,
        `record-${index}`,
        JSON.stringify({ [field]: AUTHORED_AT, id: String(index) }),
        EMITTED_AT,
        AUTHORED_AT
      );
    }

    const entriesByField = await Promise.all(
      FIELD_NAMES.map((field, index) =>
        collectRecordsTimelineEntries({
          connectorId,
          since: AUTHORED_AT,
          stream: `events-${index}`,
        }).then((entries) => ({ entries, field }))
      )
    );
    for (const { entries, field } of entriesByField) {
      assert.equal(entries.length, 1, field);
      assert.equal(entries[0]?.display_timestamp, AUTHORED_AT, field);
      assert.deepEqual(entries[0]?.semantic_timestamp, { field, value: AUTHORED_AT }, field);
    }
  }));
