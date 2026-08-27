// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The repair back-off must actually arm in production.
 *
 * It did not. PR #194 wired `noteRepairTimeout()` into `repairCandidate`'s
 * OUTER catch, but `repairCandidatePostgres` handles
 * `PostgresStatementTimeoutError` itself and RETURNS `deferred: true` — it
 * never rethrows — so the outer catch is unreachable for that error and the
 * throttle never fired. Measured in production 2026-08-26 on
 * `pdpp-core:drain74`: one connection (1,311,001 records) logged 14 cancelled
 * repairs in 15 minutes with **0** back-off activations, its evidence row
 * frozen for over an hour.
 *
 * That defect survived a passing, mutation-tested suite because the test
 * MIRRORED `repairCandidate`'s contract in a fake instead of driving the real
 * function (which needs a Postgres backend). The mutation killed the mirror,
 * not the shipped call path.
 *
 * So this file drives the REAL `reconcileConnectorSummaryEvidence` against a
 * REAL Postgres and forces a GENUINE server-side `statement_timeout` inside a
 * repair unit: a live pass deadline (so the unit is actually admitted) plus a
 * deliberately slow repair read via the `PDPP_TEST_SLOW_REPAIR_READ_SECONDS`
 * seam. That reproduces production's shape — admitted, then cancelled by
 * Postgres under the real per-unit bound.
 *
 * An already-expired deadline does NOT work and was tried first: it aborts
 * DISCOVERY, so `attempted` is 0 and no repair unit ever runs. A test built on
 * it would pass while proving nothing, which is why the zero-timeout sanity
 * assertion below fails loudly rather than silently.
 *
 * No fakes, no mirrored contract: if the wiring regresses to an unreachable
 * catch, this goes red.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL`; skips (never fails) when unset, matching
 * every other Postgres-gated test in this suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { reconcileConnectorSummaryEvidence } from "../server/connector-summary-evidence-engine.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-26T00:00:00.000Z";
const CONNECTOR_ID = "https://test.pdpp.dev/connectors/repair-backoff";
const INSTANCE_ID = "cin_repair_backoff_pg";

async function seed(): Promise<void> {
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    "{}",
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, 'owner_local', $2, 'backoff', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [INSTANCE_ID, CONNECTOR_ID, NOW]
  );
}

async function cleanup(): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_id = $1", [CONNECTOR_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

/**
 * `reconcileConnectorSummaryEvidence(null, ...)` sweeps EVERY connection in
 * the database, not just this file's. Any other connection left behind by
 * another test would get its own repair slowed by the seam and pollute the
 * counts this test reasons about, so the sweep is narrowed to exactly one
 * known row.
 */
async function assertOnlyThisConnectionExists(): Promise<void> {
  const rows = await postgresQuery<{ connector_instance_id: string }>(
    "SELECT connector_instance_id FROM connector_instances WHERE status = 'active'",
    []
  );
  const ids = rows.rows.map((row) => row.connector_instance_id);
  assert.deepEqual(
    ids,
    [INSTANCE_ID],
    `this test reasons about per-connection back-off counts, so exactly one active connection must exist; found ${JSON.stringify(ids)}`
  );
}

/**
 * Count the console line `noteRepairTimeout` emits. That line IS the
 * observable proof the back-off armed: it is written inside
 * `noteRepairTimeout` and nowhere else, so seeing it means the function ran
 * on the real code path. Asserting on it (rather than on an exported
 * counter) keeps the test blind to internals it should not reach into.
 */
async function runPassCountingBackoff(): Promise<{ backoffLines: number; timeoutLines: number }> {
  const original = console.error;
  let backoffLines = 0;
  let timeoutLines = 0;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("backing off")) {
      backoffLines += 1;
    }
    if (line.includes("cancelled by Postgres statement_timeout")) {
      timeoutLines += 1;
    }
  };
  try {
    // A LIVE deadline plus a genuinely slow repair read (the
    // `PDPP_TEST_SLOW_REPAIR_READ_SECONDS` seam) reproduces production
    // exactly: the unit IS admitted, then Postgres itself cancels it under
    // the real per-unit bound. An already-expired deadline would abort
    // discovery before any repair unit ran and prove nothing.
    await reconcileConnectorSummaryEvidence(null, { deadline: Date.now() + 1500 });
  } finally {
    console.error = original;
  }
  return { backoffLines, timeoutLines };
}

test("a repair cancelled by statement_timeout arms the back-off on the REAL code path", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  // Arm the slow-read seam for this test only, and restore it afterwards —
  // it must never leak into another file's run.
  const previousSlowRead = process.env.PDPP_TEST_SLOW_REPAIR_READ_SECONDS;
  process.env.PDPP_TEST_SLOW_REPAIR_READ_SECONDS = "1";

  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  await cleanup();
  await seed();
  await assertOnlyThisConnectionExists();
  t.after(async () => {
    if (previousSlowRead === undefined) {
      process.env.PDPP_TEST_SLOW_REPAIR_READ_SECONDS = undefined;
      delete process.env.PDPP_TEST_SLOW_REPAIR_READ_SECONDS;
    } else {
      process.env.PDPP_TEST_SLOW_REPAIR_READ_SECONDS = previousSlowRead;
    }
    await cleanup();
    await closePostgresStorage();
  });

  const first = await runPassCountingBackoff();

  // Sanity FIRST: if no repair was cancelled, this test proves nothing —
  // fail loudly rather than pass vacuously on zero timeouts.
  assert.ok(
    first.timeoutLines > 0,
    `expected the slow-read seam to cancel at least one repair; saw ${first.timeoutLines} — the test never exercised the path it exists to check`
  );

  // THE CLAIM: the throttle armed. Before this fix it was 0 here, because
  // `repairCandidatePostgres` returned instead of rethrowing.
  assert.ok(
    first.backoffLines > 0,
    `expected the back-off to arm after a cancelled repair; saw ${first.backoffLines} activations against ${first.timeoutLines} cancellations — the handler is wired to an unreachable catch`
  );

  // And it must STAY armed. This is the half that a naive fix would miss:
  // the Postgres branch RETURNS `deferred: true` rather than throwing, so a
  // success-path `delete()` that does not exclude `deferred` would disarm
  // the back-off one frame after arming it, and the next pass would retry
  // at full rate. Measured on the real path: pass 1 arms (timeouts 2,
  // activations 1), passes 2 and 3 are silent — the unit is deferred, not
  // re-attempted.
  const second = await runPassCountingBackoff();
  assert.equal(
    second.timeoutLines,
    0,
    `a unit inside its back-off window must not be re-attempted at all; saw ${second.timeoutLines} cancellation(s) on the second pass — the back-off was disarmed by the success-path clear`
  );
});
