/**
 * Record read conformance — in-memory second adapter.
 *
 * Runs the reusable conformance scenarios from
 * `helpers/record-read-conformance.js` against a memory-backed driver that
 * has no coupling to the SQLite reference helpers (`server/records.js`,
 * `server/db.js`, `server/auth.js`). This is the second-adapter proof that
 * the harness pins portable PDPP record-read behavior rather than SQLite
 * accidents.
 *
 * The driver is test-only and SHALL NOT be used as a production adapter or
 * environment profile. There is no production `RecordStore` interface being
 * extracted by this proof.
 *
 * Spec: openspec/changes/add-record-read-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 *       (second-adapter requirement from
 *        openspec/changes/add-second-conformance-adapters/).
 */

import test from 'node:test';

import { createMemoryRecordReadDriver } from './helpers/memory-record-read-driver.js';
import { runRecordReadConformance } from './helpers/record-read-conformance.js';

runRecordReadConformance({
  label: 'memory',
  test,
  makeDriver: () => createMemoryRecordReadDriver(),
});
