// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-account fingerprint behavior for the Chase `accounts` stream.
 *
 * The `accounts` record carries the account identity (id, name, type,
 * last_four) plus balance fields that are ALL hardcoded `null` (balances
 * live in the separate `balances` stream) plus a run-clock `fetched_at`.
 * So the only field that moved between runs was `fetched_at` — ~20
 * versions/record of pure run-clock churn with no semantic change.
 *
 * These tests pin:
 *
 *   1. Re-emitting the same accounts (only fetched_at differs) is fully
 *      suppressed on the second run.
 *   2. A genuinely new/changed account still emits.
 *   3. A removed account is pruned so a re-add re-emits.
 *   4. The accounts STATE carries a fingerprints map.
 *   5. Legacy callers without a cursor emit unconditionally and write no
 *      accounts STATE.
 *   6. Connector fingerprint (excludes fetched_at) == compaction
 *      fingerprint over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitAccountsStream, readPriorAccountFingerprints } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChaseAccount } from "./types.ts";

const FROZEN_EMITTED_AT_1 = "2026-04-22T12:00:00.000Z";
const FROZEN_EMITTED_AT_2 = "2026-04-23T12:00:00.000Z";

function makeDeps(emittedAt: string): {
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
    requested: new Map<string, StreamScope>([["accounts", { name: "accounts" }]]),
    resFilters: new Map(),
    tmpDir: "/tmp/chase-test",
    txState: {},
    wantsAccounts: true,
    wantsBalances: false,
    wantsCurrentActivity: false,
    wantsStatements: false,
    wantsTransactions: false,
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeAccount(overrides: Partial<ChaseAccount> = {}): ChaseAccount {
  return { internal_id: "INTACC123", last_four: "9241", name: "Sapphire Preferred", type: "credit_card", ...overrides };
}

function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "accounts").at(-1);
  return { accounts: (state as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };
}

test("accounts: re-emitting with only a new fetched_at is fully suppressed", async () => {
  const accounts = [makeAccount({ internal_id: "A1" }), makeAccount({ internal_id: "A2", name: "Freedom Unlimited" })];

  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, cursor1);
  assert.equal(run1.emitted.length, 2, "first run emits both accounts once");

  const priorState = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(priorState.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(priorState),
  });
  await emitAccountsStream(run2.deps, accounts, cursor2);
  assert.equal(run2.emitted.length, 0, "unchanged accounts fully suppressed despite new fetched_at");
});

test("accounts: a changed account field re-emits; unchanged ones stay silent", async () => {
  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, [makeAccount({ internal_id: "A1", name: "Old Name" })], cursor1);

  const priorState = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(priorState.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(priorState),
  });
  await emitAccountsStream(run2.deps, [makeAccount({ internal_id: "A1", name: "Renamed Card" })], cursor2);
  assert.equal(run2.emitted.length, 1, "a renamed account is a real change and re-emits");
});

test("accounts: a removed account is pruned so a re-add re-emits", async () => {
  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(
    run1.deps,
    [makeAccount({ internal_id: "A1" }), makeAccount({ internal_id: "A2" })],
    cursor1
  );

  // A2 closed — only A1 this run.
  const state2 = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(state2.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(state2),
  });
  await emitAccountsStream(run2.deps, [makeAccount({ internal_id: "A1" })], cursor2);
  assert.equal(run2.emitted.length, 0, "A1 unchanged stays silent");

  // A2 re-opened later — must re-emit because it was pruned.
  const state3 = nextStateFrom(run2.messages);
  const run3 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor3 = openFingerprintCursor(state3.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(state3),
  });
  await emitAccountsStream(
    run3.deps,
    [makeAccount({ internal_id: "A1" }), makeAccount({ internal_id: "A2" })],
    cursor3
  );
  assert.equal(run3.emitted.length, 1, "re-added account re-emits after prune");
  assert.equal((run3.emitted[0]?.data as { id: string }).id, "A2");
});

test("accounts: STATE carries a fingerprints map keyed by account id", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, [makeAccount({ internal_id: "A1" })], cursor);
  const fps = readPriorAccountFingerprints(nextStateFrom(run.messages));
  assert.equal(fps.size, 1);
  assert.ok(fps.get("A1"));
});

test("accounts: legacy callers without a cursor emit unconditionally and write no accounts STATE", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  await emitAccountsStream(run.deps, [makeAccount({ internal_id: "A1" })]);
  assert.equal(run.emitted.length, 1, "no cursor → emits");
  const accountsState = run.messages.filter((m) => m.type === "STATE" && m.stream === "accounts");
  assert.equal(accountsState.length, 0, "no cursor → no accounts STATE written");
});

test("accounts: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
  const body = {
    id: "A1",
    name: "Sapphire Preferred",
    type: "credit_card",
    last_four: "9241",
    balance_cents: null,
    available_balance_cents: null,
    credit_limit_cents: null,
    available_credit_cents: null,
    statement_balance_cents: null,
    status: null,
    balance_as_of: null,
    fetched_at: FROZEN_EMITTED_AT_1,
  };
  const later = { ...body, fetched_at: FROZEN_EMITTED_AT_2 };
  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(later, ["fetched_at"]),
    "fetched_at must not participate; both runs hash identically"
  );
});
