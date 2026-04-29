/**
 * Record read conformance — SQLite reference driver.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/record-read-conformance.js` against the current SQLite-backed
 * reference helpers (`queryRecords`, `ingestRecord`, `registerConnector`).
 * Replaces nothing on its own; the focused records-cursor-fallback,
 * records-nullable-cursor, and records-nullable-filters route-level suites
 * remain as direct evidence alongside this conformance run. See worker
 * report for rationale.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';

import { runRecordReadConformance } from './helpers/record-read-conformance.js';
import { createSqliteRecordReadDriver } from './helpers/sqlite-record-read-driver.js';

runRecordReadConformance({
  label: 'sqlite-reference',
  test,
  makeDriver: () => createSqliteRecordReadDriver(),
});
