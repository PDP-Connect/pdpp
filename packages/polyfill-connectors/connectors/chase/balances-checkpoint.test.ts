import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitBalancesStateIfAny } from "./index.ts";
import { validateRecord } from "./schemas.ts";

// Regression proof for the stream-coverage evidence omission: a succeeded Chase
// run emitted `balances` records (point-in-time ledger snapshots from the QFX
// LEDGERBAL/AVAILBAL blocks) but never staged a checkpoint for the stream, so
// `buildCollectionFacts` reported `checkpoint:not_staged` and the
// `singleton_presence` coverage strategy could not prove coverage — the stream
// projected `unmeasured` despite retained records (live run_1783395077609).
//
// `balances` is append-only with no incremental cursor to advance, so the fix
// stages a bare `{ fetched_at }` presence checkpoint (mirroring
// `current_activity`) iff at least one balance was emitted this run.
//
// The projection consequence — `checkpoint:committed` + `singleton_presence` ->
// coverage `complete` instead of the pre-fix `unknown`/`unmeasured` — is proven
// against the real projection in
// reference-implementation/test/collection-report-projection.test.js.

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

function makeDeps(overrides: Partial<EmitDeps> = {}): {
  deps: EmitDeps;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const requestedStreams: readonly StreamScope[] = [
    { name: "accounts" },
    { name: "transactions" },
    { name: "balances" },
  ];
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: FROZEN_EMITTED_AT,
    maxSeenByAccount: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map(requestedStreams.map((s) => [s.name, s])),
    resFilters: new Map(),
    tmpDir: "/tmp/pdpp-chase-test-noop",
    txState: {},
    wantsAccounts: true,
    wantsBalances: true,
    wantsCurrentActivity: false,
    wantsStatements: false,
    wantsTransactions: true,
    ...overrides,
  };
  return { deps, messages: harness.protocolMessages };
}

function balancesState(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "STATE" }>[] {
  return messages.filter(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "balances"
  );
}

test("emitBalancesStateIfAny: stages a balances presence checkpoint when a balance was emitted", async () => {
  const { deps, messages } = makeDeps();
  await emitBalancesStateIfAny(deps, true);

  const state = balancesState(messages);
  assert.equal(state.length, 1, "expected exactly one balances STATE checkpoint");
  // singleton_presence: no cursor to advance, just a presence marker.
  assert.deepEqual(state[0]?.cursor, { fetched_at: FROZEN_EMITTED_AT });
});

test("emitBalancesStateIfAny: stages nothing when no balance was emitted (no hollow checkpoint)", async () => {
  const { deps, messages } = makeDeps();
  await emitBalancesStateIfAny(deps, false);
  assert.equal(balancesState(messages).length, 0, "no checkpoint over an empty balances run");
});

test("emitBalancesStateIfAny: stages nothing when balances is out of scope", async () => {
  // An out-of-scope STATE would throw `STATE for undeclared stream` in the
  // runtime, so the emit must be gated on wantsBalances.
  const { deps, messages } = makeDeps({
    requested: new Map([["transactions", { name: "transactions" }]]),
    wantsBalances: false,
  });
  await emitBalancesStateIfAny(deps, true);
  assert.equal(balancesState(messages).length, 0, "no checkpoint when balances not requested");
});
