// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression test for the live 2026-08-01T04:06:18Z ChatGPT incident:
 * `duplicate key value violates unique constraint
 * "controller_active_runs_run_id_key"` when two scheduled runs for two
 * DIFFERENT connector_instance_id values are admitted at nearly the same
 * instant.
 *
 * ROOT CAUSE: run-admission callsites minted their auto-generated run_id
 * fallback independently, each as either `run_${Date.now()}` or
 * `run_${Date.now()}_${attempt}` -- millisecond resolution, no
 * connector-instance-scoped entropy. Two different connections (or two
 * retry attempts landing in the same millisecond) admitted concurrently
 * produced the byte-identical run_id string, tripping
 * controller_active_runs.run_id's table-wide UNIQUE constraint (which is
 * the CORRECT invariant -- run_id must be globally unique; the bug was in
 * generation, not the schema).
 *
 * There were FOUR independent mint sites, not three -- a prior pass fixed
 * only three and missed the direct scheduler's own retry-attempt mint:
 *   - runtime/controller.ts (runNow)
 *   - runtime/index.ts (runConnector)
 *   - runtime/scheduler/run-executor.ts:677 (createActiveRunAttemptLease's
 *     fallback -- now dead code, since buildAttemptCall below always fills
 *     call.runId before this runs, but kept as defense-in-depth)
 *   - runtime/scheduler/run-executor.ts's buildAttemptCall (the actual
 *     mint site the direct, non-managed scheduler path exercises on every
 *     attempt, including retries -- this is what test 3 below proves)
 *
 * FIX: every mint site now calls the single shared `generateRunId()`
 * primitive (lib/spine.ts), which is `` `run_${randomUUID().replace(/-/g, "")}` ``
 * -- 122 bits of CSPRNG entropy (a v4 UUID's 128 bits minus 6 fixed
 * version/variant bits), not the weaker 64-bit `generateSpineId` used for
 * other spine ids. 64 bits is not an acceptable margin for a bare,
 * globally-unique identity backed by a hard DB constraint with no
 * collision-retry loop: the birthday bound puts a 64-bit space at
 * ~2.7e-4 collision probability at 100M generated ids and ~2.67% at 1B.
 * A 122-bit space's birthday bound is astronomically smaller (on the
 * order of 1e-19 at 1B ids), the same margin every RFC 4122 UUID consumer
 * already relies on for global uniqueness without a retry protocol.
 * `controller_active_runs.run_id` keeps its table-wide UNIQUE constraint
 * on both backends (SQLite and Postgres) as a correctly-enforceable
 * invariant, not weakened.
 */

import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import test from "node:test";

import { __resetControllerInteractionStateForTests, createController } from "../runtime/controller.ts";
import { buildAttemptCall, type RunConnectorCall } from "../runtime/scheduler/run-executor.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID = "https://registry.pdpp.org/connectors/chatgpt";
const OLD_DATE_NOW_RUN_ID_SHAPE_RE = /^run_\d+(_\d+)?$/;
const MANIFEST = {
  connector_id: CONNECTOR_ID,
  name: "ChatGPT Collision Test",
  streams: [],
  version: "1.0.0",
};

function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? `cin_${ownerSubjectId}_${connectorId.replace(/[^a-z0-9]+/gi, "_")}`;
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function freshDb(t: TestContext): void {
  closeDb();
  initDb(makeTemporaryDbPath("pdpp-active-run-id-collision-"));
  __resetControllerInteractionStateForTests();
  t.after(() => {
    __resetControllerInteractionStateForTests();
    closeDb();
  });
}

/**
 * Freezes Date.now() to a single fixed millisecond value for the duration
 * of `fn` -- reproducing the exact clock state that collided live (two
 * connections' scheduled ticks, or two retry attempts, landing in the
 * same millisecond) -- and restores the real Date.now afterward
 * regardless of outcome.
 */
async function withFrozenClock<T>(fixedMs: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => fixedMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

function minimalRunConnectorCall(): RunConnectorCall {
  return {
    collectionMode: "full_refresh",
    connectorId: CONNECTOR_ID,
    connectorInstanceId: "cin_chatgpt_direct_scheduler",
    connectorPath: "/tmp/connector.js",
    manifest: MANIFEST,
    onInteraction: async () => ({ accepted: false }),
    onProgress: () => {
      // no-op
    },
    ownerSubjectId: "owner_local",
    ownerToken: "owner-token",
    persistState: false,
    rsUrl: "http://localhost.invalid",
    state: null,
  };
}

test("two different connector instances admitted concurrently under an identical frozen clock get distinct run_ids and both succeed", async (t) => {
  freshDb(t);

  const CIN_A = "cin_chatgpt_account_a";
  const CIN_B = "cin_chatgpt_account_b";

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
  });

  // Mirrors the live failure exactly: two DIFFERENT connector_instance_id
  // values, both scheduler-triggered (no explicit runId, so each falls
  // through to the auto-generated fallback), admitted concurrently under a
  // clock frozen to a single millisecond -- the precise condition that
  // collided the old Date.now()-based generator.
  const [resultA, resultB] = await withFrozenClock(1_785_557_178_019, () =>
    Promise.all([
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId: CIN_A,
        manifest: MANIFEST,
        ownerToken: "owner-token",
        triggerKind: "scheduled",
      }),
      controller.runNow(CONNECTOR_ID, {
        connectorInstanceId: CIN_B,
        manifest: MANIFEST,
        ownerToken: "owner-token",
        triggerKind: "scheduled",
      }),
    ])
  );

  await controller.drainActiveRuns(1000);

  assert.ok(resultA.run_id, "connection A must have been admitted with a run_id");
  assert.ok(resultB.run_id, "connection B must have been admitted with a run_id");
  assert.notEqual(
    resultA.run_id,
    resultB.run_id,
    "the two connections must end up with distinct run_id values despite the identical frozen clock"
  );
  assert.doesNotMatch(
    resultA.run_id ?? "",
    OLD_DATE_NOW_RUN_ID_SHAPE_RE,
    "run_id must not be the old Date.now()-derived shape (run_<digits> or run_<digits>_<attempt>)"
  );
  assert.doesNotMatch(
    resultB.run_id ?? "",
    OLD_DATE_NOW_RUN_ID_SHAPE_RE,
    "run_id must not be the old Date.now()-derived shape (run_<digits> or run_<digits>_<attempt>)"
  );
});

test("100 concurrent scheduler-triggered admissions under a frozen clock produce 100 distinct run_ids", async (t) => {
  freshDb(t);

  const controller = createController({
    admitRunConnection: fakeAdmitRunConnection(),
    connectorPathResolver: () => "/tmp/connector.js",
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    logger: { error: () => {}, warn: () => {} },
    maxRunWallClockMs: Number.POSITIVE_INFINITY,
    runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
  });

  const CONNECTION_COUNT = 100;
  const connectorInstanceIds = Array.from({ length: CONNECTION_COUNT }, (_, i) => `cin_chatgpt_fleet_${i}`);

  const results = await withFrozenClock(1_785_557_178_019, () =>
    Promise.all(
      connectorInstanceIds.map((connectorInstanceId) =>
        controller.runNow(CONNECTOR_ID, {
          connectorInstanceId,
          manifest: MANIFEST,
          ownerToken: "owner-token",
          triggerKind: "scheduled",
        })
      )
    )
  );

  await controller.drainActiveRuns(2000);

  const runIds = results.map((r) => r.run_id);
  assert.equal(runIds.length, CONNECTION_COUNT);
  assert.equal(
    new Set(runIds).size,
    CONNECTION_COUNT,
    "every one of the 100 concurrently-admitted connections must receive a distinct run_id"
  );
});

// ─── Direct-scheduler mint oracle (gate-3 blocker 1) ────────────────────────
//
// `runtime/scheduler/run-executor.ts`'s direct (non-managed) scheduler path
// -- runWithRetries -> buildAttemptCall -- was the mint site a prior pass
// missed: it fills `call.runId` on EVERY attempt (including retries)
// BEFORE createActiveRunAttemptLease's own generateRunId() fallback ever
// runs, so that fallback was reachable in name only. This exercises
// buildAttemptCall directly (it is a pure function of its three
// parameters -- no I/O, no closure over runtime state) under a frozen
// clock, proving both (a) two different connections' first attempts and
// (b) a single connection's own retry attempts never collide.

test("buildAttemptCall (direct-scheduler mint site): two different connections' first attempts get distinct run_ids under a frozen clock", () => {
  const schedule = {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: "cin_chatgpt_direct_a",
    connectorPath: "/tmp/connector.js",
    intervalMs: 60_000,
    manifest: MANIFEST,
    ownerToken: "owner-token",
  };
  const callA = { ...minimalRunConnectorCall(), connectorInstanceId: "cin_chatgpt_direct_a" };
  const callB = { ...minimalRunConnectorCall(), connectorInstanceId: "cin_chatgpt_direct_b" };

  const [attemptCallA, attemptCallB] = withFrozenClockSync(1_785_557_178_019, () => [
    buildAttemptCall(schedule, callA, 1),
    buildAttemptCall({ ...schedule, connectorInstanceId: "cin_chatgpt_direct_b" }, callB, 1),
  ]);

  assert.ok(attemptCallA.runId, "connection A's attempt must have a run_id");
  assert.ok(attemptCallB.runId, "connection B's attempt must have a run_id");
  assert.notEqual(
    attemptCallA.runId,
    attemptCallB.runId,
    "two different connections' scheduler-minted run_ids must differ despite an identical frozen clock"
  );
  assert.doesNotMatch(attemptCallA.runId ?? "", OLD_DATE_NOW_RUN_ID_SHAPE_RE);
  assert.doesNotMatch(attemptCallB.runId ?? "", OLD_DATE_NOW_RUN_ID_SHAPE_RE);
});

test("buildAttemptCall (direct-scheduler mint site): a single connection's own retry attempts get distinct run_ids under a frozen clock", () => {
  const schedule = {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: "cin_chatgpt_direct_retry",
    connectorPath: "/tmp/connector.js",
    intervalMs: 60_000,
    manifest: MANIFEST,
    maxRetries: 2,
    ownerToken: "owner-token",
  };
  // runWithRetries never carries call.runId across attempts -- each retry
  // re-derives from the ORIGINAL scheduler-triggered call, which never had
  // a runId set. This mirrors that exactly: the same `call` object (no
  // runId) is passed to buildAttemptCall at increasing attempt numbers,
  // exactly as runWithRetries's loop does at runtime/scheduler/run-executor.ts.
  const call = minimalRunConnectorCall();

  const attemptRunIds = withFrozenClockSync(1_785_557_178_019, () =>
    [1, 2, 3].map((attempt) => buildAttemptCall(schedule, call, attempt).runId)
  );

  assert.equal(attemptRunIds.length, 3);
  for (const runId of attemptRunIds) {
    assert.ok(runId, "every retry attempt must mint a run_id");
    assert.doesNotMatch(runId ?? "", OLD_DATE_NOW_RUN_ID_SHAPE_RE);
  }
  assert.equal(
    new Set(attemptRunIds).size,
    3,
    "three retry attempts under an identical frozen clock must produce three distinct run_ids"
  );
});

function withFrozenClockSync<T>(fixedMs: number, fn: () => T): T {
  const realNow = Date.now;
  Date.now = () => fixedMs;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

// ─── Real Postgres concurrent-admission proof (gate-3 blocker 3) ───────────
//
// Runs the identical concurrent-admission scenario as the first SQLite
// test above, but against a real, disposable PostgreSQL instance, so the
// restored `controller_active_runs.run_id UNIQUE` constraint is proven
// correctly enforced (not silently bypassed) on the backend the live
// incident actually happened on. Skips cleanly when
// PDPP_TEST_POSTGRES_URL is unset, matching this suite's existing
// Postgres-gated test convention (see connector-state-scheduler-conformance-postgres.test.ts).

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  test("[postgres] two different connector instances admitted concurrently under an identical frozen clock get distinct run_ids and both succeed", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    __resetControllerInteractionStateForTests();
    // A per-invocation unique suffix (captured with the REAL clock, before
    // it's frozen below) -- not a fixed literal -- so a prior run's row
    // against a real, persistent Postgres instance can never collide with
    // this run's admission. Matches this suite's existing convention for
    // real-Postgres tests (see suffix in postgres-runtime-storage.test.ts).
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const CIN_A = `cin_chatgpt_pg_account_a_${suffix}`;
    const CIN_B = `cin_chatgpt_pg_account_b_${suffix}`;
    try {
      const controller = createController({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorPathResolver: () => "/tmp/connector.js",
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        logger: { error: () => {}, warn: () => {} },
        maxRunWallClockMs: Number.POSITIVE_INFINITY,
        runConnectorImpl: () => Promise.resolve({ records_emitted: 0, status: "succeeded" }),
      });

      const [resultA, resultB] = await withFrozenClock(1_785_557_178_019, () =>
        Promise.all([
          controller.runNow(CONNECTOR_ID, {
            connectorInstanceId: CIN_A,
            manifest: MANIFEST,
            ownerToken: "owner-token",
            triggerKind: "scheduled",
          }),
          controller.runNow(CONNECTOR_ID, {
            connectorInstanceId: CIN_B,
            manifest: MANIFEST,
            ownerToken: "owner-token",
            triggerKind: "scheduled",
          }),
        ])
      );

      await controller.drainActiveRuns(1000);

      assert.ok(resultA.run_id, "connection A must have been admitted with a run_id");
      assert.ok(resultB.run_id, "connection B must have been admitted with a run_id");
      assert.notEqual(
        resultA.run_id,
        resultB.run_id,
        "the two connections must end up with distinct run_id values despite the identical frozen clock, on real Postgres"
      );
      assert.doesNotMatch(resultA.run_id ?? "", OLD_DATE_NOW_RUN_ID_SHAPE_RE);
      assert.doesNotMatch(resultB.run_id ?? "", OLD_DATE_NOW_RUN_ID_SHAPE_RE);
    } finally {
      // Belt-and-suspenders cleanup: drainActiveRuns's persisted-row delete
      // is fire-and-forget (not awaited on the success path), so explicitly
      // clear this test's rows rather than relying on that race winning
      // before the next test/run reuses this connector_instance_id. Matches
      // the cleanup convention in postgres-runtime-storage.test.ts.
      await postgresQuery("DELETE FROM controller_active_runs WHERE connector_instance_id IN ($1, $2)", [
        CIN_A,
        CIN_B,
      ]).catch(() => {
        // best-effort cleanup only
      });
      __resetControllerInteractionStateForTests();
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  test("[postgres] active-run-id-collision concurrent admission (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}
