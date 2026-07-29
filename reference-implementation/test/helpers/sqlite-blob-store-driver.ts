// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import type { BindParams } from "../../lib/db.ts";
import { exec, iterateDynamicSqlAcknowledged, referenceQueries, transaction } from "../../lib/db.ts";
import { closeDb, initDb } from "../../server/db.ts";
import { makeDefaultAccountConnectorInstanceId } from "../../server/stores/connector-instance-store.ts";

interface BlobRow {
  blob_id: string;
  data?: Buffer | Uint8Array;
  mime_type: string;
  sha256: string;
  size_bytes: number | string;
}
interface BindingRow {
  blob_id: string;
  connector_id: string;
  record_key: string;
  stream: string;
}
interface PutBlobArgs {
  blobId: string;
  connectorId: string;
  data: Buffer | Uint8Array;
  mimeType: string;
  recordKey: string;
  sha256: string;
  sizeBytes: number;
  stream: string;
}
interface BindingArgs {
  blobId: string;
  connectorId: string;
  recordKey: string;
  stream: string;
}

function getOneRow<R>(sql: string, params: BindParams): R | null {
  for (const row of iterateDynamicSqlAcknowledged<R>(sql, params)) {
    return row;
  }
  return null;
}

function listRows<R>(sql: string, params: BindParams): R[] {
  const rows: R[] = [];
  for (const row of iterateDynamicSqlAcknowledged<R>(sql, params)) {
    rows.push(row);
  }
  return rows;
}

export function createSqliteBlobStoreDriver() {
  return {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async getBlob(blobId: string) {
      // REVIEWED-DYNAMIC: harness read of one row by primary key, no LIMIT
      // needed because blob_id is PRIMARY KEY.
      const row = getOneRow<BlobRow>(
        "SELECT blob_id, mime_type, size_bytes, sha256, data FROM blobs WHERE blob_id = ?",
        [blobId]
      );
      if (!(row && "sha256" in row && "data" in row)) {
        return null;
      }
      return {
        blob_id: row.blob_id,
        data: row.data,
        mime_type: row.mime_type,
        sha256: row.sha256,
        size_bytes: Number(row.size_bytes),
      };
    },
    identity() {
      // Mirrors the SQLite reference's actual content-address scheme.
      // `persistContentAddressedBlob` derives the id as
      // `blob_sha256_<sha256-hex>`; the harness reads that prefix and
      // hashing algorithm here so non-SQLite drivers can declare their
      // own values (or match this one) and the harness can derive
      // matching blob ids on either side.
      return {
        backend_kind: "sqlite-blob-rows",
        binding_kind: "composite",
        content_address: {
          algorithm: "sha256",
          id_prefix: "blob_sha256_",
        },
        dedupe: "content_addressed",
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listBindingsForBlob(blobId: string) {
      // REVIEWED-DYNAMIC: harness read scoped by blob_id (left-prefix of
      // blob_bindings PK). Bounded by LIMIT for safety in test workloads.
      const rows = listRows<BindingRow>(
        `SELECT blob_id, connector_id, stream, record_key
         FROM blob_bindings
         WHERE blob_id = ?
         LIMIT 1000`,
        [blobId]
      );
      return rows.map((row) => ({
        blobId: row.blob_id,
        connectorId: row.connector_id,
        recordKey: row.record_key,
        stream: row.stream,
      }));
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listBindingsForRecord({ connectorId, stream, recordKey }: Omit<BindingArgs, "blobId">) {
      // REVIEWED-DYNAMIC: harness read scoped by composite key + index
      // `idx_blob_bindings_record(connector_instance_id, stream, record_key)`. Bound
      // by fanout per record in the test workload (typically <=3).
      const rows = listRows<BindingRow>(
        `SELECT blob_id, connector_id, stream, record_key
         FROM blob_bindings
         WHERE connector_instance_id = ? AND stream = ? AND record_key = ?
         LIMIT 1000`,
        [makeDefaultAccountConnectorInstanceId("owner_local", connectorId), stream, recordKey]
      );
      return rows.map((row) => ({
        blobId: row.blob_id,
        connectorId: row.connector_id,
        recordKey: row.record_key,
        stream: row.stream,
      }));
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async putBinding({ blobId, connectorId, stream, recordKey }: BindingArgs) {
      exec(referenceQueries.blobsInsertBinding, [
        blobId,
        connectorId,
        makeDefaultAccountConnectorInstanceId("owner_local", connectorId),
        stream,
        recordKey,
      ]);
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async putBlob({ blobId, connectorId, stream, recordKey, mimeType, sizeBytes, sha256, data }: PutBlobArgs) {
      // Mirror `persistContentAddressedBlob`'s transaction shape: insert
      // (or ignore) the content-addressed row, then re-read to detect a
      // collision (same blob_id, different sha256/size).
      return transaction(() => {
        exec(referenceQueries.blobsInsertBlob, [
          blobId,
          connectorId,
          makeDefaultAccountConnectorInstanceId("owner_local", connectorId),
          stream,
          recordKey,
          mimeType,
          sizeBytes,
          sha256,
          data,
        ]);
        // REVIEWED-DYNAMIC: harness read of one row by primary key, no LIMIT
        // needed because blob_id is PRIMARY KEY.
        const row = getOneRow<BlobRow>("SELECT blob_id, mime_type, size_bytes, sha256 FROM blobs WHERE blob_id = ?", [
          blobId,
        ]);
        if (!(row && "sha256" in row)) {
          const err = Object.assign(new Error("Blob storage row missing after insert"), { code: "storage_error" });
          throw err;
        }
        if (row.sha256 !== sha256 || Number(row.size_bytes) !== sizeBytes) {
          const err = Object.assign(new Error("Blob storage collision"), { code: "collision" });
          throw err;
        }
        return {
          blob_id: row.blob_id,
          mime_type: row.mime_type,
          sha256: row.sha256,
          size_bytes: Number(row.size_bytes),
        };
      });
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setup() {
      initDb();
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async teardown() {
      closeDb();
    },
  };
}
