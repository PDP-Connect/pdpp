// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite-backed driver for the record read conformance harness.
 *
 * Wraps the current reference helpers (`registerConnector`, `ingestRecord`,
 * `queryRecords`) and applies a fabricated grant per call. This driver is the
 * pinned baseline for the read conformance suite; it is not exported from
 * production code.
 *
 * The grant shape this driver constructs (`{ streams: [{ name, fields? }] }`)
 * mirrors `buildOwnerReadGrant` in `server/index.js` — i.e. the same grant
 * surface the route handlers pass to `queryRecords`. Restricting `grantFields`
 * via the harness's `params.grantFields` exercises grant-level field
 * projection.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import { registerConnector } from "../../server/auth.ts";
import { closeDb, initDb } from "../../server/db.ts";
import { ingestRecord, queryRecords } from "../../server/records.ts";

import { CONFORMANCE_CONNECTOR_ID, CONFORMANCE_MANIFEST, CONFORMANCE_STREAM } from "./record-read-conformance.ts";

const DEFAULT_EMITTED_AT = "2026-04-28T12:00:00.000Z";

interface SeedRecord {
  data: Record<string, unknown>;
  emitted_at?: string;
  key: string;
  op?: "upsert" | "delete";
}

interface ReadParams {
  changes_since?: string;
  cursor?: string;
  fields?: string[];
  filter?: Record<string, unknown>;
  grantFields?: string[];
  limit?: number;
  order?: "asc" | "desc";
  stream?: string;
}

export function createSqliteRecordReadDriver() {
  return {
    list(params: ReadParams = {}) {
      const stream = params.stream || CONFORMANCE_STREAM;
      const grantStream: { name: string; fields?: string[] } = { name: stream };
      if (params.grantFields) {
        grantStream.fields = params.grantFields;
      }
      const grant = { streams: [grantStream] };

      const requestParams: Record<string, unknown> = {};
      for (const [key, value] of Object.entries({
        changes_since: params.changes_since,
        cursor: params.cursor,
        fields: params.fields,
        filter: params.filter,
        limit: params.limit,
        order: params.order,
      })) {
        if (value !== null && value !== undefined) {
          requestParams[key] = value;
        }
      }

      return queryRecords(CONFORMANCE_CONNECTOR_ID, stream, grant, requestParams, CONFORMANCE_MANIFEST as never);
    },

    async seed(records: SeedRecord[], options: { stream?: string } = {}): Promise<void> {
      const stream = options.stream || CONFORMANCE_STREAM;
      const ingestNext = async (index: number): Promise<void> => {
        const record = records[index];
        if (!record) {
          return;
        }
        const op = record.op || "upsert";
        await ingestRecord(CONFORMANCE_CONNECTOR_ID, {
          data: record.data,
          emitted_at: record.emitted_at || DEFAULT_EMITTED_AT,
          key: record.key,
          op,
          stream,
        });
        return ingestNext(index + 1);
      };
      await ingestNext(0);
    },
    async setup() {
      initDb();
      await registerConnector(CONFORMANCE_MANIFEST as never);
    },

    teardown() {
      closeDb();
    },
  };
}
