// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Chase served-gap recovery: DETAIL_GAP_RECOVERED for reached account gaps
 * and for statement gaps whose PDF is hydrated again.
 *
 * When the runtime serves the Chase connector a pending per-account
 * `DETAIL_GAP` at START (`ctx.detailGaps`), Chase re-enumerates and re-downloads
 * every in-scope account anyway, so the served account is hydrated by the normal
 * QFX pass. On a successful (or source-limited no-activity) outcome for a
 * served account, the connector emits `DETAIL_GAP_RECOVERED` with the served
 * `gap_id`, so the durable `connector_detail_gaps` row moves to `recovered`
 * instead of being reset to `pending` by runtime cleanup.
 *
 * Chase `statements` has the identical shape: a failed PDF download opens a
 * retryable `DETAIL_GAP` (see `processStatementRow`), and only a later run
 * that hydrates that statement's PDF again can close it — via
 * `recoverServedStatementGaps`, mirroring the account-gap path above.
 *
 * These exercise the exported recovery helpers directly through the recording
 * harness (the same pattern detail-coverage.test.ts uses) so they validate the
 * emitted protocol messages without driving Playwright. An account is treated
 * as reached exactly when `emitTransactionsDetailCoverage` would count it as a
 * `hydrated_key`; a statement is treated as recoverable exactly when
 * `emitStatementDetailCoverage` counts it in `hydratedKeys` — keeping recovery
 * and coverage in lockstep for both streams.
 *
 * Safety pinned here (lose-no-data):
 *   - only a served gap whose account was reached is recovered;
 *   - only a served statement gap whose PDF is hydrated again this run is
 *     recovered — a considered-but-still-missing statement never is, even
 *     though it appears in the same run's `requiredKeys`;
 *   - a served gap whose account still FAILS this run is never recovered
 *     (it stays on the DETAIL_GAP re-emit path → runtime resets to pending);
 *   - a served gap whose account is not enumerated this run is never recovered;
 *   - the recovery gap_id is always the served gap_id, never synthesized;
 *   - only account-level chase.account transaction gaps are recovered by
 *     `buildServedAccountGapLookup`, and only chase.statement statements gaps
 *     by `buildServedStatementGapLookup` — a foreign, wrong-stream, or
 *     malformed served gap is ignored by both.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetailGapStartEntry, EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AccountDetailOutcome,
  buildServedAccountGapLookup,
  buildServedStatementGapLookup,
  classifyNoActivityOutcome,
  type EmitDeps,
  emitNoActivityProgress,
  emitStatementDetailCoverage,
  recoverServedAccountGaps,
  recoverServedStatementGaps,
  type StatementDetailOutcome,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { TransactionCursor, TransactionsStateShape } from "./types.ts";

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

interface HarnessOverrides {
  maxSeenByAccount?: Record<string, TransactionCursor>;
  requestedStreams?: readonly StreamScope[];
  resFilters?: Map<string, ReadonlySet<string> | null>;
  servedAccountGaps?: ReadonlyMap<string, string>;
  servedStatementGaps?: ReadonlyMap<string, string>;
  txState?: TransactionsStateShape;
  wantsAccounts?: boolean;
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
    servedAccountGaps: overrides.servedAccountGaps,
    servedStatementGaps: overrides.servedStatementGaps,
    tmpDir: "/tmp/pdpp-chase-test-noop",
    txState: overrides.txState ?? {},
    wantsAccounts: overrides.wantsAccounts ?? true,
    wantsBalances: true,
    wantsCurrentActivity: false,
    wantsStatements: overrides.wantsStatements ?? false,
    wantsTransactions: overrides.wantsTransactions ?? true,
  };
  return { deps, messages: harness.protocolMessages };
}

function recoveriesOf(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }>[] {
  return messages.filter(
    (m): m is Extract<EmittedMessage, { type: "DETAIL_GAP_RECOVERED" }> => m.type === "DETAIL_GAP_RECOVERED"
  );
}

function servedGap(accountId: string, gapId: string): DetailGapStartEntry {
  return {
    gap_id: gapId,
    stream: "transactions",
    status: "pending",
    reference_only: true,
    record_key: accountId,
    detail_locator: { kind: "chase.account", account_id: accountId },
  };
}

test("unbounded no-activity is not accepted as evidence that transaction history is empty", () => {
  assert.deepEqual(classifyNoActivityOutcome("ACC-1", "all"), {
    kind: "gap",
    accountId: "ACC-1",
    reason: "temporary_unavailable",
    errorClass: "unbounded_no_activity_unverified",
  });
  assert.deepEqual(classifyNoActivityOutcome("ACC-1", "date_range"), {
    kind: "no_activity",
    accountId: "ACC-1",
  });
});

test("unbounded no-activity is reported as unverified rather than complete", async () => {
  const { deps, messages } = makeHarness();
  await emitNoActivityProgress(deps, "all");
  const progress = messages.find((message) => message.type === "PROGRESS");
  assert.ok(progress);
  assert.match(progress.message, /unverified/);
  assert.doesNotMatch(progress.message, /complete/);
});

// ─── buildServedAccountGapLookup: only account-level chase gaps ──────────

test("buildServedAccountGapLookup: maps served chase.account transaction gaps by account id", () => {
  const lookup = buildServedAccountGapLookup([servedGap("ACC-1", "gap-1"), servedGap("ACC-2", "gap-2")]);
  assert.equal(lookup.get("ACC-1"), "gap-1");
  assert.equal(lookup.get("ACC-2"), "gap-2");
  assert.equal(lookup.size, 2);
});

test("buildServedAccountGapLookup: ignores foreign, non-transactions, or malformed served gaps", () => {
  const lookup = buildServedAccountGapLookup([
    // foreign connector locator kind
    {
      gap_id: "g1",
      stream: "transactions",
      status: "pending",
      detail_locator: { kind: "amazon.order_detail", order_id: "O1" },
    },
    // wrong stream for THIS lookup — a statements gap must go through
    // buildServedStatementGapLookup instead, never this one
    {
      gap_id: "g2",
      stream: "statements",
      status: "pending",
      detail_locator: { kind: "chase.account", account_id: "ACC-9" },
    },
    // missing account_id
    { gap_id: "g3", stream: "transactions", status: "pending", detail_locator: { kind: "chase.account" } },
    // null locator
    { gap_id: "g4", stream: "transactions", status: "pending", detail_locator: null },
    // a valid one survives the filter
    servedGap("ACC-OK", "g5"),
  ] as readonly DetailGapStartEntry[]);
  assert.deepEqual([...lookup.entries()], [["ACC-OK", "g5"]]);
});

// ─── recoverServedAccountGaps: reached accounts are recovered ────────────

test("recoverServedAccountGaps: a served gap whose account is hydrated with 0 transactions is recovered", async () => {
  // The exact live case: retry reaches the account, parses a 0-transaction QFX
  // (valid coverage), and the served gap must move to recovered.
  const { deps, messages } = makeHarness({
    servedAccountGaps: new Map([["ACC-1", "gap-09e85901"]]),
  });
  const outcomes: AccountDetailOutcome[] = [{ kind: "hydrated", accountId: "ACC-1" }];
  await recoverServedAccountGaps(deps, outcomes);

  const recoveries = recoveriesOf(messages);
  assert.deepEqual(recoveries, [
    {
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: "gap-09e85901",
      stream: "transactions",
      record_key: "ACC-1",
    },
  ]);
});

test("recoverServedAccountGaps: a served gap whose account reports no-activity is recovered (source-limited coverage)", async () => {
  const { deps, messages } = makeHarness({
    servedAccountGaps: new Map([["ACC-1", "gap-1"]]),
  });
  const outcomes: AccountDetailOutcome[] = [{ kind: "no_activity", accountId: "ACC-1" }];
  await recoverServedAccountGaps(deps, outcomes);

  const recoveries = recoveriesOf(messages);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0]?.gap_id, "gap-1");
});

test("recoverServedAccountGaps: recovers ONLY the reached served account, not other served gaps", async () => {
  // Two gaps served; only ACC-1 reached. ACC-2 still fails and must NOT recover.
  const { deps, messages } = makeHarness({
    servedAccountGaps: new Map([
      ["ACC-1", "gap-1"],
      ["ACC-2", "gap-2"],
    ]),
  });
  const outcomes: AccountDetailOutcome[] = [
    { kind: "hydrated", accountId: "ACC-1" },
    { kind: "gap", accountId: "ACC-2", reason: "temporary_unavailable", errorClass: "qfx_download_failed" },
  ];
  await recoverServedAccountGaps(deps, outcomes);

  const recoveries = recoveriesOf(messages);
  assert.deepEqual(
    recoveries.map((r) => r.gap_id),
    ["gap-1"],
    "the still-failing served gap must remain unrecovered so the runtime resets it to pending"
  );
});

test("recoverServedAccountGaps: a served gap for an account not enumerated this run is never recovered", async () => {
  // Runtime served a gap for ACC-GONE, but this run only reached ACC-1.
  const { deps, messages } = makeHarness({
    servedAccountGaps: new Map([["ACC-GONE", "gap-gone"]]),
  });
  const outcomes: AccountDetailOutcome[] = [{ kind: "hydrated", accountId: "ACC-1" }];
  await recoverServedAccountGaps(deps, outcomes);

  assert.deepEqual(
    recoveriesOf(messages),
    [],
    "an unmatched served gap must fall through to the runtime's pending reset"
  );
});

test("recoverServedAccountGaps: a reached account with NO served gap emits no recovery (ordinary run)", async () => {
  const { deps, messages } = makeHarness({ servedAccountGaps: new Map() });
  const outcomes: AccountDetailOutcome[] = [{ kind: "hydrated", accountId: "ACC-1" }];
  await recoverServedAccountGaps(deps, outcomes);
  assert.deepEqual(recoveriesOf(messages), [], "no served gaps means no recovery — a normal forward run is unaffected");
});

test("recoverServedAccountGaps: undefined servedAccountGaps is a no-op (legacy/ordinary run)", async () => {
  const { deps, messages } = makeHarness({});
  const outcomes: AccountDetailOutcome[] = [{ kind: "hydrated", accountId: "ACC-1" }];
  await recoverServedAccountGaps(deps, outcomes);
  assert.deepEqual(recoveriesOf(messages), []);
});

// ─── buildServedStatementGapLookup: only chase.statement gaps ────────────

function servedStatementGap(statementId: string, gapId: string): DetailGapStartEntry {
  return {
    gap_id: gapId,
    stream: "statements",
    status: "pending",
    reference_only: true,
    record_key: statementId,
    detail_locator: { kind: "chase.statement", statement_id: statementId },
  };
}

test("buildServedStatementGapLookup: maps served chase.statement gaps by statement id", () => {
  const lookup = buildServedStatementGapLookup([
    servedStatementGap("stmt-1", "gap-1"),
    servedStatementGap("stmt-2", "gap-2"),
  ]);
  assert.equal(lookup.get("stmt-1"), "gap-1");
  assert.equal(lookup.get("stmt-2"), "gap-2");
  assert.equal(lookup.size, 2);
});

test("buildServedStatementGapLookup: ignores foreign, non-statements, or malformed served gaps", () => {
  const lookup = buildServedStatementGapLookup([
    // foreign connector locator kind
    {
      gap_id: "g1",
      stream: "statements",
      status: "pending",
      detail_locator: { kind: "amazon.order_detail", order_id: "O1" },
    },
    // wrong stream (a transactions gap, never recoverable by the statements path)
    {
      gap_id: "g2",
      stream: "transactions",
      status: "pending",
      detail_locator: { kind: "chase.statement", statement_id: "stmt-9" },
    },
    // missing statement_id
    { gap_id: "g3", stream: "statements", status: "pending", detail_locator: { kind: "chase.statement" } },
    // null locator
    { gap_id: "g4", stream: "statements", status: "pending", detail_locator: null },
    // not pending (already recovered)
    { ...servedStatementGap("stmt-done", "g6"), status: "recovered" as never },
    // a valid one survives the filter
    servedStatementGap("stmt-ok", "g5"),
  ] as readonly DetailGapStartEntry[]);
  assert.deepEqual([...lookup.entries()], [["stmt-ok", "g5"]]);
});

// ─── recoverServedStatementGaps / emitStatementDetailCoverage: statements close on hydration ───

test("recoverServedStatementGaps: a served statement gap whose PDF is hydrated again this run is recovered", async () => {
  const { deps, messages } = makeHarness({
    servedStatementGaps: new Map([["stmt-1", "gap-1"]]),
  });
  await recoverServedStatementGaps(deps, ["stmt-1"]);

  assert.deepEqual(recoveriesOf(messages), [
    {
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: "gap-1",
      stream: "statements",
      record_key: "stmt-1",
    },
  ]);
});

test("recoverServedStatementGaps: a served gap whose statement is not in hydratedKeys is never recovered", async () => {
  // Mirrors USAA's mutation-killing case: feeding requiredKeys (every
  // considered id) instead of hydratedKeys (only proven-hydrated ids) would
  // recover a still-missing statement's gap. hydratedKeys must be the only
  // acceptable input.
  const { deps, messages } = makeHarness({
    servedStatementGaps: new Map([
      ["stmt-have", "gap-have"],
      ["stmt-missing", "gap-missing"],
    ]),
  });
  // Only stmt-have is passed as hydrated; stmt-missing was considered
  // (it would appear in requiredKeys) but never proven hydrated.
  await recoverServedStatementGaps(deps, ["stmt-have"]);

  assert.deepEqual(
    recoveriesOf(messages).map((r) => r.gap_id),
    ["gap-have"],
    "recovery must follow hydration proof, never merely a considered/required key"
  );
});

test("recoverServedStatementGaps: an unmatched or unserved statement id is never recovered", async () => {
  const { deps, messages } = makeHarness({ servedStatementGaps: new Map() });
  await recoverServedStatementGaps(deps, ["stmt-unserved"]);
  assert.deepEqual(
    recoveriesOf(messages),
    [],
    "a gap id the runtime did not serve must never be synthesized — that could close unrelated work"
  );
});

test("recoverServedStatementGaps: undefined servedStatementGaps is a no-op (legacy/ordinary run)", async () => {
  const { deps, messages } = makeHarness({});
  await recoverServedStatementGaps(deps, ["stmt-1"]);
  assert.deepEqual(recoveriesOf(messages), []);
});

const STATEMENT_OUTCOME_HYDRATED = (id: string): StatementDetailOutcome => ({ kind: "hydrated", id });
const STATEMENT_OUTCOME_GAP = (id: string): StatementDetailOutcome => ({
  kind: "gap",
  id,
  reason: "temporary_unavailable",
  errorClass: "pdf_download_failed",
});

test("emitStatementDetailCoverage: recovers a served statement gap once its PDF is hydrated again", async () => {
  // The exact defect this suite pins: a statement PDF download failure opens
  // a DETAIL_GAP (see processStatementRow), and until this recovery path
  // existed, NOTHING ever closed it — buildServedAccountGapLookup only ever
  // recovers `stream: "transactions"`, so a served `statements` gap was
  // filtered out as wrong-stream and stayed pending forever, even after the
  // statement was collected on a later run.
  const { deps, messages } = makeHarness({
    wantsStatements: true,
    servedStatementGaps: new Map([["stmt-recovered", "gap-recovered"]]),
  });
  await emitStatementDetailCoverage(deps, [STATEMENT_OUTCOME_HYDRATED("stmt-recovered")]);

  assert.deepEqual(
    recoveriesOf(messages),
    [
      {
        type: "DETAIL_GAP_RECOVERED",
        reference_only: true,
        gap_id: "gap-recovered",
        stream: "statements",
        record_key: "stmt-recovered",
      },
    ],
    "a statement whose PDF is hydrated again must close its served gap, or the gap stays pending forever"
  );
});

test("emitStatementDetailCoverage: never closes a gap for a statement still missing its PDF", async () => {
  const { deps, messages } = makeHarness({
    wantsStatements: true,
    servedStatementGaps: new Map([
      ["stmt-have", "gap-have"],
      ["stmt-missing", "gap-missing"],
    ]),
  });
  await emitStatementDetailCoverage(deps, [
    STATEMENT_OUTCOME_HYDRATED("stmt-have"),
    STATEMENT_OUTCOME_GAP("stmt-missing"),
  ]);

  assert.deepEqual(
    recoveriesOf(messages).map((r) => r.gap_id),
    ["gap-have"],
    "recovery must follow the hydration proof, never merely the fact that a gap was served"
  );
  assert.ok(
    messages.some((m) => m.type === "DETAIL_GAP" && m.record_key === "stmt-missing"),
    "the still-missing statement must keep a pending gap"
  );
});
