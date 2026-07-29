// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import test from "node:test";

import { runRecordReadConformance } from "./helpers/record-read-conformance.ts";
import { createSqliteRecordReadDriver } from "./helpers/sqlite-record-read-driver.ts";

runRecordReadConformance({
  label: "sqlite-reference",
  makeDriver: () => {
    const driver = createSqliteRecordReadDriver();
    return {
      ...driver,
      async list(
        params: {
          changes_since?: string;
          cursor?: string | null;
          fields?: string[];
          filter?: Record<string, unknown>;
          grantFields?: string[];
          limit?: number;
          order?: "asc" | "desc";
          stream?: string;
        } = {}
      ) {
        const { cursor, ...rest } = params;
        const page = await driver.list(cursor === null || cursor === undefined ? rest : { ...rest, cursor });
        return {
          data: page.data.map((record) => ({
            ...(record.data === undefined ? {} : { data: record.data }),
            id: record.id,
          })),
          has_more: page.has_more,
          ...(page.next_changes_since === undefined ? {} : { next_changes_since: page.next_changes_since }),
          ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }),
          object: page.object,
        };
      },
    };
  },
  test,
});
