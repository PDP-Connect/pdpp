// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

interface StoredBlob {
  connector_id: string;
  data: Buffer;
  mime_type: string;
  record_key: string;
  sha256: string;
  size_bytes: number;
  stream: string;
}

interface BindingTuple {
  blobId: string;
  connectorId: string;
  recordKey: string;
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

interface BlobMetadata {
  blob_id: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
}

interface BindingScope {
  connectorId: string;
  recordKey: string;
  stream: string;
}

interface CollisionError extends Error {
  code: string;
}

function bindingKey(blobId: string, connectorId: string, stream: string, recordKey: string): string {
  // Use a nested structure to avoid string-delimiter collisions across
  // arbitrary connector ids, stream names, and record keys.
  return JSON.stringify([blobId, connectorId, stream, recordKey]);
}

export function createMemoryBlobStoreDriver() {
  let blobs: Map<string, StoredBlob> | null = null;
  let bindings: Map<string, BindingTuple> | null = null;

  return {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async getBlob(blobId: string): Promise<(BlobMetadata & { data: Buffer }) | null> {
      const store = blobs as Map<string, StoredBlob>;
      const row = store.get(blobId);
      if (!row) {
        return null;
      }
      return {
        blob_id: blobId,
        // Defensive copy so a caller that mutates the buffer cannot
        // corrupt subsequent reads.
        data: Buffer.from(row.data),
        mime_type: row.mime_type,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
      };
    },
    identity() {
      return {
        backend_kind: "memory-content-addressed",
        binding_kind: "composite",
        content_address: {
          algorithm: "sha256",
          id_prefix: "blob_sha256_",
        },
        dedupe: "content_addressed",
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listBindingsForBlob(blobId: string): Promise<BindingTuple[]> {
      const store = bindings as Map<string, BindingTuple>;
      const out: BindingTuple[] = [];
      for (const tuple of store.values()) {
        if (tuple.blobId === blobId) {
          out.push({ ...tuple });
        }
      }
      return out;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async listBindingsForRecord({ connectorId, stream, recordKey }: BindingScope): Promise<BindingTuple[]> {
      const store = bindings as Map<string, BindingTuple>;
      const out: BindingTuple[] = [];
      for (const tuple of store.values()) {
        if (tuple.connectorId === connectorId && tuple.stream === stream && tuple.recordKey === recordKey) {
          out.push({ ...tuple });
        }
      }
      return out;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async putBinding({ blobId, connectorId, stream, recordKey }: BindingTuple): Promise<void> {
      const store = bindings as Map<string, BindingTuple>;
      const key = bindingKey(blobId, connectorId, stream, recordKey);
      // Map.set is naturally idempotent on the key; storing the same
      // tuple is a no-op when the value is structurally identical.
      store.set(key, { blobId, connectorId, recordKey, stream });
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async putBlob({
      blobId,
      connectorId,
      stream,
      recordKey,
      mimeType,
      sizeBytes,
      sha256,
      data,
    }: PutBlobArgs): Promise<BlobMetadata> {
      const store = blobs as Map<string, StoredBlob>;
      const existing = store.get(blobId);
      if (existing) {
        if (existing.sha256 !== sha256 || existing.size_bytes !== sizeBytes) {
          const err = new Error("Blob storage collision") as CollisionError;
          err.code = "collision";
          throw err;
        }
        // Honest dedupe: keep the original row, return its metadata.
        return {
          blob_id: blobId,
          mime_type: existing.mime_type,
          sha256: existing.sha256,
          size_bytes: existing.size_bytes,
        };
      }
      const stored: StoredBlob = {
        connector_id: connectorId,
        data: Buffer.from(data),
        mime_type: mimeType,
        record_key: recordKey,
        sha256,
        size_bytes: sizeBytes,
        stream,
      };
      store.set(blobId, stored);
      return {
        blob_id: blobId,
        mime_type: stored.mime_type,
        sha256: stored.sha256,
        size_bytes: stored.size_bytes,
      };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setup(): Promise<void> {
      blobs = new Map();
      bindings = new Map();
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async teardown(): Promise<void> {
      blobs = null;
      bindings = null;
    },
  };
}
