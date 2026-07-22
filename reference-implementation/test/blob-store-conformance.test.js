// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Blob-store conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/blob-store-conformance.js` against the current SQLite-backed
 * reference implementation (`blobsInsertBlob`, `blobsGetStoredById`,
 * `blobsInsertBinding`).
 *
 * This run pins the SQLite reference's blob-persistence semantics. The
 * existing `/v1/blobs` query-contract tests still cover the public
 * route end-to-end; this suite is the storage-level conformance
 * baseline before any future `BlobStore` extraction or split between
 * blob metadata (rows) and blob bytes (object storage).
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runBlobStoreConformance } from './helpers/blob-store-conformance.js';
import { createSqliteBlobStoreDriver } from './helpers/sqlite-blob-store-driver.js';

runBlobStoreConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteBlobStoreDriver(),
});
