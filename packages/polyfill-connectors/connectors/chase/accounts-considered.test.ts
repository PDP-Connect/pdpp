// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Steady-state `considered` + `covered` declaration on Chase's fingerprint-
 * suppressed full-sync `accounts` stream (OpenSpec
 * `define-connector-progress-evidence-contract`, task 4.4).
 *
 * `accounts` re-enumerates the whole dashboard account boundary every run and
 * suppresses unchanged accounts via the per-record fingerprint cursor. Before
 * this change it declared NO `considered` denominator, because the coverage gate
 * compared `considered` against the post-suppression emitted count
 * (`collected`), so a steady-state run (nothing changed → nothing emitted) would
 * have read a FALSE `partial`.
 *
 * The fix adds an objective `covered` count — the in-boundary accounts the run
 * accounted for: emitted PLUS suppressed-because-unchanged — measured at the
 * enumeration loop, never aliased to the emitted count. The gate compares
 * `considered` against `covered` when present, so:
 *   - a fresh run reads complete-eligible (covered === considered, all emitted);
 *   - a steady-state run reads complete-eligible (covered === considered,
 *     collected 0);
 *   - a one-changed run still reads complete-eligible (covered === considered).
 *
 * These tests drive the real `emitAccountsStream` against the recording emit
 * harness and assert on the self-coverage DETAIL_COVERAGE it emits
 * (`stream === state_stream === "accounts"`). The projection half (the gate
 * turning covered-vs-considered into complete/partial, and the dropped-row →
 * partial guardrail) is pinned in
 * reference-implementation/test/collection-report-projection.test.js.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetailCoverageMessage, EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
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

/** The single self-coverage DETAIL_COVERAGE the accounts stream emits per run
 *  (stream === state_stream === "accounts"). Returns undefined when none. */
function accountsSelfCoverage(messages: EmittedMessage[]): DetailCoverageMessage | undefined {
  return messages.find(
    (m): m is DetailCoverageMessage =>
      m.type === "DETAIL_COVERAGE" && m.stream === "accounts" && m.state_stream === "accounts"
  );
}

test("accounts considered: a fresh run declares considered === covered === enumerated, all emitted", async () => {
  const accounts = [makeAccount({ internal_id: "A1" }), makeAccount({ internal_id: "A2", name: "Freedom Unlimited" })];
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run.deps, accounts, cursor);

  assert.equal(run.emitted.length, 2, "fresh run emits both accounts");
  const cov = accountsSelfCoverage(run.messages);
  assert.ok(cov, "fresh run declares an accounts self-coverage message");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered === considered (all emitted)");
  assert.deepEqual(cov?.required_keys, [], "list stream: no detail-hydration required keys");
  assert.deepEqual(cov?.hydrated_keys, [], "list stream: no detail-hydration hydrated keys");
});

test("accounts considered: a steady-state run declares covered === considered while collected is 0", async () => {
  const accounts = [makeAccount({ internal_id: "A1" }), makeAccount({ internal_id: "A2", name: "Freedom Unlimited" })];

  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(run1.deps, accounts, cursor1);

  // Second run: same accounts, only the run-clock fetched_at differs → every
  // account suppressed, collected 0. covered must still equal the enumerated
  // boundary so the projection reads complete, not a false partial.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(priorState.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(priorState),
  });
  await emitAccountsStream(run2.deps, accounts, cursor2);

  assert.equal(run2.emitted.length, 0, "steady-state run emits nothing (all suppressed)");
  const cov = accountsSelfCoverage(run2.messages);
  assert.ok(cov, "steady-state run still declares accounts self-coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered counts suppressed-unchanged, NOT aliased to collected (0)");
});

test("accounts considered: a one-changed run keeps covered === considered", async () => {
  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitAccountsStream(
    run1.deps,
    [makeAccount({ internal_id: "A1", name: "Old Name" }), makeAccount({ internal_id: "A2" })],
    cursor1
  );

  // Second run: A1 renamed (re-emits), A2 unchanged (suppressed). collected 1,
  // but both are covered → covered === considered === 2.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(priorState.accounts, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorAccountFingerprints(priorState),
  });
  await emitAccountsStream(
    run2.deps,
    [makeAccount({ internal_id: "A1", name: "Renamed Card" }), makeAccount({ internal_id: "A2" })],
    cursor2
  );

  assert.equal(run2.emitted.length, 1, "only the renamed account re-emits");
  const cov = accountsSelfCoverage(run2.messages);
  assert.ok(cov, "one-changed run declares accounts self-coverage");
  assert.equal(cov?.considered, 2, "considered === enumerated boundary");
  assert.equal(cov?.covered, 2, "covered (1 emitted + 1 suppressed) === considered, not the collected count of 1");
});

test("accounts considered: legacy callers without a cursor declare no coverage", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  await emitAccountsStream(run.deps, [makeAccount({ internal_id: "A1" })]);

  assert.equal(run.emitted.length, 1, "no cursor → emits unconditionally");
  assert.equal(
    accountsSelfCoverage(run.messages),
    undefined,
    "no fingerprint cursor → not the steady-state suppress shape → declare no considered/covered"
  );
});
