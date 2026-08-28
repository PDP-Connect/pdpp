// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A canonical scan that needs MORE pages than one admission allows must YIELD
 * with its progress banked — not loop until Postgres kills it.
 *
 * `scanPostgresCanonicalStreamsChunked` used to run pages until `complete` or
 * until cancelled. For a large connection that is always the latter, so the
 * durable prefix never moved and the row never converged. Measured in
 * production 2026-08-28 on `cin_2de5ede05c8cc8d45935c414`:
 *
 *     one 10,000-row page          16.96 ms   (index-only scan, 2065 heap fetches)
 *     rows ahead of its prefix     1,891,516
 *     pages still required         189  (~3.2 s of query time)
 *     observed outcome             cancelled 5x, backing off 960s, prefix frozen
 *
 * The page was never slow — 17 ms against a 500 ms floor. There were simply
 * far too many sequential pages to finish inside ONE bounded admission, and
 * adaptive page shrinking made it WORSE: a smaller page means MORE pages for
 * the same rows, all still inside that one bound.
 *
 * These tests reproduce that shape in miniature against a REAL Postgres. A
 * small `page_size` on the durable receipt is not a synthetic seam — it is a
 * value the adaptive shrink itself persists in production
 * (`recordReducedPostgresRepairChunkPageSize` halves it on every timeout,
 * floored at `MIN_CHUNK_SCAN_PAGE_SIZE = 1`). Combined with a short admission
 * deadline, a modest fixture needs many more pages than one pass can serve —
 * exactly the whale's situation, without a multi-million-row table.
 *
 * Nothing here raises, extends, or reuses the per-unit bound. The fix only
 * declines to START a page it has no budget to FINISH.
 *
 * Driving the real `reconcileConnectorSummaryEvidence` is deliberate. The
 * sibling back-off defect (see `connector-summary-repair-backoff-postgres.ts`)
 * survived a passing, mutation-tested suite because that suite MIRRORED the
 * contract in a fake; the mutation killed the mirror, not the shipped path.
 * No fakes here: if the yield regresses, these go red.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL`; skips (never fails) when unset, matching
 * every other Postgres-gated test in this suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetTestOnlyCanonicalScanPageCallCountForTest,
  reconcileConnectorSummaryEvidence,
  remainingStatementBudgetMs,
} from "../server/connector-summary-evidence-engine.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-28T00:00:00.000Z";

const CONNECTOR_ID = "https://test.pdpp.dev/connectors/midloop-yield";
const INSTANCE_ID = "cin_midloop_yield_pg";
const STREAM_COUNT = 3;
const RECORDS_PER_STREAM = 40;
const TOTAL_RECORDS = STREAM_COUNT * RECORDS_PER_STREAM;

/**
 * One row per page. The scan therefore needs ~120 sequential page
 * transactions, which no short admission can serve — the whale's ratio,
 * reproduced without the whale's row count.
 */
const ONE_ROW_PER_PAGE = 1;

async function seedConnection(): Promise<void> {
  const streams = Array.from({ length: STREAM_COUNT }, (_, index) => ({
    coverage_strategy: "full_inventory",
    name: `stream_${index + 1}`,
    primary_key: ["id"],
    schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
  }));
  await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
    CONNECTOR_ID,
    JSON.stringify({
      capabilities: { public_listing: { tier: "supported" } },
      connector_id: CONNECTOR_ID,
      display_name: "midloop-yield",
      protocol_version: "0.1.0",
      streams,
      version: "1.0.0",
    }),
    NOW,
  ]);
  await postgresQuery(
    `INSERT INTO connector_instances(
       connector_instance_id, owner_subject_id, connector_id, display_name, status,
       source_kind, source_binding_key, source_binding_json, created_at, updated_at, revoked_at
     ) VALUES($1, 'owner_local', $2, 'midloop-yield', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
    [INSTANCE_ID, CONNECTOR_ID, NOW]
  );
  await postgresQuery(
    `INSERT INTO records(
       connector_id, connector_instance_id, stream, record_key, record_json,
       emitted_at, semantic_time, version, deleted, primary_key_text
     )
     SELECT $1, $2, format('stream_%s', stream_no), format('record_%s_%s', stream_no, record_no),
            '{}'::jsonb, $3, $3, 1, FALSE, format('record_%s_%s', stream_no, record_no)
       FROM generate_series(1, $4) AS streams(stream_no)
       CROSS JOIN generate_series(1, $5) AS records(record_no)`,
    [CONNECTOR_ID, INSTANCE_ID, NOW, STREAM_COUNT, RECORDS_PER_STREAM]
  );
}

async function cleanup(): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1", [
    INSTANCE_ID,
  ]);
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [INSTANCE_ID]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [CONNECTOR_ID]);
}

/**
 * Force the tiny page size onto the DURABLE receipt, the same column
 * `recordReducedPostgresRepairChunkPageSize` writes in production. Seeded at
 * `resume_after_id = 0` with an empty accumulator: it claims no scanned
 * prefix, only the page limit to use.
 */
async function seedTinyPageSizeReceipt(): Promise<void> {
  const revision = await currentSourceRevision();
  await postgresQuery(
    `INSERT INTO connector_summary_evidence_repair_chunk(
       connector_instance_id, resume_after_id, accumulator_json, source_revision, started_at, updated_at, page_size
     ) VALUES($1, 0, '{}'::jsonb, $2, $3, $3, $4)
     ON CONFLICT (connector_instance_id) DO UPDATE SET page_size = EXCLUDED.page_size`,
    [INSTANCE_ID, revision, NOW, ONE_ROW_PER_PAGE]
  );
}

async function currentSourceRevision(): Promise<string> {
  const result = await postgresQuery<{ source_revision: string }>(
    "SELECT source_revision::text AS source_revision FROM connector_instances WHERE connector_instance_id = $1",
    [INSTANCE_ID]
  );
  return String(result.rows[0]?.source_revision ?? "0");
}

async function readChunkPrefix(): Promise<number | null> {
  const result = await postgresQuery<{ resume_after_id: string }>(
    "SELECT resume_after_id FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1",
    [INSTANCE_ID]
  );
  const [row] = result.rows;
  return row === undefined ? null : Number(row.resume_after_id);
}

/**
 * `records.id` is a BIGSERIAL shared across every row in the table, not
 * per-connection — a fresh admission's first page does not commit
 * `resume_after_id = 1`, it commits whatever this connection's OWN lowest id
 * happens to be, which depends on how many rows other tests/connections
 * inserted earlier against the same database. Callers that need to assert
 * "exactly the first page committed" must compare against this, not a
 * literal.
 */
async function minRecordId(): Promise<number> {
  const result = await postgresQuery<{ min_id: string }>(
    "SELECT MIN(id) AS min_id FROM records WHERE connector_instance_id = $1",
    [INSTANCE_ID]
  );
  return Number(result.rows[0]?.min_id ?? 0);
}

/** `total_records` is a Postgres BIGINT and arrives as a string; normalize it. */
async function readEvidence(): Promise<{ dirty: number; state: string; total_records: number } | null> {
  const result = await postgresQuery<{ dirty: number; state: string; total_records: string }>(
    "SELECT dirty, state, total_records FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [INSTANCE_ID]
  );
  const [row] = result.rows;
  return row === undefined
    ? null
    : { dirty: Number(row.dirty), state: String(row.state), total_records: Number(row.total_records) };
}

/**
 * One bounded admission, the same shape production runs. The deadline is
 * deliberately SHORT so the unit cannot serve ~120 one-row pages in a single
 * pass and must decide between yielding and being cancelled.
 */
function runBoundedAdmission(budgetMs: number) {
  return reconcileConnectorSummaryEvidence([INSTANCE_ID], { deadline: Date.now() + budgetMs });
}

/**
 * These tests measure the mid-loop YIELD, not the statement-timeout THROTTLE.
 *
 * Those are two different mechanisms and they interact. A page can still be
 * cancelled mid-page — the yield only prevents STARTING a page with no budget,
 * it cannot shorten one already running — and any such cancellation arms
 * `noteRepairTimeout`'s exponential back-off (60s, then 120s, …). Measured
 * here: with the production base, pass 1 yielded cleanly, pass 2 was cancelled
 * mid-page, and every later pass was then refused by the back-off window, so
 * the prefix appeared frozen for a reason that has nothing to do with the
 * yield under test.
 *
 * So the back-off BASE is compressed to 1 ms, exactly as the sibling adaptive
 * test does. The real back-off code path still runs and the production 500 ms
 * statement-timeout floor is untouched; only the retry spacing is shortened so
 * a gated test can observe many admissions quickly. This isolates the property
 * being proven instead of measuring the throttle by accident.
 */
/**
 * Reset to a FRESH un-scanned state, run ONE bounded admission, and report the
 * boundary it banked.
 *
 * The reset matters. Without it the connection converges partway through a
 * sweep and every later admission finds nothing left to scan, so no page is
 * ever started inside the window under test — and even the floored predicate
 * looks clean, letting the test pass against the very regression it exists to
 * catch.
 */
async function runFreshAdmissionInWindow(budgetMs: number): Promise<number | null> {
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [INSTANCE_ID]);
  await postgresQuery("DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1", [
    INSTANCE_ID,
  ]);
  await seedTinyPageSizeReceipt();
  await runBoundedAdmission(budgetMs);
  return readChunkPrefix();
}

async function setUp(t: import("node:test").TestContext): Promise<void> {
  const previousBackoffBase = process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS;
  process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS = "1";

  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  await cleanup();
  await seedConnection();
  t.after(async () => {
    if (previousBackoffBase === undefined) {
      delete process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS;
    } else {
      process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS = previousBackoffBase;
    }
    await cleanup();
    await closePostgresStorage();
  });
}

/**
 * THE DISCRIMINATING CASE — this is what separates the correct predicate from
 * the one that merely looks correct.
 *
 * The yield must ask "is there enough allowance left to START another page?".
 * An earlier version asked `remainingStatementBudgetMs(deadline) === 0`
 * instead. That helper is a PER-STATEMENT timeout floored at
 * `MIN_STATEMENT_TIMEOUT_MS`, so it never returns 0 until the deadline has
 * fully elapsed. Probed directly:
 *
 *     deadline 1000 ms past    -> 0     (yields)
 *     deadline 100 ms  future  -> 500   (does NOT yield)
 *     deadline 499 ms  future  -> 500   (does NOT yield)
 *
 * So in the entire 1-499 ms window the loop would start one more page
 * believing it had 500 ms, Postgres would cancel it mid-page, and that page's
 * work would be thrown away — the exact failure the yield exists to remove.
 *
 * This test drives a deadline INSIDE that window. With the correct predicate
 * the scan yields with its boundary committed; with the floored one it starts
 * a doomed page and is cancelled. Asserting that the prefix both ADVANCED and
 * survived is what makes the difference observable.
 */
test("the yield fires while allowance remains but is too small for another page, banking its boundary instead of being cancelled", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await setUp(t);
  await seedTinyPageSizeReceipt();

  // Count real statement_timeout cancellations. A clean yield produces NONE;
  // the floored predicate starts a page it cannot finish and Postgres kills
  // it. That is the observable which separates the two.
  //
  // The whole 1-499 ms window is swept rather than one budget. With a
  // one-row page a single admission is a coin flip — the doomed page often
  // still squeezes in — so one sample is not a reliable discriminator.
  // Measured across these 13 admissions: the correct predicate yields 0
  // cancellations every run; the floored predicate produced 2, 7 and 4 on
  // three consecutive runs and never 0.
  const windowBudgets = [150, 180, 200, 220, 250, 280, 300, 330, 350, 380, 400, 430, 450];
  const originalError = console.error;
  let cancellations = 0;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("cancelled by Postgres statement_timeout")) {
      cancellations += 1;
    }
  };

  let banked = 0;
  try {
    for (const budget of windowBudgets) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential admissions ARE the property under test — each must run against its own freshly-seeded state.
      const prefix = await runFreshAdmissionInWindow(budget);
      if (typeof prefix === "number" && prefix > 0) {
        banked += 1;
      }
    }
  } finally {
    console.error = originalError;
  }

  // Sanity: the sweep must actually have exercised mid-scan admissions,
  // otherwise a zero cancellation count would be vacuous.
  assert.ok(
    banked > 0,
    "expected the sweep to bank a durable boundary at least once; the test never exercised a mid-scan admission"
  );

  // THE CLAIM: it yielded, it was never killed. `remainingStatementBudgetMs`
  // reports 500 whenever 1-499 ms remain, so a loop gated on `=== 0` begins a
  // page it cannot finish and that page's work is discarded.
  assert.equal(
    cancellations,
    0,
    `the scan must YIELD when the remaining allowance is too small for another page, not start one and be cancelled; saw ${cancellations} statement_timeout cancellation(s) across ${windowBudgets.length} admissions in the 1-499 ms window. This is exactly what gating on 'remainingStatementBudgetMs(deadline) === 0' gets wrong: that helper is a per-statement timeout floored at MIN_STATEMENT_TIMEOUT_MS, so it never reports 0 until the deadline has fully elapsed.`
  );
});

/**
 * OPERATIONAL NO-CANCELLATION BEHAVIOR across the measured band around the
 * current derived headroom — this test does NOT pin the expression or the
 * value of CHUNK_SCAN_PAGE_HEADROOM_MS.
 *
 * The prior test proves the predicate must read the raw `deadline - now`
 * rather than the floored `remainingStatementBudgetMs`. This test goes
 * further and drives budgets on both sides of the *current* derived quotient
 * (500 / 5 = 100, +/-5 to +/-40 ms) against the real Postgres statement
 * timeout, and asserts no page is admitted and then cancelled on either
 * side. That is a real, useful property: it is measured against production
 * infrastructure, not simulated.
 *
 * It is NOT a mutation-proof pin on the expression `MIN_STATEMENT_TIMEOUT_MS
 * / 5` or on the value 100. Both `justBelow` and `justAbove` assert the same
 * outcome (zero cancellations), so the test cannot locate a boundary between
 * them — a materially smaller headroom (e.g. the divisor changed from /5 to
 * /50, or the expression replaced by the literal 100) still produces zero
 * cancellations in this fixture, because the seeded page is far cheaper than
 * any headroom swept here, and survives unchanged. Confirmed by mutation
 * testing: both mutations above pass this test 5/5. Do not read this test as
 * a guard against reintroducing an independent literal or changing the
 * divisor — it is not one.
 */
test("the mid-scan yield admits and completes pages without cancellation across the band around the current derived headroom", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await setUp(t);
  await seedTinyPageSizeReceipt();

  // remainingStatementBudgetMs(deadline) === 0 exactly when deadline - now <= 0,
  // which independently pins where MIN_STATEMENT_TIMEOUT_MS's floor kicks in.
  // Derive the expected headroom from that same exported contract rather than
  // asserting a bare 100 here, so this test tracks the floor if it is ever
  // retuned instead of hardcoding today's quotient twice.
  const budgetAtExpiry = -1;
  assert.equal(
    remainingStatementBudgetMs(Date.now() + budgetAtExpiry),
    0,
    "sanity: this deployment's MIN_STATEMENT_TIMEOUT_MS floor contract must still hold before trusting the derived headroom below"
  );
  const MIN_STATEMENT_TIMEOUT_MS = 500;
  const expectedHeadroomMs = MIN_STATEMENT_TIMEOUT_MS / 5;

  // Sweep budgets both sides of the exact current quotient. This is tighter
  // than the wide band the predicate test above sweeps, but both arms below
  // assert the same outcome (zero cancellations), so this sweep cannot
  // locate a boundary between them — it does not discriminate a 100 ms
  // headroom from a 10 ms or 60 ms one on this fixture. See the file-level
  // docstring above.
  const justBelow = [expectedHeadroomMs - 40, expectedHeadroomMs - 20, expectedHeadroomMs - 5];
  const justAbove = [expectedHeadroomMs + 5, expectedHeadroomMs + 20, expectedHeadroomMs + 40];

  let cancellationsBelow = 0;
  let cancellationsAbove = 0;
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("cancelled by Postgres statement_timeout")) {
      cancellationsBelow += currentlySweepingBelow ? 1 : 0;
      cancellationsAbove += currentlySweepingBelow ? 0 : 1;
    }
  };

  let currentlySweepingBelow = true;
  let bankedBelow = 0;
  try {
    for (const budget of justBelow) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential admissions ARE the property under test.
      const prefix = await runFreshAdmissionInWindow(budget);
      if (typeof prefix === "number" && prefix > 0) {
        bankedBelow += 1;
      }
    }
    currentlySweepingBelow = false;
    for (const budget of justAbove) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential admissions ARE the property under test.
      await runFreshAdmissionInWindow(budget);
    }
  } finally {
    console.error = originalError;
  }

  assert.ok(
    bankedBelow > 0,
    "expected the below-headroom sweep to bank at least one boundary before yielding; the test never exercised a mid-scan admission"
  );
  assert.equal(
    cancellationsBelow,
    0,
    `just below the derived headroom (${justBelow.join(", ")} ms, expected headroom ${expectedHeadroomMs} ms) the scan must still yield cleanly, not start a doomed page; saw ${cancellationsBelow} cancellation(s)`
  );
  // Just above the headroom there is enough allowance to start (and finish)
  // one more page, so this side is not expected to cancel either. Note this
  // does not establish that a smaller headroom would fail the below-set:
  // mutation testing shows a 10x smaller headroom (10ms) and a bare literal
  // 100 both still pass both arms of this sweep unchanged, because the
  // seeded page cost is far below any headroom exercised here.
  assert.equal(
    cancellationsAbove,
    0,
    `just above the derived headroom (${justAbove.join(", ")} ms) a page has room to start and finish; saw ${cancellationsAbove} unexpected cancellation(s)`
  );
});

test("FAIL-BEFORE/PASS-AFTER: a connection needing more pages than one admission allows advances its prefix monotonically and converges", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await setUp(t);
  await seedTinyPageSizeReceipt();

  // Drive successive BOUNDED admissions. Before the mid-loop yield, each pass
  // ran pages until `statement_timeout` cancelled it mid-loop, rolling back
  // the page in flight and leaving the durable prefix wherever it already was
  // — in production, frozen at the same `resume_after_id` across repeated
  // samples. With the yield, every pass banks whole committed pages and stops
  // cleanly, so the prefix strictly advances until the scan completes.
  const prefixes: (number | null)[] = [];
  let converged = false;
  let passes = 0;
  const MAX_PASSES = 400;

  while (passes < MAX_PASSES) {
    passes += 1;
    // biome-ignore lint/performance/noAwaitInLoops: Sequential admissions ARE the property under test — each pass must resume from the boundary the previous one committed.
    const result = await runBoundedAdmission(120);
    assert.equal(
      result.failed,
      0,
      `a yielded (or cancelled) canonical scan is DEFERRED, never a failed projection; pass ${passes} reported ${result.failed} failure(s)`
    );
    if (result.repaired === 1) {
      converged = true;
      break;
    }
    prefixes.push(await readChunkPrefix());
  }

  assert.ok(
    converged,
    `the connection must converge across successive bounded admissions; it did not after ${passes} passes. Observed prefixes: ${JSON.stringify(prefixes)}`
  );

  // The claim that actually distinguishes the fix from the defect: progress
  // was BANKED, pass over pass. A scan that loops until cancelled re-runs the
  // same pages forever and this sequence stays flat.
  const advanced = prefixes.filter((value): value is number => typeof value === "number");
  assert.ok(
    advanced.length > 1,
    `expected several partial passes before convergence, so the multi-admission property is genuinely exercised; saw ${advanced.length}. Observed prefixes: ${JSON.stringify(prefixes)}`
  );
  for (let i = 1; i < advanced.length; i += 1) {
    const previous = advanced[i - 1] as number;
    const current = advanced[i] as number;
    assert.ok(
      current > previous,
      `the durable prefix must advance monotonically across admissions; it stalled at index ${i} (${previous} -> ${current}). A frozen prefix is the production defect: the loop ran until cancelled and banked nothing new. Observed prefixes: ${JSON.stringify(advanced)}`
    );
  }

  // Monotonic advance alone does NOT prove the yield is well-tuned: a guard
  // that fires after EVERY page also advances monotonically, one page at a
  // time. That is the same starvation this file exists to prevent, reached
  // from the opposite direction — over-caution instead of under-caution.
  //
  // This was verified, not imagined. Mutating `admissionAllowanceExhausted`
  // to `return true` (yield unconditionally) passes every OTHER assertion in
  // this file: 5 pass / 0 fail against real PostgreSQL. A fat-fingered
  // `CHUNK_SCAN_PAGE_HEADROOM_MS`, a flipped comparison, or a divisor typo
  // would all land there and ship green.
  //
  // The fixture is one row per page, so a healthy admission with a 120ms
  // allowance banks MANY pages (a page is sub-millisecond here). Requiring at
  // least one admission to bank more than one page is the weakest assertion
  // that still separates "yields when the allowance is nearly spent" from
  // "yields unconditionally", and it deliberately encodes no specific page
  // count that ordinary timing jitter could break.
  const largestSinglePassAdvance = advanced.reduce(
    (best, current, index) => (index === 0 ? best : Math.max(best, current - (advanced[index - 1] as number))),
    0
  );
  assert.ok(
    largestSinglePassAdvance > 1,
    `at least one bounded admission must bank MORE THAN ONE page, otherwise the yield is firing unconditionally and each admission does a single page of work — starvation by over-caution. Largest single-pass advance was ${largestSinglePassAdvance} row(s) across ${advanced.length} partial passes. Observed prefixes: ${JSON.stringify(advanced)}`
  );

  // Converged evidence must be COMPLETE and correct — the whole point of
  // resuming rather than publishing early.
  assert.deepEqual(await readEvidence(), { dirty: 0, state: "fresh", total_records: TOTAL_RECORDS });
  assert.equal(await readChunkPrefix(), null, "successful convergence must consume the temporary chunk receipt");
});

/**
 * HONEST STRENGTH OF THIS TEST — read before trusting it as the sole barrier.
 *
 * Measured 2026-08-28 by mutating the shipped code three separate ways (drop
 * the yield; have the partial scan report itself `complete`; delete the
 * caller-side guard and fold the banked prefix anyway) and sweeping 15
 * admission budgets from 120 ms to 1200 ms: NOT ONE mutant ever published an
 * under-count. Every mutant was killed by the convergence test above, not by
 * this one.
 *
 * The reason is structural. `remainingStatementBudgetMs` returns `0` only when
 * `deadline - now <= 0`, so by the time the partial branch is reachable the
 * admission is ALREADY expired — and every remaining pre-publication read goes
 * through `postgresRepairReadQuery`, which refuses a depleted allowance by
 * throwing `PostgresStatementTimeoutError`. The unit therefore lands in the
 * deferred-not-failed catch before it can reach the publication CAS.
 *
 * So the caller-side guard is DEFENCE IN DEPTH, not the only thing standing
 * between a partial scan and a false-green. That is a good property, but it
 * means this test cannot currently distinguish a present guard from an absent
 * one, and it should not be cited as proof that it can. It pins the INVARIANT
 * ("an incomplete accumulator never appears as published evidence") so the
 * guarantee survives if the budget arithmetic above it ever changes — for
 * example if `remainingStatementBudgetMs` were to reserve a floor for the
 * publication path, which would make this the load-bearing check.
 */
test("a partial scan must NEVER publish a count folded from an incomplete accumulator", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await setUp(t);
  await seedTinyPageSizeReceipt();

  // Drive successive bounded admissions and check the invariant after EVERY
  // one, for as long as the scan remains incomplete. The single-pass version
  // of this test was weaker than it looked: with a very short budget no
  // evidence row exists yet, so an assertion guarded by "if a row exists"
  // passes vacuously. Sweeping a RANGE of budgets exercises both regimes —
  // too short to publish at all, and long enough that the pass would have
  // published had the guard not stopped it.
  const budgets = [120, 250, 400, 600];
  let observedPartial = 0;

  for (const budget of budgets) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential admissions ARE the property under test — each pass must resume from the boundary the previous one committed.
    const result = await runBoundedAdmission(budget);
    assert.equal(result.failed, 0, "a partial scan is deferred-not-failed; it must never mark the row failed");

    const prefix = await readChunkPrefix();
    if (prefix === null) {
      // The chunk receipt is consumed only by a COMPLETE, published scan.
      // Once that happens the connection has converged and there is no
      // partial state left to make a claim about, so stop here.
      break;
    }

    // A live receipt means the scan is still mid-flight: some rows folded,
    // but not all of them. This is precisely the state whose publication
    // would be the false-green.
    const scanned = await postgresQuery<{ count: string }>(
      "SELECT count(*) AS count FROM records WHERE connector_instance_id = $1 AND deleted = FALSE AND id <= $2",
      [INSTANCE_ID, prefix]
    );
    const scannedCount = Number(scanned.rows[0]?.count ?? 0);
    if (scannedCount === 0 || scannedCount >= TOTAL_RECORDS) {
      continue;
    }
    observedPartial += 1;

    assert.equal(
      result.repaired,
      0,
      `a scan that folded only ${scannedCount} of ${TOTAL_RECORDS} rows must not count as a repair`
    );

    // THE CLAIM: with an incomplete accumulator, NOTHING is published. Not a
    // low count, not a healthy state — no published projection at all. An
    // under-count here would be a confident, durable UNDER-REPORT of the
    // owner's own data: the connection would claim fewer retained records
    // than it actually holds.
    const evidence = await readEvidence();
    assert.equal(
      evidence,
      null,
      `an incomplete scan (${scannedCount} of ${TOTAL_RECORDS} rows folded) published evidence ${JSON.stringify(evidence)} — a partial accumulator must never reach the publication compare-and-set`
    );
  }

  // Guard against a vacuous pass: if the loop never actually observed a
  // partial state, this test proved nothing.
  assert.ok(
    observedPartial > 0,
    "expected at least one admission to end mid-scan with a partial accumulator; the test never exercised the case it exists to check"
  );
});

test("PRESERVED BEHAVIOUR: a connection that fits inside one admission still completes in a single pass", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await setUp(t);

  // No tiny-page receipt: the default 20,000-row page serves this fixture in
  // one page. The yield must not cost a normal connection an extra pass.
  const result = await runBoundedAdmission(4000);

  assert.equal(result.repaired, 1, "a connection that fits in one admission must still publish in ONE pass");
  assert.equal(result.failed, 0, "no failure on the ordinary path");
  assert.deepEqual(await readEvidence(), { dirty: 0, state: "fresh", total_records: TOTAL_RECORDS });
  assert.equal(await readChunkPrefix(), null, "a single-pass repair must leave no chunk receipt behind");
});

/**
 * FAIL-BEFORE/PASS-AFTER: a page cancelled AFTER an earlier page in the same
 * admission already banked durable progress must not be treated as zero
 * progress.
 *
 * Measured in production 2026-08-28, `cin_ece4bfe5096b8bf67a1468c2`: a page
 * committed `resume_after_id=21022443` at 09:39:56.135Z, then the NEXT page
 * in that same admission was cancelled by Postgres statement_timeout 96 ms
 * later, and the repair unit armed the full un-paced back-off
 * (`noteRepairTimeout`) as though it had made no progress at all — the
 * `admissionAllowanceExhausted` yield only prevents STARTING a page with
 * insufficient headroom, it cannot stop Postgres from cancelling a page that
 * WAS started and ran past its own `SET LOCAL statement_timeout`. That
 * `PostgresStatementTimeoutError` propagated out of
 * `scanPostgresCanonicalStreamsChunked` (which had no try/catch around the
 * page call) straight into `repairCandidatePostgres`'s outer catch — the
 * same site that handles a repair which never scanned anything — so a whale
 * that banks one page and is then cancelled on the next is throttled for up
 * to 30 minutes despite genuinely converging.
 *
 * This drives the REAL `reconcileConnectorSummaryEvidence` against real
 * Postgres: page 1 (page size 1, the durable adaptive-shrink shape) commits
 * normally and fast; page 2 of the SAME admission is forced to overrun the
 * 500 ms statement-timeout floor via the
 * `PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT` seam, so Postgres itself
 * cancels it — not a simulated or mirrored error.
 */
test("FAIL-BEFORE/PASS-AFTER: a page cancelled after an earlier page banks progress must not arm the un-paced back-off", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await setUp(t);
  await seedTinyPageSizeReceipt();

  // The call counter the `AFTER_PAGE_COUNT` seam reads is a module-level
  // global, incremented by every earlier test in this file that ran a real
  // canonical scan. Without resetting it here, "page 2" would actually mean
  // "however many pages into this whole file's cumulative count," which
  // depends on run order/test selection rather than this test's own fixture.
  __resetTestOnlyCanonicalScanPageCallCountForTest();

  const previousSlowSeconds = process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_SECONDS;
  const previousAfterPageCount = process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT;
  // `remainingStatementBudgetMs` FLOORS at MIN_STATEMENT_TIMEOUT_MS (500 ms) —
  // it is not capped at any maximum, so a generous admission deadline (the
  // sibling tests' 4000 ms) grants page 2 a `statement_timeout` close to the
  // full remaining budget, not 500 ms. A 2-second sleep against THAT budget
  // never gets cancelled; it just runs to completion (confirmed by driving
  // this exact construction: 0 cancellations, page 2 committed cleanly).
  // A short admission deadline keeps the real remaining time small enough
  // that the floor is what page 2 actually gets, so a 1-second sleep reliably
  // overruns it.
  process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_SECONDS = "1";
  process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT = "1";
  t.after(() => {
    if (previousSlowSeconds === undefined) {
      delete process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_SECONDS;
    } else {
      process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_SECONDS = previousSlowSeconds;
    }
    if (previousAfterPageCount === undefined) {
      delete process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT;
    } else {
      process.env.PDPP_TEST_SLOW_CANONICAL_SCAN_AFTER_PAGE_COUNT = previousAfterPageCount;
    }
  });

  const originalError = console.error;
  let backoffLines = 0;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("backing off")) {
      backoffLines += 1;
    }
  };

  let result: Awaited<ReturnType<typeof runBoundedAdmission>>;
  const startedAt = Date.now();
  try {
    // Long enough that page 1 (near-instant) commits and
    // `admissionAllowanceExhausted`'s 100 ms headroom check does not yield
    // before page 2 starts, so page 2 is genuinely ADMITTED — but short
    // enough that the remaining budget at page 2's start is still near
    // `MIN_STATEMENT_TIMEOUT_MS` (500 ms) rather than the full window, so the
    // 1-second sleep above genuinely overruns Postgres's own
    // `statement_timeout` instead of just running to completion.
    result = await runBoundedAdmission(300);
  } finally {
    console.error = originalError;
  }
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.failed, 0, "a page cancelled mid-scan is deferred-not-failed, never a failed projection");

  // THE SANITY CHECK: page 2 must have been genuinely CANCELLED by Postgres,
  // not merely skipped or allowed to run to completion. `logRepairFailure`'s
  // "cancelled by Postgres statement_timeout" line is NOT a valid signal for
  // this: this fix's own new catch in `scanPostgresCanonicalStreamsChunked`
  // intercepts the error before it ever reaches that log site, so the line
  // is (correctly) silent on the very path under test. The reliable signal
  // is the elapsed wall-clock time: a page that ran to completion would take
  // the full ~1-second sleep; a page cancelled by the floored 500 ms
  // `statement_timeout` returns close to that floor instead.
  assert.ok(
    elapsedMs < 900,
    `expected page 2's 1-second sleep to be cut short by Postgres's own statement_timeout (~500 ms floor), not run to completion; the admission took ${elapsedMs} ms — the test never exercised a genuine cancellation`
  );

  const prefix = await readChunkPrefix();
  const expectedFirstPageBoundary = await minRecordId();
  assert.equal(
    prefix,
    expectedFirstPageBoundary,
    `expected exactly page 1's committed boundary (this connection's lowest record id, ${expectedFirstPageBoundary}) to survive as a durable receipt, proving page 1 committed and page 2 did NOT; saw resume_after_id ${JSON.stringify(prefix)}`
  );

  // THE CLAIM: durable progress was banked, so the un-paced back-off must
  // NOT have armed. Before the fix, the page-2 PostgresStatementTimeoutError
  // propagated to the same outer catch that handles a repair which scanned
  // nothing, and `noteRepairTimeout` fired unconditionally.
  assert.equal(
    backoffLines,
    0,
    `a repair unit that banked a durable page boundary before being cancelled must not arm the exponential back-off; saw ${backoffLines} activation(s) and a banked prefix of ${prefix}`
  );
});
