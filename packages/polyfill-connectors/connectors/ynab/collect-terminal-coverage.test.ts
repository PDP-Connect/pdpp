// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Terminal coverage proof for the YNAB connector's required-by-default
 * streams (`budgets`, `accounts`, `payee_locations`, `scheduled_transactions`
 * — all `full_inventory` — per manifests/ynab.json) plus `account_stats`
 * (`singleton_presence`, not required but needs an explicit disposition).
 *
 * Before this change, `accounts` and `payee_locations` NEVER called
 * `emitDetailCoverage` — a succeeded run with real records retained would
 * still project `unknown`/`unmeasured` under the `full_inventory` strategy,
 * indistinguishable from a run that skipped the stream entirely. This file
 * drives the real production entrypoint (`ynabCollect`, the exact function
 * `runConnector` invokes — see index.ts) rather than re-implementing a
 * parallel orchestration, so a future edit that deletes one of these
 * coverage emits fails a test that exercises the true call path.
 *
 * Every scenario below feeds the run's emitted facts through
 * `evaluateStreamCoherence` (@pdpp/reference-contract/evidence) — the same
 * pure function the reference implementation's projection boundary uses — so
 * "the coverage message shape looks right" is never accepted as a substitute
 * for "the coherence evaluator actually reads this run as proven."
 *
 * `ynabCollect`'s second parameter is the injected `request` — the sole DI
 * seam, matching `ynab()`'s own signature (see index.ts's `YnabRequest`
 * type). This test never stubs `globalThis.fetch` and never calls the real
 * `ynab()`, so the module-level `httpGovernor` (real per-request pacing
 * floor from `ynabPacingProfile()`) is never on the call path — a fixture
 * lookup resolves synchronously instead of waiting on the governor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CoverageProofStrategy,
  evaluateStreamCoherence,
  type StreamEvidenceEnvelope,
} from "@pdpp/reference-contract/evidence";
import type { CollectContext, EmittedMessage } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { ynabCollect } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const BUDGET_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BUDGET_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT_1 = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_2 = "22222222-2222-4222-8222-222222222222";
const PAYEE_1 = "33333333-3333-4333-8333-333333333333";
const PAYEE_LOC_1 = "44444444-4444-4444-8444-444444444444";
const SCHEDULED_1 = "55555555-5555-4555-8555-555555555555";

interface BudgetFixture {
  accounts?: Record<string, unknown>[];
  id: string;
  payeeLocations?: Record<string, unknown>[];
  scheduledTransactions?: Record<string, unknown>[];
}

function budgetSummary(id: string): Record<string, unknown> {
  return { id, name: `Budget ${id}` };
}

function account(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: "Checking",
    type: "checking",
    on_budget: true,
    closed: false,
    balance: 100_000,
    cleared_balance: 100_000,
    uncleared_balance: 0,
    deleted: false,
    ...overrides,
  };
}

function payeeLocation(id: string, payeeId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    payee_id: payeeId,
    latitude: "40.0",
    longitude: "-105.0",
    deleted: false,
    ...overrides,
  };
}

function scheduledTxn(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    date_first: "2026-01-01",
    date_next: "2026-09-01",
    frequency: "monthly",
    amount: -50_000,
    account_id: ACCOUNT_1,
    deleted: false,
    ...overrides,
  };
}

/**
 * A deterministic double for `YnabRequest` (index.ts), keyed by path suffix
 * so a multi-budget, multi-stream `ynabCollect` run can be driven with one
 * fake. Injected directly as `ynabCollect`'s `request` parameter — this
 * never touches `globalThis.fetch`, `ynab()`, or the module-level
 * `httpGovernor`, so none of `ynabPacingProfile()`'s real pacing floor is on
 * the call path. `knowledgeSeenFor` records the `knowledge` option the
 * connector passed per endpoint+budget, so incremental-vs-fresh behavior is
 * observable without inspecting connector internals.
 */
function fakeRequest(budgets: readonly BudgetFixture[]): {
  knowledgeSeenFor: (path: string) => number | undefined;
  requestsFor: (path: string) => Array<number | undefined>;
  request: <T>(path: string, token: string, options?: { knowledge?: number; sinceDate?: string }) => Promise<T>;
} {
  const knowledgeSeen = new Map<string, number | undefined>();
  const requestKnowledge = new Map<string, Array<number | undefined>>();
  const byId = new Map(budgets.map((b) => [b.id, b]));

  const request = <T>(
    path: string,
    _token: string,
    options?: { knowledge?: number; sinceDate?: string }
  ): Promise<T> => {
    knowledgeSeen.set(path, options?.knowledge);
    requestKnowledge.set(path, [...(requestKnowledge.get(path) ?? []), options?.knowledge]);

    if (path === "/budgets") {
      return Promise.resolve({ data: { budgets: budgets.map((b) => budgetSummary(b.id)) } } as T);
    }
    const budgetMatch = path.match(/^\/budgets\/([^/]+)\/(.+)$/);
    const [, budgetId, resource] = budgetMatch ?? [];
    const fixture = budgetId ? byId.get(budgetId) : undefined;
    if (!fixture) {
      return Promise.reject(new Error(`ynab_http_404 [endpoint ${path}]: not_found`));
    }
    if (resource === "accounts") {
      return Promise.resolve({ data: { accounts: fixture.accounts ?? [], server_knowledge: 100 } } as T);
    }
    if (resource === "payee_locations") {
      return Promise.resolve({ data: { payee_locations: fixture.payeeLocations ?? [] } } as T);
    }
    if (resource === "scheduled_transactions") {
      return Promise.resolve({
        data: { scheduled_transactions: fixture.scheduledTransactions ?? [], server_knowledge: 200 },
      } as T);
    }
    if (resource === "categories") {
      return Promise.resolve({ data: { category_groups: [], server_knowledge: 300 } } as T);
    }
    if (resource === "payees") {
      return Promise.resolve({ data: { payees: [], server_knowledge: 400 } } as T);
    }
    if (resource === "transactions") {
      return Promise.resolve({ data: { transactions: [], server_knowledge: 500 } } as T);
    }
    if (resource === "months") {
      return Promise.resolve({ data: { months: [], server_knowledge: 600 } } as T);
    }
    return Promise.reject(new Error(`ynab_http_404 [endpoint ${path}]: not_found`));
  };

  return {
    request,
    knowledgeSeenFor: (path: string) => knowledgeSeen.get(path),
    requestsFor: (path: string) => requestKnowledge.get(path) ?? [],
  };
}

function makeCtx(
  streamNames: readonly string[],
  state: Record<string, unknown> = {}
): { ctx: CollectContext; messages: EmittedMessage[] } {
  const harness = makeRecordingEmit(validateRecord);
  const ctx: CollectContext = {
    assist: () => Promise.reject(new Error("not used")),
    capture: null,
    completeAssistance: () => Promise.resolve(),
    credentials: { YNAB_PERSONAL_ACCESS_TOKEN: "test-token" },
    detailGaps: [],
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt: "2026-08-10T00:00:00Z",
    progress: () => Promise.resolve(),
    requestDetailGapPage: () => Promise.resolve([]),
    requested: new Map(streamNames.map((name) => [name, { name }])),
    scope: { streams: streamNames.map((name) => ({ name })) },
    sendInteraction: () => Promise.reject(new Error("not used")),
    state,
  };
  return { ctx, messages: harness.protocolMessages };
}

function coverageFor(messages: EmittedMessage[], stream: string): Record<string, unknown> | undefined {
  return messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === stream && m.state_stream === stream) as
    | Record<string, unknown>
    | undefined;
}

function hasCommittedState(messages: EmittedMessage[], stream: string): boolean {
  return messages.some((m) => m.type === "STATE" && m.stream === stream);
}

/** Build the coherence envelope a real projection would read from this run's
 *  facts and evaluate it through the shared, zero-I/O reference evaluator. */
function coherenceFor(
  messages: EmittedMessage[],
  stream: string,
  strategy: CoverageProofStrategy
): ReturnType<typeof evaluateStreamCoherence> {
  const coverage = coverageFor(messages, stream);
  const envelope: StreamEvidenceEnvelope = {
    checkpoint: hasCommittedState(messages, stream) ? "committed" : null,
    ...(coverage?.considered === undefined ? {} : { considered: coverage.considered as number }),
    ...(coverage?.covered === undefined ? {} : { covered: coverage.covered as number }),
  };
  return evaluateStreamCoherence(envelope, { coverage_strategy: strategy });
}

const ALL_STREAMS = ["budgets", "accounts", "account_stats", "payee_locations", "scheduled_transactions"];

// ─── Multi-budget, nonzero, fresh: every required stream proves coverage ──

test("ynabCollect: multi-budget fresh run proves coverage for every required-by-default stream plus account_stats", async () => {
  const fixtures: BudgetFixture[] = [
    {
      id: BUDGET_A,
      accounts: [account(ACCOUNT_1), account(ACCOUNT_2, { name: "Savings", type: "savings" })],
      payeeLocations: [payeeLocation(PAYEE_LOC_1, PAYEE_1)],
      scheduledTransactions: [scheduledTxn(SCHEDULED_1)],
    },
    {
      id: BUDGET_B,
      accounts: [account(ACCOUNT_1)],
      payeeLocations: [],
      scheduledTransactions: [],
    },
  ];
  const { request } = fakeRequest(fixtures);
  const { ctx, messages } = makeCtx(ALL_STREAMS);
  await ynabCollect(ctx, request);

  const accountsCov = coverageFor(messages, "accounts");
  assert.ok(accountsCov, "accounts declares self-coverage");
  assert.equal(accountsCov?.considered, 3, "3 accounts total across both budgets");
  assert.equal(accountsCov?.covered, 3, "all 3 accounted for");

  const statsCov = coverageFor(messages, "account_stats");
  assert.ok(statsCov, "account_stats declares an explicit disposition, not silence");
  assert.equal(statsCov?.considered, 3);
  assert.equal(statsCov?.covered, 3, "singleton_presence: every enumerated account is accounted for");

  const payeeLocCov = coverageFor(messages, "payee_locations");
  assert.ok(payeeLocCov, "payee_locations declares self-coverage");
  assert.equal(payeeLocCov?.considered, 1, "only budget A has a payee location");
  assert.equal(payeeLocCov?.covered, 1);

  const schedCov = coverageFor(messages, "scheduled_transactions");
  assert.ok(schedCov, "scheduled_transactions declares self-coverage");
  assert.equal(schedCov?.considered, 1);
  assert.equal(schedCov?.covered, 1);

  const budgetsCov = coverageFor(messages, "budgets");
  assert.ok(budgetsCov, "budgets declares self-coverage");
  assert.equal(budgetsCov?.considered, 2);
  assert.equal(budgetsCov?.covered, 2);

  for (const [stream, strategy] of [
    ["budgets", "full_inventory"],
    ["accounts", "full_inventory"],
    ["account_stats", "singleton_presence"],
    ["payee_locations", "full_inventory"],
    ["scheduled_transactions", "full_inventory"],
  ] as const) {
    const verdict = coherenceFor(messages, stream, strategy);
    assert.equal(verdict.proven, true, `${stream}: coherence evaluator must read this run as proven`);
    assert.equal(verdict.reason, "enumeration_boundary", `${stream}: proof came from a measured boundary`);
  }
});

// ─── Zero budgets: no facts collected, coverage must not be fabricated ────

test("ynabCollect: zero-budget run emits no coverage for per-budget streams — a checkpoint alone is not proof", async () => {
  const { request } = fakeRequest([]);
  const { ctx, messages } = makeCtx(ALL_STREAMS);
  await ynabCollect(ctx, request);

  assert.equal(coverageFor(messages, "accounts"), undefined, "no budgets ran → no accounts coverage fabricated");
  assert.equal(coverageFor(messages, "account_stats"), undefined);
  assert.equal(coverageFor(messages, "payee_locations"), undefined);
  assert.equal(coverageFor(messages, "scheduled_transactions"), undefined);

  // budgets itself is a single top-level call (not per-budget), so it DOES
  // enumerate and prove a genuine zero — verified-empty, not unmeasured.
  const budgetsCov = coverageFor(messages, "budgets");
  assert.ok(budgetsCov, "budgets still proves its own (empty) boundary");
  assert.equal(budgetsCov?.considered, 0);
  assert.equal(budgetsCov?.covered, 0);
  const budgetsVerdict = coherenceFor(messages, "budgets", "full_inventory");
  assert.equal(budgetsVerdict.proven, true, "budgets: genuine zero is proven-empty");

  // accounts/payee_locations/scheduled_transactions never staged a
  // checkpoint (no budgets to iterate), so the coherence evaluator must
  // NOT read them as proven — the invariant this whole change exists to
  // guarantee: absence of evidence must not launder into `complete`.
  for (const [stream, strategy] of [
    ["accounts", "full_inventory"],
    ["payee_locations", "full_inventory"],
    ["scheduled_transactions", "full_inventory"],
  ] as const) {
    const verdict = coherenceFor(messages, stream, strategy);
    assert.equal(verdict.proven, false, `${stream}: zero budgets must not read as proven`);
  }
});

test("ynabCollect: established zero streams prove empty only after a fresh provider traversal", async () => {
  const fixtures: BudgetFixture[] = [{ id: BUDGET_A }];
  const { request, knowledgeSeenFor, requestsFor } = fakeRequest(fixtures);
  const priorState = {
    categories: { [BUDGET_A]: { server_knowledge: 10 } },
    payees: { [BUDGET_A]: { server_knowledge: 20 } },
    transactions: { [BUDGET_A]: { server_knowledge: 30, since_date: "2026-01-01" } },
    months: { [BUDGET_A]: { server_knowledge: 40 } },
    month_categories: { [BUDGET_A]: { last_fetched_month: "2026-07-01" } },
    scheduled_transactions: { [BUDGET_A]: { server_knowledge: 50 } },
  };
  const streams = [
    "category_groups",
    "categories",
    "payees",
    "transactions",
    "scheduled_transactions",
    "months",
    "month_categories",
  ];
  const { ctx, messages } = makeCtx(streams, priorState);

  await ynabCollect(ctx, request);

  for (const stream of streams) {
    const coverage = coverageFor(messages, stream);
    assert.ok(coverage, `${stream}: successful full traversal emits zero proof`);
    assert.equal(coverage?.considered, 0, `${stream}: provider returned an empty inventory`);
    assert.equal(coverage?.covered, 0, `${stream}: empty inventory is fully covered`);
    assert.equal(coherenceFor(messages, stream, "full_inventory").proven, true, `${stream}: zero is proven`);
  }
  assert.equal(knowledgeSeenFor(`/budgets/${BUDGET_A}/categories`), undefined);
  assert.equal(knowledgeSeenFor(`/budgets/${BUDGET_A}/payees`), undefined);
  assert.equal(knowledgeSeenFor(`/budgets/${BUDGET_A}/transactions`), undefined);
  assert.equal(knowledgeSeenFor(`/budgets/${BUDGET_A}/months`), undefined);
  assert.equal(knowledgeSeenFor(`/budgets/${BUDGET_A}/scheduled_transactions`), undefined);
  assert.deepEqual(requestsFor(`/budgets/${BUDGET_A}/categories`), [10, undefined]);
  assert.deepEqual(requestsFor(`/budgets/${BUDGET_A}/payees`), [20, undefined]);
  assert.deepEqual(requestsFor(`/budgets/${BUDGET_A}/transactions`), [30, undefined]);
  assert.deepEqual(requestsFor(`/budgets/${BUDGET_A}/months`), [40, undefined]);
  assert.deepEqual(requestsFor(`/budgets/${BUDGET_A}/scheduled_transactions`), [50, undefined]);
});

test("ynabCollect: a nonempty prior-cursor delta stays incremental", async () => {
  const fixtures: BudgetFixture[] = [{ id: BUDGET_A, scheduledTransactions: [scheduledTxn(SCHEDULED_1)] }];
  const { request, requestsFor } = fakeRequest(fixtures);
  const { ctx, messages } = makeCtx(["scheduled_transactions"], {
    scheduled_transactions: { [BUDGET_A]: { server_knowledge: 50 } },
  });

  await ynabCollect(ctx, request);

  assert.deepEqual(requestsFor(`/budgets/${BUDGET_A}/scheduled_transactions`), [50]);
  const coverage = coverageFor(messages, "scheduled_transactions");
  assert.equal(coverage?.considered, 1);
  assert.equal(coverage?.covered, 1);
});

// ─── Malformed row: covered must fall short of considered, never overclaim ─

test("ynabCollect: a malformed account/payee_location row leaves covered < considered, never silently aliased to the raw count", async () => {
  const fixtures: BudgetFixture[] = [
    {
      id: BUDGET_A,
      // Second account has a non-UUID id: validateRecord rejects it, the
      // runtime's real emitRecord SKIPs it, and it must NOT be counted as
      // covered even though the API "considered" it.
      accounts: [account(ACCOUNT_1), account("not-a-uuid")],
      payeeLocations: [payeeLocation(PAYEE_LOC_1, PAYEE_1), payeeLocation("also-not-a-uuid", PAYEE_1)],
      scheduledTransactions: [],
    },
  ];
  const { request } = fakeRequest(fixtures);
  const { ctx, messages } = makeCtx(["accounts", "payee_locations"]);
  await ynabCollect(ctx, request);

  const accountsCov = coverageFor(messages, "accounts");
  assert.ok(accountsCov);
  assert.equal(accountsCov?.considered, 2, "both rows were in the API response");
  assert.equal(accountsCov?.covered, 1, "only the valid row is covered — never aliased to the raw count of 2");

  const payeeLocCov = coverageFor(messages, "payee_locations");
  assert.ok(payeeLocCov);
  assert.equal(payeeLocCov?.considered, 2);
  assert.equal(payeeLocCov?.covered, 1);

  // `full_inventory` is a window-bounding strategy for an ABSENT `covered`
  // count: once `considered` is measured and the checkpoint closes without
  // an explicit numerator, evaluateStreamCoherence proves the ENUMERATED
  // BOUNDARY on `collected` alone, because a closed window's `collected` may
  // legitimately read below `considered` for suppressed-unchanged rows (see
  // reference-contract/test/evidence-coherence.test.ts "a closed window
  // proves its measured boundary despite a changed-record-only collected
  // count"). That does NOT extend to an EXPLICIT `covered` numerator: when
  // the connector supplies one (as YNAB always does — see
  // AccountsBudgetFact's doc comment), it is a coverage numerator regardless
  // of strategy, so `covered: 1 < considered: 2` here is a genuine
  // boundary_shortfall — the window closing does not launder it, unlike an
  // absent-covered run. This is the exact real-world shape the
  // coverage-oracle covered-count fix exists to catch (a real YNAB
  // multi-budget run undercounting `account_stats`/`accounts`).
  const accountsVerdict = coherenceFor(messages, "accounts", "full_inventory");
  assert.equal(
    accountsVerdict.proven,
    false,
    "an explicit covered shortfall is a real gap, not proven by a closed window"
  );
  assert.equal(accountsVerdict.reason, "boundary_shortfall");

  const payeeLocVerdict = coherenceFor(messages, "payee_locations", "full_inventory");
  assert.equal(payeeLocVerdict.proven, false);
  assert.equal(payeeLocVerdict.reason, "boundary_shortfall");
});

// ─── Steady-state connection: accounts/account_stats must keep proving
//     coverage on every run, not just the connection's first ever run ─────
//
// `/accounts` never returns a total-boundary count on its own — a
// `server_knowledge`-scoped call only returns changed rows — so
// `collectAccounts` never sends `knowledge` at all (mirroring
// `payee_locations`/`scheduled_transactions`, and `collectTransactions`'s own
// unconditional `/accounts` refetch): every call walks the full account list,
// which the API returns just as reliably as a delta payload for this
// small, per-budget-single-request endpoint (see `collectScheduledTransactions`'s
// "One request per budget" comment for the same reasoning applied to that
// endpoint — accounts is one request per budget regardless of whether it
// requests a delta). This is what makes `accounts`/`account_stats` provable
// on EVERY run, not just the first — matching manifest.json's declared
// `full_inventory` strategy, which the shared coherence oracle
// (coherence.ts) evaluates fresh per run with no "proven once, stays proven"
// concept. A live UAT connection (run #26 on the same connector instance)
// hit exactly this gap before the fix: `accounts`/`account_stats` fell back
// to checkpoint-only evidence forever after run 1.

test("ynabCollect: a run on an established (many-runs-old) connection still proves accounts/account_stats coverage, never sends a knowledge cursor to /accounts", async () => {
  const fixtures: BudgetFixture[] = [{ id: BUDGET_A, accounts: [account(ACCOUNT_1)] }];
  const { request, knowledgeSeenFor } = fakeRequest(fixtures);

  // First run: fresh (no prior state) — proves the boundary and commits a
  // server_knowledge cursor (still recorded for other consumers of state,
  // even though collectAccounts itself no longer reads it back as a delta
  // scope).
  const first = makeCtx(["accounts", "account_stats"]);
  await ynabCollect(first.ctx, request);
  const firstCov = coverageFor(first.messages, "accounts");
  assert.ok(firstCov, "fresh run proves accounts coverage");
  assert.equal(firstCov?.considered, 1);

  const stateMsg = first.messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "accounts"
  );
  assert.ok(stateMsg, "fresh run commits an accounts STATE cursor");

  // Second run: reuse the persisted cursor, exactly as a long-running
  // connection's scheduler would. If `collectAccounts` still gated on
  // `knowledge === undefined`, this would be the incremental/non-fresh path
  // and coverage would silently stop being provable forever after.
  const second = makeCtx(["accounts", "account_stats"], { accounts: stateMsg.cursor as Record<string, unknown> });
  await ynabCollect(second.ctx, request);

  assert.equal(
    knowledgeSeenFor(`/budgets/${BUDGET_A}/accounts`),
    undefined,
    "collectAccounts must never send a knowledge cursor — /accounts is a full walk on every run, like payee_locations/scheduled_transactions"
  );

  const secondCov = coverageFor(second.messages, "accounts");
  assert.ok(secondCov, "a run on an established connection still proves accounts coverage");
  assert.equal(secondCov?.considered, 1);
  assert.equal(secondCov?.covered, 1);
  assert.ok(coverageFor(second.messages, "account_stats"), "account_stats also still proves coverage");

  const accountsVerdict = coherenceFor(second.messages, "accounts", "full_inventory");
  assert.equal(accountsVerdict.proven, true, "an established connection's run must still read as proven");
  assert.equal(accountsVerdict.reason, "enumeration_boundary");

  // Simulate a third run — the exact shape of the live UAT connection this
  // regression came from (dozens of runs deep). Coverage must still hold;
  // this is not a one-time "second run" exception.
  const thirdStateMsg = second.messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "accounts"
  );
  assert.ok(thirdStateMsg);
  const third = makeCtx(["accounts", "account_stats"], { accounts: thirdStateMsg.cursor as Record<string, unknown> });
  await ynabCollect(third.ctx, request);
  assert.ok(coverageFor(third.messages, "accounts"), "a third run on the same connection still proves coverage");
  const thirdVerdict = coherenceFor(third.messages, "accounts", "full_inventory");
  assert.equal(thirdVerdict.proven, true);
});

// ─── Full-walk semantics: an account absent from a later full list was
//     genuinely deleted, and its fingerprint must be pruned from committed
//     STATE ─────────────────────────────────────────────────────────────────
//
// This is only safe because `collectAccounts` never sends a `knowledge`
// cursor (see above) — a partial delta could never license a prune, since an
// id absent from a delta might just be unchanged, not deleted. Once every
// call is a full walk, an id genuinely missing this run MUST be dropped from
// `newState.accounts[budgetId].fingerprints`, or a future re-creation of the
// same id would silently no-op against the stale fingerprint instead of
// re-emitting. `collectAccounts` calls `entityCursor.pruneStale()` right
// before serializing `fingerprints` into STATE — this test proves that call
// is load-bearing by asserting the deleted account's fingerprint is actually
// gone from the second run's committed cursor, not just that the record
// wasn't re-emitted.

test("ynabCollect: an account present in run 1 and absent from run 2's full list is pruned from committed accounts STATE", async () => {
  const runOneFixtures: BudgetFixture[] = [{ id: BUDGET_A, accounts: [account(ACCOUNT_1), account(ACCOUNT_2)] }];
  const { request: requestOne } = fakeRequest(runOneFixtures);

  const first = makeCtx(["accounts"]);
  await ynabCollect(first.ctx, requestOne);

  const firstStateMsg = first.messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "accounts"
  );
  assert.ok(firstStateMsg, "run 1 commits an accounts STATE cursor");
  const firstCursor = firstStateMsg.cursor as Record<string, { fingerprints?: Record<string, string> }>;
  const firstFingerprints = firstCursor[BUDGET_A]?.fingerprints ?? {};
  assert.ok(ACCOUNT_1 in firstFingerprints, "run 1's committed STATE fingerprints ACCOUNT_1");
  assert.ok(ACCOUNT_2 in firstFingerprints, "run 1's committed STATE fingerprints ACCOUNT_2");

  // Run 2: the same budget's full account list now omits ACCOUNT_2 entirely
  // (closed and purged at the source, not merely marked `deleted: true`) —
  // the only way `/accounts` can signal a deletion on a full walk.
  const runTwoFixtures: BudgetFixture[] = [{ id: BUDGET_A, accounts: [account(ACCOUNT_1)] }];
  const { request: requestTwo } = fakeRequest(runTwoFixtures);

  const second = makeCtx(["accounts"], { accounts: firstStateMsg.cursor as Record<string, unknown> });
  await ynabCollect(second.ctx, requestTwo);

  const secondStateMsg = second.messages.find(
    (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "accounts"
  );
  assert.ok(secondStateMsg, "run 2 commits an accounts STATE cursor");
  const secondCursor = secondStateMsg.cursor as Record<string, { fingerprints?: Record<string, string> }>;
  const secondFingerprints = secondCursor[BUDGET_A]?.fingerprints ?? {};

  assert.ok(
    ACCOUNT_1 in secondFingerprints,
    "ACCOUNT_1 is still present this run, so its fingerprint must survive into committed STATE"
  );
  assert.ok(
    !(ACCOUNT_2 in secondFingerprints),
    "ACCOUNT_2 was absent from run 2's full list — pruneStale must remove its fingerprint from committed STATE, or a future re-creation of ACCOUNT_2 would silently no-op against the stale entry"
  );

  const secondCov = coverageFor(second.messages, "accounts");
  assert.equal(secondCov?.considered, 1, "run 2's boundary is 1 account — the deleted account is not double-counted");
});

// A dedicated "regression pin" test was deliberately NOT added as a separate
// scenario: the first test's `assert.ok(accountsCov)`/`assert.ok(payeeLocCov)`
// (and the loop asserting every required stream's coherence verdict) already
// fail hard if a future edit deletes the `emitDetailCoverage` call for any of
// these streams — a second `ynabCollect` invocation to re-prove the identical
// fact would add fake-fixture calls without adding coverage. Each
// `ynabCollect` call below is real production orchestration end to end, with
// only the `request` boundary faked; this file intentionally keeps their
// count to the minimum the distinct scenarios (fresh/zero/malformed/
// incremental) require.
