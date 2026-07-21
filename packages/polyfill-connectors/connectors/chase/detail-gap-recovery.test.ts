/**
 * Chase served-gap recovery: DETAIL_GAP_RECOVERED for reached account gaps.
 *
 * When the runtime serves the Chase connector a pending per-account
 * `DETAIL_GAP` at START (`ctx.detailGaps`), Chase re-enumerates and re-downloads
 * every in-scope account anyway, so the served account is hydrated by the normal
 * QFX pass. The missing step this suite pins is the acknowledgement: on a
 * successful (or source-limited no-activity) outcome for a served account, the
 * connector emits `DETAIL_GAP_RECOVERED` with the served `gap_id`, so the
 * durable `connector_detail_gaps` row moves to `recovered` instead of being
 * reset to `pending` by runtime cleanup.
 *
 * These exercise the exported recovery helpers directly through the recording
 * harness (the same pattern detail-coverage.test.ts uses) so they validate the
 * emitted protocol messages without driving Playwright. The account is treated
 * as reached exactly when `emitTransactionsDetailCoverage` would count it as a
 * `hydrated_key`, keeping recovery and coverage in lockstep.
 *
 * Safety pinned here (lose-no-data):
 *   - only a served gap whose account was reached is recovered;
 *   - a served gap whose account still FAILS this run is never recovered
 *     (it stays on the DETAIL_GAP re-emit path → runtime resets to pending);
 *   - a served gap whose account is not enumerated this run is never recovered;
 *   - the recovery gap_id is always the served gap_id, never synthesized;
 *   - only account-level chase.account transaction gaps are recovered — a
 *     foreign or malformed served gap is ignored.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DetailGapStartEntry, EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type AccountDetailOutcome,
  buildServedAccountGapLookup,
  type EmitDeps,
  recoverServedAccountGaps,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { TransactionCursor, TransactionsStateShape } from "./types.ts";

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

interface HarnessOverrides {
  maxSeenByAccount?: Record<string, TransactionCursor>;
  requestedStreams?: readonly StreamScope[];
  resFilters?: Map<string, ReadonlySet<string> | null>;
  servedAccountGaps?: ReadonlyMap<string, string>;
  txState?: TransactionsStateShape;
  wantsAccounts?: boolean;
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
    tmpDir: "/tmp/pdpp-chase-test-noop",
    txState: overrides.txState ?? {},
    wantsAccounts: overrides.wantsAccounts ?? true,
    wantsBalances: true,
    wantsCurrentActivity: false,
    wantsStatements: false,
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
    // wrong stream
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
