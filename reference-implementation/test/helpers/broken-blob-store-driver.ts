// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import type { BindingTuple, BlobStoreDriver, PutBlobArgs } from "./blob-store-conformance.ts";

interface StoredBlob {
  data: Buffer;
  mime_type: string;
  sha256: string;
  size_bytes: number;
}

export function createBrokenBlobStoreDriver(): BlobStoreDriver {
  let blobs: Map<string, StoredBlob> | null = null;
  let bindings: BindingTuple[] | null = null;

  return {
    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async getBlob(blobId: string) {
      const row = (blobs as Map<string, StoredBlob>).get(blobId);
      if (!row) {
        return null;
      }
      return {
        blob_id: blobId,
        data: Buffer.from(row.data),
        mime_type: row.mime_type,
        sha256: row.sha256,
        size_bytes: row.size_bytes,
      };
    },
    identity() {
      return {
        backend_kind: "broken-test-only",
        binding_kind: "composite",
        content_address: {
          algorithm: "sha256",
          id_prefix: "blob_sha256_",
        },
        dedupe: "content_addressed",
      };
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listBindingsForBlob(blobId: string) {
      return (bindings as BindingTuple[]).filter((b) => b.blobId === blobId).map((b) => ({ ...b }));
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async listBindingsForRecord({
      connectorId,
      stream,
      recordKey,
    }: {
      connectorId: string;
      stream: string;
      recordKey: string;
    }) {
      return (bindings as BindingTuple[])
        .filter((b) => b.connectorId === connectorId && b.stream === stream && b.recordKey === recordKey)
        .map((b) => ({ ...b }));
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async putBinding({ blobId, connectorId, stream, recordKey }: BindingTuple) {
      // Deliberate: every call appends, even if the same tuple was
      // already inserted. This falsifies the idempotency scenario.
      (bindings as BindingTuple[]).push({ blobId, connectorId, recordKey, stream });
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async putBlob({ blobId, mimeType, sizeBytes, sha256, data }: PutBlobArgs) {
      // Deliberate: silently OVERWRITE on duplicate. A real backend
      // must reject puts that claim an existing id with different
      // bytes, but this one happily clobbers the original.
      const stored: StoredBlob = {
        data: Buffer.from(data),
        mime_type: mimeType,
        sha256,
        size_bytes: sizeBytes,
      };
      (blobs as Map<string, StoredBlob>).set(blobId, stored);
      return {
        blob_id: blobId,
        mime_type: stored.mime_type,
        sha256: stored.sha256,
        size_bytes: stored.size_bytes,
      };
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async setup() {
      blobs = new Map();
      bindings = [];
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async teardown() {
      blobs = null;
      bindings = null;
    },
  };
}
