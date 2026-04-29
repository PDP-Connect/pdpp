/**
 * SQLite-backed driver for the record mutation conformance harness.
 *
 * Wraps the current reference helpers (`ingestRecord`, `deleteRecord`) and
 * test-only DB reads. This driver is the pinned baseline for the
 * conformance suite; it is not exported from production code.
 *
 * Spec: openspec/changes/add-record-mutation-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import { closeDb, getDb, initDb } from '../../server/db.js';
import {
  __setDeleteFaultHookForTest,
  __setIngestFaultHookForTest,
  deleteRecord,
  ingestRecord,
} from '../../server/records.js';

const DEFAULT_CONNECTOR_ID = 'https://test.pdpp.org/connectors/conformance';
const DEFAULT_STREAM = 'items';

export function createSqliteRecordMutationDriver({
  connectorId = DEFAULT_CONNECTOR_ID,
  stream = DEFAULT_STREAM,
} = {}) {
  return {
    async setup() {
      initDb();
    },

    async teardown() {
      __setIngestFaultHookForTest(null);
      __setDeleteFaultHookForTest(null);
      closeDb();
    },

    async ingestUpsert(key, payload) {
      const result = await ingestRecord(connectorId, {
        stream,
        key,
        data: { id: key, ...payload },
        emitted_at: '2026-04-28T12:00:00.000Z',
        op: 'upsert',
      });
      return { changed: result.changed === true };
    },

    async ingestDelete(key) {
      const result = await ingestRecord(connectorId, {
        stream,
        key,
        data: { id: key },
        emitted_at: '2026-04-28T12:00:00.000Z',
        op: 'delete',
      });
      return { changed: result.changed === true };
    },

    async directDelete(key) {
      return deleteRecord(connectorId, stream, key);
    },

    async readLive(key) {
      const row = getDb()
        .prepare(
          `SELECT record_key, record_json, version, deleted
           FROM records
           WHERE connector_id = ? AND stream = ? AND record_key = ?`,
        )
        .get(connectorId, stream, key);
      return row ?? null;
    },

    async readChanges() {
      return getDb()
        .prepare(
          `SELECT version, record_key, record_json, deleted
           FROM record_changes
           WHERE connector_id = ? AND stream = ?
           ORDER BY version ASC`,
        )
        .all(connectorId, stream);
    },

    async readVersionCounter() {
      const row = getDb()
        .prepare(
          `SELECT max_version FROM version_counter
           WHERE connector_id = ? AND stream = ?`,
        )
        .get(connectorId, stream);
      return row ? row.max_version : null;
    },

    async setIngestFault(hook) {
      __setIngestFaultHookForTest(hook);
    },

    async setDeleteFault(hook) {
      __setDeleteFaultHookForTest(hook);
    },
  };
}
