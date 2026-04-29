/**
 * SQLite-backed driver for the blob-store conformance harness.
 *
 * Wraps the reference implementation's `blobs` + `blob_bindings` tables
 * at the SQL level. Mutations use the existing canonical query helpers
 * (`blobsInsertBlob`, `blobsGetStoredById`, `blobsInsertBinding`).
 * Reads not covered by static query helpers (e.g. fetching blob bytes
 * by id, listing bindings) go through `iterateDynamicSqlAcknowledged`
 * with fixed shapes — the harness does not paginate.
 *
 * This driver is the pinned baseline for the blob-store conformance
 * suite. It is not exported from production code and SHALL NOT be
 * treated as a production `BlobStore` adapter — `/v1/blobs` continues
 * to route through `persistContentAddressedBlob` directly.
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  exec,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  transaction,
} from '../../lib/db.ts';
import { closeDb, initDb } from '../../server/db.js';

function getOneRow(sql, params) {
  for (const row of iterateDynamicSqlAcknowledged(sql, params)) {
    return row;
  }
  return null;
}

function listRows(sql, params) {
  const rows = [];
  for (const row of iterateDynamicSqlAcknowledged(sql, params)) {
    rows.push(row);
  }
  return rows;
}

export function createSqliteBlobStoreDriver() {
  return {
    identity() {
      // Mirrors the SQLite reference's actual content-address scheme.
      // `persistContentAddressedBlob` derives the id as
      // `blob_sha256_<sha256-hex>`; the harness reads that prefix and
      // hashing algorithm here so non-SQLite drivers can declare their
      // own values (or match this one) and the harness can derive
      // matching blob ids on either side.
      return {
        backend_kind: 'sqlite-blob-rows',
        content_address: {
          algorithm: 'sha256',
          id_prefix: 'blob_sha256_',
        },
        dedupe: 'content_addressed',
        binding_kind: 'composite',
      };
    },

    async setup() {
      initDb();
    },

    async teardown() {
      closeDb();
    },

    async putBlob({
      blobId,
      connectorId,
      stream,
      recordKey,
      mimeType,
      sizeBytes,
      sha256,
      data,
    }) {
      // Mirror `persistContentAddressedBlob`'s transaction shape: insert
      // (or ignore) the content-addressed row, then re-read to detect a
      // collision (same blob_id, different sha256/size).
      return transaction(() => {
        exec(referenceQueries.blobsInsertBlob, [
          blobId,
          connectorId,
          stream,
          recordKey,
          mimeType,
          sizeBytes,
          sha256,
          data,
        ]);
        // REVIEWED-DYNAMIC: harness read of one row by primary key, no LIMIT
        // needed because blob_id is PRIMARY KEY.
        const row = getOneRow(
          'SELECT blob_id, mime_type, size_bytes, sha256 FROM blobs WHERE blob_id = ?',
          [blobId],
        );
        if (!row) {
          const err = new Error('Blob storage row missing after insert');
          err.code = 'storage_error';
          throw err;
        }
        if (row.sha256 !== sha256 || Number(row.size_bytes) !== sizeBytes) {
          const err = new Error('Blob storage collision');
          err.code = 'collision';
          throw err;
        }
        return {
          blob_id: row.blob_id,
          mime_type: row.mime_type,
          size_bytes: Number(row.size_bytes),
          sha256: row.sha256,
        };
      });
    },

    async getBlob(blobId) {
      // REVIEWED-DYNAMIC: harness read of one row by primary key, no LIMIT
      // needed because blob_id is PRIMARY KEY.
      const row = getOneRow(
        'SELECT blob_id, mime_type, size_bytes, sha256, data FROM blobs WHERE blob_id = ?',
        [blobId],
      );
      if (!row) return null;
      return {
        blob_id: row.blob_id,
        mime_type: row.mime_type,
        size_bytes: Number(row.size_bytes),
        sha256: row.sha256,
        data: row.data,
      };
    },

    async putBinding({ blobId, connectorId, stream, recordKey }) {
      exec(referenceQueries.blobsInsertBinding, [
        blobId,
        connectorId,
        stream,
        recordKey,
      ]);
    },

    async listBindingsForRecord({ connectorId, stream, recordKey }) {
      // REVIEWED-DYNAMIC: harness read scoped by composite key + index
      // `idx_blob_bindings_record(connector_id, stream, record_key)`. Bound
      // by fanout per record in the test workload (typically <=3).
      const rows = listRows(
        `SELECT blob_id, connector_id, stream, record_key
         FROM blob_bindings
         WHERE connector_id = ? AND stream = ? AND record_key = ?
         LIMIT 1000`,
        [connectorId, stream, recordKey],
      );
      return rows.map((row) => ({
        blobId: row.blob_id,
        connectorId: row.connector_id,
        stream: row.stream,
        recordKey: row.record_key,
      }));
    },

    async listBindingsForBlob(blobId) {
      // REVIEWED-DYNAMIC: harness read scoped by blob_id (left-prefix of
      // blob_bindings PK). Bounded by LIMIT for safety in test workloads.
      const rows = listRows(
        `SELECT blob_id, connector_id, stream, record_key
         FROM blob_bindings
         WHERE blob_id = ?
         LIMIT 1000`,
        [blobId],
      );
      return rows.map((row) => ({
        blobId: row.blob_id,
        connectorId: row.connector_id,
        stream: row.stream,
        recordKey: row.record_key,
      }));
    },
  };
}
