// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-account fingerprint behavior for the USAA `accounts` ENTITY stream.
 *
 * Two layers act on this stream. The run-clock gate (this file) excludes
 * `fetched_at` so a no-op refresh whose body is otherwise byte-identical is
 * suppressed. The Family-2 split (account-stats.test.ts) moved the
 * point-in-time `balance_cents` / `available_balance_cents` OUT of the entity
 * body into the `account_stats` observation stream, so after the split the
 * entity body carries identity/settings only (id, type, name, last_four,
 * status). The combined effect: the entity re-emits only on a real
 * identity/settings change; a balance tick no longer versions it (it appends a
 * point to `account_stats` instead — proven in account-stats.test.ts).
 *
 * These tests pin:
 *
 *   1. Re-emitting the same accounts with only a new `fetched_at` is fully
 *      suppressed on the second run.
 *   2. A real identity/status move re-emits (the gate never hides a real
 *      change to an entity field).
 *   3. A disappeared account is pruned so its re-appearance re-emits.
 *   4. The fingerprint cursor's STATE round-trips and excludes
 *      `fetched_at` so it survives the next run.
 *   5. `readPriorAccountFingerprints` tolerates missing/legacy/malformed
 *      state.
 *   6. Legacy callers without a cursor still emit unconditionally.
 *   7. Connector fingerprint (excludes `fetched_at`) == compaction
 *      fingerprint over the stored (post-split) body with excludeKeys
 *      ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitAccountsStream, readPriorAccountFingerprints } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";

function makeHarness(): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = { emit: harness.emit, emitRecord: harness.emitRecord };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT-CHK-0001",
    account_url: "/my/checking?accountId=ACCT-CHK-0001",
    account_type: "checking",
    name: "USAA CLASSIC CHECKING",
    last_four: "9241",
    balance_cents: 123_456,
    raw_text: "USAA CLASSIC CHECKING Ending in *9241 $1,234.56",
    ...overrides,
  };
}

/** Pull the persisted `fingerprints` map out of the accounts STATE the
 *  helper emitted, in the `{ accounts: cursor }` shape the next run reads. */
function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "accounts").at(-1);
  return { accounts: (state as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };
}

function openAccountsCursor(priorState: Record<string, unknown>) {
  return openFingerprintCursor(priorState.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(priorState),
  });
}

test("accounts: re-emitting with only a new fetched_at is fully suppressed", async () => {
  const accounts = [
    makeAccount({ account_id_raw: "A1" }),
    makeAccount({ account_id_raw: "A2", name: "USAA SAVINGS", account_type: "savings", balance_cents: 500_000 }),
  ];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, RUN1_AT, cursor1);
  assert.equal(run1.emitted.length, 2, "first run emits both accounts once");

  // Second run: identical balances, only fetched_at differs (RUN2_AT).
  // Nothing should re-emit.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(run2.deps, accounts, RUN2_AT, cursor2);
  assert.equal(run2.emitted.length, 0, "unchanged accounts are fully suppressed on the second run");
});

test("accounts: a balance-only move does NOT re-emit the entity (balance lives on account_stats)", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1", balance_cents: 100_000 })];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, RUN1_AT, cursor1);
  assert.equal(run1.emitted.length, 1, "first run emits the entity");

  // Second run: balance moved 100000 → 95000. After the Family-2 split the
  // balance is no longer on the entity body, so the entity record modulo
  // fetched_at is byte-identical → suppressed. The new balance is captured on
  // account_stats instead (see account-stats.test.ts).
  const moved = [makeAccount({ account_id_raw: "A1", balance_cents: 95_000 })];
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(run2.deps, moved, RUN2_AT, cursor2);
  assert.equal(run2.emitted.length, 0, "a balance-only move no longer versions the entity record");
});

test("accounts: external account dashboard freshness text does NOT re-emit the entity", async () => {
  const account = makeAccount({
    account_id_raw: "EXT1",
    account_type: "external-account",
    name: "Chase Sapphire Preferred 9241 as of 13 hours ago $9,212.10 $9,212.10 View Details",
    balance_cents: 921_210,
  });
  const accounts = [account];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, RUN1_AT, cursor1);
  assert.equal(run1.emitted.length, 1, "first run emits the external account entity");

  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(
    run2.deps,
    [
      {
        ...account,
        name: "Chase Sapphire Preferred 9241 as of 14 hours ago $9,212.10 $9,212.10 View Details",
      },
    ],
    RUN2_AT,
    cursor2
  );
  assert.equal(run2.emitted.length, 0, "dashboard freshness text is normalized before entity fingerprinting");
});

test("accounts: a real identity/status move re-emits the entity", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1", name: "USAA CLASSIC CHECKING" })];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, RUN1_AT, cursor1);
  assert.equal(run1.emitted.length, 1, "first run emits the account");

  // Second run: a real entity field (name) moved → re-emit.
  const renamed = [makeAccount({ account_id_raw: "A1", name: "USAA PERFORMANCE CHECKING" })];
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(run2.deps, renamed, RUN2_AT, cursor2);
  assert.equal(run2.emitted.length, 1, "an identity move is a fingerprint boundary and re-emits");
  const emittedRec = run2.emitted[0]?.data as { name?: string };
  assert.equal(emittedRec.name, "USAA PERFORMANCE CHECKING", "the re-emitted record carries the new name");
});

test("accounts: a disappeared account is pruned so its re-appearance re-emits", async () => {
  const both = [makeAccount({ account_id_raw: "A1" }), makeAccount({ account_id_raw: "A2", balance_cents: 1 })];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, both, RUN1_AT, cursor1);
  assert.equal(run1.emitted.length, 2);

  // Run 2: A2 disappears (closed/hidden). Only A1 present, unchanged.
  const onlyA1 = [makeAccount({ account_id_raw: "A1" })];
  const state1 = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(state1);
  await emitAccountsStream(run2.deps, onlyA1, RUN2_AT, cursor2);
  assert.equal(run2.emitted.length, 0, "A1 unchanged → suppressed; A2 absent → not emitted");
  // A2 must have been pruned from STATE so a re-appearance re-emits.
  const state2 = nextStateFrom(run2.messages);
  const fps2 = readPriorAccountFingerprints(state2);
  assert.equal(fps2.has("A2"), false, "disappeared account pruned from fingerprint map");
  assert.equal(fps2.has("A1"), true, "present account retained");

  // Run 3: A2 re-appears with the same balance it had in run 1.
  const bothAgain = [makeAccount({ account_id_raw: "A1" }), makeAccount({ account_id_raw: "A2", balance_cents: 1 })];
  const run3 = makeHarness();
  const cursor3 = openAccountsCursor(state2);
  await emitAccountsStream(run3.deps, bothAgain, RUN1_AT, cursor3);
  assert.equal(run3.emitted.length, 1, "re-appeared account re-emits exactly once; A1 still suppressed");
  const reemitted = run3.emitted[0];
  assert.ok(reemitted);
  assert.equal((reemitted.data as { id?: string }).id, "A2", "the re-emit is the re-appeared account");
});

test("accounts: STATE carries a fingerprints map that excludes fetched_at", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1" })];
  const run = makeHarness();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, accounts, RUN1_AT, cursor);

  const nextState = nextStateFrom(run.messages);
  const fps = readPriorAccountFingerprints(nextState);
  assert.equal(fps.size, 1, "one fingerprint persisted");
  assert.ok(fps.get("A1"), "keyed by account id");
});

test("accounts: legacy callers without a cursor still emit unconditionally", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1" })];
  const run = makeHarness();
  // No cursor argument → backward-compatible unconditional emit + heartbeat STATE.
  await emitAccountsStream(run.deps, accounts, RUN1_AT);
  assert.equal(run.emitted.length, 1, "no cursor → emits");
  const state = run.messages.filter((m) => m.type === "STATE" && m.stream === "accounts").at(-1) as
    | { cursor?: Record<string, unknown> }
    | undefined;
  assert.ok(state?.cursor && "fetched_at" in state.cursor, "heartbeat STATE still written");
  assert.equal("fingerprints" in (state?.cursor ?? {}), false, "no fingerprints map without a cursor");
});

test("readPriorAccountFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorAccountFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorAccountFingerprints({ accounts: { fetched_at: "x" } }).size,
    0,
    "legacy cursor (no fingerprints) → empty map"
  );
  assert.equal(
    readPriorAccountFingerprints({ accounts: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const ok = readPriorAccountFingerprints({ accounts: { fingerprints: { A1: "fp-1", bad: null } } });
  assert.equal(ok.size, 1, "valid entries kept, invalid dropped");
});

test("accounts: connector fingerprint (excludes fetched_at) == compaction fingerprint over the post-split body", () => {
  // Byte-parity contract for the entity compaction policy over the
  // post-split body: the connector excludes fetched_at; the compaction
  // script must use the same exclude set over the stored record_json. The
  // entity body no longer carries balances, so a no-op refresh hashes
  // identically and a real identity/status move produces a DIFFERENT
  // fingerprint (never collapsed). Balance churn is handled by the
  // account_stats stream, not by re-versioning the entity.
  const body = {
    id: "A1",
    type: "checking",
    name: "USAA CLASSIC CHECKING",
    last_four: "9241",
    status: "open",
    fetched_at: "2026-06-01T10:00:00.000Z",
  };
  const laterNoop = { ...body, fetched_at: "2026-06-02T10:00:00.000Z" };
  const laterRenamed = { ...laterNoop, name: "USAA PERFORMANCE CHECKING" };

  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(laterNoop, ["fetched_at"]),
    "fetched_at must not participate; a no-op refresh hashes identically"
  );
  assert.notEqual(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(laterRenamed, ["fetched_at"]),
    "an identity move is a real change and MUST produce a different fingerprint"
  );
});
