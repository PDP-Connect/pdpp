// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Steady-state `considered` + `covered` declaration on USAA's fingerprint-
 * suppressed full-sync `accounts` ENTITY stream (OpenSpec
 * `define-connector-progress-evidence-contract`, task 4.4).
 *
 * The entity stream re-enumerates the whole dashboard account boundary every run
 * and suppresses unchanged accounts via the per-record fingerprint cursor.
 * Before this change it declared NO `considered` denominator, because the
 * coverage gate compared `considered` against the post-suppression emitted count
 * (`collected`), so a steady-state run (nothing changed → nothing emitted) would
 * have read a FALSE `partial`.
 *
 * The fix adds an objective `covered` count — the in-boundary accounts the run
 * accounted for: emitted PLUS suppressed-because-unchanged — measured at the
 * enumeration loop, never aliased to the emitted count. The gate compares
 * `considered` against `covered` when present, so a fresh / steady-state /
 * one-changed run all read complete-eligible (covered === considered).
 *
 * `account_stats` is an append-keyed daily observation, not an inventory, so it
 * declares no denominator; the stats-only path (emitEntity: false) emits no
 * accounts self-coverage. The projection half (covered-vs-considered →
 * complete/partial, and the dropped-row → partial guardrail) is pinned in
 * reference-implementation/test/collection-report-projection.test.js.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetailCoverageMessage, EmittedMessage } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
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

/** The single accounts self-coverage DETAIL_COVERAGE per run
 *  (stream === state_stream === "accounts"). Returns undefined when none. */
function accountsSelfCoverage(messages: EmittedMessage[]): DetailCoverageMessage | undefined {
  return messages.find(
    (m): m is DetailCoverageMessage =>
      m.type === "DETAIL_COVERAGE" && m.stream === "accounts" && m.state_stream === "accounts"
  );
}

test("accounts considered: a fresh run declares considered === covered === enumerated, all emitted", async () => {
  const accounts = [
    makeAccount({ account_id_raw: "A1" }),
    makeAccount({ account_id_raw: "A2", name: "USAA SAVINGS", account_type: "savings" }),
  ];
  const run = makeHarness();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, accounts, RUN1_AT, cursor);

  assert.equal(run.emitted.length, 2, "fresh run emits both entity records");
  const cov = accountsSelfCoverage(run.messages);
  assert.ok(cov, "fresh run declares an accounts self-coverage message");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered === considered (all emitted)");
  assert.deepEqual(cov?.required_keys, [], "list stream: no detail-hydration required keys");
  assert.deepEqual(cov?.hydrated_keys, [], "list stream: no detail-hydration hydrated keys");
});

test("accounts considered: a steady-state run declares covered === considered while collected is 0", async () => {
  const accounts = [
    makeAccount({ account_id_raw: "A1" }),
    makeAccount({ account_id_raw: "A2", name: "USAA SAVINGS", account_type: "savings" }),
  ];

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, RUN1_AT, cursor1);

  // Second run: identical accounts, only a balance tick (which lives on
  // account_stats, not the entity body) and a new fetched_at → every entity
  // suppressed, collected 0. covered must still equal the enumerated boundary.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(run2.deps, accounts, RUN2_AT, cursor2);

  assert.equal(run2.emitted.length, 0, "steady-state run emits no entity records (all suppressed)");
  const cov = accountsSelfCoverage(run2.messages);
  assert.ok(cov, "steady-state run still declares accounts self-coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered counts suppressed-unchanged, NOT aliased to collected (0)");
});

test("accounts considered: a one-changed run keeps covered === considered", async () => {
  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(
    run1.deps,
    [makeAccount({ account_id_raw: "A1", name: "OLD NAME" }), makeAccount({ account_id_raw: "A2" })],
    RUN1_AT,
    cursor1
  );

  // Second run: A1 renamed (a real entity-field change → re-emits), A2 unchanged
  // (suppressed). collected 1, but both covered → covered === considered === 2.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openAccountsCursor(priorState);
  await emitAccountsStream(
    run2.deps,
    [makeAccount({ account_id_raw: "A1", name: "RENAMED CHECKING" }), makeAccount({ account_id_raw: "A2" })],
    RUN2_AT,
    cursor2
  );

  assert.equal(run2.emitted.length, 1, "only the renamed account re-emits");
  const cov = accountsSelfCoverage(run2.messages);
  assert.ok(cov, "one-changed run declares accounts self-coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered (1 emitted + 1 suppressed) === considered, not the collected count of 1");
});

test("accounts considered: the stats-only path (emitEntity false) declares no accounts coverage", async () => {
  const run = makeHarness();
  // account_stats-only run: no entity enumeration, no entity boundary to cover.
  await emitAccountsStream(run.deps, [makeAccount({ account_id_raw: "A1" })], RUN1_AT, undefined, {
    emitEntity: false,
    emitStats: true,
  });

  assert.equal(
    accountsSelfCoverage(run.messages),
    undefined,
    "stats-only path enumerates no entity inventory → declares no considered/covered"
  );
});

test("accounts considered: legacy callers without a cursor declare no coverage", async () => {
  const run = makeHarness();
  await emitAccountsStream(run.deps, [makeAccount({ account_id_raw: "A1" })], RUN1_AT);

  assert.equal(run.emitted.length, 1, "no cursor → emits unconditionally");
  assert.equal(
    accountsSelfCoverage(run.messages),
    undefined,
    "no fingerprint cursor → not the steady-state suppress shape → declare no considered/covered"
  );
});
