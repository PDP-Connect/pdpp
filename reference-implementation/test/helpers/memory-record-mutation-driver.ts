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

export interface LiveRow {
  deleted: 0 | 1;
  record_json: string;
  record_key: string;
  version: number;
}

export interface ChangeRow {
  deleted: 0 | 1;
  record_json: string;
  record_key: string;
  version: number;
}

export type FaultHook = (point: string, context: { key: string; v: number }) => void;

export interface RecordMutationDriver {
  directDelete: (key: string) => Promise<number>;
  ingestDelete: (key: string) => Promise<{ changed: boolean }>;
  ingestUpsert: (key: string, payload: Record<string, unknown>) => Promise<{ changed: boolean }>;
  readChanges: () => Promise<ChangeRow[]>;
  readLive: (key: string) => Promise<LiveRow | null>;
  readVersionCounter: () => Promise<number | null>;
  setDeleteFault: (hook: FaultHook | null) => Promise<void>;
  setIngestFault: (hook: FaultHook | null) => Promise<void>;
  setup: () => Promise<void>;
  teardown: () => Promise<void>;
}

export function createMemoryRecordMutationDriver(): RecordMutationDriver {
  let live = new Map<string, LiveRow>();
  let changes: ChangeRow[] = [];
  let counter: number | null = null;
  let ingestFault: FaultHook | null = null;
  let deleteFault: FaultHook | null = null;

  function nextVersion(): number {
    return (counter ?? 0) + 1;
  }

  return {
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async directDelete(key: string) {
      const current = live.get(key);
      if (!current || current.deleted) {
        return 0;
      }

      const v = nextVersion();
      const prevJson = current.record_json;
      const nextLive: LiveRow = { deleted: 1, record_json: prevJson, record_key: key, version: v };
      const nextChange: ChangeRow = { deleted: 1, record_json: prevJson, record_key: key, version: v };

      if (deleteFault) {
        deleteFault("after-records-mutation", { key, v });
      }

      live.set(key, nextLive);
      changes.push(nextChange);
      counter = v;
      return 1;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async ingestDelete(key: string) {
      const current = live.get(key);
      if (!current || current.deleted) {
        return { changed: false };
      }

      const v = nextVersion();
      const prevJson = current.record_json;
      const nextLive: LiveRow = { deleted: 1, record_json: prevJson, record_key: key, version: v };
      const nextChange: ChangeRow = { deleted: 1, record_json: prevJson, record_key: key, version: v };

      if (ingestFault) {
        ingestFault("after-records-mutation", { key, v });
      }

      live.set(key, nextLive);
      changes.push(nextChange);
      counter = v;
      return { changed: true };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async ingestUpsert(key: string, payload: Record<string, unknown>) {
      const record_json = JSON.stringify({ id: key, ...payload });
      const current = live.get(key);

      if (current && !current.deleted && current.record_json === record_json) {
        return { changed: false };
      }

      const v = nextVersion();
      const nextLive: LiveRow = { deleted: 0, record_json, record_key: key, version: v };
      const nextChange: ChangeRow = { deleted: 0, record_json, record_key: key, version: v };

      // Fault hook fires at the same logical point the SQLite reference
      // raises `after-records-mutation`. We have NOT yet mutated any
      // observable state — if the hook throws, the live row, the change
      // feed, and the version counter all remain at their pre-call values.
      if (ingestFault) {
        ingestFault("after-records-mutation", { key, v });
      }

      live.set(key, nextLive);
      changes.push(nextChange);
      counter = v;
      return { changed: true };
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async readChanges() {
      return changes
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((row) => ({ ...row }));
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async readLive(key: string) {
      const row = live.get(key);
      return row ? { ...row } : null;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async readVersionCounter() {
      return counter;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setDeleteFault(hook: FaultHook | null) {
      deleteFault = typeof hook === "function" ? hook : null;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setIngestFault(hook: FaultHook | null) {
      ingestFault = typeof hook === "function" ? hook : null;
    },
    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async setup() {
      live = new Map();
      changes = [];
      counter = null;
      ingestFault = null;
      deleteFault = null;
    },

    // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
    async teardown() {
      ingestFault = null;
      deleteFault = null;
    },
  };
}
