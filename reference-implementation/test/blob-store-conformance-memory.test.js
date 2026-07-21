// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Blob-store conformance — in-memory second adapter.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/blob-store-conformance.js` against an honestly-declared
 * in-memory driver. The memory driver does not impersonate SQLite; it
 * advertises a different backend kind and stores bytes in a `Map`, and
 * still passes every portable invariant the harness encodes.
 *
 * Together with the SQLite run and the falsifiability run, this proves
 * the harness encodes durable blob-persistence obligations rather than
 * SQLite-specific schema.
 *
 * Spec: openspec/changes/add-blob-store-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { createMemoryBlobStoreDriver } from './helpers/memory-blob-store-driver.js';
import { runBlobStoreConformance } from './helpers/blob-store-conformance.js';

runBlobStoreConformance({
  label: 'memory',
  test,
  makeDriver: () => createMemoryBlobStoreDriver(),
});
