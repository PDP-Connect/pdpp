// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record mutation conformance — in-memory second adapter.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/record-mutation-conformance.js` against a small in-memory
 * driver that has no SQLite dependency. This is the second-adapter proof
 * required by `add-second-conformance-adapters`: the harness must catch
 * the same durable-mutation obligations against an implementation whose
 * shape and storage layer are deliberately unrelated to the reference
 * SQLite path.
 *
 * The driver is test-only and is not exported from production code.
 *
 * Spec: openspec/changes/add-second-conformance-adapters/proposal.md
 */

import test from 'node:test';

import { createMemoryRecordMutationDriver } from './helpers/memory-record-mutation-driver.js';
import { runRecordMutationConformance } from './helpers/record-mutation-conformance.js';

runRecordMutationConformance({
  label: 'memory',
  test,
  makeDriver: () => createMemoryRecordMutationDriver(),
});
