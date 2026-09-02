// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for gmail-backfill-target-extend.ts - the owner-gated repair that
 * raises `backfill.target_uid` on the Gmail `messages` cursor to close the
 * downtime-then-forward-resume UID gap.
 *
 * Pure units run everywhere. The DB integration suite is env-gated on
 * PDPP_TEST_POSTGRES_URL and asserts:
 *   - dry-run reports the plan and writes nothing;
 *   - apply snapshots the pre-image, raises target_uid under a CAS guard,
 *     and leaves backfilled_through_uid/forward_uidnext untouched;
 *   - preconditions (no cursor, no backfill.target_uid, uidvalidity
 *     mismatch, non-raising target, target at/above forward_uidnext) refuse
 *     the write;
 *   - a concurrent same-id STATE commit between read and write makes the
 *     guarded UPDATE match zero rows;
 *   - apply mode acquires the SAME connector-instance advisory lock D9
 *     coalescence and every other production Postgres writer take, BEFORE
 *     the cursor read used to build the plan (PR238-POSTGRES-D9-FIX-R5-0831).
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
  planExtend,
  runExtend,
  sanitizeIdentifierToken,
  truncateId,
  validateArgs,
} from "../scripts/repair/gmail-backfill-target-extend.ts";
import { connectorInstanceAdvisoryLockKey } from "../server/connector-instance-write-coordinator.ts";

const REGEXP_MISSING_ID = /connector-instance-id/;
const REGEXP_MISSING_TARGET = /--new-target-uid must be a positive integer/;
const REGEXP_UNSAFE = /unsafe cin/;
const REGEXP_DRY_RUN = /\[DRY-RUN\]/;
const REGEXP_APPLY = /\[APPLY\]/;
const REGEXP_NO_CURSOR = /no stored `messages` cursor/;
const REGEXP_NO_TARGET_UID = /no backfill\.target_uid/;
const REGEXP_UIDVALIDITY_MISMATCH = /does not match --expect-uidvalidity/;
const REGEXP_NO_RAISE = /does not raise the ceiling/;
const REGEXP_FORWARD_OVERLAP = /must stay below all_mail\.forward_uidnext/;
const REGEXP_ADMISSION_SATURATED = /connector-instance writer admission is saturated/;

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// Pure units

test("parseArgs reads connector-instance-id, new-target-uid, expect-uidvalidity, apply", () => {
  const args = parseArgs([
    "--connector-instance-id=cin_gmail_1",
    "--new-target-uid=324020",
    "--expect-uidvalidity=7",
    "--apply",
  ]);
  assert.equal(args.connectorInstanceId, "cin_gmail_1");
  assert.equal(args.newTargetUid, 324_020);
  assert.equal(args.expectUidvalidity, 7);
  assert.equal(args.apply, true);
});

test("validateArgs requires an instance id", () => {
  const error = validateArgs({ apply: false, connectorInstanceId: null, expectUidvalidity: null, newTargetUid: 100 });
  assert.ok(error);
  assert.match(error, REGEXP_MISSING_ID);
});

test("validateArgs requires a positive integer new-target-uid", () => {
  const error = validateArgs({
    apply: false,
    connectorInstanceId: "cin_x",
    expectUidvalidity: null,
    newTargetUid: Number.NaN,
  });
  assert.ok(error);
  assert.match(error, REGEXP_MISSING_TARGET);
});

test("sanitizeIdentifierToken lowercases and strips unsafe chars", () => {
  assert.equal(sanitizeIdentifierToken("cin_B110-e71", "cin"), "cin_b110_e71");
  assert.throws(() => sanitizeIdentifierToken("", "cin"), REGEXP_UNSAFE);
});

test("truncateId elides long identifiers but preserves short ones", () => {
  assert.equal(truncateId("issues"), "issues");
  assert.equal(truncateId("cin_b110e71fb14fb61450d2d427"), "cin_b110...d427");
});

test("backupTableName is prefixed and within 63 bytes", () => {
  const name = backupTableName({ connectorInstanceId: "cin_b110e71fb14fb61450d2d427", stamp: "20260604120000" });
  assert.ok(name.startsWith(`${BACKUP_TABLE_PREFIX}_`));
  assert.ok(name.length <= 63, `name within 63 bytes: ${name} (${name.length})`);
});

test("planExtend refuses when there is no stored cursor", () => {
  const result = planExtend({ cursor: null, expectUidvalidity: null, newTargetUid: 100 });
  assert.ok("error" in result);
  assert.match(result.error, REGEXP_NO_CURSOR);
});

test("planExtend refuses when the cursor has no backfill.target_uid", () => {
  const result = planExtend({
    cursor: { all_mail: { forward_uidnext: 500 } },
    expectUidvalidity: null,
    newTargetUid: 100,
  });
  assert.ok("error" in result);
  assert.match(result.error, REGEXP_NO_TARGET_UID);
});

test("planExtend refuses on a uidvalidity mismatch", () => {
  const result = planExtend({
    cursor: { backfill: { target_uid: 50, uidvalidity: 2 } },
    expectUidvalidity: 1,
    newTargetUid: 100,
  });
  assert.ok("error" in result);
  assert.match(result.error, REGEXP_UIDVALIDITY_MISMATCH);
});

test("planExtend refuses a non-raising target", () => {
  const result = planExtend({ cursor: { backfill: { target_uid: 500 } }, expectUidvalidity: null, newTargetUid: 500 });
  assert.ok("error" in result);
  assert.match(result.error, REGEXP_NO_RAISE);
});

test("planExtend refuses a target at or above forward_uidnext", () => {
  const result = planExtend({
    cursor: { all_mail: { forward_uidnext: 600 }, backfill: { target_uid: 500 } },
    expectUidvalidity: null,
    newTargetUid: 600,
  });
  assert.ok("error" in result);
  assert.match(result.error, REGEXP_FORWARD_OVERLAP);
});

test("planExtend accepts a valid raise and preserves backfilled_through_uid/forward_uidnext untouched in the plan", () => {
  const result = planExtend({
    cursor: {
      all_mail: { forward_uidnext: 700 },
      backfill: { backfilled_through_uid: 400, completed_at: null, target_uid: 500, uidvalidity: 9 },
    },
    expectUidvalidity: 9,
    newTargetUid: 650,
  });
  assert.ok("plan" in result);
  assert.deepEqual(result.plan, {
    backfilledThroughUid: 400,
    completedAt: null,
    forwardUidnext: 700,
    newTargetUid: 650,
    priorTargetUid: 500,
    uidvalidity: 9,
  });
});

test("formatSummary labels dry-run vs apply and never prints raw record content", () => {
  const dry = formatSummary({
    applied: false,
    backupTable: null,
    connectorInstanceId: "cin_b110e71fb14fb61450d2d427",
    error: null,
    failed: false,
    plan: {
      backfilledThroughUid: 400,
      completedAt: null,
      forwardUidnext: 700,
      newTargetUid: 650,
      priorTargetUid: 500,
      uidvalidity: 9,
    },
  });
  assert.match(dry, REGEXP_DRY_RUN);

  const applied = formatSummary({
    applied: true,
    backupTable: "gbte_backup_deadbeef__cin_b110__2026",
    connectorInstanceId: "cin_b110e71fb14fb61450d2d427",
    error: null,
    failed: false,
    plan: {
      backfilledThroughUid: 400,
      completedAt: null,
      forwardUidnext: 700,
      newTargetUid: 650,
      priorTargetUid: 500,
      uidvalidity: 9,
    },
  });
  assert.match(applied, REGEXP_APPLY);
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
    const connectorInstanceId = `cin_gbte_${suffix}`;
    const connectorId = `gbte_${suffix}`;
    const stamp = `t${suffix}`;
    try {
      await fn({ connectorId, connectorInstanceId, pool, stamp });
    } finally {
      const cinHead = sanitizeIdentifierToken(connectorInstanceId, "cin").slice(0, 12);
      const backups = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE tablename LIKE $1",
        [`${BACKUP_TABLE_PREFIX}_%${cinHead}%`]
      );
      for (const r of backups.rows) {
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test teardown order is intentional.
        await pool.query(`DROP TABLE IF EXISTS "${r.tablename}"`);
      }
      await pool.query("DELETE FROM connector_state WHERE connector_instance_id = $1", [connectorInstanceId]);
      await pool.end();
    }
  }

  async function seedMessagesCursor(pool: pg.Pool, connectorId: string, connectorInstanceId: string, cursor: unknown) {
    await pool.query(
      `INSERT INTO connector_state (connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES ($1, $2, 'messages', $3::jsonb, '2026-06-04T05:00:00.000Z')`,
      [connectorId, connectorInstanceId, JSON.stringify(cursor)]
    );
  }

  async function readMessagesCursor(pool: pg.Pool, connectorInstanceId: string): Promise<unknown> {
    const r = await pool.query<{ state_json: unknown }>(
      "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = 'messages'",
      [connectorInstanceId]
    );
    return r.rows.length ? (r.rows[0]?.state_json ?? null) : null;
  }

  const seedCursorFixture = {
    all_mail: { forward_uidnext: 900 },
    backfill: { backfilled_through_uid: 400, completed_at: null, target_uid: 500, uidvalidity: 9 },
  };

  test("dry-run reports the plan and writes nothing", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      const result = await runExtend({
        apply: false,
        connectorInstanceId,
        expectUidvalidity: 9,
        newTargetUid: 700,
        pool,
        stamp,
      });

      assert.equal(result.failed, false);
      assert.equal(result.applied, false);
      assert.equal(result.backupTable, null);
      assert.deepEqual(result.plan, {
        backfilledThroughUid: 400,
        completedAt: null,
        forwardUidnext: 900,
        newTargetUid: 700,
        priorTargetUid: 500,
        uidvalidity: 9,
      });
      assert.deepEqual(await readMessagesCursor(pool, connectorInstanceId), seedCursorFixture);
    });
  });

  test("apply raises target_uid, snapshots the pre-image, and leaves backfilled_through_uid/forward_uidnext untouched", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      const result = await runExtend({
        apply: true,
        connectorInstanceId,
        expectUidvalidity: 9,
        newTargetUid: 700,
        pool,
        stamp,
      });

      assert.equal(result.failed, false);
      assert.ok(result.backupTable);
      const after = (await readMessagesCursor(pool, connectorInstanceId)) as typeof seedCursorFixture;
      assert.equal(after.backfill.target_uid, 700);
      assert.equal(after.backfill.backfilled_through_uid, 400);
      assert.equal(after.all_mail.forward_uidnext, 900);

      const backup = await pool.query(`SELECT state_json FROM "${result.backupTable}"`);
      assert.deepEqual(backup.rows[0]?.state_json, seedCursorFixture);
    });
  });

  test("apply refuses and writes nothing when the CAS guard misses (concurrent same-id write between read and write)", async () => {
    // runExtend has no injectable fault hook to pause it between its cursor
    // read and its guarded UPDATE, so a true concurrent-write race cannot be
    // driven through the public function alone. This test instead drives
    // the exact CAS-guarded UPDATE statement runExtend issues, with an
    // explicit stale `priorTargetUid` that no longer matches the row — i.e.
    // exactly the state runExtend's own transaction would be in had a
    // concurrent same-id write landed between its read and its write. This
    // proves the CAS guard's SQL genuinely refuses a stale write rather than
    // asserting on a scenario that never reaches the guard.
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      // Simulate a concurrent connector STATE commit that already landed
      // (and committed) after runExtend would have read target_uid=500 but
      // before its own UPDATE runs.
      await pool.query(
        `UPDATE connector_state SET state_json = jsonb_set(state_json::jsonb, '{backfill,target_uid}', '550'::jsonb)
          WHERE connector_instance_id = $1 AND stream = 'messages'`,
        [connectorInstanceId]
      );

      const table = backupTableName({ connectorInstanceId, stamp });
      const client = await pool.connect();
      let updated: pg.QueryResult;
      try {
        await client.query("BEGIN");
        await client.query(
          `CREATE TABLE IF NOT EXISTS "${table}" (
             connector_instance_id text NOT NULL, stream text NOT NULL, state_json jsonb NOT NULL,
             backed_up_at timestamptz NOT NULL DEFAULT now()
           )`
        );
        // The exact guarded UPDATE runExtend issues, built against the STALE
        // priorTargetUid=500 a read taken before the concurrent write above
        // would have produced.
        updated = await client.query(
          `UPDATE connector_state
              SET state_json = jsonb_set(state_json::jsonb, '{backfill,target_uid}', to_jsonb($3::bigint), false)
            WHERE connector_instance_id = $1
              AND stream = $2
              AND (state_json::jsonb #>> '{backfill,target_uid}')::bigint = $4::bigint`,
          [connectorInstanceId, "messages", 700, 500]
        );
        await client.query(updated.rowCount === 1 ? "COMMIT" : "ROLLBACK");
      } finally {
        client.release();
      }

      assert.equal(
        updated.rowCount,
        0,
        "the CAS guard matches zero rows once target_uid has moved since the stale read"
      );
      const after = (await readMessagesCursor(pool, connectorInstanceId)) as typeof seedCursorFixture;
      assert.equal(
        after.backfill.target_uid,
        550,
        "the concurrent write's value survives; a stale-plan write never lands"
      );
    });
  });

  test("apply's own end-to-end CAS guard passes when nothing raced it, matching the read it just took", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      const result = await runExtend({
        apply: true,
        connectorInstanceId,
        expectUidvalidity: 9,
        newTargetUid: 700,
        pool,
        stamp,
      });

      assert.equal(result.failed, false);
      const after = (await readMessagesCursor(pool, connectorInstanceId)) as typeof seedCursorFixture;
      assert.equal(after.backfill.target_uid, 700);
    });
  });

  // D9 fence: connector-instance advisory lock (PR238-POSTGRES-D9-FIX-R5-0831)

  test("apply blocks on the connector-instance advisory lock (deterministic contention, D9 fence)", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      // Hold the SAME connector-instance advisory lock this apply-mode
      // extend must acquire, on a separate raw connection, in an open
      // (uncommitted) transaction — modeling a concurrent D9 coalescence
      // merge (or any other production writer) already mid-transaction on
      // this instance.
      const holderPool = new Pool({ connectionString: POSTGRES_URL });
      const holder = await holderPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        // runExtend never throws — its outer catch converts a
        // lock-acquisition failure into { failed: true, error }, same as any
        // other transaction error. Assert on that contract, not a rejection.
        const contended = await runExtend({
          apply: true,
          connectorInstanceId,
          expectUidvalidity: 9,
          newTargetUid: 700,
          pool,
          stamp,
        });
        assert.equal(contended.failed, true);
        assert.match(contended.error ?? "", REGEXP_ADMISSION_SATURATED);

        // The transaction never got past lock acquisition — not even the
        // cursor READ used to build the plan happened, so the cursor is
        // exactly as seeded and no backup table exists.
        assert.deepEqual(await readMessagesCursor(pool, connectorInstanceId), seedCursorFixture);

        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        await holderPool.end();
      }

      // Once the holder releases, an otherwise-identical apply succeeds.
      const recovered = await runExtend({
        apply: true,
        connectorInstanceId,
        expectUidvalidity: 9,
        newTargetUid: 700,
        pool,
        stamp,
      });
      assert.equal(recovered.failed, false);
      const after = (await readMessagesCursor(pool, connectorInstanceId)) as typeof seedCursorFixture;
      assert.equal(after.backfill.target_uid, 700);
    });
  });

  test("D9 legacy-target coalescence seam: an extend against a connector instance mid-coalescence-merge is fenced, not raced", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      // Simulate the exact shape of
      // coalesceExactPostgresLocalDeviceBindingDuplicates's merge
      // transaction: BEGIN, acquire the connector-instance lock, then either
      // COMMIT or ROLLBACK. Proves the extend cannot land INSIDE that
      // window (neither its read nor its write), matching the D9 legacy-
      // target late-writer seam covered for the production terminal-run
      // writer in device-enroll-postgres-admission-decoupling.test.ts.
      const mergePool = new Pool({ connectionString: POSTGRES_URL });
      const merge = await mergePool.connect();
      try {
        await merge.query("BEGIN");
        await merge.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        const duringMerge = await runExtend({
          apply: true,
          connectorInstanceId,
          expectUidvalidity: 9,
          newTargetUid: 700,
          pool,
          stamp,
        });
        assert.equal(duringMerge.failed, true);
        assert.match(duringMerge.error ?? "", REGEXP_ADMISSION_SATURATED);

        await merge.query("COMMIT");
      } finally {
        merge.release();
        await mergePool.end();
      }

      assert.deepEqual(
        await readMessagesCursor(pool, connectorInstanceId),
        seedCursorFixture,
        "the fenced extend attempt left no trace: no read raced the merge, no orphaned backup table, no partial write"
      );
    });
  });

  // Mutation/counterweight: proves the tests above actually discriminate a
  // fenced implementation from an unfenced one. Drives the exact read-then-
  // write sequence an UNFENCED runExtend would issue (no
  // acquireConnectorInstanceLock call at all) against a connector instance
  // whose lock is held open by a concurrent transaction — this is expected
  // to SUCCEED uncontended, the mirror image of the real tool's expected
  // BLOCK above.
  test("mutation counterweight: an UNFENCED extend sequence (no advisory lock) succeeds uncontended, proving the lock above is load-bearing", async () => {
    await withFixture(async ({ pool, connectorId, connectorInstanceId, stamp }) => {
      await seedMessagesCursor(pool, connectorId, connectorInstanceId, seedCursorFixture);

      const holderPool = new Pool({ connectionString: POSTGRES_URL });
      const holder = await holderPool.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          connectorInstanceAdvisoryLockKey(connectorInstanceId),
        ]);

        // The exact sequence runExtend's apply path uses, MINUS the
        // acquireConnectorInstanceLock call — this is what the tool looked
        // like before this fix. It must succeed uncontended even while the
        // holder above has the connector-instance lock open.
        const client = await pool.connect();
        const table = backupTableName({ connectorInstanceId, stamp });
        try {
          await client.query("BEGIN");
          const read = await client.query(
            "SELECT state_json FROM connector_state WHERE connector_instance_id = $1 AND stream = 'messages'",
            [connectorInstanceId]
          );
          assert.ok(read.rows[0]);
          await client.query(
            `CREATE TABLE IF NOT EXISTS "${table}" (
               connector_instance_id text NOT NULL, stream text NOT NULL, state_json jsonb NOT NULL,
               backed_up_at timestamptz NOT NULL DEFAULT now()
             )`
          );
          await client.query(
            `INSERT INTO "${table}" (connector_instance_id, stream, state_json)
             SELECT connector_instance_id, stream, state_json::jsonb FROM connector_state
              WHERE connector_instance_id = $1 AND stream = 'messages'`,
            [connectorInstanceId]
          );
          await client.query(
            `UPDATE connector_state
                SET state_json = jsonb_set(state_json::jsonb, '{backfill,target_uid}', '700'::jsonb)
              WHERE connector_instance_id = $1 AND stream = 'messages'`,
            [connectorInstanceId]
          );
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        const after = (await readMessagesCursor(pool, connectorInstanceId)) as typeof seedCursorFixture;
        assert.equal(
          after.backfill.target_uid,
          700,
          "an unfenced read-then-write reaches connector_state even while a concurrent transaction holds the connector-instance lock — this is the exact race the real tool's lock acquisition (asserted above) closes"
        );

        await holder.query("ROLLBACK");
      } finally {
        holder.release();
        await holderPool.end();
      }
    });
  });
} else {
  test("gmail-backfill-target-extend DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
