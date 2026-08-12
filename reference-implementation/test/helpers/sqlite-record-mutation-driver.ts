// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite-backed driver for the record mutation conformance harness.
 *
 * Wraps the current reference helpers (`ingestRecord`, `deleteRecord`) and
 * test-only DB reads. This driver is the pinned baseline for the
 * conformance suite; it is not exported from production code.
 *
 * Spec: openspec/changes/add-record-mutation-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import { closeDb, getDb, initDb } from "../../server/db.ts";
import {
  __setDeleteFaultHookForTest,
  __setIngestFaultHookForTest,
  deleteRecord,
  ingestRecord,
} from "../../server/records.ts";

const DEFAULT_CONNECTOR_ID = "https://test.pdpp.dev/connectors/conformance";
const DEFAULT_STREAM = "items";

export function createSqliteRecordMutationDriver({
  connectorId = DEFAULT_CONNECTOR_ID,
  stream = DEFAULT_STREAM,
}: {
  connectorId?: string;
  stream?: string;
} = {}) {
  return {
    async directDelete(key: string) {
      const result = await deleteRecord(connectorId, stream, key);
      // biome-ignore lint/style/noNestedTernary: the compact fixture mapping makes the tested precedence explicit.
      return typeof result === "number" ? result : result.changed ? 1 : 0;
    },

    async ingestDelete(key: string) {
      const result = await ingestRecord(connectorId, {
        data: { id: key },
        emitted_at: "2026-04-28T12:00:00.000Z",
        key,
        op: "delete",
        stream,
      });
      return { changed: result.changed === true };
    },

    async ingestUpsert(key: string, payload: Record<string, unknown>) {
      const result = await ingestRecord(connectorId, {
        data: { id: key, ...payload },
        emitted_at: "2026-04-28T12:00:00.000Z",
        key,
        op: "upsert",
        stream,
      });
      return { changed: result.changed === true };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async readChanges() {
      return getDb()
        .prepare(
          `SELECT version, record_key, record_json, deleted
           FROM record_changes
           WHERE connector_id = ? AND stream = ?
           ORDER BY version ASC`
        )
        .all(connectorId, stream);
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async readLive(key: string) {
      const row = getDb()
        .prepare(
          `SELECT record_key, record_json, version, deleted
           FROM records
           WHERE connector_id = ? AND stream = ? AND record_key = ?`
        )
        .get(connectorId, stream, key);
      return row ?? null;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async readVersionCounter() {
      const row = getDb()
        .prepare(
          `SELECT max_version FROM version_counter
           WHERE connector_id = ? AND stream = ?`
        )
        .get(connectorId, stream);
      return row ? row.max_version : null;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setDeleteFault(hook: ((point: string) => void) | null) {
      __setDeleteFaultHookForTest(hook);
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setIngestFault(hook: ((point: string) => void) | null) {
      __setIngestFaultHookForTest(hook);
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setup() {
      initDb();
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async teardown() {
      __setIngestFaultHookForTest(null);
      __setDeleteFaultHookForTest(null);
      closeDb();
    },
  };
}
