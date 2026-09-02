// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for connector-cursor-reset.ts - the owner-gated cursor-reset tool
 * that turns the next incremental run into a full source resync by blanking
 * `connector_state.state_json` for explicit (connector_instance_id, stream)
 * pairs.
 *
 * Pure units run everywhere. The DB integration suite is env-gated on
 * PDPP_TEST_POSTGRES_URL and asserts:
 *   - dry-run writes nothing and reports present/absent streams;
 *   - apply snapshots the pre-image into a backup table and resets only the
 *     present streams to {};
 *   - an absent stream is skipped (a missing cursor already means "no since");
 *   - the backup table holds the exact prior cursor so the reset is reversible.
 *
 * The cursor-reset is the only owner step in the current-projection GitHub
 * repair that had no tooling and no test; this closes that gap. The subsequent
 * run + self-heal + reconcile are covered by current-projection-recurrence-
 * guard.test.js and postgres-records-ingest-noop.test.js.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import pg from "pg";
import {
  BACKUP_TABLE_PREFIX,
  backupTableName,
  formatSummary,
  parseArgs,
  runCursorReset,
  sanitizeIdentifierToken,
  truncateId,
  validateArgs,
} from "../scripts/repair/connector-cursor-reset.ts";
import { connectorInstanceAdvisoryLockKey } from "../server/connector-instance-write-coordinator.ts";

const REGEXP_1 = /connector-instance-id/;
const REGEXP_2 = /at least one --stream/;
const REGEXP_3 = /unsafe cin/;
const REGEXP_4 = /\[DRY-RUN\]/;
const REGEXP_5 = /would reset to \{\}/;
const REGEXP_6 = /absent\s+gists/;
const REGEXP_7 = /--apply/;
const REGEXP_8 = /\[APPLY\]/;
const REGEXP_9 = /reset_count=1/;
const REGEXP_10 = /backup_table=ccr_backup_/;
const REGEXP_11 = /POST \/v1\/owner\/connections/;
const REGEXP_12 = /connector-instance writer admission is saturated/;

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Pure units

test("parseArgs collects a repeatable --stream, de-duplicating in first-seen order", () => {
  const args = parseArgs([
    "--connector-instance-id=cin_abc",
    "--stream=issues",
    "--stream=pull_requests",
    "--stream=issues",
    "--apply",
  ]);
  assert.equal(args.connectorInstanceId, "cin_abc");
  assert.deepEqual(args.streams, ["issues", "pull_requests"]);
  assert.equal(args.apply, true);
});

test("parseArgs leaves apply false and streams empty when absent", () => {
  const args = parseArgs(["--connector-instance-id=cin_abc"]);
  assert.equal(args.apply, false);
  assert.deepEqual(args.streams, []);
});

test("validateArgs requires an instance id", () => {
  const error = validateArgs({ connectorInstanceId: null, streams: ["issues"] });
  assert.ok(error, "expected a validation error string");
  assert.match(error, REGEXP_1);
});

test("validateArgs refuses an empty stream set (no reset-all mode)", () => {
  const error = validateArgs({ connectorInstanceId: "cin_abc", streams: [] });
  assert.ok(error, "expected a validation error string");
  assert.match(error, REGEXP_2);
});

test("validateArgs passes for a scoped request", () => {
  assert.equal(validateArgs({ connectorInstanceId: "cin_abc", streams: ["issues"] }), null);
});

test("truncateId elides long identifiers but preserves short ones", () => {
  assert.equal(truncateId("issues"), "issues");
  assert.equal(truncateId("cin_b110e71fb14fb61450d2d427"), "cin_b110...d427");
});

test("sanitizeIdentifierToken lowercases and strips unsafe chars", () => {
  assert.equal(sanitizeIdentifierToken("cin_B110-e71", "cin"), "cin_b110_e71");
  assert.throws(() => sanitizeIdentifierToken("", "cin"), REGEXP_3);
});

test("backupTableName is prefixed, stable for the same scope, and within 63 bytes", () => {
  const a = backupTableName({
    connectorInstanceId: "cin_b110e71fb14fb61450d2d427",
    stamp: "20260604120000",
    streams: ["issues", "pull_requests", "repositories"],
  });
  // Stream order must not change the name (sorted internally).
  const b = backupTableName({
    connectorInstanceId: "cin_b110e71fb14fb61450d2d427",
    stamp: "20260604120000",
    streams: ["repositories", "issues", "pull_requests"],
  });
  assert.ok(a.startsWith(`${BACKUP_TABLE_PREFIX}_`));
  assert.equal(a, b, "name is independent of stream argument order");
  assert.ok(a.length <= 63, `name within 63 bytes: ${a} (${a.length})`);
});

test("backupTableName diverges when the stream set differs", () => {
  const a = backupTableName({ connectorInstanceId: "cin_x", stamp: "s1", streams: ["issues"] });
  const b = backupTableName({ connectorInstanceId: "cin_x", stamp: "s1", streams: ["issues", "pull_requests"] });
  assert.notEqual(a, b);
});

test("formatSummary labels dry-run vs apply and never prints cursor values", () => {
  const dry = formatSummary({
    absent: ["gists"],
    applied: false,
    backupTable: null,
    connectorInstanceId: "cin_b110e71fb14fb61450d2d427",
    failed: false,
    present: ["issues"],
    resetCount: 0,
    streams: ["issues", "gists"],
  });
  assert.match(dry, REGEXP_4);
  assert.match(dry, REGEXP_5);
  assert.match(dry, REGEXP_6);
  assert.match(dry, REGEXP_7);

  const applied = formatSummary({
    absent: [],
    applied: true,
    backupTable: "ccr_backup_deadbeef__cin_b110__2026",
    connectorInstanceId: "cin_b110e71fb14fb61450d2d427",
    failed: false,
    present: ["issues"],
    resetCount: 1,
    streams: ["issues"],
  });
  assert.match(applied, REGEXP_8);
  assert.match(applied, REGEXP_9);
  assert.match(applied, REGEXP_10);
  assert.match(applied, REGEXP_11);
});

// DB integration (Postgres)

if (POSTGRES_URL) {
  interface FixtureContext {
    connectorId: string;
    connectorInstanceId: string;
    pool: pg.Pool;
    stamp: string;
  }

  async function ensureSchema(pool: pg.Pool): Promise<void> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS connector_state (
        connector_id TEXT NOT NULL,
        connector_instance_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_instance_id, stream)
      );
    `);
  }

  async function withFixture(fn: (ctx: FixtureContext) => Promise<void>): Promise<void> {
    const pool = new Pool({ connectionString: POSTGRES_URL });
    await ensureSchema(pool);
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorInstanceId = `cin_ccr_${suffix}`;
    const connectorId = `ccr_${suffix}`;
    const stamp = `t${suffix}`;
    try {
      await fn({ connectorId, connectorInstanceId, pool, stamp });
    } finally {
      // Drop backup tables this fixture created (name embeds a sanitized head
      // of the unique cin), then the seed rows.
      const cinHead = sanitizeIdentifierToken(connectorInstanceId, "cin").slice(0, 12);
      const backups = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables
          WHERE tablename LIKE $1`,
        [`${BACKUP_TABLE_PREFIX}_%${cinHead}%`]
      );
      for (const r of backups.rows) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await pool.query(`DROP TABLE IF EXISTS "${r.tablename}"`);
      }
      await pool.query("DELETE FROM connector_state WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.end();
    }
  }

  interface SeedCursorInput {
    connectorId: string;
    connectorInstanceId: string;
    stateJson: unknown;
    stream: string;
  }

  async function seedCursor(
    pool: pg.Pool,
    { connectorId, connectorInstanceId, stream, stateJson }: SeedCursorInput
  ): Promise<void> {
    await pool.query(
      `INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, '2026-06-04T05:00:00.000Z')`,
      [connectorId, connectorInstanceId, stream, JSON.stringify(stateJson)]
    );
  }

  async function readCursor(pool: pg.Pool, connectorInstanceId: string, stream: string): Promise<unknown> {
    const r = await pool.query<{ state_json: unknown }>(
      "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = $2",
      [connectorInstanceId, stream]
    );
    return r.rows.length ? (r.rows[0]?.state_json ?? null) : null;
  }

  test("dry-run reports present/absent and writes nothing", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stateJson: { last_updated_at: "2026-06-04T05:37:44Z" },
        stream: "issues",
      });

      const result = await runCursorReset({
        apply: false,
        connectorInstanceId,
        pool,
        stamp,
        streams: ["issues", "gists"],
      });

      assert.deepEqual(result.present, ["issues"]);
      assert.deepEqual(result.absent, ["gists"]);
      assert.equal(result.applied, false);
      assert.equal(result.backupTable, null);
      assert.equal(result.resetCount, 0);

      // The stored cursor is untouched by a dry-run.
      const after = await readCursor(pool, connectorInstanceId, "issues");
      assert.deepEqual(after, { last_updated_at: "2026-06-04T05:37:44Z" });
    });
  });

  test("apply resets only present streams to {} and snapshots the pre-image", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stateJson: { last_updated_at: "2026-06-04T05:37:44Z" },
        stream: "issues",
      });
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stateJson: { last_pushed_at: "2026-06-04T05:36:23Z" },
        stream: "repositories",
      });

      const result = await runCursorReset({
        apply: true,
        connectorInstanceId,
        pool,
        stamp,
        streams: ["issues", "repositories", "gists"],
      });

      assert.equal(result.failed, false);
      // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
      assert.deepEqual(result.present.sort(), ["issues", "repositories"]);
      assert.deepEqual(result.absent, ["gists"]);
      assert.equal(result.resetCount, 2);
      assert.ok(result.backupTable);

      // Both present cursors are now empty objects.
      assert.deepEqual(await readCursor(pool, connectorInstanceId, "issues"), {});
      assert.deepEqual(await readCursor(pool, connectorInstanceId, "repositories"), {});

      // The backup table holds the exact pre-image so the reset is reversible.
      const backup = await pool.query(`SELECT stream, state_json FROM "${result.backupTable}" ORDER BY stream`);
      const byStream = Object.fromEntries(backup.rows.map((r) => [r.stream, r.state_json]));
      assert.deepEqual(byStream.issues, { last_updated_at: "2026-06-04T05:37:44Z" });
      assert.deepEqual(byStream.repositories, { last_pushed_at: "2026-06-04T05:36:23Z" });

      // Restore from the backup proves the undo path works.
      await pool.query(
        `UPDATE connector_state cs
            SET state_json = b.state_json
           FROM "${result.backupTable}" b
          WHERE cs.connector_instance_id = $1
            AND cs.stream = b.stream`,
        [connectorInstanceId]
      );
      assert.deepEqual(await readCursor(pool, connectorInstanceId, "issues"), {
        last_updated_at: "2026-06-04T05:37:44Z",
      });
    });
  });

  test("apply with no present streams writes nothing and creates no backup", async () => {
    await withFixture(async ({ pool, connectorInstanceId, stamp }) => {
      const result = await runCursorReset({
        apply: true,
        connectorInstanceId,
        pool,
        stamp,
        streams: ["issues"],
      });
      assert.deepEqual(result.present, []);
      assert.deepEqual(result.absent, ["issues"]);
      assert.equal(result.resetCount, 0);
      assert.equal(result.backupTable, null);
      assert.equal(result.failed, false);
    });
  });

  // D9 fence: connector-instance advisory lock (PR238-POSTGRES-D9-FIX-R5-0831)

  test("apply blocks on the connector-instance advisory lock (deterministic contention, D9 fence)", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stateJson: { last_updated_at: "2026-06-04T05:37:44Z" },
        stream: "issues",
      });

      // Hold the SAME connector-instance advisory lock this apply-mode reset
      // must acquire, on a separate raw connection, in an open (uncommitted)
      // transaction — modeling a concurrent D9 coalescence merge (or any
      // other production writer) that is already mid-transaction on this
      // instance. If the reset's write reached connector_state without
      // taking this lock, it would proceed uncontended; proving it BLOCKS
      // proves the lock is real, not decorative.
      const holderPool = new Pool({ connectionString: POSTGRES_URL });
      const holder = await holderPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        // runCursorReset never throws — its outer catch converts a
        // lock-acquisition failure into { failed: true, error }, same as any
        // other transaction error. Assert on that contract, not a rejection.
        const contended = await runCursorReset({
          apply: true,
          connectorInstanceId,
          pool,
          stamp,
          streams: ["issues"],
        });
        assert.equal(contended.failed, true);
        assert.match(contended.error ?? "", REGEXP_12);

        // The reset's transaction never got past lock acquisition, so the
        // cursor must be exactly as seeded — no partial write, no backup
        // table created.
        const after = await readCursor(pool, connectorInstanceId, "issues");
        assert.deepEqual(after, { last_updated_at: "2026-06-04T05:37:44Z" });

        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        await holderPool.end();
      }

      // Once the holder releases, an otherwise-identical apply succeeds —
      // proving the fence serializes rather than permanently wedging the
      // instance.
      const recovered = await runCursorReset({ apply: true, connectorInstanceId, pool, stamp, streams: ["issues"] });
      assert.equal(recovered.failed, false);
      assert.deepEqual(await readCursor(pool, connectorInstanceId, "issues"), {});
    });
  });

  test("D9 legacy-target coalescence seam: a reset against a connector instance mid-coalescence-merge is fenced, not raced", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stateJson: { last_updated_at: "2026-06-04T05:37:44Z" },
        stream: "issues",
      });

      // Simulate the exact shape of coalesceExactPostgresLocalDeviceBindingDuplicates's
      // merge transaction: BEGIN, acquire the connector-instance lock, do
      // some merge work (here: nothing further is needed — holding the lock
      // open is the race window itself), then either COMMIT or ROLLBACK.
      // This proves the reset cannot land INSIDE that window regardless of
      // whether the merge eventually commits or rolls back.
      const mergePool = new Pool({ connectionString: POSTGRES_URL });
      const merge = await mergePool.connect();
      try {
        await merge.query("BEGIN");
        await merge.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        const duringMerge = await runCursorReset({
          apply: true,
          connectorInstanceId,
          pool,
          stamp,
          streams: ["issues"],
        });
        assert.equal(duringMerge.failed, true);
        assert.match(duringMerge.error ?? "", REGEXP_12);

        await merge.query("COMMIT");
      } finally {
        merge.release();
        await mergePool.end();
      }

      // The merge's own commit did not touch connector_state in this
      // simulation, so the cursor is still exactly as seeded — the fenced
      // reset attempt left no trace (no orphaned backup table, no partial
      // update).
      assert.deepEqual(await readCursor(pool, connectorInstanceId, "issues"), {
        last_updated_at: "2026-06-04T05:37:44Z",
      });
    });
  });

  // Mutation/counterweight: proves the test suite above actually
  // discriminates a fenced implementation from an unfenced one, rather than
  // passing regardless of whether the lock is taken. Drives the exact SQL
  // sequence an UNFENCED runCursorReset would issue (BEGIN, backup snapshot,
  // UPDATE, COMMIT — no pg_advisory_xact_lock call at all) against a
  // connector instance whose lock is held open by a concurrent transaction.
  // The unfenced sequence is expected to SUCCEED uncontended (proving the
  // regression this fix closes existed), which is the mirror image of the
  // real tool's expected BLOCK above.
  test("mutation counterweight: an UNFENCED reset sequence (no advisory lock) succeeds uncontended, proving the lock above is load-bearing", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedCursor(pool, {
        connectorId,
        connectorInstanceId,
        stateJson: { last_updated_at: "2026-06-04T05:37:44Z" },
        stream: "issues",
      });

      const holderPool = new Pool({ connectionString: POSTGRES_URL });
      const holder = await holderPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        // The exact write sequence runCursorReset's apply path uses, MINUS
        // the acquireConnectorInstanceLock call — this is what the tool
        // looked like before this fix. It must succeed uncontended even
        // while the holder above has the connector-instance lock open,
        // because it never asks for that lock.
        const client = await pool.connect();
        const backupTable = backupTableName({ connectorInstanceId, stamp, streams: ["issues"] });
        try {
          await client.query("BEGIN");
          await client.query(
            `CREATE TABLE "${backupTable}" AS
               SELECT connector_id, connector_instance_id, stream, state_json, updated_at
                 FROM connector_state
                WHERE connector_instance_id = $1 AND stream = ANY($2::text[])`,
            [connectorInstanceId, ["issues"]]
          );
          await client.query(
            `UPDATE connector_state
                SET state_json = '{}'::jsonb
              WHERE connector_instance_id = $1 AND stream = ANY($2::text[])`,
            [connectorInstanceId, ["issues"]]
          );
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        assert.deepEqual(
          await readCursor(pool, connectorInstanceId, "issues"),
          {},
          "an unfenced write reaches connector_state even while a concurrent transaction holds the connector-instance lock — this is the exact race the real tool's lock acquisition (asserted above) closes"
        );

        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        await holderPool.end();
      }
    });
  });
} else {
  test("connector-cursor-reset DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
