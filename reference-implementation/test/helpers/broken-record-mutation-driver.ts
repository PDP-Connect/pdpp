// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deliberately broken in-memory driver for harness falsifiability.
 *
 * This driver exists ONLY for the conformance harness's negative proof. It
 * implements a small in-memory record store whose durable mutation is
 * intentionally non-atomic: the live row is mutated *before* the change-log
 * append, and a fault hook installed between those two steps will leave the
 * live row advanced while record_changes and version_counter stay behind.
 *
 * This is the exact failure mode that the SQLite atomicity fix pins. The
 * harness's rollback scenarios MUST detect it; if they do not, the harness
 * is theater.
 *
 * This driver SHALL NOT be used as a production adapter or environment
 * profile. It is only imported from the falsifiability test.
 */

import type { ChangeRow, FaultHook, LiveRow, RecordMutationDriver } from "./memory-record-mutation-driver.ts";

export function createBrokenInMemoryRecordMutationDriver(): RecordMutationDriver {
  let live = new Map<string, LiveRow>();
  let changes: ChangeRow[] = [];
  let counter: number | null = null;
  let ingestFault: FaultHook | null = null;
  let deleteFault: FaultHook | null = null;

  function nextVersion(): number {
    return (counter ?? 0) + 1;
  }

  return {
    async directDelete(key: string) {
      await Promise.resolve();
      const current = live.get(key);
      if (!current || current.deleted) {
        return 0;
      }
      const v = nextVersion();
      const prevJson = current.record_json;

      live.set(key, { deleted: 1, record_json: prevJson, record_key: key, version: v });
      if (deleteFault) {
        deleteFault("after-records-mutation", { key, v });
      }

      changes.push({ deleted: 1, record_json: prevJson, record_key: key, version: v });
      counter = v;
      return 1;
    },

    async ingestDelete(key: string) {
      await Promise.resolve();
      const current = live.get(key);
      if (!current || current.deleted) {
        return { changed: false };
      }
      const v = nextVersion();
      const prevJson = current.record_json;

      live.set(key, { deleted: 1, record_json: prevJson, record_key: key, version: v });
      if (ingestFault) {
        ingestFault("after-records-mutation", { key, v });
      }

      changes.push({ deleted: 1, record_json: prevJson, record_key: key, version: v });
      counter = v;
      return { changed: true };
    },

    async ingestUpsert(key: string, payload: Record<string, unknown>) {
      await Promise.resolve();
      const record_json = JSON.stringify({ id: key, ...payload });
      const current = live.get(key);

      if (current && !current.deleted && current.record_json === record_json) {
        return { changed: false };
      }

      const v = nextVersion();

      // BUG: mutate live row first.
      live.set(key, { deleted: 0, record_json, record_key: key, version: v });

      // Fault hook between live mutation and change-log append. With the bug,
      // throwing here leaves the live row mutated but no record_changes row
      // and no counter advance — the live/feed/counter drift the spec
      // forbids.
      if (ingestFault) {
        ingestFault("after-records-mutation", { key, v });
      }

      changes.push({ deleted: 0, record_json, record_key: key, version: v });
      counter = v;
      return { changed: true };
    },

    async readChanges() {
      await Promise.resolve();
      return changes
        .slice()
        .sort((a, b) => a.version - b.version)
        .map((row) => ({ ...row }));
    },

    async readLive(key: string) {
      await Promise.resolve();
      return live.get(key) ?? null;
    },

    async readVersionCounter() {
      await Promise.resolve();
      return counter;
    },

    async setDeleteFault(hook: FaultHook | null) {
      await Promise.resolve();
      deleteFault = typeof hook === "function" ? hook : null;
    },

    async setIngestFault(hook: FaultHook | null) {
      await Promise.resolve();
      ingestFault = typeof hook === "function" ? hook : null;
    },
    async setup() {
      await Promise.resolve();
      live = new Map();
      changes = [];
      counter = null;
      ingestFault = null;
      deleteFault = null;
    },

    async teardown() {
      await Promise.resolve();
      ingestFault = null;
      deleteFault = null;
    },
  };
}
