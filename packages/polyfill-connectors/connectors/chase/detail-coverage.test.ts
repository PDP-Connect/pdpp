/**
 * Chase account -> transactions DETAIL_COVERAGE evidence.
 *
 * Chase's `accounts` stream is an enumerated inventory: a real, known
 * denominator for the per-account QFX detail fan-out. These tests pin the
 * honest coverage the connector emits over that fan-out:
 *   - every considered account lands in `required_keys`;
 *   - a reached account (parsed QFX, even 0 transactions) is hydrated;
 *   - a source-limited no-activity account is ALSO hydrated coverage, never
 *     a gap (Chase's "won't backfill" windows are complete, not broken);
 *   - a transient QFX failure is a retryable DETAIL_GAP keyed by account id
 *     AND lands in `gap_keys`, so the run is honestly partial and the
 *     runtime's coverage invariant stays satisfiable;
 *   - the report is suppressed when the denominator is not genuinely known
 *     (accounts or transactions out of scope, or zero accounts considered)
 *     rather than inventing a `complete` projection.
 *
 * These exercise the exported helpers directly through the recording
 * harness — the same pattern integration.test.ts uses — so they validate
 * the emitted protocol messages without driving Playwright.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AccountDetailOutcome,
  buildAccountDetailGap,
  type EmitDeps,
  emitTransactionsDetailCoverage,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { TransactionCursor, TransactionsStateShape } from "./types.ts";

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

interface HarnessOverrides {
  maxSeenByAccount?: Record<string, TransactionCursor>;
  requestedStreams?: readonly StreamScope[];
  resFilters?: Map<string, ReadonlySet<string> | null>;
  txState?: TransactionsStateShape;
  wantsAccounts?: boolean;
  wantsBalances?: boolean;
  wantsCurrentActivity?: boolean;
  wantsStatements?: boolean;
  wantsTransactions?: boolean;
}

interface Harness {
  deps: EmitDeps;
  messages: EmittedMessage[];
}

function makeHarness(overrides: HarnessOverrides = {}): Harness {
  const harness = makeRecordingEmit(validateRecord);
  const requestedStreams = overrides.requestedStreams ?? [
    { name: "accounts" },
    { name: "transactions" },
    { name: "balances" },
  ];
  const requested = new Map<string, StreamScope>(requestedStreams.map((s) => [s.name, s]));
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: FROZEN_EMITTED_AT,
    maxSeenByAccount: overrides.maxSeenByAccount ?? {},
    progress: (): Promise<void> => Promise.resolve(),
    requested,
    resFilters: overrides.resFilters ?? new Map(),
    tmpDir: "/tmp/pdpp-chase-test-noop",
    txState: overrides.txState ?? {},
    wantsAccounts: overrides.wantsAccounts ?? true,
    wantsBalances: overrides.wantsBalances ?? true,
    wantsCurrentActivity: overrides.wantsCurrentActivity ?? true,
    wantsStatements: overrides.wantsStatements ?? true,
    wantsTransactions: overrides.wantsTransactions ?? true,
  };
  return { deps, messages: harness.protocolMessages };
}

function coverageOf(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> | undefined {
  return messages.find((m): m is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> => m.type === "DETAIL_COVERAGE");
}

// ─── buildAccountDetailGap ──────────────────────────────────────────────

test("buildAccountDetailGap: a transient QFX failure becomes a retryable, reference-only gap keyed by account id", () => {
  const gap = buildAccountDetailGap({
    accountId: "INTACC123",
    reason: "temporary_unavailable",
    errorClass: "qfx_download_failed",
  });
  assert.deepEqual(gap, {
    type: "DETAIL_GAP",
    stream: "transactions",
    parent_stream: "accounts",
    record_key: "INTACC123",
    status: "pending",
    reason: "temporary_unavailable",
    detail_locator: {
      kind: "chase.account",
      account_id: "INTACC123",
    },
    retryable: true,
    reference_only: true,
    detail: { class: "qfx_download_failed" },
    last_error: { class: "qfx_download_failed" },
  });
});

test("buildAccountDetailGap: locator carries only the account id, never PII (name/last_four)", () => {
  const gap = buildAccountDetailGap({
    accountId: "INTACC123",
    reason: "temporary_unavailable",
    errorClass: "qfx_parse_failed",
  });
  const locatorValues = Object.values(gap.detail_locator).map((v) => String(v));
  assert.ok(!locatorValues.includes("Sapphire Preferred"), "no account name in locator");
  assert.ok(!locatorValues.includes("9241"), "no last_four in locator");
});

// ─── emitTransactionsDetailCoverage: honest hydrated/gap classification ──

test("emitTransactionsDetailCoverage: all accounts hydrated -> complete coverage, no gap_keys", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1" },
    { kind: "hydrated", accountId: "ACC-2" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes);

  const coverage = coverageOf(messages);
  assert.deepEqual(coverage, {
    type: "DETAIL_COVERAGE",
    reference_only: true,
    state_stream: "accounts",
    stream: "transactions",
    required_keys: ["ACC-1", "ACC-2"],
    hydrated_keys: ["ACC-1", "ACC-2"],
  });
});

test("emitTransactionsDetailCoverage: a source-limited no-activity account is HYDRATED coverage, never a gap", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1" },
    { kind: "no_activity", accountId: "ACC-2" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes);

  const coverage = coverageOf(messages);
  assert.ok(coverage, "expected a DETAIL_COVERAGE message");
  // No-activity is "won't backfill" completeness: the account was reached,
  // the source had nothing. It must be hydrated, NOT a gap.
  assert.deepEqual(coverage.required_keys, ["ACC-1", "ACC-2"]);
  assert.deepEqual(coverage.hydrated_keys, ["ACC-1", "ACC-2"]);
  assert.equal(coverage.gap_keys, undefined, "no-activity must not appear in gap_keys");
});

test("emitTransactionsDetailCoverage: a transient QFX failure makes the run partial via gap_keys", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1" },
    { kind: "gap", accountId: "ACC-2", reason: "temporary_unavailable", errorClass: "qfx_download_failed" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes);

  const coverage = coverageOf(messages);
  assert.ok(coverage, "expected a DETAIL_COVERAGE message");
  assert.deepEqual(coverage.required_keys, ["ACC-1", "ACC-2"]);
  assert.deepEqual(coverage.hydrated_keys, ["ACC-1"]);
  assert.deepEqual(coverage.gap_keys, ["ACC-2"], "the failed account is reported as a gap, not silently complete");
});

// ─── emitTransactionsDetailCoverage: denominator-known guard ─────────────

test("emitTransactionsDetailCoverage: emits nothing when no accounts were considered (denominator unknown)", async () => {
  const { deps, messages } = makeHarness();
  await emitTransactionsDetailCoverage(deps, []);
  assert.equal(coverageOf(messages), undefined, "no coverage for an empty denominator — never infer complete");
});

test("emitTransactionsDetailCoverage: emits nothing when transactions are out of scope", async () => {
  const { deps, messages } = makeHarness({
    requestedStreams: [{ name: "accounts" }],
    wantsTransactions: false,
  });
  await emitTransactionsDetailCoverage(deps, [{ kind: "hydrated", accountId: "ACC-1" }]);
  assert.equal(coverageOf(messages), undefined, "the detail stream must be in scope before its coverage is declared");
});

test("emitTransactionsDetailCoverage: emits nothing when accounts (the state_stream) is out of scope", async () => {
  const { deps, messages } = makeHarness({
    requestedStreams: [{ name: "transactions" }],
    wantsAccounts: false,
  });
  await emitTransactionsDetailCoverage(deps, [{ kind: "hydrated", accountId: "ACC-1" }]);
  assert.equal(coverageOf(messages), undefined, "the state_stream anchor must be in scope before coverage is declared");
});

// ─── shape-level invariants the runtime relies on ───────────────────────

test("emitTransactionsDetailCoverage: required_keys is the union of hydrated + gap keys (every account accounted for)", async () => {
  const { deps, messages } = makeHarness();
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1" },
    { kind: "no_activity", accountId: "ACC-2" },
    { kind: "gap", accountId: "ACC-3", reason: "temporary_unavailable", errorClass: "qfx_parse_failed" },
  ];
  await emitTransactionsDetailCoverage(deps, outcomes);

  const coverage = coverageOf(messages);
  assert.ok(coverage);
  const accountedFor = new Set([...coverage.hydrated_keys, ...(coverage.gap_keys ?? [])]);
  assert.deepEqual(
    [...coverage.required_keys].sort(),
    [...accountedFor].sort(),
    "every required account is either hydrated or a gap — no key silently dropped"
  );
});
