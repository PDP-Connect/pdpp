/**
 * Integration tests for the Chase connector's `collect()` emit path —
 * the per-stream helpers in collect-helpers.ts (emitAccountsStream,
 * emitTransactionsForAccount, emitStatementIndexOnly) and the pure
 * scope gates (filterAccountsByScope, statementRowOutsideTimeRange,
 * emitTransactionsStateIfAny).
 *
 * These tests DON'T drive Playwright. They construct a fake `EmitDeps`
 * backed by `makeRecordingEmit(validateRecord)` — records go through
 * the real zod schema so fixture drift here fails the test instead of
 * silently passing. Captures every (stream, data) pair pushed through
 * emitRecord plus every non-RECORD EmittedMessage pushed through emit,
 * then asserts on the observable invariants: ordering across streams,
 * stream-scope suppression, res-filter + time_range gating, cursor
 * propagation, and the index-only fallback when PDF download fails.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
 *
 * Why bother: parsers.test.ts proves record *shapes* are correct from
 * QFX/DOM input. Integration tests on the emit path prove the
 * invariants downstream consumers observe:
 *   - accounts emit before transactions/balances/statements (parent
 *     before children),
 *   - stream-scope flags each gate their own stream without breaking
 *     siblings,
 *   - the accounts res-filter narrows ALL per-account work (including
 *     statement-row account resolution), not just the `accounts` stream,
 *   - statements time_range skips out-of-window rows BEFORE the PDF
 *     click path (so we don't pay the download cost),
 *   - a failed PDF download still emits a statement index row (never
 *     silently drops the fact that the statement exists),
 *   - fetched_at = emittedAt on every record (not Date.now() reads
 *     scattered through the helpers),
 *   - STATE cursor reflects MAX(seen dates) per account across a run.
 * Regressing any of these is a real data-integrity bug.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type EmitDeps,
  emitAccountsStream,
  emitStatementIndexOnly,
  emitTransactionsForAccount,
  emitTransactionsStateIfAny,
  filterAccountsByScope,
  statementRowOutsideTimeRange,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChaseAccount, QfxTransaction, StatementRow, TransactionCursor, TransactionsStateShape } from "./types.ts";

interface RecordingHarness {
  deps: EmitDeps;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
}

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

interface HarnessOverrides {
  maxSeenByAccount?: Record<string, TransactionCursor>;
  requestedStreams?: readonly StreamScope[];
  resFilters?: Map<string, ReadonlySet<string> | null>;
  txState?: TransactionsStateShape;
  wantsAccounts?: boolean;
  wantsBalances?: boolean;
  wantsStatements?: boolean;
  wantsTransactions?: boolean;
}

/** Build an EmitDeps that records every emit() and emitRecord() call.
 *  capture/progress/tmpDir are unused by the helpers under test — the
 *  recording harness fills them with inert defaults. */
function makeHarness(overrides: HarnessOverrides = {}): RecordingHarness {
  const harness = makeRecordingEmit(validateRecord);
  const requestedStreams = overrides.requestedStreams ?? [
    { name: "accounts" },
    { name: "transactions" },
    { name: "balances" },
    { name: "statements" },
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
    wantsStatements: overrides.wantsStatements ?? true,
    wantsTransactions: overrides.wantsTransactions ?? true,
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeAccount(overrides: Partial<ChaseAccount> = {}): ChaseAccount {
  return {
    internal_id: "INTACC123",
    last_four: "9241",
    name: "Sapphire Preferred",
    type: "credit_card",
    ...overrides,
  };
}

function makeTx(overrides: Partial<QfxTransaction> = {}): QfxTransaction {
  return {
    amount_cents: -1299,
    check_number: null,
    currency: "USD",
    date: "2026-04-10",
    fitid: "FITID-0001",
    memo: null,
    name: "STARBUCKS #42",
    reference_number: null,
    type: "DEBIT",
    ...overrides,
  };
}

function makeStatementRow(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    account_reference: "...9241",
    date_delivered_raw: "Apr 13, 2026",
    doc_kind: "Statement",
    rowAnchorId: "accountsTable-0-row0-cell3-requestThisDocumentAnchor-download",
    rowIdx: "0",
    tableIdx: "0",
    title: "April 2026 statement",
    ...overrides,
  };
}

// ─── Invariant 1: parent-before-child (accounts before transactions) ─────

test("emit order: accounts stream emits before transactions for the same run", async () => {
  const { deps, emitted } = makeHarness();
  const account = makeAccount();
  await emitAccountsStream(deps, [account]);
  await emitTransactionsForAccount(deps, account, "all", [makeTx()]);

  const accountIdx = emitted.findIndex((r) => r.stream === "accounts");
  const txIdx = emitted.findIndex((r) => r.stream === "transactions");
  assert.notEqual(accountIdx, -1, "expected an accounts record");
  assert.notEqual(txIdx, -1, "expected a transactions record");
  assert.ok(accountIdx < txIdx, "accounts must emit before transactions");
});

// ─── Invariant 2: stream-scope filters cleanly ───────────────────────────

test("emitTransactionsForAccount: iterates every dated tx — caller gates on wantsTransactions", async () => {
  // The helper itself is faithful to its input; the gate is at the
  // collect() call site (see index.ts `if (deps.wantsTransactions) ...`).
  // This test pins the helper's contract: don't silently skip when
  // wantsTransactions is false — the caller is responsible.
  const { deps, emitted } = makeHarness({ wantsTransactions: false });
  const account = makeAccount();
  await emitTransactionsForAccount(deps, account, "all", [makeTx(), makeTx({ fitid: "FITID-0002" })]);
  assert.equal(emitted.filter((r) => r.stream === "transactions").length, 2);
});

test("emitAccountsStream: still emits when only accounts stream is in scope", async () => {
  const { deps, emitted } = makeHarness({
    requestedStreams: [{ name: "accounts" }],
    wantsBalances: false,
    wantsStatements: false,
    wantsTransactions: false,
  });
  await emitAccountsStream(deps, [makeAccount(), makeAccount({ internal_id: "INTACC456" })]);
  const accountRecords = emitted.filter((r) => r.stream === "accounts");
  assert.equal(accountRecords.length, 2, "both accounts emit when only that stream is requested");
  assert.equal(accountRecords[0]?.data.id, "INTACC123");
  assert.equal(accountRecords[1]?.data.id, "INTACC456");
});

// ─── Invariant 3: all-streams-disabled emits nothing ─────────────────────

test("all helpers over an empty input set emit nothing", async () => {
  const { deps, emitted, messages } = makeHarness({ wantsTransactions: false });
  await emitAccountsStream(deps, []);
  await emitTransactionsForAccount(deps, makeAccount(), "all", []);
  await emitTransactionsStateIfAny(deps);
  assert.equal(emitted.length, 0, "no records emitted when there's nothing to emit");
  assert.equal(messages.length, 0, "no STATE/PROGRESS messages for empty runs");
});

// ─── Invariant 4: index-only fallback when PDF download fails ────────────

test("emitStatementIndexOnly: emits a statement record with null pdf_path + null document_url", async () => {
  const { deps, emitted } = makeHarness();
  const row = makeStatementRow();
  await emitStatementIndexOnly(deps, "stmt-id-123", row, "INTACC123", "2026-04-13");

  const stmtRecord = emitted.find((r) => r.stream === "statements");
  assert.ok(stmtRecord, "a statements record must still emit when PDF download fails");
  assert.equal(stmtRecord.data.id, "stmt-id-123");
  assert.equal(stmtRecord.data.account_id, "INTACC123");
  assert.equal(stmtRecord.data.date_delivered, "2026-04-13");
  assert.equal(stmtRecord.data.pdf_path, null, "null pdf_path marks the fallback");
  assert.equal(stmtRecord.data.pdf_sha256, null);
  assert.equal(stmtRecord.data.document_url, null);
  assert.equal(stmtRecord.data.title, row.title, "title survives to the index-only record");
});

// ─── Invariant 5: transactions cursor propagation (MAX of seen dates) ────

test("emitTransactionsForAccount: cursor max_seen_date reflects MAX of the emitted tx dates", async () => {
  const { deps } = makeHarness();
  const account = makeAccount();
  await emitTransactionsForAccount(deps, account, "all", [
    makeTx({ date: "2026-03-15", fitid: "A" }),
    makeTx({ date: "2026-04-10", fitid: "B" }),
    makeTx({ date: "2026-02-28", fitid: "C" }),
  ]);
  assert.equal(deps.maxSeenByAccount[account.internal_id]?.max_seen_date, "2026-04-10");
  assert.equal(deps.maxSeenByAccount[account.internal_id]?.last_activity, "all");
  assert.equal(deps.maxSeenByAccount[account.internal_id]?.last_fetched_at, FROZEN_EMITTED_AT);
});

test("emitTransactionsForAccount: prior cursor is preserved when new tx dates are all older", async () => {
  const { deps } = makeHarness({
    maxSeenByAccount: {
      INTACC123: { max_seen_date: "2026-05-01", last_activity: "since_last_statement" },
    },
  });
  await emitTransactionsForAccount(deps, makeAccount(), "all", [makeTx({ date: "2026-03-01", fitid: "OLD" })]);
  assert.equal(deps.maxSeenByAccount.INTACC123?.max_seen_date, "2026-05-01", "older tx must not regress the cursor");
});

test("emitTransactionsForAccount: tx with date=null is skipped (no emit, no cursor update)", async () => {
  const { deps, emitted } = makeHarness();
  const account = makeAccount();
  await emitTransactionsForAccount(deps, account, "all", [makeTx({ date: null, fitid: "DATELESS" })]);
  assert.equal(emitted.filter((r) => r.stream === "transactions").length, 0);
  assert.equal(deps.maxSeenByAccount[account.internal_id], undefined, "no cursor write for a dateless-only batch");
});

// ─── Invariant 6: emittedAt propagates into every record's fetched_at ────

test("emittedAt propagates into accounts.fetched_at + transactions.fetched_at + statements.fetched_at", async () => {
  const { deps, emitted } = makeHarness();
  const account = makeAccount();
  await emitAccountsStream(deps, [account]);
  await emitTransactionsForAccount(deps, account, "all", [makeTx()]);
  await emitStatementIndexOnly(deps, "stmt-id", makeStatementRow(), "INTACC123", "2026-04-13");

  for (const r of emitted) {
    assert.equal(
      r.data.fetched_at,
      FROZEN_EMITTED_AT,
      `fetched_at on stream=${r.stream} must be the frozen emittedAt, got ${String(r.data.fetched_at)}`
    );
  }
});

// ─── Invariant 7a: accountsResFilter narrows the filtered-accounts list ──

test("filterAccountsByScope: resFilter on 'accounts' stream narrows to matching internal_ids", () => {
  const accounts = [
    makeAccount({ internal_id: "KEEP-1" }),
    makeAccount({ internal_id: "DROP-1" }),
    makeAccount({ internal_id: "KEEP-2" }),
  ];
  const resFilters = new Map<string, ReadonlySet<string> | null>([["accounts", new Set(["KEEP-1", "KEEP-2"])]]);
  const { accountsResFilter, filteredAccounts } = filterAccountsByScope(accounts, resFilters);
  assert.equal(filteredAccounts.length, 2);
  assert.deepEqual(
    filteredAccounts.map((a) => a.internal_id),
    ["KEEP-1", "KEEP-2"]
  );
  assert.ok(accountsResFilter?.has("KEEP-1"));
  assert.ok(!accountsResFilter?.has("DROP-1"));
});

test("filterAccountsByScope: falls back to transactions res-filter when 'accounts' has none", () => {
  const accounts = [makeAccount({ internal_id: "A" }), makeAccount({ internal_id: "B" })];
  const resFilters = new Map<string, ReadonlySet<string> | null>([["transactions", new Set(["A"])]]);
  const { accountsResFilter, filteredAccounts } = filterAccountsByScope(accounts, resFilters);
  assert.equal(filteredAccounts.length, 1);
  assert.equal(filteredAccounts[0]?.internal_id, "A");
  assert.ok(accountsResFilter?.has("A"));
});

// ─── Invariant 7b: statement time_range skips out-of-window rows ─────────

test("statementRowOutsideTimeRange: dateIso before time_range.since returns true", () => {
  const { deps } = makeHarness({
    requestedStreams: [{ name: "statements", time_range: { since: "2026-03-01T00:00:00.000Z" } }],
  });
  assert.equal(statementRowOutsideTimeRange(deps, "2026-02-15"), true, "February is before March-since");
  assert.equal(statementRowOutsideTimeRange(deps, "2026-03-01"), false, "on-boundary since is inclusive");
  assert.equal(statementRowOutsideTimeRange(deps, "2026-04-10"), false, "after since is in-range");
});

test("statementRowOutsideTimeRange: dateIso on/after time_range.until returns true (until is exclusive)", () => {
  const { deps } = makeHarness({
    requestedStreams: [{ name: "statements", time_range: { until: "2026-04-01T00:00:00.000Z" } }],
  });
  assert.equal(statementRowOutsideTimeRange(deps, "2026-03-31"), false, "day before until is in-range");
  assert.equal(statementRowOutsideTimeRange(deps, "2026-04-01"), true, "on-boundary until is exclusive");
  assert.equal(statementRowOutsideTimeRange(deps, "2026-05-10"), true, "after until is out-of-range");
});

test("statementRowOutsideTimeRange: null dateIso is always considered in-range", () => {
  const { deps } = makeHarness({
    requestedStreams: [
      { name: "statements", time_range: { since: "2026-03-01T00:00:00.000Z", until: "2026-04-01T00:00:00.000Z" } },
    ],
  });
  // Null date can't be compared — we keep the row rather than silently drop it,
  // so the PDF's content-addressed path is still the single source of truth
  // and a bad date parse doesn't hide a statement that exists.
  assert.equal(statementRowOutsideTimeRange(deps, null), false);
});

// ─── Invariant 8: transactions STATE is emitted iff there's something to say ─

test("emitTransactionsStateIfAny: emits STATE with per_account cursor when txs were emitted", async () => {
  const { deps, messages } = makeHarness({
    maxSeenByAccount: {
      INTACC123: { max_seen_date: "2026-04-10", last_activity: "all", last_fetched_at: FROZEN_EMITTED_AT },
    },
  });
  await emitTransactionsStateIfAny(deps);
  const stateMsg = messages.find((m) => m.type === "STATE");
  assert.ok(stateMsg, "STATE must emit when per-account cursor is non-empty");
  assert.equal(stateMsg.stream, "transactions");
  assert.deepEqual(stateMsg.cursor, {
    per_account: {
      INTACC123: { max_seen_date: "2026-04-10", last_activity: "all", last_fetched_at: FROZEN_EMITTED_AT },
    },
  });
});

test("emitTransactionsStateIfAny: skipped when wantsTransactions=false (avoids clobbering prior STATE)", async () => {
  const { deps, messages } = makeHarness({
    maxSeenByAccount: {
      INTACC123: { max_seen_date: "2026-04-10" },
    },
    wantsTransactions: false,
  });
  await emitTransactionsStateIfAny(deps);
  assert.equal(messages.length, 0, "don't emit STATE when the client didn't ask for transactions");
});
