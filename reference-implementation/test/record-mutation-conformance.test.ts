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

import assert from "node:assert/strict";
import test from "node:test";

import { runRecordMutationConformance } from "./helpers/record-mutation-conformance.ts";
import { createSqliteRecordMutationDriver } from "./helpers/sqlite-record-mutation-driver.ts";

runRecordMutationConformance({
  label: "sqlite-reference",
  makeDriver: () => {
    const driver = createSqliteRecordMutationDriver();
    const mutationRow = (row: Record<string, unknown>) => {
      assert.ok(typeof row.version === "number");
      assert.ok(typeof row.record_key === "string");
      assert.ok(typeof row.record_json === "string");
      assert.ok(typeof row.deleted === "number");
      return { deleted: row.deleted, record_json: row.record_json, record_key: row.record_key, version: row.version };
    };
    return {
      ...driver,
      async readChanges() {
        return (await driver.readChanges()).map(mutationRow);
      },
      async readLive(key: string) {
        const row = await driver.readLive(key);
        return row === null ? null : mutationRow(row);
      },
      async readVersionCounter() {
        const value = await driver.readVersionCounter();
        assert.ok(value === null || typeof value === "number");
        return value;
      },
    };
  },
  test,
});
