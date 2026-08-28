// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A repair unit whose canonical scan has ALREADY banked a complete accumulator
 * must not be paced like a unit that made zero progress, and reads whose
 * results are only used AFTER the scan succeeds must not run before it.
 *
 * Root cause (see `bz-projection-convergence-regression-0828.md`): production
 * whales' first-page canonical-scan timeouts and any OTHER read's timeout
 * inside the same repair unit were indistinguishable in the backoff
 * bookkeeping — every `PostgresStatementTimeoutError` reaching
 * `repairCandidatePostgres`'s outer catch armed the SAME escalating
 * 60s -> 120s -> ... `noteRepairTimeout` backoff, whether or not the call had
 * actually made durable progress. A row whose canonical scan converges but
 * then loses a trailing bookkeeping read (manifest, `record_reset_generation`,
 * `version_counter`, retained size, terminal/schedule high-water, or the
 * publication CAS itself) to contention got backed off harder each time with
 * nothing making the next attempt more likely to succeed — even though the
 * next attempt's OWN scan would resolve almost instantly (one page query
 * confirming nothing lies past the already-committed boundary).
 *
 * Two independent, minimal corrections, both proven here DETERMINISTICALLY —
 * no `pg_sleep`, no wall-clock race against a per-unit deadline, no dependency
 * on scan-page count or network/scheduler timing:
 *
 *   1. `repairCandidatePostgres` used to read the connector's manifest,
 *      `record_reset_generation`, and `version_counter` streams BEFORE
 *      `scanPostgresCanonicalStreamsChunked`, even though none of their
 *      results are consumed until `buildRepairedRow`, which only runs once
 *      the scan is fully complete. Proven by
 *      `PDPP_TEST_THROW_STATEMENT_TIMEOUT_AT_STAGE=streams_read`: this
 *      deterministically throws `PostgresStatementTimeoutError` the instant
 *      the `version_counter` read runs, on EVERY call, regardless of timing.
 *      If that read still ran before the scan, the scan function would never
 *      even be entered, so it could never issue a single `records` page
 *      query. After the fix, the scan runs FIRST and issues its page query
 *      (observed via `__testOnlyCanonicalScanPageCallCount`) before the
 *      (still-throwing) streams read is ever reached.
 *
 *   2. `repairCandidatePostgres` now tracks `canonicalScanCompletedThisAttempt`.
 *      A `PostgresStatementTimeoutError` on a read AFTER that flag is set
 *      arms a single FLAT backoff (`noteRepairTimeoutAfterCompletedScan`) —
 *      not escalating, not zero — instead of the full escalating
 *      `noteRepairTimeout`. Proven by observing the EXACT log line each
 *      function emits (the same proof technique the sibling
 *      `connector-summary-repair-backoff-postgres.test.ts` already uses:
 *      the console line is the one observable surface of which internal path
 *      ran, without reaching into module-private backoff maps), across TWO
 *      consecutive admissions of the same unit, each of which deterministically
 *      re-throws. A real fix never escalates ("1 time(s)" -> "2 time(s)"); a
 *      regression back to the old unconditional `noteRepairTimeout` would.
 *
 * Driving the real `reconcileConnectorSummaryEvidence` against a REAL
 * Postgres, no fakes: the sibling back-off defect survived a mutation-tested
 * suite exactly because that suite mirrored the contract instead of the
 * shipped call path.
 *
 * Gated on `PDPP_TEST_POSTGRES_URL`; skips (never fails) when unset, matching
 * every other Postgres-gated test in this suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  __resetTestOnlyCanonicalScanPageCallCountForTest,
  __testOnlyCanonicalScanPageCallCount,
  __testOnlyClearRepairTimeoutBackoffUntil,
  __testOnlyNoteRepairTimeout,
  __testOnlyNoteRepairTimeoutAfterCompletedScan,
  __testOnlyReadRepairTimeoutBackoffUntil,
  reconcileConnectorSummaryEvidence,
} from "../server/connector-summary-evidence-engine.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = "2026-08-28T00:00:00.000Z";

const STREAM_COUNT = 3;
const RECORDS_PER_STREAM = 5;
const TOTAL_RECORDS = STREAM_COUNT * RECORDS_PER_STREAM;

function seedConnection(connectorId: string, instanceId: string): Promise<void> {
  const streams = Array.from({ length: STREAM_COUNT }, (_, index) => ({
    coverage_strategy: "full_inventory",
    name: `stream_${index + 1}`,
    primary_key: ["id"],
    schema: { properties: { id: { type: "string" } }, required: ["id"], type: "object" },
  }));
  return (async () => {
    await postgresQuery("INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)", [
      connectorId,
      JSON.stringify({
        capabilities: { public_listing: { tier: "supported" } },
        connector_id: connectorId,
        display_name: "prescan-ordering",
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
       ) VALUES($1, 'owner_local', $2, 'prescan-ordering', 'active', 'account', $1, '{}'::jsonb, $3, $3, NULL)`,
      [instanceId, connectorId, NOW]
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
      [connectorId, instanceId, NOW, STREAM_COUNT, RECORDS_PER_STREAM]
    );
  })();
}

async function cleanup(connectorId: string, instanceId: string): Promise<void> {
  await postgresQuery("DELETE FROM connector_summary_evidence_repair_chunk WHERE connector_instance_id = $1", [
    instanceId,
  ]);
  await postgresQuery("DELETE FROM connector_summary_evidence WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM records WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [instanceId]);
  await postgresQuery("DELETE FROM connectors WHERE connector_id = $1", [connectorId]);
}

async function readEvidence(instanceId: string): Promise<{
  dirty: number;
  state: string;
  streamCountStates: Record<string, string>;
  total_records: number;
} | null> {
  const result = await postgresQuery<{
    dirty: number;
    state: string;
    stream_records_json: unknown;
    total_records: string;
  }>(
    "SELECT dirty, state, total_records, stream_records_json FROM connector_summary_evidence WHERE connector_instance_id = $1",
    [instanceId]
  );
  const [row] = result.rows;
  if (row === undefined) {
    return null;
  }
  const streamRecords = (
    typeof row.stream_records_json === "string" ? JSON.parse(row.stream_records_json) : row.stream_records_json
  ) as ReadonlyArray<{ count_state: string; stream: string }>;
  return {
    dirty: Number(row.dirty),
    state: String(row.state),
    streamCountStates: Object.fromEntries(streamRecords.map((entry) => [entry.stream, entry.count_state])),
    total_records: Number(row.total_records),
  };
}

async function withEnv<T>(name: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

/**
 * Count console lines matching each of the two backoff functions' EXACT,
 * distinct wording, and capture the last escalating line's full text so a
 * test can assert its reported strike count/delay directly (e.g. "2
 * time(s) ... 120s") rather than only whether the line appeared. Asserting on
 * the log line (not on internal maps this file keeps module-private) is the
 * same proof technique the sibling `connector-summary-repair-backoff-postgres.test.ts`
 * already established for this exact subsystem.
 */
async function runCountingBackoffLines<T>(fn: () => Promise<T>): Promise<{
  escalatingLines: number;
  escalatingLogLine: string | undefined;
  flatLines: number;
  result: T;
}> {
  const original = console.error;
  let escalatingLines = 0;
  let escalatingLogLine: string | undefined;
  let flatLines = 0;
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.includes("flat, never escalating further")) {
      flatLines += 1;
    } else if (line.includes("backing off") && line.includes("cancelled by statement_timeout")) {
      escalatingLines += 1;
      escalatingLogLine = line;
    }
  };
  try {
    const result = await fn();
    return { escalatingLines, escalatingLogLine, flatLines, result };
  } finally {
    console.error = original;
  }
}

const ORDERING_CONNECTOR_ID = "https://test.pdpp.dev/connectors/prescan-ordering";
const ORDERING_INSTANCE_ID = "cin_prescan_ordering_pg";

test("FAIL-BEFORE/PASS-AFTER: the canonical scan must run even when a read that used to precede it deterministically times out", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  await cleanup(ORDERING_CONNECTOR_ID, ORDERING_INSTANCE_ID);
  await seedConnection(ORDERING_CONNECTOR_ID, ORDERING_INSTANCE_ID);

  t.after(async () => {
    await cleanup(ORDERING_CONNECTOR_ID, ORDERING_INSTANCE_ID);
    await closePostgresStorage();
  });

  // THE CLAIM, checked with zero timing dependency: at least one canonical
  // `records` page query runs DURING this admission, even though the
  // streams read is configured to throw on EVERY call (so this admission
  // can never reach publication regardless of ordering).
  //
  // Before the fix: the streams read ran BEFORE
  // `scanPostgresCanonicalStreamsChunked` was ever reached, so the throw
  // aborted `repairCandidatePostgres` with the page-call counter still at
  // 0 — the scan function was never entered, unconditionally, on every
  // call (this seam throws every time; there is no timing window to miss).
  // After the fix, the scan runs FIRST and issues its page query before the
  // (still-throwing) streams read is ever reached.
  __resetTestOnlyCanonicalScanPageCallCountForTest();
  const admission = await withEnv("PDPP_TEST_THROW_STATEMENT_TIMEOUT_AT_STAGE", "streams_read", () =>
    reconcileConnectorSummaryEvidence([ORDERING_INSTANCE_ID])
  );

  assert.equal(admission.failed, 0, "a deterministic read timeout must defer this unit, never mark it failed");
  assert.equal(
    admission.repaired,
    0,
    "the streams read is configured to ALWAYS throw, so this specific admission cannot publish — the claim under test is that the scan ran anyway"
  );
  assert.ok(
    __testOnlyCanonicalScanPageCallCount() > 0,
    "the canonical scan must have issued at least one records page query before the streams read's deterministic throw was ever reached"
  );
  const evidence = await readEvidence(ORDERING_INSTANCE_ID);
  assert.equal(evidence, null, "no evidence can publish while the streams read always throws");
});

const BACKOFF_CONNECTOR_ID = "https://test.pdpp.dev/connectors/prescan-completed-scan-backoff";
const BACKOFF_INSTANCE_ID = "cin_prescan_completed_scan_backoff_pg";

test("FAIL-BEFORE/PASS-AFTER: a trailing read that times out AFTER the scan completes must back off FLAT on every occurrence, never escalating", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  await cleanup(BACKOFF_CONNECTOR_ID, BACKOFF_INSTANCE_ID);
  await seedConnection(BACKOFF_CONNECTOR_ID, BACKOFF_INSTANCE_ID);

  // Compress the backoff base to a fixed, tiny constant (the same seam the
  // sibling back-off/adaptive tests already use) so the short real sleep
  // between admissions below is a deterministic multiple of a KNOWN
  // constant, not a race against Postgres/network timing. The production
  // 500ms per-statement floor is untouched; only the retry-spacing base is
  // shortened.
  const previousBackoffBase = process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS;
  process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS = "1";

  t.after(async () => {
    if (previousBackoffBase === undefined) {
      delete process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS;
    } else {
      process.env.PDPP_TEST_REPAIR_TIMEOUT_BACKOFF_BASE_MS = previousBackoffBase;
    }
    await cleanup(BACKOFF_CONNECTOR_ID, BACKOFF_INSTANCE_ID);
    await closePostgresStorage();
  });

  // Pass 1: the (tiny, one-page) canonical scan completes fully inside this
  // call — `canonicalScanCompletedThisAttempt` becomes true — and then the
  // streams read, which always throws under this seam, fails. THE CLAIM:
  // this must log the FLAT line (`noteRepairTimeoutAfterCompletedScan`),
  // never the escalating one.
  const first = await withEnv("PDPP_TEST_THROW_STATEMENT_TIMEOUT_AT_STAGE", "streams_read", () =>
    runCountingBackoffLines(() => reconcileConnectorSummaryEvidence([BACKOFF_INSTANCE_ID]))
  );
  assert.equal(first.result.failed, 0, "a completed-scan trailing timeout must defer this unit, never fail it");
  assert.equal(first.result.repaired, 0, "the streams read always throws, so this admission cannot publish");
  assert.equal(
    first.flatLines,
    1,
    "a timeout after the scan has already completed must log the FLAT backoff line exactly once"
  );
  assert.equal(
    first.escalatingLines,
    0,
    "a completed-scan timeout must NEVER log the escalating `noteRepairTimeout` line — that is the exact regression this test guards against"
  );

  // A short, fixed real sleep — a small multiple of the compressed 1ms
  // backoff base, not a race against scan duration or network jitter — lets
  // the flat window from pass 1 elapse so pass 2 is actually attempted
  // (not silently skipped by the outer back-off gate) and reaches the
  // SAME streams-read throw again.
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Pass 2: THE CLAIM under test. If this ever regressed to the old
  // unconditional `noteRepairTimeout`, `repairTimeoutStrikes` would have
  // incremented to 2 on pass 1 and this second call would log
  // "...2 time(s)...", i.e. an ESCALATING line — proving the strike counter
  // is being fed by a completed-scan timeout, which is exactly the
  // generic gap this fix closes. The fix must show the SAME flat line
  // again, with no escalation, because `noteRepairTimeoutAfterCompletedScan`
  // deliberately never touches `repairTimeoutStrikes`.
  const second = await withEnv("PDPP_TEST_THROW_STATEMENT_TIMEOUT_AT_STAGE", "streams_read", () =>
    runCountingBackoffLines(() => reconcileConnectorSummaryEvidence([BACKOFF_INSTANCE_ID]))
  );
  assert.equal(second.result.failed, 0, "a completed-scan trailing timeout must defer this unit, never fail it");
  assert.equal(
    second.flatLines,
    1,
    "the SECOND consecutive completed-scan timeout must ALSO log the flat line exactly once — proving the pacing does not escalate on repetition"
  );
  assert.equal(
    second.escalatingLines,
    0,
    "the second occurrence must not have escalated to `noteRepairTimeout`'s line — a regression would show '...2 time(s)...' here"
  );
});

const DEESCALATION_INSTANCE_ID = "cin_prescan_no_deescalation_unit_test";

test("FAIL-BEFORE/PASS-AFTER: a completed-scan trailing timeout must never shorten a backoff window earned by prior genuine strikes", () => {
  // Calls the real `noteRepairTimeout`/`noteRepairTimeoutAfterCompletedScan`
  // directly against their real, shared, module-level maps -- the same maps
  // and functions `repairCandidatePostgres`'s outer catch calls in
  // production. This is NOT a reconstruction of the contract in a fake: it is
  // the exact code under test, invoked without going through
  // `reconcileConnectorSummaryEvidence`, because `repairCandidate`'s own gate
  // (`repairTimeoutBackoffUntil.get(id) < Date.now()`) is the only real
  // caller and it NEVER lets a second call through while a prior window is
  // still live -- so a live "genuine strikes still armed, then a
  // completed-scan timeout arrives" race cannot be constructed by driving the
  // real reconcile pipeline end-to-end without an actual multi-minute sleep.
  // `Math.max`'s contract must hold for a window that has not yet elapsed,
  // since nothing in `noteRepairTimeoutAfterCompletedScan`'s own signature
  // enforces that precondition; this is the only way to test that directly.
  __testOnlyClearRepairTimeoutBackoffUntil(DEESCALATION_INSTANCE_ID);

  // Strike 1: 60s.
  __testOnlyNoteRepairTimeout(DEESCALATION_INSTANCE_ID);
  const afterStrike1 = __testOnlyReadRepairTimeoutBackoffUntil(DEESCALATION_INSTANCE_ID);
  assert.ok(afterStrike1 !== undefined, "strike 1 must arm a backoff window");
  assert.ok(
    Math.abs(afterStrike1 - (Date.now() + 60_000)) < 5000,
    `expected strike 1 to arm ~60s, got ${afterStrike1 - Date.now()}ms`
  );

  // Strike 2: 120s. Calling `noteRepairTimeout` again directly (bypassing the
  // gate, which a real live 60s window would otherwise enforce) is exactly
  // how production reaches strike 2: a LATER genuine first-page scan timeout
  // on the same row, once its window has actually elapsed. This call
  // reproduces that outcome without the wait.
  __testOnlyNoteRepairTimeout(DEESCALATION_INSTANCE_ID);
  const afterStrike2 = __testOnlyReadRepairTimeoutBackoffUntil(DEESCALATION_INSTANCE_ID);
  assert.ok(afterStrike2 !== undefined, "strike 2 must arm a backoff window");
  assert.ok(
    Math.abs(afterStrike2 - (Date.now() + 120_000)) < 5000,
    `expected strike 2 to arm ~120s, got ${afterStrike2 - Date.now()}ms`
  );

  // THE CLAIM: while strike 2's ~120s window is STILL LIVE (has not elapsed —
  // this call happens immediately after arming it, not after a wait), a
  // completed-scan trailing timeout on the SAME row must not shorten it.
  // Before this fix (`noteRepairTimeoutAfterCompletedScan` doing an
  // unconditional `.set`), this would overwrite the live ~120s window down to
  // the flat function's own ~60s base -- a 2x de-escalation from one cheap
  // trailing-read collision, reachable across independent processes (this
  // backoff state is deliberately in-process/per-replica, so process B's flat
  // collision can overwrite process A's strike-earned window in any shared
  // storage this ever migrated to, and is a latent hazard in this function's
  // OWN contract regardless). `Math.max` against the existing deadline means
  // this call must hold or extend the still-live ~120s window, never shrink
  // it to its own ~60s base.
  __testOnlyNoteRepairTimeoutAfterCompletedScan(DEESCALATION_INSTANCE_ID);
  const afterTrailing = __testOnlyReadRepairTimeoutBackoffUntil(DEESCALATION_INSTANCE_ID);
  const minimumSurvivingWindowMs = 100_000; // strike 2's ~120s minus generous slack for this test's own runtime
  assert.ok(
    afterTrailing !== undefined && afterTrailing - Date.now() > minimumSurvivingWindowMs,
    `expected the surviving window to still reflect strike 2's ~120s, not the flat function's own ~60s base; ` +
      `remaining=${afterTrailing === undefined ? "undefined" : Math.round((afterTrailing - Date.now()) / 1000)}s`
  );

  // And strike 3 (a LATER genuine timeout on this same row) must resume at
  // strike 3 (~240s), not reset to strike 1 (~60s) -- the exact claim
  // `noteRepairTimeoutAfterCompletedScan`'s docblock makes about
  // `repairTimeoutStrikes` being untouched by the trailing collision above.
  __testOnlyNoteRepairTimeout(DEESCALATION_INSTANCE_ID);
  const afterStrike3 = __testOnlyReadRepairTimeoutBackoffUntil(DEESCALATION_INSTANCE_ID);
  assert.ok(afterStrike3 !== undefined, "strike 3 must arm a backoff window");
  assert.ok(
    Math.abs(afterStrike3 - (Date.now() + 240_000)) < 5000,
    `expected the NEXT genuine timeout to resume at strike 3 (~240s), not reset to strike 1 (~60s); got ${afterStrike3 - Date.now()}ms`
  );
});

test("the moved manifest/generation/streams reads still feed a fully correct published row", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL not set",
}, async (t) => {
  const connectorId = "https://test.pdpp.dev/connectors/prescan-ordering-correctness";
  const instanceId = "cin_prescan_ordering_correctness_pg";
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL as string });
  await cleanup(connectorId, instanceId);
  await seedConnection(connectorId, instanceId);
  t.after(async () => {
    await cleanup(connectorId, instanceId);
    await closePostgresStorage();
  });

  const result = await reconcileConnectorSummaryEvidence([instanceId]);
  assert.equal(result.repaired, 1, "a small connection must converge in one admission with no seam armed");

  const evidence = await readEvidence(instanceId);
  assert.deepEqual(
    { dirty: evidence?.dirty, state: evidence?.state, total_records: evidence?.total_records },
    { dirty: 0, state: "fresh", total_records: TOTAL_RECORDS },
    "the moved reads must still feed a fully correct published row"
  );

  // Extends the correctness guard to the field that actually depends on the
  // moved `version_counter` read: `deriveStreamCountState` derives
  // `known_zero` (an affirmative "provably zero" claim) vs `unobserved` from
  // whether a stream appears in `checkpoint.streams` (built from the MOVED
  // read) without a matching canonical row. Every stream in this fixture has
  // live records, so every stream's `count_state` must be `known` — a
  // regression that let the moved read's ordering interleave with a
  // concurrent `version_counter` insert (see the `known_zero` hazard-direction
  // note on `observedStreams` in `buildRepairedRow`) would surface here as an
  // unexpected `known_zero`, which `total_records`/`state` alone cannot catch
  // since the CAS either publishes the whole row or discards it whole.
  assert.deepEqual(
    evidence?.streamCountStates,
    { stream_1: "known", stream_2: "known", stream_3: "known" },
    "every stream with live records must be known, never known_zero or unobserved"
  );
});
