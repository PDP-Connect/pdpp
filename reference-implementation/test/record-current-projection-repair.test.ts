// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the record-current-projection-repair tool.
 *
 * Two layers:
 *
 *   1. Pure-unit tests (no DB) for the classifier and helpers. These run
 *      everywhere and are the regression guard for the invariant logic:
 *      missing-current, stale-current, latest-deleted, and the
 *      unresolved-pruned refusal are decided by classifyMismatch().
 *
 *   2. DB-backed integration tests (skipped cleanly when
 *      PDPP_TEST_POSTGRES_URL is unset) that seed fixture rows in a
 *      uniquely-named connector_instance, run the real detect/repair
 *      path, and assert:
 *        - missing_current is detected and inserted on --apply
 *        - stale_current is detected and updated on --apply
 *        - latest_deleted is detected but NOT applied without
 *          --apply-deletes, and IS reconciled with --apply-deletes
 *        - unresolved_pruned (current newer than retained history, and
 *          orphan current with no history) is reported and never touched
 *        - cross-key isolation: repair never reaches across record_key
 *        - a backup table is created on --apply and captures pre-images
 *        - an already-consistent projection yields zero previews
 *
 * The integration tests create the minimal records/record_changes/
 * version_counter schema themselves so they can run against a throwaway
 * database (never pdpp_proof) without bootstrapping the full server.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: localized test assertion preserves its explicit contract.
import pg from "pg";
import {
  applyDeleteRepair,
  applyProjectionRepair,
  BACKUP_TABLE_PREFIX,
  backupTableName,
  classifyMismatch,
  countByKind,
  detectMismatches,
  isRepairable,
  MISMATCH_KINDS,
  type MismatchPreview,
  parseLimit,
  runRepair,
  sanitizeIdentifierToken,
  truncateKey,
} from "../scripts/repair/record-current-projection-repair.ts";

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Fixture builder for MismatchPreview literals used only to exercise
// isRepairable/countByKind, which read `kind` alone. The other fields are
// filled with neutral defaults so each call site only has to state the
// field(s) it actually varies.
function fakePreview(overrides: Partial<MismatchPreview> & Pick<MismatchPreview, "kind">): MismatchPreview {
  return {
    currentDeleted: null,
    currentExists: false,
    currentJsonBytes: 0,
    currentVersion: null,
    latestHistoryDeleted: null,
    latestHistoryJsonBytes: 0,
    latestHistoryVersion: null,
    recordKey: "fixture-key",
    ...overrides,
  };
}

// noUncheckedIndexedAccess makes `previews[0]` possibly-undefined; the
// call sites already assert `previews.length` immediately before reading
// index 0, so this re-asserts that same invariant to narrow the type
// without a forbidden non-null assertion.
function onlyPreview(previews: MismatchPreview[]): MismatchPreview {
  assert.equal(previews.length, 1);
  const [preview] = previews;
  assert.ok(preview);
  return preview;
}

interface FixtureContext {
  connectorId: string;
  connectorInstanceId: string;
  pool: pg.Pool;
  stamp: string;
  stream: string;
}

interface SeedOpts {
  deleted?: boolean;
}

// ─── Pure-unit tests (no DB) ─────────────────────────────────────────────

test("parseLimit accepts positive integers, rejects the rest", () => {
  assert.equal(parseLimit("1"), 1);
  assert.equal(parseLimit("42"), 42);
  assert.equal(parseLimit(undefined), null);
  assert.equal(parseLimit(""), null);
  assert.equal(parseLimit("0"), "invalid");
  assert.equal(parseLimit("-3"), "invalid");
  assert.equal(parseLimit("1.5"), "invalid");
  assert.equal(parseLimit("abc"), "invalid");
  assert.equal(parseLimit(true), "invalid");
});

test("truncateKey elides long keys but preserves short ones", () => {
  assert.equal(truncateKey("short"), "short");
  assert.equal(truncateKey("0123456789abcdef"), "0123456789abcdef"); // 16
  assert.equal(truncateKey("0123456789abcdefg"), "01234567…defg");
});

test("sanitizeIdentifierToken lowercases and strips unsafe chars", () => {
  assert.equal(sanitizeIdentifierToken("cin_029a67A16", "x"), "cin_029a67a16");
  assert.equal(sanitizeIdentifierToken("trans-actions!", "x"), "trans_actions_");
  // All-unsafe chars sanitize to underscores (non-empty, still a valid
  // identifier fragment; uniqueness comes from the stamp).
  assert.equal(sanitizeIdentifierToken("!!!", "x"), "___");
  // Empty / over-long tokens are refused so the backup-table name stays safe.
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => sanitizeIdentifierToken("", "x"), /unsafe x/);
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.throws(() => sanitizeIdentifierToken("a".repeat(200), "x"), /unsafe x/);
});

test("backupTableName composes a prefixed, hashed, stamped name within 63 bytes", () => {
  const name = backupTableName({
    connectorInstanceId: "cin_ABC",
    stamp: "1717400000000",
    stream: "transactions",
  });
  assert.ok(name.startsWith(`${BACKUP_TABLE_PREFIX}_`));
  assert.ok(name.includes("cin_abc"), "short cin survives as a readable fragment");
  assert.ok(name.length <= 63, `name must fit Postgres identifier limit, got ${name.length}`);
});

test("backupTableName stays within 63 bytes and is unique for a long real-world cin", () => {
  const longCin = "cin_029a67a16d8a252f6e3eb896";
  const a = backupTableName({ connectorInstanceId: longCin, stamp: "1780528955918", stream: "transactions" });
  const b = backupTableName({ connectorInstanceId: longCin, stamp: "1780528955919", stream: "transactions" });
  assert.ok(a.length <= 63, `got ${a.length}: ${a}`);
  assert.ok(b.length <= 63, `got ${b.length}: ${b}`);
  // Different stamps must yield different names even after truncation —
  // the hash component guarantees no silent collision.
  assert.notEqual(a, b);
  // Same scope + same stamp is deterministic.
  const aAgain = backupTableName({ connectorInstanceId: longCin, stamp: "1780528955918", stream: "transactions" });
  assert.equal(a, aAgain);
});

test("classifyMismatch: missing current row for a non-deleted latest history", () => {
  // The Chase symptom: latest history says the record exists, no current row.
  assert.equal(
    classifyMismatch({ deleted: false, jsonEqual: false, version: 5 }, null),
    MISMATCH_KINDS.MISSING_CURRENT
  );
  // A current row that is itself deleted but latest history is live → missing.
  assert.equal(
    classifyMismatch({ deleted: false, jsonEqual: false, version: 5 }, { deleted: true, version: 4 }),
    MISMATCH_KINDS.MISSING_CURRENT
  );
});

test("classifyMismatch: stale current row (older version or different json)", () => {
  assert.equal(
    classifyMismatch({ deleted: false, jsonEqual: true, version: 5 }, { deleted: false, version: 4 }),
    MISMATCH_KINDS.STALE_CURRENT
  );
  // Same version but json drifted → stale.
  assert.equal(
    classifyMismatch({ deleted: false, jsonEqual: false, version: 5 }, { deleted: false, version: 5 }),
    MISMATCH_KINDS.STALE_CURRENT
  );
});

test("classifyMismatch: consistent projection returns null", () => {
  // Live latest, matching current version + json.
  assert.equal(classifyMismatch({ deleted: false, jsonEqual: true, version: 5 }, { deleted: false, version: 5 }), null);
  // Deleted latest, no current row.
  assert.equal(classifyMismatch({ deleted: true, jsonEqual: false, version: 5 }, null), null);
  // Deleted latest, already-deleted current row.
  assert.equal(classifyMismatch({ deleted: true, jsonEqual: false, version: 5 }, { deleted: true, version: 5 }), null);
});

test("classifyMismatch: latest-deleted with a live current row is flagged, not resurrected", () => {
  assert.equal(
    classifyMismatch({ deleted: true, jsonEqual: false, version: 6 }, { deleted: false, version: 5 }),
    MISMATCH_KINDS.LATEST_DELETED
  );
});

test("classifyMismatch: current newer than retained history is unresolved_pruned", () => {
  // Current row version exceeds the newest retained change → source pruned.
  assert.equal(
    classifyMismatch({ deleted: false, jsonEqual: false, version: 5 }, { deleted: false, version: 9 }),
    MISMATCH_KINDS.UNRESOLVED_PRUNED
  );
});

test("isRepairable gates latest_deleted behind applyDeletes and never repairs pruned", () => {
  const missing = fakePreview({ kind: MISMATCH_KINDS.MISSING_CURRENT });
  const stale = fakePreview({ kind: MISMATCH_KINDS.STALE_CURRENT });
  const del = fakePreview({ kind: MISMATCH_KINDS.LATEST_DELETED });
  const pruned = fakePreview({ kind: MISMATCH_KINDS.UNRESOLVED_PRUNED });
  assert.equal(isRepairable(missing, false), true);
  assert.equal(isRepairable(stale, false), true);
  assert.equal(isRepairable(del, false), false);
  assert.equal(isRepairable(del, true), true);
  assert.equal(isRepairable(pruned, false), false);
  assert.equal(isRepairable(pruned, true), false);
});

test("countByKind tallies each class", () => {
  const counts = countByKind([
    fakePreview({ kind: MISMATCH_KINDS.MISSING_CURRENT }),
    fakePreview({ kind: MISMATCH_KINDS.MISSING_CURRENT }),
    fakePreview({ kind: MISMATCH_KINDS.STALE_CURRENT }),
    fakePreview({ kind: MISMATCH_KINDS.UNRESOLVED_PRUNED }),
  ]);
  assert.equal(counts.missing_current, 2);
  assert.equal(counts.stale_current, 1);
  assert.equal(counts.latest_deleted, 0);
  assert.equal(counts.unresolved_pruned, 1);
});

// ─── DB-backed integration tests ─────────────────────────────────────────

if (POSTGRES_URL) {
  // Minimal schema matching server/postgres-storage.js. Created idempotently
  // so the test runs against a throwaway DB without the full bootstrap.
  async function ensureSchema(pool: pg.Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS records (
        id BIGSERIAL PRIMARY KEY,
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json JSONB NOT NULL,
        emitted_at TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 1,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        cursor_value TEXT,
        primary_key_text TEXT NOT NULL,
        UNIQUE(connector_instance_id, stream, record_key)
      );
      CREATE TABLE IF NOT EXISTS record_changes (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version BIGINT NOT NULL,
        record_json JSONB,
        emitted_at TEXT NOT NULL,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        deleted_at TEXT,
        PRIMARY KEY(connector_instance_id, stream, version)
      );
      CREATE TABLE IF NOT EXISTS version_counter (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_instance_id, stream)
      );
    `);
  }

  async function withFixture(fn: (ctx: FixtureContext) => Promise<void>): Promise<void> {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    await ensureSchema(pool);
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_repairproj_${suffix}`;
    const connectorId = `repairproj_${suffix}`;
    const stream = "transactions";
    const stamp = `t${suffix}`;
    try {
      await fn({ connectorId, connectorInstanceId, pool, stamp, stream });
    } finally {
      // Drop any backup tables this fixture created, then the seed rows.
      // The backup name embeds a readable HEAD of the (sanitized) cin
      // (long cins are truncated to fit 63 bytes), so match on a short
      // head that always survives. Each fixture uses a unique cin.
      const cinHead = sanitizeIdentifierToken(connectorInstanceId, "cin").slice(0, 18);
      const backups = await pool.query(
        `SELECT tablename FROM pg_tables
          WHERE schemaname = 'public'
            AND tablename LIKE $1
            AND tablename LIKE $2`,
        [`${BACKUP_TABLE_PREFIX}_%`, `%${cinHead}%`]
      );
      for (const r of backups.rows) {
        // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
        await pool.query(`DROP TABLE IF EXISTS "${r.tablename}"`);
      }
      await pool.query("DELETE FROM record_changes WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM records WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.query("DELETE FROM version_counter WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.end();
    }
  }

  async function seedChange(
    pool: pg.Pool,
    { connectorId, connectorInstanceId, stream }: FixtureContext,
    recordKey: string,
    version: number,
    data: { amount: number; id: string } | null,
    opts: SeedOpts = {}
  ): Promise<void> {
    const deleted = opts.deleted === true;
    await pool.query(
      `INSERT INTO record_changes
         (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        connectorId,
        connectorInstanceId,
        stream,
        recordKey,
        version,
        // biome-ignore lint/style/noNestedTernary: localized test assertion preserves its explicit contract.
        deleted ? (data === null || data === undefined ? null : JSON.stringify(data)) : JSON.stringify(data),
        `2026-05-0${(version % 9) + 1}T00:00:00Z`,
        deleted,
        deleted ? `2026-05-0${(version % 9) + 1}T00:00:00Z` : null,
      ]
    );
  }

  async function seedCurrent(
    pool: pg.Pool,
    { connectorId, connectorInstanceId, stream }: FixtureContext,
    recordKey: string,
    version: number,
    data: { amount: number; id: string },
    opts: SeedOpts = {}
  ): Promise<void> {
    const deleted = opts.deleted === true;
    await pool.query(
      `INSERT INTO records
         (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $4, $4)`,
      [
        connectorId,
        connectorInstanceId,
        stream,
        recordKey,
        JSON.stringify(data),
        `2026-05-0${(version % 9) + 1}T00:00:00Z`,
        version,
        deleted,
        deleted ? `2026-05-0${(version % 9) + 1}T00:00:00Z` : null,
      ]
    );
  }

  async function setCounter(
    pool: pg.Pool,
    { connectorId, connectorInstanceId, stream }: FixtureContext,
    maxVersion: number
  ): Promise<void> {
    await pool.query(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES($1, $2, $3, $4)`,
      [connectorId, connectorInstanceId, stream, maxVersion]
    );
  }

  test("detects and (on apply) inserts a missing current row — the Chase symptom", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      // History exists (latest non-deleted) but NO current row.
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "txn-1", 1, { amount: 100, id: "txn-1" });
      await seedChange(pool, ctx, "txn-1", 2, { amount: 150, id: "txn-1" });

      const dry = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      const dryPreview = onlyPreview(dry.previews);
      assert.equal(dryPreview.kind, MISMATCH_KINDS.MISSING_CURRENT);
      assert.equal(dryPreview.latestHistoryVersion, 2);
      assert.equal(dry.repairableCount, 1);

      const applied = await runRepair({
        apply: true,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(applied.failed, false);
      assert.equal(applied.affected.inserted, 1);
      assert.ok(applied.backupTable, "apply creates a backup table");

      // Current row now reflects latest history version + payload.
      const row = await pool.query(
        `SELECT version, deleted, record_json FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'txn-1'`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(row.rows[0].version), 2);
      assert.equal(row.rows[0].deleted, false);
      assert.equal(row.rows[0].record_json.amount, 150);

      // Re-running is now a no-op (projection consistent).
      const after = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(after.previews.length, 0);

      // version_counter must be untouched — repair allocates no new version.
      const counter = await pool.query(
        "SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2",
        [connectorInstanceId, stream]
      );
      assert.equal(Number(counter.rows[0].max_version), 2);
    });
  });

  test("backup table captures the pre-image (existed_before=false for an inserted key)", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 1);
      await seedChange(pool, ctx, "txn-1", 1, { amount: 100, id: "txn-1" });

      const applied = await runRepair({
        apply: true,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      const backup = await pool.query(`SELECT record_key, existed_before, version FROM "${applied.backupTable}"`);
      assert.equal(backup.rows.length, 1);
      assert.equal(backup.rows[0].record_key, "txn-1");
      assert.equal(backup.rows[0].existed_before, false);
      assert.equal(backup.rows[0].version, null);
    });
  });

  test("detects and (on apply) updates a stale current row to latest history", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "txn-2", 1, { amount: 10, id: "txn-2" });
      await seedChange(pool, ctx, "txn-2", 2, { amount: 20, id: "txn-2" });
      // Current row stuck at the OLD version/payload.
      await seedCurrent(pool, ctx, "txn-2", 1, { amount: 10, id: "txn-2" });

      const dry = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      const dryPreview = onlyPreview(dry.previews);
      assert.equal(dryPreview.kind, MISMATCH_KINDS.STALE_CURRENT);

      const applied = await runRepair({
        apply: true,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(applied.affected.updated, 1);

      const row = await pool.query(
        `SELECT version, record_json FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'txn-2'`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(row.rows[0].version), 2);
      assert.equal(row.rows[0].record_json.amount, 20);

      // The backup captured the stale pre-image (existed_before=true, v1).
      const backup = await pool.query(`SELECT existed_before, version FROM "${applied.backupTable}"`);
      assert.equal(backup.rows[0].existed_before, true);
      assert.equal(Number(backup.rows[0].version), 1);
    });
  });

  test("latest_deleted is detected but NOT applied without --apply-deletes", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "txn-3", 1, { amount: 5, id: "txn-3" });
      await seedChange(pool, ctx, "txn-3", 2, null, { deleted: true });
      // Current row is still live (the bug: a delete that never projected).
      await seedCurrent(pool, ctx, "txn-3", 1, { amount: 5, id: "txn-3" });

      const dry = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      const dryPreview = onlyPreview(dry.previews);
      assert.equal(dryPreview.kind, MISMATCH_KINDS.LATEST_DELETED);
      assert.equal(dry.repairableCount, 0, "not repairable without --apply-deletes");

      // apply WITHOUT apply-deletes must not touch the row.
      const appliedNoDel = await runRepair({
        apply: true,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(appliedNoDel.affected.deleted, 0);
      assert.equal(appliedNoDel.backupTable, null, "no backup table when nothing repairable");
      const stillLive = await pool.query(
        `SELECT deleted FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'txn-3'`,
        [connectorInstanceId, stream]
      );
      assert.equal(stillLive.rows[0].deleted, false, "row must not be resurrected/deleted silently");
    });
  });

  test("latest_deleted IS reconciled with --apply-deletes (consistent delete, no resurrection)", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "txn-4", 1, { amount: 5, id: "txn-4" });
      await seedChange(pool, ctx, "txn-4", 2, null, { deleted: true });
      await seedCurrent(pool, ctx, "txn-4", 1, { amount: 5, id: "txn-4" });

      const applied = await runRepair({
        apply: true,
        applyDeletes: true,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(applied.affected.deleted, 1);

      const row = await pool.query(
        `SELECT deleted, version, deleted_at FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'txn-4'`,
        [connectorInstanceId, stream]
      );
      assert.equal(row.rows[0].deleted, true);
      assert.equal(Number(row.rows[0].version), 2);
      assert.ok(row.rows[0].deleted_at, "deleted_at is set from the authoritative delete row");
    });
  });

  test("unresolved_pruned: current newer than retained history is reported, never touched", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      // Counter says v10, but only v8 retained; current row is v10 (its
      // source change row was pruned away).
      await setCounter(pool, ctx, 10);
      await seedChange(pool, ctx, "txn-5", 8, { amount: 80, id: "txn-5" });
      await seedCurrent(pool, ctx, "txn-5", 10, { amount: 100, id: "txn-5" });

      const dry = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      const dryPreview = onlyPreview(dry.previews);
      assert.equal(dryPreview.kind, MISMATCH_KINDS.UNRESOLVED_PRUNED);
      assert.equal(dry.repairableCount, 0);

      // Even --apply --apply-deletes must not mutate it.
      const applied = await runRepair({
        apply: true,
        applyDeletes: true,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(applied.affected.inserted, 0);
      assert.equal(applied.affected.updated, 0);
      assert.equal(applied.affected.deleted, 0);
      const row = await pool.query(
        `SELECT version, record_json FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'txn-5'`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(row.rows[0].version), 10);
      assert.equal(row.rows[0].record_json.amount, 100);
    });
  });

  test("unresolved_pruned: orphan current row with no history at all is reported, never touched", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 3);
      // A current row whose key has zero retained record_changes rows.
      await seedCurrent(pool, ctx, "orphan-1", 3, { amount: 7, id: "orphan-1" });

      const dry = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      const dryPreview = onlyPreview(dry.previews);
      assert.equal(dryPreview.kind, MISMATCH_KINDS.UNRESOLVED_PRUNED);
      assert.equal(dry.repairableCount, 0);
    });
  });

  test("cross-key isolation: repair only touches the mismatched key", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 4);
      // Key A: consistent (history v1 == current v1).
      await seedChange(pool, ctx, "a", 1, { amount: 1, id: "a" });
      await seedCurrent(pool, ctx, "a", 1, { amount: 1, id: "a" });
      // Key B: missing current row.
      await seedChange(pool, ctx, "b", 2, { amount: 2, id: "b" });

      const applied = await runRepair({
        apply: true,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(applied.affected.inserted, 1);
      assert.equal(applied.affected.updated, 0);

      // Backup table only references the touched key (b).
      const backup = await pool.query(`SELECT record_key FROM "${applied.backupTable}" ORDER BY record_key`);
      assert.deepEqual(
        backup.rows.map((r) => r.record_key),
        ["b"]
      );

      // Key A is untouched.
      const a = await pool.query(
        `SELECT version FROM records WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'a'`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(a.rows[0].version), 1);
    });
  });

  test("--record-key scopes detection to a single key", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "x", 1, { amount: 1, id: "x" }); // missing current
      await seedChange(pool, ctx, "y", 2, { amount: 2, id: "y" }); // missing current

      const onlyX = await detectMismatches({
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: "x",
        stream,
      });
      const onlyXPreview = onlyPreview(onlyX);
      assert.equal(onlyXPreview.recordKey, "x");
    });
  });

  test("a fully consistent projection yields zero previews", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "k1", 1, { amount: 1, id: "k1" });
      await seedChange(pool, ctx, "k2", 2, { amount: 2, id: "k2" });
      await seedCurrent(pool, ctx, "k1", 1, { amount: 1, id: "k1" });
      await seedCurrent(pool, ctx, "k2", 2, { amount: 2, id: "k2" });

      const dry = await runRepair({
        apply: false,
        applyDeletes: false,
        connectorInstanceId,
        limit: null,
        pool,
        recordKey: null,
        stamp: ctx.stamp,
        stream,
      });
      assert.equal(dry.previews.length, 0);
      assert.equal(dry.repairableCount, 0);
    });
  });

  test("applyProjectionRepair refuses to project a stale preview when newer history exists", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 2);
      await seedChange(pool, ctx, "race-1", 1, { amount: 10, id: "race-1" });
      await seedChange(pool, ctx, "race-1", 2, { amount: 20, id: "race-1" });

      const client = await pool.connect();
      try {
        await assert.rejects(
          () =>
            applyProjectionRepair({
              client,
              connectorInstanceId,
              preview: fakePreview({
                kind: MISMATCH_KINDS.STALE_CURRENT,
                latestHistoryVersion: 1,
                recordKey: "race-1",
              }),
              stream,
            }),
          // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
          /no longer safe/
        );
      } finally {
        client.release();
      }

      const current = await pool.query(
        `SELECT COUNT(*)::int AS count FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'race-1'`,
        [connectorInstanceId, stream]
      );
      assert.equal(current.rows[0].count, 0, "stale preview must not insert an older current row");
    });
  });

  test("applyProjectionRepair refuses to overwrite a current row that already advanced beyond the preview", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 1);
      await seedChange(pool, ctx, "race-2", 1, { amount: 10, id: "race-2" });
      await seedCurrent(pool, ctx, "race-2", 2, { amount: 20, id: "race-2" });

      const client = await pool.connect();
      try {
        await assert.rejects(
          () =>
            applyProjectionRepair({
              client,
              connectorInstanceId,
              preview: fakePreview({
                kind: MISMATCH_KINDS.STALE_CURRENT,
                latestHistoryVersion: 1,
                recordKey: "race-2",
              }),
              stream,
            }),
          // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
          /no longer safe/
        );
      } finally {
        client.release();
      }

      const current = await pool.query(
        `SELECT version, record_json FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'race-2'`,
        [connectorInstanceId, stream]
      );
      assert.equal(Number(current.rows[0].version), 2);
      assert.equal(current.rows[0].record_json.amount, 20);
    });
  });

  test("applyDeleteRepair refuses to project a stale delete when newer history exists", async () => {
    await withFixture(async (ctx) => {
      const { pool, connectorInstanceId, stream } = ctx;
      await setCounter(pool, ctx, 3);
      await seedChange(pool, ctx, "race-3", 1, { amount: 10, id: "race-3" });
      await seedChange(pool, ctx, "race-3", 2, null, { deleted: true });
      await seedChange(pool, ctx, "race-3", 3, { amount: 30, id: "race-3" });
      await seedCurrent(pool, ctx, "race-3", 1, { amount: 10, id: "race-3" });

      const client = await pool.connect();
      try {
        await assert.rejects(
          () =>
            applyDeleteRepair({
              client,
              connectorInstanceId,
              preview: fakePreview({
                kind: MISMATCH_KINDS.LATEST_DELETED,
                latestHistoryVersion: 2,
                recordKey: "race-3",
              }),
              stream,
            }),
          // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
          /no longer safe/
        );
      } finally {
        client.release();
      }

      const current = await pool.query(
        `SELECT deleted, version FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = 'race-3'`,
        [connectorInstanceId, stream]
      );
      assert.equal(current.rows[0].deleted, false);
      assert.equal(Number(current.rows[0].version), 1);
    });
  });
} else {
  test("current-projection repair DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  }, () => {});
}
