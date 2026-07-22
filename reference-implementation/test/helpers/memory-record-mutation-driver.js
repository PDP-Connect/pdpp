// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * In-memory driver for the record mutation conformance harness.
 *
 * Implements the full set of durable record-mutation obligations as a small
 * in-process object — independent of SQLite and of any production
 * `records.js` code path. The point of this driver is to prove the
 * conformance harness expresses portable PDPP semantics rather than
 * artifacts of the SQLite reference (`writeTransaction`, prepared
 * statements, `version_counter` table layout, etc.).
 *
 * Key durable obligations modelled here:
 *
 *   - Per-stream monotonic version allocation.
 *   - No-op re-ingest (identical payload) does not append a change row or
 *     advance the version counter.
 *   - Repeated/absent ingest delete is a no-op.
 *   - Direct delete on absent / already-deleted rows is a no-op.
 *   - Live row, `record_changes`, and `version_counter` form one durable
 *     unit: a fault between the live mutation and the change-log append
 *     must leave all three in their pre-mutation state.
 *   - Repeated `setIngestFault(null)` / `setDeleteFault(null)` clears any
 *     previously-installed fault.
 *
 * Atomicity is implemented by computing the next state into local
 * variables, only invoking the fault hook *after* the would-be live-row
 * mutation point but *before* committing any of the three observable
 * fields. This keeps the implementation honest with the harness while
 * remaining a simple memory object — not a copy of `records.js` SQL.
 *
 * This driver is test-only and SHALL NOT be exported from production code.
 * It does not implement the full `RecordStore` surface — only the slice
 * the conformance harness drives.
 *
 * Spec: openspec/changes/add-second-conformance-adapters/proposal.md
 */

export function createMemoryRecordMutationDriver() {
  let live = new Map();   // key -> { record_key, record_json, version, deleted }
  let changes = [];       // [{ version, record_key, record_json, deleted }]
  let counter = null;     // null until the first changed write
  let ingestFault = null;
  let deleteFault = null;

  function nextVersion() {
    return (counter ?? 0) + 1;
  }

  return {
    async setup() {
      live = new Map();
      changes = [];
      counter = null;
      ingestFault = null;
      deleteFault = null;
    },

    async teardown() {
      ingestFault = null;
      deleteFault = null;
    },

    async ingestUpsert(key, payload) {
      const record_json = JSON.stringify({ id: key, ...payload });
      const current = live.get(key);

      if (current && !current.deleted && current.record_json === record_json) {
        return { changed: false };
      }

      const v = nextVersion();
      const nextLive = { record_key: key, record_json, version: v, deleted: 0 };
      const nextChange = { version: v, record_key: key, record_json, deleted: 0 };

      // Fault hook fires at the same logical point the SQLite reference
      // raises `after-records-mutation`. We have NOT yet mutated any
      // observable state — if the hook throws, the live row, the change
      // feed, and the version counter all remain at their pre-call values.
      if (ingestFault) ingestFault('after-records-mutation', { key, v });

      live.set(key, nextLive);
      changes.push(nextChange);
      counter = v;
      return { changed: true };
    },

    async ingestDelete(key) {
      const current = live.get(key);
      if (!current || current.deleted) {
        return { changed: false };
      }

      const v = nextVersion();
      const prevJson = current.record_json;
      const nextLive = { record_key: key, record_json: prevJson, version: v, deleted: 1 };
      const nextChange = { version: v, record_key: key, record_json: prevJson, deleted: 1 };

      if (ingestFault) ingestFault('after-records-mutation', { key, v });

      live.set(key, nextLive);
      changes.push(nextChange);
      counter = v;
      return { changed: true };
    },

    async directDelete(key) {
      const current = live.get(key);
      if (!current || current.deleted) {
        return 0;
      }

      const v = nextVersion();
      const prevJson = current.record_json;
      const nextLive = { record_key: key, record_json: prevJson, version: v, deleted: 1 };
      const nextChange = { version: v, record_key: key, record_json: prevJson, deleted: 1 };

      if (deleteFault) deleteFault('after-records-mutation', { key, v });

      live.set(key, nextLive);
      changes.push(nextChange);
      counter = v;
      return 1;
    },

    async readLive(key) {
      const row = live.get(key);
      return row ? { ...row } : null;
    },

    async readChanges() {
      return changes
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((row) => ({ ...row }));
    },

    async readVersionCounter() {
      return counter;
    },

    async setIngestFault(hook) {
      ingestFault = typeof hook === 'function' ? hook : null;
    },

    async setDeleteFault(hook) {
      deleteFault = typeof hook === 'function' ? hook : null;
    },
  };
}
