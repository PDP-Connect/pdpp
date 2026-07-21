/**
 * Broken / falsifiability driver for the blob-store conformance
 * harness.
 *
 * Deliberately non-conformant in two specific ways:
 *
 *   1. Silent overwrite on duplicate put: a second `putBlob` with the
 *      same blob_id but DIFFERENT bytes silently overwrites the stored
 *      row instead of throwing. This falsifies the content-address
 *      collision-rejection scenario, and corrupts the dedupe scenario
 *      because the stored bytes after the second put no longer match
 *      the original.
 *   2. Non-idempotent bindings: `putBinding` appends every call to a
 *      flat array, so two identical calls leave two rows behind. This
 *      falsifies the binding-idempotency scenario.
 *
 * If the harness is sound, at least one scenario MUST fail when
 * exercised against this driver. If every scenario passed, the harness
 * would be a green-path wrapper rather than a real conformance gate.
 *
 * Test-only. Not exported from production code and SHALL NOT be used
 * as a production adapter.
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

export function createBrokenBlobStoreDriver() {
  let blobs;
  let bindings;

  return {
    identity() {
      return {
        backend_kind: 'broken-test-only',
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
      bindings = [];
    },

    async teardown() {
      blobs = null;
      bindings = null;
    },

    async putBlob({
      blobId,
      mimeType,
      sizeBytes,
      sha256,
      data,
    }) {
      // Deliberate: silently OVERWRITE on duplicate. A real backend
      // must reject puts that claim an existing id with different
      // bytes, but this one happily clobbers the original.
      const stored = {
        mime_type: mimeType,
        size_bytes: sizeBytes,
        sha256,
        data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data),
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
        data: Buffer.from(row.data),
      };
    },

    async putBinding({ blobId, connectorId, stream, recordKey }) {
      // Deliberate: every call appends, even if the same tuple was
      // already inserted. This falsifies the idempotency scenario.
      bindings.push({ blobId, connectorId, stream, recordKey });
    },

    async listBindingsForRecord({ connectorId, stream, recordKey }) {
      return bindings
        .filter(
          (b) =>
            b.connectorId === connectorId &&
            b.stream === stream &&
            b.recordKey === recordKey,
        )
        .map((b) => ({ ...b }));
    },

    async listBindingsForBlob(blobId) {
      return bindings.filter((b) => b.blobId === blobId).map((b) => ({ ...b }));
    },
  };
}
