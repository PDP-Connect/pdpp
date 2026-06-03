/**
 * Per-row fingerprint behavior for the Chase `current_activity` stream.
 *
 * Before this gate, `emitCurrentActivityForAccount` appended a fresh version
 * of every still-listed dashboard activity row on every run because the
 * record body carried a run-clock `fetched_at: deps.emittedAt`, and the
 * dashboard overview re-renders the same recent rows each run. A row keyed by
 * a stable `ui_transaction_id` is otherwise immutable until it transitions
 * pending → posted, so the only field that moved between byte-identical runs
 * was `fetched_at`.
 *
 * These tests pin:
 *
 *   1. Re-rendering the same rows (only fetched_at differs) is fully
 *      suppressed on the second run.
 *   2. A genuine pending → posted transition on a stable `ui_transaction_id`
 *      (status / posted_date move) re-emits.
 *   3. NO prune: a row dropped from a narrower later overview keeps its
 *      fingerprint, so when it scrolls back into the recent window it stays
 *      suppressed — the partial-scan invariant. (Contrast with
 *      accounts/statements, which DO prune because they are full scans.)
 *   4. The current_activity STATE carries the `fingerprints` map and it
 *      excludes `fetched_at`; a zero-row run (ambiguous multi-account
 *      overview) carries the prior fingerprints forward unchanged.
 *   5. `readPriorCurrentActivityFingerprints` tolerates missing / legacy /
 *      malformed state.
 *   6. Legacy callers without a cursor emit unconditionally.
 *   7. Connector fingerprint (excludes fetched_at) == compaction fingerprint
 *      over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import {
  type EmitDeps,
  emitCurrentActivityForAccount,
  readPriorCurrentActivityFingerprints,
  runCurrentActivity,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { ChaseAccount } from "./types.ts";

const FROZEN_EMITTED_AT_1 = "2026-06-01T10:00:00.000Z";
const FROZEN_EMITTED_AT_2 = "2026-06-02T10:00:00.000Z";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "__fixtures__");

const ACCOUNT: ChaseAccount = {
  internal_id: "INTACC123",
  last_four: "9241",
  name: "Sapphire Preferred",
  type: "credit_card",
};

/** The committed minimal fixture: a pending row keyed by ui_transaction_id
 *  (`txn_20260514_A1`) and a posted, fallback-keyed row. */
function minimalHtml(): string {
  return readFileSync(join(FIXTURE_DIR, "current-activity-minimal.html"), "utf8");
}

/** Same two rows, but the pending Whole Foods row has now POSTED — same
 *  ui_transaction_id, so the id is stable but status / posted_date move. */
function postedHtml(): string {
  return `<!doctype html>
<html>
  <body>
    <section aria-label="Account activity">
      <div data-testid="transaction-row" data-transaction-id="txn_20260514_A1">
        <span>Posted</span>
        <span>05/14/2026</span>
        <span>Whole Foods Market</span>
        <span>-$42.17</span>
      </div>
      <div data-testid="activity-row">
        <span>Posted</span>
        <span>05/13/2026</span>
        <span>ACH Deposit Payroll</span>
        <span>$1,250.00</span>
      </div>
    </section>
  </body>
</html>`;
}

function makeDeps(
  emittedAt: string,
  currentActivityFingerprintCursor?: FingerprintCursor
): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    capture: null,
    currentActivityFingerprintCursor,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt,
    maxSeenByAccount: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map<string, StreamScope>([["current_activity", { name: "current_activity" }]]),
    resFilters: new Map(),
    tmpDir: "/tmp/chase-test",
    txState: {},
    wantsAccounts: false,
    wantsBalances: false,
    wantsCurrentActivity: true,
    wantsStatements: false,
    wantsTransactions: false,
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

/** Pull the current_activity STATE in the `{ current_activity: cursor }`
 *  shape the next run reads. */
function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "current_activity").at(-1);
  return { current_activity: (state as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };
}

function openCursorFrom(state: Record<string, unknown>): FingerprintCursor {
  return openFingerprintCursor(state.current_activity, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorCurrentActivityFingerprints(state),
  });
}

test("current_activity: re-rendering the same rows (only fetched_at differs) is fully suppressed", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await runCurrentActivity(run1.deps, minimalHtml(), [ACCOUNT]);
  assert.equal(
    run1.emitted.filter((r) => r.stream === "current_activity").length,
    2,
    "first run emits both activity rows once"
  );

  const priorState = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(priorState);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  await runCurrentActivity(run2.deps, minimalHtml(), [ACCOUNT]);
  assert.equal(
    run2.emitted.filter((r) => r.stream === "current_activity").length,
    0,
    "re-rendered unchanged rows fully suppressed despite new fetched_at"
  );
});

test("current_activity: a pending → posted transition on a stable ui_transaction_id re-emits", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await runCurrentActivity(run1.deps, minimalHtml(), [ACCOUNT]);

  const priorState = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(priorState);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  // The Whole Foods row (ui_transaction_id txn_20260514_A1) has POSTED; the
  // payroll row is byte-identical. Only the transitioned row re-emits.
  await runCurrentActivity(run2.deps, postedHtml(), [ACCOUNT]);
  const reemitted = run2.emitted.filter((r) => r.stream === "current_activity");
  assert.equal(reemitted.length, 1, "only the pending→posted row re-emits; the unchanged payroll row stays silent");
  assert.equal((reemitted[0]?.data as { id: string }).id, `${ACCOUNT.internal_id}|txn_20260514_A1`);
  assert.equal((reemitted[0]?.data as { status: string }).status, "posted");
  assert.equal((reemitted[0]?.data as { posted_date: string }).posted_date, "2026-05-14");
});

test("current_activity: NO prune — a row dropped from a narrower overview keeps its fingerprint", async () => {
  // Run 1: overview shows both rows.
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await runCurrentActivity(run1.deps, minimalHtml(), [ACCOUNT]);

  // Run 2: overview scrolled — only the payroll row is still listed. The
  // Whole Foods row must NOT be pruned: its fingerprint must survive.
  const onlyPayrollHtml = `<!doctype html>
<html>
  <body>
    <section aria-label="Account activity">
      <div data-testid="activity-row">
        <span>Posted</span>
        <span>05/13/2026</span>
        <span>ACH Deposit Payroll</span>
        <span>$1,250.00</span>
      </div>
    </section>
  </body>
</html>`;
  const state2 = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(state2);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  await runCurrentActivity(run2.deps, onlyPayrollHtml, [ACCOUNT]);
  assert.equal(
    run2.emitted.filter((r) => r.stream === "current_activity").length,
    0,
    "payroll unchanged stays silent; Whole Foods row not looked at this run"
  );

  // Run 3: overview shows both rows again. Because the Whole Foods row was
  // never pruned, its fingerprint survived run 2 and its re-render is
  // suppressed.
  const state3 = nextStateFrom(run2.messages);
  const cursor3 = openCursorFrom(state3);
  const run3 = makeDeps(FROZEN_EMITTED_AT_2, cursor3);
  await runCurrentActivity(run3.deps, minimalHtml(), [ACCOUNT]);
  assert.equal(
    run3.emitted.filter((r) => r.stream === "current_activity").length,
    0,
    "re-rendered Whole Foods row stays suppressed because it was never pruned"
  );
});

test("current_activity: STATE carries a fetched_at-excluding fingerprints map", async () => {
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run = makeDeps(FROZEN_EMITTED_AT_1, cursor);
  await runCurrentActivity(run.deps, minimalHtml(), [ACCOUNT]);

  const fps = readPriorCurrentActivityFingerprints(nextStateFrom(run.messages));
  assert.equal(fps.size, 2, "both row fingerprints persisted");
  assert.ok(
    fps.get(`${ACCOUNT.internal_id}|txn_20260514_A1`),
    "keyed by account_id|ui_transaction_id for the pending row"
  );
});

test("current_activity: a zero-row run carries prior fingerprints forward unchanged (no prune)", async () => {
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const run1 = makeDeps(FROZEN_EMITTED_AT_1, cursor1);
  await runCurrentActivity(run1.deps, minimalHtml(), [ACCOUNT]);
  const before = readPriorCurrentActivityFingerprints(nextStateFrom(run1.messages));
  assert.equal(before.size, 2);

  // Ambiguous multi-account overview: zero rows emitted, but the prior
  // fingerprints must survive so a later single-account run does not
  // re-churn the rows.
  const state2 = nextStateFrom(run1.messages);
  const cursor2 = openCursorFrom(state2);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2, cursor2);
  await runCurrentActivity(run2.deps, minimalHtml(), [ACCOUNT, { ...ACCOUNT, internal_id: "INTACC456" }]);
  assert.equal(
    run2.emitted.filter((r) => r.stream === "current_activity").length,
    0,
    "ambiguous multi-account overview emits no rows"
  );
  const after = readPriorCurrentActivityFingerprints(nextStateFrom(run2.messages));
  assert.equal(after.size, 2, "prior fingerprints carried forward unchanged across the zero-row run");
});

test("readPriorCurrentActivityFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorCurrentActivityFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorCurrentActivityFingerprints({ current_activity: { fetched_at: "2026-06-01T00:00:00Z" } }).size,
    0,
    "legacy cursor (fetched_at only, no fingerprints) → empty map"
  );
  assert.equal(
    readPriorCurrentActivityFingerprints({ current_activity: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const nested = readPriorCurrentActivityFingerprints({
    current_activity: { fingerprints: { "A|txn1": "fp-1", bad: null } },
  });
  assert.equal(nested.size, 1, "valid entries kept, invalid dropped");
});

test("current_activity: legacy callers without a cursor still emit unconditionally", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  await emitCurrentActivityForAccount(run.deps, ACCOUNT, minimalHtml());
  assert.equal(run.emitted.filter((r) => r.stream === "current_activity").length, 2, "no cursor → emits all rows");
});

test("current_activity: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
  const body = {
    id: "INTACC123|txn_20260514_A1",
    account_id: "INTACC123",
    account_name: "Sapphire Preferred",
    status: "pending",
    activity_date: "2026-05-14",
    posted_date: null,
    amount: -4217,
    currency: "USD",
    description: "Whole Foods Market",
    memo: null,
    ui_transaction_id: "txn_20260514_A1",
    source: "chase_activity_ui",
    fetched_at: FROZEN_EMITTED_AT_1,
  };
  const later = { ...body, fetched_at: FROZEN_EMITTED_AT_2 };
  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(later, ["fetched_at"]),
    "fetched_at must not participate; both runs hash identically"
  );
});
