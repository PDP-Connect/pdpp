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

export function createBrokenInMemoryRecordMutationDriver() {
  let live = new Map();      // key -> { record_key, record_json, version, deleted }
  let changes = [];          // [{ version, record_key, record_json, deleted }]
  let counter = null;
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

      // BUG: mutate live row first.
      live.set(key, { record_key: key, record_json, version: v, deleted: 0 });

      // Fault hook between live mutation and change-log append. With the bug,
      // throwing here leaves the live row mutated but no record_changes row
      // and no counter advance — the live/feed/counter drift the spec
      // forbids.
      if (ingestFault) ingestFault('after-records-mutation', { key, v });

      changes.push({ version: v, record_key: key, record_json, deleted: 0 });
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

      live.set(key, { record_key: key, record_json: prevJson, version: v, deleted: 1 });
      if (ingestFault) ingestFault('after-records-mutation', { key, v });

      changes.push({ version: v, record_key: key, record_json: prevJson, deleted: 1 });
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

      live.set(key, { record_key: key, record_json: prevJson, version: v, deleted: 1 });
      if (deleteFault) deleteFault('after-records-mutation', { key, v });

      changes.push({ version: v, record_key: key, record_json: prevJson, deleted: 1 });
      counter = v;
      return 1;
    },

    async readLive(key) {
      return live.get(key) ?? null;
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
