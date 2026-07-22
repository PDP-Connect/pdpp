// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-transaction fingerprint behavior for the Chase `transactions` stream.
 *
 * Before this gate, `emitTransactionsForAccount` appended a fresh version
 * of every transaction on every run because the record body carried a
 * run/acquisition metadata (`fetched_at`, `source`), and the connector
 * re-downloads an overlapping incremental QFX window each run. A posted
 * transaction's identity (id = account_id|fitid) and its fields (date,
 * amount, name, memo, …) are immutable, so changing only the run clock or
 * QFX activity-mode source must not create a new retained transaction.
 *
 * These tests pin:
 *
 *   1. Re-downloading the same transactions when only fetched_at or source
 *      differs is fully suppressed on the second run.
 *   2. A genuinely-new transaction (new fitid) still emits.
 *   3. A real field move (amount correction) on an existing id re-emits.
 *   4. NO prune: a transaction omitted from a later (narrower) window keeps
 *      its fingerprint, so when the overlap re-downloads it later it is
 *      still suppressed — the partial-scan invariant. (Contrast with
 *      accounts/statements, which DO prune because they are full scans.)
 *   5. The transactions STATE carries BOTH `per_account` and the
 *      `fingerprints` map, and `fingerprints` excludes `fetched_at` and
 *      `source`.
 *   6. `readPriorTransactionFingerprints` tolerates missing/legacy/
 *      malformed state and the bare inner cursor shape.
 *   7. Legacy callers without a cursor emit unconditionally.
 *   8. Connector fingerprint (excludes fetched_at/source) == compaction
 *      fingerprint over the stored body with excludeKeys
 *      ['fetched_at', 'source'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type EmitDeps,
  emitTransactionsForAccount,
  emitTransactionsStateIfAny,
  readPriorTransactionFingerprints,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChaseAccount, QfxTransaction } from "./types.ts";

const FROZEN_EMITTED_AT_1 = "2026-06-01T10:00:00.000Z";
const FROZEN_EMITTED_AT_2 = "2026-06-02T10:00:00.000Z";
const TRANSACTION_FINGERPRINT_EXCLUDE_KEYS = ["fetched_at", "source"] as const;

const ACCOUNT: ChaseAccount = {
  internal_id: "INTACC123",
  last_four: "9241",
  name: "Sapphire Preferred",
  type: "credit_card",
};

function makeDeps(
  emittedAt: string,
  transactionsFingerprintCursor?: FingerprintCursor
): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt,
    maxSeenByAccount: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map<string, StreamScope>([["transactions", { name: "transactions" }]]),
    resFilters: new Map(),
    tmpDir: "/tmp/chase-test",
    txState: {},
    transactionsFingerprintCursor,
    wantsAccounts: false,
    wantsBalances: false,
    wantsCurrentActivity: false,
    wantsStatements: false,
    wantsTransactions: true,
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeTxn(overrides: Partial<QfxTransaction> = {}): QfxTransaction {
  return {
    amount_cents: -4599,
    check_number: null,
    currency: "USD",
    date: "2026-04-10",
    fitid: "FITID-0001",
    memo: null,
    name: "COFFEE SHOP",
    reference_number: null,
    type: "DEBIT",
    ...overrides,
  };
}

/** Pull the transactions STATE in the `{ transactions: cursor }` shape the
 *  next run reads. */
function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "transactions").at(-1);
  return { transactions: (state as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };
}

function openCursorFrom(state: Record<string, unknown>): FingerprintCursor {
  return openFingerprintCursor(state.transactions, {
    excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS,
    priorFingerprints: readPriorTransactionFingerprints(state),
  });
}

test("transactions: re-downloading the same transactions (only fetched_at differs) is fully suppressed", async () => {
  const txns = [makeTxn({ fitid: "F1" }), makeTxn({ fitid: "F2", name: "GROCERY", amount_cents: -8123 })];

  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await emitTransactionsForAccount(run1.deps, ACCOUNT, "since_last_statement", txns, cursor1);
  await emitTransactionsStateIfAny(run1.deps);
  assert.equal(run1.emitted.length, 2, "first run emits both transactions once");

  const priorState = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(priorState);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  await emitTransactionsForAccount(run2.deps, ACCOUNT, "since_last_statement", txns, cursor2);
  await emitTransactionsStateIfAny(run2.deps);
  assert.equal(run2.emitted.length, 0, "re-downloaded unchanged transactions fully suppressed despite new fetched_at");
});

test("transactions: QFX acquisition-mode source changes do not re-emit the same transaction", async () => {
  const txns = [makeTxn({ fitid: "F1", date: "2026-04-10" })];

  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await emitTransactionsForAccount(run1.deps, ACCOUNT, "all", txns, cursor1);
  await emitTransactionsStateIfAny(run1.deps);
  assert.equal((run1.emitted[0]?.data as { source?: string } | undefined)?.source, "qfx_download_all_2026-04-10");

  const priorState = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(priorState);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  await emitTransactionsForAccount(run2.deps, ACCOUNT, "since_last_statement", txns, cursor2);
  await emitTransactionsStateIfAny(run2.deps);
  assert.equal(run2.emitted.length, 0, "same transaction stays silent when only source/fetched_at move");
});

test("transactions: a genuinely-new transaction (new fitid) still emits", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await emitTransactionsForAccount(run1.deps, ACCOUNT, "since_last_statement", [makeTxn({ fitid: "F1" })], cursor1);
  await emitTransactionsStateIfAny(run1.deps);

  const priorState = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(priorState);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  // Overlap window: F1 (already seen) + F2 (new).
  await emitTransactionsForAccount(
    run2.deps,
    ACCOUNT,
    "since_last_statement",
    [makeTxn({ fitid: "F1" }), makeTxn({ fitid: "F2", date: "2026-04-12", name: "GAS", amount_cents: -3210 })],
    cursor2
  );
  await emitTransactionsStateIfAny(run2.deps);
  assert.equal(run2.emitted.length, 1, "only the new transaction emits");
  const emitted = run2.emitted[0];
  assert.ok(emitted);
  assert.equal((emitted.data as { fitid: string }).fitid, "F2");
});

test("transactions: a real field move (amount correction) on an existing id re-emits", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await emitTransactionsForAccount(
    run1.deps,
    ACCOUNT,
    "since_last_statement",
    [makeTxn({ fitid: "F1", amount_cents: -4599 })],
    cursor1
  );
  await emitTransactionsStateIfAny(run1.deps);

  const priorState = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(priorState);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  // Same fitid, corrected amount — a real change, must re-emit.
  await emitTransactionsForAccount(
    run2.deps,
    ACCOUNT,
    "since_last_statement",
    [makeTxn({ fitid: "F1", amount_cents: -5000 })],
    cursor2
  );
  await emitTransactionsStateIfAny(run2.deps);
  assert.equal(run2.emitted.length, 1, "a corrected amount is a real change and re-emits");
});

test("transactions: NO prune — a transaction omitted from a narrower window keeps its fingerprint", async () => {
  // Run 1: window returns F1 + F2.
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await emitTransactionsForAccount(
    run1.deps,
    ACCOUNT,
    "since_last_statement",
    [makeTxn({ fitid: "F1" }), makeTxn({ fitid: "F2", name: "GROCERY" })],
    cursor1
  );
  await emitTransactionsStateIfAny(run1.deps);

  // Run 2: a NARROWER incremental window returns only F2 (F1 is older than
  // the new `since`). F1 must NOT be pruned — its fingerprint must survive.
  const state2 = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(state2);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  await emitTransactionsForAccount(
    run2.deps,
    ACCOUNT,
    "since_last_statement",
    [makeTxn({ fitid: "F2", name: "GROCERY" })],
    cursor2
  );
  await emitTransactionsStateIfAny(run2.deps);
  assert.equal(run2.emitted.length, 0, "F2 unchanged stays silent; F1 not looked at this run");

  // Run 3: a WIDER window re-downloads F1 (and F2). Because F1 was never
  // pruned, its fingerprint survived run 2 and the re-download is suppressed.
  const state3 = nextStateFrom(run2.messages);
  const cursor3 = openCursorFrom(state3);
  const run3 = makeDeps(FROZEN_EMITTED_AT_2, cursor3);
  await emitTransactionsForAccount(
    run3.deps,
    ACCOUNT,
    "since_last_statement",
    [makeTxn({ fitid: "F1" }), makeTxn({ fitid: "F2", name: "GROCERY" })],
    cursor3
  );
  await emitTransactionsStateIfAny(run3.deps);
  assert.equal(run3.emitted.length, 0, "re-downloaded F1 stays suppressed because it was never pruned");
});

test("transactions: STATE carries BOTH per_account and a transaction-field fingerprints map", async () => {
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: TRANSACTION_FINGERPRINT_EXCLUDE_KEYS });
  const run = makeDeps(FROZEN_EMITTED_AT_1, cursor);
  await emitTransactionsForAccount(run.deps, ACCOUNT, "since_last_statement", [makeTxn({ fitid: "F1" })], cursor);
  await emitTransactionsStateIfAny(run.deps);

  const cursorState = nextStateFrom(run.messages).transactions as Record<string, unknown>;
  assert.ok(cursorState.per_account, "STATE keeps the per_account cursor");
  const fps = readPriorTransactionFingerprints(nextStateFrom(run.messages));
  assert.equal(fps.size, 1, "one fingerprint persisted");
  assert.ok(fps.get("INTACC123|F1"), "keyed by account_id|fitid");
});

test("readPriorTransactionFingerprints: tolerates missing / legacy / malformed / bare-inner state", () => {
  assert.equal(readPriorTransactionFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorTransactionFingerprints({ transactions: { per_account: {} } }).size,
    0,
    "legacy cursor (per_account only, no fingerprints) → empty map"
  );
  assert.equal(
    readPriorTransactionFingerprints({ transactions: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const nested = readPriorTransactionFingerprints({ transactions: { fingerprints: { "A|F1": "fp-1", bad: null } } });
  assert.equal(nested.size, 1, "valid entries kept, invalid dropped");
  // Bare inner cursor shape (no `transactions` wrapper) is also tolerated.
  const bare = readPriorTransactionFingerprints({ fingerprints: { "A|F1": "fp-1" } });
  assert.equal(bare.size, 1, "bare inner cursor shape tolerated");
});

test("transactions: legacy callers without a cursor still emit unconditionally", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  await emitTransactionsForAccount(run.deps, ACCOUNT, "since_last_statement", [
    makeTxn({ fitid: "F1" }),
    makeTxn({ fitid: "F2" }),
  ]);
  assert.equal(run.emitted.length, 2, "no cursor → emits all");
});

test("transactions: connector fingerprint equals compaction fingerprint over stored body", () => {
  const body = {
    id: "INTACC123|F1",
    account_id: "INTACC123",
    account_name: "Sapphire Preferred",
    fitid: "F1",
    date: "2026-04-10",
    amount: -4599,
    currency: "USD",
    type: "DEBIT",
    name: "COFFEE SHOP",
    memo: null,
    check_number: null,
    reference_number: null,
    source: "qfx_download_since_last_statement_2026-04-10",
    fetched_at: FROZEN_EMITTED_AT_1,
  };
  const later = {
    ...body,
    source: "qfx_download_all_2026-04-10",
    fetched_at: FROZEN_EMITTED_AT_2,
  };
  assert.equal(
    recordFingerprint(body, TRANSACTION_FINGERPRINT_EXCLUDE_KEYS),
    recordFingerprint(later, TRANSACTION_FINGERPRINT_EXCLUDE_KEYS),
    "run/acquisition metadata must not participate; both runs hash identically"
  );
});
