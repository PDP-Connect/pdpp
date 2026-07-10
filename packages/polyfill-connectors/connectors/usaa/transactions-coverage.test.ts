/**
 * USAA account -> transactions DETAIL_COVERAGE evidence.
 *
 * USAA's `transactions` stream is a parent_detail_accounting stream: the
 * dashboard account list is the enumerated denominator, and each
 * transaction-eligible account's CSV export is the per-account "detail" the
 * connector hydrates. Before this test file, `runTransactionsStream` never
 * emitted DETAIL_COVERAGE at all, so the stream's coverage was permanently
 * unmeasured. These tests pin the honest coverage now emitted, mirroring
 * chase's `emitTransactionsDetailCoverage` contract:
 *   - every attempted account lands in `required_keys`;
 *   - a reached account (CSV parsed with usable rows) is hydrated;
 *   - a source-limited no-activity account (the export dialog explicitly
 *     reported "no transactions", OR the export downloaded a headers-only
 *     CSV with zero data rows — a dormant account's steady state) is ALSO
 *     hydrated coverage, never a gap;
 *   - an export-ladder-exhausted account, or one whose CSV had data rows
 *     but none usable (parse trouble), is a retryable DETAIL_GAP keyed by
 *     account id AND lands in `gap_keys`, so the run is honestly partial —
 *     a failed account is NEVER silently omitted from the denominator
 *     (that would make a partial run misread as complete);
 *   - a run whose account loop completed with ZERO transaction-eligible
 *     accounts still reports a measured considered:0/covered:0 coverage
 *     (`enumerationComplete: true`) — the denominator was genuinely walked,
 *     it just happened to be empty;
 *   - a run cut short by a mid-run session death (`enumerationComplete:
 *     false`) suppresses the report entirely, even with zero outcomes —
 *     the denominator is genuinely unknown, never inferred as zero.
 *
 * These exercise the exported helpers directly through the recording
 * harness — the same pattern integration.test.ts and chase's
 * detail-coverage.test.ts use — so they validate the emitted protocol
 * messages without driving Playwright.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AccountTransactionOutcome,
  buildAccountTransactionDetailGap,
  classifyCsvTransactionResult,
  type EmitDeps,
  emitTransactionsDetailCoverage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";

interface Harness {
  deps: EmitDeps;
  messages: EmittedMessage[];
}

function makeHarness(): Harness {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    emit: harness.emit,
    emitRecord: harness.emitRecord,
  };
  return { deps, messages: harness.protocolMessages };
}

function coverageOf(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
  return messages.find((m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE");
}

// ─── buildAccountTransactionDetailGap ────────────────────────────────────

test("buildAccountTransactionDetailGap: an exhausted export ladder becomes a retryable, reference-only gap keyed by account id", () => {
  const gap = buildAccountTransactionDetailGap({
    accountId: "ACCT-CHK-0001",
    reason: "temporary_unavailable",
    errorClass: "export_no_download",
  });
  assert.deepEqual(gap, {
    type: "DETAIL_GAP",
    stream: "transactions",
    parent_stream: "accounts",
    record_key: "ACCT-CHK-0001",
    status: "pending",
    reason: "temporary_unavailable",
    detail_locator: {
      kind: "usaa.account",
      account_id: "ACCT-CHK-0001",
    },
    retryable: true,
    reference_only: true,
    detail: { class: "export_no_download" },
    last_error: { class: "export_no_download" },
  });
});

test("buildAccountTransactionDetailGap: locator carries only the account id, never PII (name/last_four)", () => {
  const gap = buildAccountTransactionDetailGap({
    accountId: "ACCT-CHK-0001",
    reason: "temporary_unavailable",
    errorClass: "csv_no_usable_transactions",
  });
  const locatorValues = Object.values(gap.detail_locator).map((v) => String(v));
  assert.ok(!locatorValues.includes("USAA CLASSIC CHECKING"), "no account name in locator");
  assert.ok(!locatorValues.includes("9241"), "no last_four in locator");
});

// ─── classifyCsvTransactionResult: dormant vs parse-trouble split ─────────

test("classifyCsvTransactionResult: a headers-only CSV (dormant account) is no_activity/covered, never a gap", () => {
  // A dormant account's export downloads a CSV with a header and zero data
  // rows EVERY run. That is the source's honest "nothing here" answer —
  // classifying it as a gap would pin a pending retryable DETAIL_GAP on it
  // forever (permanent Degraded) for perfectly healthy behavior.
  const result = classifyCsvTransactionResult("ACCT-DORMANT", "2026-01-15", "2025-01-01", {
    dataRows: 0,
    latest: "2026-01-15",
    usableCount: 0,
  });
  assert.deepEqual(result.outcome, { accountId: "ACCT-DORMANT", kind: "no_activity" });
  assert.equal(result.last_date, "2026-01-15", "the prior watermark is preserved, not advanced or dropped");
});

test("classifyCsvTransactionResult: a headers-only CSV with no prior watermark stays no_activity with a null cursor", () => {
  const result = classifyCsvTransactionResult("ACCT-DORMANT", null, "2025-01-01", {
    dataRows: 0,
    latest: null,
    usableCount: 0,
  });
  assert.equal(result.outcome.kind, "no_activity");
  assert.equal(
    result.last_date,
    null,
    "no prior watermark → the caller writes no cursor entry (pre-coverage behavior)"
  );
});

test("classifyCsvTransactionResult: data rows present but none usable is parse trouble → gap csv_no_usable_transactions", () => {
  const result = classifyCsvTransactionResult("ACCT-BROKEN", "2026-01-15", "2025-01-01", {
    dataRows: 7,
    latest: "2026-01-15",
    usableCount: 0,
  });
  assert.deepEqual(result.outcome, {
    accountId: "ACCT-BROKEN",
    kind: "gap",
    reason: "temporary_unavailable",
    errorClass: "csv_no_usable_transactions",
  });
  assert.equal(result.last_date, "2026-01-15", "the cursor never advances past unparsed rows");
});

test("classifyCsvTransactionResult: usable transactions parsed → hydrated, cursor advances to the latest date", () => {
  const result = classifyCsvTransactionResult("ACCT-ACTIVE", "2026-01-15", "2025-01-01", {
    dataRows: 12,
    latest: "2026-04-20",
    usableCount: 12,
  });
  assert.deepEqual(result.outcome, { accountId: "ACCT-ACTIVE", kind: "hydrated" });
  assert.equal(result.last_date, "2026-04-20");
});

test("dormant headers-only CSV outcome flows to covered coverage with no DETAIL_GAP; unusable-rows outcome flows to gap with one", async () => {
  const { deps, messages } = makeHarness();
  // Mirror runTransactionsStream's wiring: classify each account, emit a
  // DETAIL_GAP for gap outcomes only, then the run-level coverage.
  const dormant = classifyCsvTransactionResult("ACCT-DORMANT", "2026-01-15", null, {
    dataRows: 0,
    latest: "2026-01-15",
    usableCount: 0,
  });
  const broken = classifyCsvTransactionResult("ACCT-BROKEN", null, null, {
    dataRows: 3,
    latest: null,
    usableCount: 0,
  });
  const outcomes = [dormant.outcome, broken.outcome];
  for (const outcome of outcomes) {
    if (outcome.kind === "gap") {
      await deps.emit(buildAccountTransactionDetailGap(outcome));
    }
  }
  await emitTransactionsDetailCoverage(deps, outcomes, true);

  const gaps = messages.filter((m) => m.type === "DETAIL_GAP");
  assert.equal(gaps.length, 1, "only the parse-trouble account carries a DETAIL_GAP");
  assert.equal(gaps[0]?.type === "DETAIL_GAP" && gaps[0].record_key, "ACCT-BROKEN");

  const coverage = coverageOf(messages);
  assert.ok(coverage);
  assert.deepEqual(coverage.hydrated_keys, ["ACCT-DORMANT"], "the dormant account is covered");
  assert.deepEqual(coverage.gap_keys, ["ACCT-BROKEN"]);
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 1, "dormant counts as covered; parse trouble does not");
});

// ─── emitTransactionsDetailCoverage: honest hydrated/gap classification ──

test("emitTransactionsDetailCoverage: all accounts hydrated -> complete coverage, no gap_keys", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-1", kind: "hydrated" },
    { accountId: "ACCT-2", kind: "hydrated" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes, true);

  const coverage = coverageOf(messages);
  assert.deepEqual(coverage, {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "accounts",
    stream: "transactions",
    required_keys: ["ACCT-1", "ACCT-2"],
    hydrated_keys: ["ACCT-1", "ACCT-2"],
    considered: 2,
    covered: 2,
  });
});

test("emitTransactionsDetailCoverage: steady-state run — every account verified with zero new records still reports full coverage", async () => {
  const { deps, messages } = makeHarness();
  // A steady-state incremental run: every account's export ladder produced a
  // CSV that parsed to zero NEW usable rows because everything was already
  // seen (fingerprint-suppressed), but the account was genuinely reached.
  // That is represented as `hydrated` here (processAccountTransactions only
  // returns a `gap` outcome when the CSV produced zero usable rows AND there
  // was no prior cursor to fall back on — see index.ts).
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-CHK-0001", kind: "hydrated" },
    { accountId: "ACCT-SAV-0002", kind: "no_activity" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes, true);

  const coverage = coverageOf(messages);
  assert.ok(coverage, "expected a DETAIL_COVERAGE message");
  assert.deepEqual([...coverage.required_keys].sort(), ["ACCT-CHK-0001", "ACCT-SAV-0002"]);
  assert.deepEqual([...coverage.hydrated_keys].sort(), ["ACCT-CHK-0001", "ACCT-SAV-0002"]);
  assert.equal(coverage.considered, 2, "the run considered both accounts");
  assert.equal(coverage.covered, 2, "a steady-state verified account counts as covered");
  assert.equal(coverage.gap_keys, undefined, "a steady-state run has no gaps");
});

test("emitTransactionsDetailCoverage: a source-limited no-activity account is HYDRATED coverage, never a gap", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-1", kind: "hydrated" },
    { accountId: "ACCT-2", kind: "no_activity" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes, true);

  const coverage = coverageOf(messages);
  assert.ok(coverage, "expected a DETAIL_COVERAGE message");
  assert.deepEqual(coverage.required_keys, ["ACCT-1", "ACCT-2"]);
  assert.deepEqual(coverage.hydrated_keys, ["ACCT-1", "ACCT-2"]);
  assert.equal(coverage.considered, 2, "the run still accounted for both considered accounts");
  assert.equal(coverage.covered, 2, "no-activity counts as covered, not collected-only");
  assert.equal(coverage.gap_keys, undefined, "no-activity must not appear in gap_keys");
});

test("emitTransactionsDetailCoverage: an export failure makes the run partial via gap_keys — a failed account is NOT counted as covered", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-1", kind: "hydrated" },
    { accountId: "ACCT-2", kind: "gap", reason: "temporary_unavailable", errorClass: "export_no_download" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes, true);

  const coverage = coverageOf(messages);
  assert.ok(coverage, "expected a DETAIL_COVERAGE message");
  assert.deepEqual(coverage.required_keys, ["ACCT-1", "ACCT-2"]);
  assert.deepEqual(coverage.hydrated_keys, ["ACCT-1"]);
  assert.deepEqual(coverage.gap_keys, ["ACCT-2"], "the failed account is reported as a gap, not silently complete");
  assert.equal(coverage.considered, 2, "the run considered both accounts");
  assert.equal(coverage.covered, 1, "a failed account is not counted as covered");
});

// ─── emitTransactionsDetailCoverage: zero-denominator vs unknown-denominator ─

test("emitTransactionsDetailCoverage: a completed enumeration with ZERO eligible accounts still emits considered 0 / covered 0", async () => {
  const { deps, messages } = makeHarness();
  // The account loop ran to completion (no session death) but found zero
  // transaction-eligible accounts (e.g. every dashboard account is an
  // external_account/loan/investing type outside TRANSACTION_ACCOUNT_TYPE_RE).
  // This denominator was genuinely measured — it just happened to be zero —
  // so it must be reported, not silently dropped.
  await emitTransactionsDetailCoverage(deps, [], true);

  const coverage = coverageOf(messages);
  assert.ok(coverage, "a completed zero-eligible-account enumeration still emits DETAIL_COVERAGE");
  assert.deepEqual(coverage.required_keys, []);
  assert.deepEqual(coverage.hydrated_keys, []);
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
  assert.equal(coverage.gap_keys, undefined);
});

test("emitTransactionsDetailCoverage: a run cut short by session death before any account was attempted emits nothing", async () => {
  const { deps, messages } = makeHarness();
  // enumerationComplete=false: the session died before the account loop
  // finished walking its denominator. Zero outcomes here is ambiguous with
  // the zero-eligible-accounts case above UNLESS the caller tells us the
  // sweep didn't finish — which is exactly what this flag is for.
  await emitTransactionsDetailCoverage(deps, [], false);
  assert.equal(coverageOf(messages), undefined, "an unknown denominator must never be reported as zero");
});

test("emitTransactionsDetailCoverage: a run cut short mid-loop still suppresses the report even with some outcomes recorded", async () => {
  const { deps, messages } = makeHarness();
  // Two accounts were reached before the session died on a third; the
  // denominator (how many eligible accounts exist in total) was never fully
  // walked, so the whole report is suppressed rather than reporting a
  // falsely-small considered count.
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-1", kind: "hydrated" },
    { accountId: "ACCT-2", kind: "hydrated" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes, false);
  assert.equal(
    coverageOf(messages),
    undefined,
    "a run cut short mid-sweep must not report a partial denominator as final"
  );
});

// ─── shape-level invariants the runtime relies on ───────────────────────

test("emitTransactionsDetailCoverage: required_keys is the union of hydrated + gap keys (every account accounted for)", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountTransactionOutcome[] = [
    { accountId: "ACCT-1", kind: "hydrated" },
    { accountId: "ACCT-2", kind: "no_activity" },
    { accountId: "ACCT-3", kind: "gap", reason: "temporary_unavailable", errorClass: "csv_no_usable_transactions" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes, true);

  const coverage = coverageOf(messages);
  assert.ok(coverage);
  const accountedFor = new Set([...coverage.hydrated_keys, ...(coverage.gap_keys ?? [])]);
  assert.deepEqual(
    [...coverage.required_keys].sort(),
    [...accountedFor].sort(),
    "every required account is either hydrated or a gap — no key silently dropped"
  );
  assert.equal(coverage.considered, 3, "the run considered every emitted outcome");
  assert.equal(coverage.covered, 2, "only hydrated + no-activity outcomes are covered");
});
