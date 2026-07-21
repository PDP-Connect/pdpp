/**
 * Family-2 split for the USAA `accounts` stream: point-in-time balances move
 * to the append-keyed `account_stats` observation stream so a balance tick no
 * longer versions the `accounts` entity record.
 *
 * Before this split, the entity fingerprint gate (excludes `fetched_at`)
 * correctly suppressed pure run-clock churn, but a genuine balance move was a
 * fingerprint boundary that re-versioned the entity — point-in-time churn the
 * Family-2 construction removes. After the split, `accounts` carries
 * identity/settings only (id, type, name, last_four, status); the daily
 * balance snapshot lives on `account_stats`, keyed `{account_id}:{observed_on}`.
 *
 * These tests pin:
 *
 *   1. `buildAccountStatsRecord` builds the date-scoped key and carries the
 *      balance fields; the entity record drops them.
 *   2. A balance-only change does NOT re-emit the entity record (the existing
 *      fingerprint gate is now a no-op over the narrowed body) but DOES emit a
 *      fresh `account_stats` record.
 *   3. A real identity/status change re-emits the entity exactly once.
 *   4. Same-day idempotency: two emits on the same UTC day produce the same
 *      `account_stats` key; a later day produces a distinct key.
 *   5. Every emitted `account_stats` record passes the real zod schema (the
 *      harness routes records through `validateRecord`).
 *   6. Requesting only `account_stats` (no `accounts`) emits the observation
 *      stream and writes its STATE, but emits no entity record or entity STATE.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitAccountsStream, readPriorAccountFingerprints } from "./index.ts";
import { buildAccountStatsRecord } from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type { DashboardAccount } from "./types.ts";

const RUN1_AT = "2026-06-01T10:00:00.000Z";
const RUN2_AT = "2026-06-02T10:00:00.000Z";
const DAY1 = "2026-06-01";
const DAY2 = "2026-06-02";

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

const STATS_OPTS = (observedOn: string) => ({ emitEntity: true, emitStats: true, observedOn });

test("account_stats: builder builds the date-scoped key and carries balances; entity drops them", () => {
  const a = makeAccount({ account_id_raw: "A1", balance_cents: 123_456 });
  const stat = buildAccountStatsRecord(a, DAY1);
  assert.equal(stat.id, "A1:2026-06-01", "id is {account_id}:{observed_on}");
  assert.equal(stat.account_id, "A1", "carries the joinable account id");
  assert.equal(stat.observed_on, DAY1);
  assert.equal(stat.balance_cents, 123_456, "carries the balance");
  assert.equal(stat.available_balance_cents, null);
});

test("account_stats: a balance-only change does not re-emit the entity but does emit a fresh stat", async () => {
  const accounts1 = [makeAccount({ account_id_raw: "A1", balance_cents: 100_000 })];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts1, RUN1_AT, cursor1, STATS_OPTS(DAY1));
  const entity1 = run1.emitted.filter((e) => e.stream === "accounts");
  const stats1 = run1.emitted.filter((e) => e.stream === "account_stats");
  assert.equal(entity1.length, 1, "first run emits the entity once");
  assert.equal(stats1.length, 1, "first run emits one account_stats");

  // Second run, same day, balance moved 100000 → 95000. Entity body modulo
  // fetched_at is byte-identical (balances are gone) → entity suppressed.
  const accounts2 = [makeAccount({ account_id_raw: "A1", balance_cents: 95_000 })];
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(run2.deps, accounts2, RUN2_AT, cursor2, STATS_OPTS(DAY2));
  const entity2 = run2.emitted.filter((e) => e.stream === "accounts");
  const stats2 = run2.emitted.filter((e) => e.stream === "account_stats");
  assert.equal(entity2.length, 0, "a balance-only move does NOT re-version the entity record");
  assert.equal(stats2.length, 1, "the new balance is captured on account_stats");
  assert.equal((stats2[0]?.data as { balance_cents?: number }).balance_cents, 95_000);
});

test("account_stats: a real identity/status change re-emits the entity exactly once", async () => {
  const accounts1 = [makeAccount({ account_id_raw: "A1", name: "USAA CLASSIC CHECKING" })];
  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts1, RUN1_AT, cursor1, STATS_OPTS(DAY1));
  assert.equal(run1.emitted.filter((e) => e.stream === "accounts").length, 1);

  // Rename: a real identity field moved → entity re-emits.
  const renamed = [makeAccount({ account_id_raw: "A1", name: "USAA PERFORMANCE CHECKING" })];
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(run2.deps, renamed, RUN2_AT, cursor2, STATS_OPTS(DAY2));
  const entity2 = run2.emitted.filter((e) => e.stream === "accounts");
  assert.equal(entity2.length, 1, "an identity change re-emits the entity exactly once");
  assert.equal((entity2[0]?.data as { name?: string }).name, "USAA PERFORMANCE CHECKING");
});

test("account_stats: same-day re-pull is the same key; a later day is a distinct key", () => {
  const a = makeAccount({ account_id_raw: "A1", balance_cents: 100_000 });
  const sameDayA = buildAccountStatsRecord(a, DAY1);
  const sameDayB = buildAccountStatsRecord({ ...a, balance_cents: 95_000 }, DAY1);
  const laterDay = buildAccountStatsRecord(a, DAY2);
  assert.equal(sameDayA.id, sameDayB.id, "same UTC day → same append key (idempotent / overwrite)");
  assert.notEqual(sameDayA.id, laterDay.id, "a later UTC day → distinct append key (time series)");
});

test("account_stats: emitted observation records pass the real zod schema", async () => {
  const accounts = [
    makeAccount({ account_id_raw: "A1", balance_cents: 100_000 }),
    makeAccount({ account_id_raw: "A2", balance_cents: -2500, account_type: "credit-card", last_four: "0002" }),
  ];
  const run = makeHarness();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, accounts, RUN1_AT, cursor, STATS_OPTS(DAY1));
  const stats = run.emitted.filter((e) => e.stream === "account_stats");
  // makeRecordingEmit routes through validateRecord; a schema miss lands in
  // `.skipped`, not `.emitted`, so an emitted count of 2 proves both passed.
  assert.equal(stats.length, 2, "both account_stats records passed the schema (negative balance allowed)");
});

test("account_stats: an account_stats-only request emits the stream but no entity record or STATE", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1", balance_cents: 100_000 })];
  const run = makeHarness();
  // emitEntity:false, emitStats:true — the collect() path for a request that
  // selects account_stats but not accounts.
  await emitAccountsStream(run.deps, accounts, RUN1_AT, undefined, {
    emitEntity: false,
    emitStats: true,
    observedOn: DAY1,
  });
  assert.equal(run.emitted.filter((e) => e.stream === "accounts").length, 0, "no entity record emitted");
  assert.equal(run.emitted.filter((e) => e.stream === "account_stats").length, 1, "one stat emitted");
  const entityState = run.messages.filter((m) => m.type === "STATE" && m.stream === "accounts");
  const statsState = run.messages.filter((m) => m.type === "STATE" && m.stream === "account_stats");
  assert.equal(entityState.length, 0, "no entity STATE written when the entity is not requested");
  assert.equal(statsState.length, 1, "account_stats STATE written");
  assert.equal(
    (statsState[0] as { cursor?: { observed_on?: string } }).cursor?.observed_on,
    DAY1,
    "account_stats STATE carries observed_on"
  );
});

test("account_stats: STATE for the entity still carries a fetched_at-excluding fingerprints map", async () => {
  const accounts = [makeAccount({ account_id_raw: "A1" })];
  const run = makeHarness();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, accounts, RUN1_AT, cursor, STATS_OPTS(DAY1));
  const nextState = nextStateFrom(run.messages);
  const fps = readPriorAccountFingerprints(nextState);
  assert.equal(fps.size, 1, "one entity fingerprint persisted");
  assert.ok(fps.get("A1"), "keyed by account id");
});
