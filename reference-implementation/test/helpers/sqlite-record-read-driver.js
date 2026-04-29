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

import { closeDb, initDb } from '../../server/db.js';
import { registerConnector } from '../../server/auth.js';
import { ingestRecord, queryRecords } from '../../server/records.js';

import {
  CONFORMANCE_CONNECTOR_ID,
  CONFORMANCE_MANIFEST,
  CONFORMANCE_STREAM,
} from './record-read-conformance.js';

const DEFAULT_EMITTED_AT = '2026-04-28T12:00:00.000Z';

export function createSqliteRecordReadDriver() {
  return {
    async setup() {
      initDb();
      await registerConnector(CONFORMANCE_MANIFEST);
    },

    async teardown() {
      closeDb();
    },

    async seed(records, options = {}) {
      const stream = options.stream || CONFORMANCE_STREAM;
      for (const record of records) {
        const op = record.op || 'upsert';
        await ingestRecord(CONFORMANCE_CONNECTOR_ID, {
          stream,
          key: record.key,
          data: record.data,
          emitted_at: record.emitted_at || DEFAULT_EMITTED_AT,
          op,
        });
      }
    },

    async list(params = {}) {
      const stream = params.stream || CONFORMANCE_STREAM;
      const grantStream = { name: stream };
      if (params.grantFields) grantStream.fields = params.grantFields;
      const grant = { streams: [grantStream] };

      const requestParams = {};
      if (params.limit != null) requestParams.limit = params.limit;
      if (params.order != null) requestParams.order = params.order;
      if (params.cursor != null) requestParams.cursor = params.cursor;
      if (params.fields != null) requestParams.fields = params.fields;
      if (params.filter != null) requestParams.filter = params.filter;
      if (params.changes_since != null) requestParams.changes_since = params.changes_since;

      return queryRecords(
        CONFORMANCE_CONNECTOR_ID,
        stream,
        grant,
        requestParams,
        CONFORMANCE_MANIFEST,
      );
    },
  };
}
