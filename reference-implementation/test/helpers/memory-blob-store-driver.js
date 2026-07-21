/**
 * In-memory driver for the blob-store conformance harness.
 *
 * Honest, simple implementation: blobs live in a `Map<blob_id, row>`,
 * and bindings live in a `Map<binding_key, tuple>`. Content-address
 * dedupe is realized as "second put with same blob_id is a no-op when
 * sha256/size match; throws when they don't." Binding idempotency is
 * realized via composite-key Map keys.
 *
 * The point of the memory driver is to prove the conformance harness
 * encodes portable obligations (content-address dedupe, collision
 * rejection, binding idempotency, fan-out, scoped listing) rather than
 * SQLite-specific schema.
 *
 * Test-only. Not exported from production code.
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

function bindingKey(blobId, connectorId, stream, recordKey) {
  // Use a nested structure to avoid string-delimiter collisions across
  // arbitrary connector ids, stream names, and record keys.
  return JSON.stringify([blobId, connectorId, stream, recordKey]);
}

export function createMemoryBlobStoreDriver() {
  // blobs: Map<blob_id, { mime_type, size_bytes, sha256, data, connector_id, stream, record_key }>
  // bindings: Map<bindingKey, { blobId, connectorId, stream, recordKey }>
  let blobs;
  let bindings;

  return {
    identity() {
      return {
        backend_kind: 'memory-content-addressed',
        content_address: {
          algorithm: 'sha256',
          id_prefix: 'blob_sha256_',
        },
        dedupe: 'content_addressed',
        binding_kind: 'composite',
      };
    },

    async setup() {
      blobs = new Map();
      bindings = new Map();
    },

    async teardown() {
      blobs = null;
      bindings = null;
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
      const existing = blobs.get(blobId);
      if (existing) {
        if (existing.sha256 !== sha256 || existing.size_bytes !== sizeBytes) {
          const err = new Error('Blob storage collision');
          err.code = 'collision';
          throw err;
        }
        // Honest dedupe: keep the original row, return its metadata.
        return {
          blob_id: blobId,
          mime_type: existing.mime_type,
          size_bytes: existing.size_bytes,
          sha256: existing.sha256,
        };
      }
      const stored = {
        mime_type: mimeType,
        size_bytes: sizeBytes,
        sha256,
        data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data),
        connector_id: connectorId,
        stream,
        record_key: recordKey,
      };
      blobs.set(blobId, stored);
      return {
        blob_id: blobId,
        mime_type: stored.mime_type,
        size_bytes: stored.size_bytes,
        sha256: stored.sha256,
      };
    },

    async getBlob(blobId) {
      const row = blobs.get(blobId);
      if (!row) return null;
      return {
        blob_id: blobId,
        mime_type: row.mime_type,
        size_bytes: row.size_bytes,
        sha256: row.sha256,
        // Defensive copy so a caller that mutates the buffer cannot
        // corrupt subsequent reads.
        data: Buffer.from(row.data),
      };
    },

    async putBinding({ blobId, connectorId, stream, recordKey }) {
      const key = bindingKey(blobId, connectorId, stream, recordKey);
      // Map.set is naturally idempotent on the key; storing the same
      // tuple is a no-op when the value is structurally identical.
      bindings.set(key, { blobId, connectorId, stream, recordKey });
    },

    async listBindingsForRecord({ connectorId, stream, recordKey }) {
      const out = [];
      for (const tuple of bindings.values()) {
        if (
          tuple.connectorId === connectorId &&
          tuple.stream === stream &&
          tuple.recordKey === recordKey
        ) {
          out.push({ ...tuple });
        }
      }
      return out;
    },

    async listBindingsForBlob(blobId) {
      const out = [];
      for (const tuple of bindings.values()) {
        if (tuple.blobId === blobId) {
          out.push({ ...tuple });
        }
      }
      return out;
    },
  };
}
