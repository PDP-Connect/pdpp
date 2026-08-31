// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded retry of the WHOLE `bootstrapPostgresSchema` attempt on a
 * Postgres-detected deadlock (SQLSTATE 40P01), and only that SQLSTATE.
 *
 * BEHAVIOR PROTECTED. The bootstrap DDL batch takes an AccessExclusiveLock
 * on tables (connectors, connector_instances, ...) that an ordinary,
 * concurrent connector-registration write also touches at row level. Under a
 * rolling/blue-green restart -- a fresh instance bootstrapping schema while
 * an already-running instance still serves writes against the same database
 * -- Postgres can detect a genuine wait-for cycle between the two and abort
 * one side with SQLSTATE 40P01. That must not abort the whole boot; it must
 * retry the full bootstrap attempt a bounded number of times.
 *
 * PLAUSIBLE DEFECT THIS CATCHES. Before this change, `bootstrapPostgresSchema`
 * had no retry at all: a single 40P01 (proven reproducible against a real
 * Postgres backend, see the second test below and
 * PR238-AGENT-CONNECT-PG-DEADLOCK-0831.md) failed the entire boot. A wrong
 * fix could also retry every error (masking real migration defects behind
 * a retry loop) or retry mid-batch against an already-aborted connection
 * instead of re-running the whole attempt from a fresh client.
 *
 * ORACLE AND TRUTH SOURCE, PART 1 (unit). The retry wrapper's control flow
 * (attempt counting, backoff, exhaustion, SQLSTATE discrimination) is a pure
 * state transition over an injected `runOnce`/`sleep` seam -- no Postgres
 * required, deterministic by construction. This directly answers the "how
 * many 40P01 attempts, then success" and "exhaustion rethrows" and
 * "non-40P01 is immediate" requirements without relying on real lock timing.
 * The real SQLSTATE 40P01 shape and the exact server-side lock cycle
 * (bootstrap's DDL batch vs. a concurrent connector-registration write) are
 * already captured live against real PostgreSQL in
 * PR238-AGENT-CONNECT-PG-DEADLOCK-0831.md; this file does not attempt to
 * re-synthesize that race deterministically -- a real deadlock's exact
 * timing window is not a reliable thing to manufacture on demand, and doing
 * so is out of scope for this bounded fix.
 *
 * ORACLE AND TRUTH SOURCE, PART 2 (real Postgres smoke). A real, disposable
 * Postgres database proves `bootstrapPostgresSchema` (the retry wrapper)
 * still performs an ordinary, uncontended bootstrap correctly end to end --
 * no regression in the common case from adding the retry wrapper around
 * `bootstrapPostgresSchemaOnce`.
 *
 * REQUIRES (part 2 only). `PDPP_TEST_POSTGRES_URL` (real-Postgres profile).
 * Skipped, and declared as skipped, when unset. Part 1 always runs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { Pool } from "pg";
import { bootstrapPostgresSchema, closePostgresStorage, initPostgresStorage } from "../server/postgres-storage.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const RE_CONNECTION_REFUSED = /connection refused/;

function deadlockError(): Error & { code: string } {
  const err = new Error("deadlock detected") as Error & { code: string };
  err.code = "40P01";
  return err;
}

function otherError(code: string): Error & { code: string } {
  const err = new Error(`some other failure (${code})`) as Error & { code: string };
  err.code = code;
  return err;
}

test("bootstrap retry: succeeds immediately when the first attempt succeeds", async () => {
  const calls: number[] = [];
  const sleeps: number[] = [];
  await bootstrapPostgresSchema({
    runOnce: () => {
      calls.push(1);
      return Promise.resolve();
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test("bootstrap retry: recovers after one 40P01, running the whole attempt exactly twice", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await bootstrapPostgresSchema({
    runOnce: () => {
      attempts += 1;
      if (attempts === 1) {
        throw deadlockError();
      }
      return Promise.resolve();
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(attempts, 2, "the whole bootstrap attempt reran once after the deadlock, not a partial resume");
  assert.deepEqual(sleeps, [50], "backoff before the single retry uses the initial delay");
});

test("bootstrap retry: recovers after three consecutive 40P01s with increasing backoff", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await bootstrapPostgresSchema({
    runOnce: () => {
      attempts += 1;
      if (attempts <= 3) {
        throw deadlockError();
      }
      return Promise.resolve();
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(sleeps, [50, 100, 200], "backoff doubles each retry, bounded by the max delay");
});

test("bootstrap retry: exhausts the bounded budget and rethrows the last 40P01", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    bootstrapPostgresSchema({
      runOnce: () => {
        attempts += 1;
        throw deadlockError();
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }),
    (err: unknown) => (err as { code?: string }).code === "40P01"
  );
  assert.equal(attempts, 4, "exactly the max-attempts budget was spent, no more");
  assert.equal(sleeps.length, 3, "three backoff waits between four attempts");
});

test("bootstrap retry: a non-40P01 error rethrows immediately with no retry and no sleep", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  await assert.rejects(
    bootstrapPostgresSchema({
      runOnce: () => {
        attempts += 1;
        throw otherError("42501");
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }),
    (err: unknown) => (err as { code?: string }).code === "42501"
  );
  assert.equal(attempts, 1, "no retry for a non-deadlock error");
  assert.deepEqual(sleeps, []);
});

test("bootstrap retry: an error with no SQLSTATE code rethrows immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    bootstrapPostgresSchema({
      runOnce: () => {
        attempts += 1;
        throw new Error("connection refused, no SQLSTATE at all");
      },
    }),
    RE_CONNECTION_REFUSED
  );
  assert.equal(attempts, 1);
});

// ---------------------------------------------------------------------------
// Real-Postgres smoke: the retry wrapper adds no regression to the ordinary,
// uncontended bootstrap path.
// ---------------------------------------------------------------------------

test("bootstrap retry: an ordinary, uncontended bootstrap against real Postgres still completes normally", {
  skip: POSTGRES_URL
    ? false
    : "bootstrap retry: an ordinary, uncontended bootstrap against real Postgres still completes normally",
  timeout: 30_000,
}, async () => {
  const databaseName = "pdpp_test_bootstrap_deadlock_retry_smoke";
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL as string,
      databaseName,
    },
    async (databaseUrl) => {
      const attemptLog: string[] = [];
      await initPostgresStorage(
        { backend: "postgres", databaseUrl },
        {
          log: (message) => {
            attemptLog.push(message);
          },
        }
      );
      assert.ok(
        !attemptLog.some((line) => line.includes("40P01")),
        "an uncontended bootstrap must not log any deadlock retry"
      );

      const verify = new Pool({ connectionString: databaseUrl });
      try {
        const tables = await verify.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
              WHERE table_schema = 'public' AND table_name IN ('connectors', 'connector_instances', 'record_rejection_quota')
              ORDER BY table_name`
        );
        assert.deepEqual(
          tables.rows.map((row) => row.table_name),
          ["connector_instances", "connectors", "record_rejection_quota"],
          "the retry wrapper still completes the full bootstrap batch on the ordinary path"
        );
      } finally {
        await verify.end();
      }

      // Re-running bootstrap (idempotent, CREATE TABLE IF NOT EXISTS) via
      // the retry wrapper against an already-migrated schema must also
      // still succeed cleanly -- the second-boot / restart shape most
      // deployments hit on every ordinary restart.
      const secondLog: string[] = [];
      await bootstrapPostgresSchema({
        log: (message) => {
          secondLog.push(message);
        },
      });
      assert.ok(!secondLog.some((line) => line.includes("40P01")));
    }
  );
});
