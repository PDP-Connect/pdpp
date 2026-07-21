// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record mutation conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/record-mutation-conformance.js` against the current SQLite-backed
 * reference helpers (`ingestRecord`, `deleteRecord`, test-only DB reads, and
 * the existing fault hooks). Replaces nothing on its own; the focused
 * `records-ingest-atomicity.test.js` and `records-delete-atomicity.test.js`
 * suites are intentionally retained as direct, implementation-shape evidence
 * alongside this conformance run. See worker report for rationale.
 *
 * Spec: openspec/changes/add-record-mutation-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runRecordMutationConformance } from './helpers/record-mutation-conformance.js';
import { createSqliteRecordMutationDriver } from './helpers/sqlite-record-mutation-driver.js';

runRecordMutationConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteRecordMutationDriver(),
});
