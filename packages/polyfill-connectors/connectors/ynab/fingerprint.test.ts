// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * YNAB-level integration of the shared per-record fingerprint cursor for
 * `payee_locations`. Exhaustive helper behavior is covered in
 * `src/fingerprint-cursor.test.ts`; this file pins the YNAB-specific
 * wiring:
 *
 *   1. Two identical passes emit each location exactly once total — the
 *      load-bearing assertion for the live churn case (77 keys × 270
 *      versions in the 2026-05-26 report).
 *   2. A real source-field change re-emits only the changed record.
 *   3. State carry-forward survives a no-op pass — a location skipped
 *      this run still surfaces in the next STATE write.
 *   4. Multi-budget owners get per-budget cursor isolation; budget-A's
 *      fingerprint map never gates budget-B's locations.
 *   5. Locations that disappear from the source are pruned, so a future
 *      re-creation triggers a fresh emit instead of silently no-opping.
 *   6. Legacy / malformed prior state is tolerated and yields a single
 *      full re-emit pass.
 *
 * The gate is `openPayeeLocationCursor` + `payeeLocationRecord`; the
 * production caller (`collectPayeeLocations`) wraps the same calls
 * around a `fetch`. Testing the gate directly keeps the test seam pure
 * and matches the Slack `fingerprint.test.ts` pattern.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordData } from "../../src/connector-runtime.ts";
import { budgetRecord, openBudgetCursor, openPayeeLocationCursor, payeeLocationRecord } from "./index.ts";

interface PayeeLocationInput {
  deleted: boolean;
  id: string;
  latitude: string;
  longitude: string;
  payee_id: string;
}

function loc(overrides: Partial<PayeeLocationInput> = {}): PayeeLocationInput {
  return {
    deleted: false,
    id: "L1",
    latitude: "47.6062",
    longitude: "-122.3321",
    payee_id: "P1",
    ...overrides,
  };
}

interface PassResult {
  emitted: RecordData[];
  state: Record<string, unknown>;
}

/**
 * Drive a single pass: build records, gate through the cursor, prune,
 * and return the records that would have been emitted plus the next
 * STATE shape this pass would have written.
 */
function runPass(
  priorState: Record<string, unknown>,
  budgetId: string,
  locations: readonly PayeeLocationInput[]
): PassResult {
  const cursor = openPayeeLocationCursor(priorState, budgetId);
  const emitted: RecordData[] = [];
  for (const l of locations) {
    const record = payeeLocationRecord(l, budgetId);
    if (cursor.shouldEmit(record)) {
      emitted.push(record);
    }
  }
  cursor.pruneStale();
  const priorPayeeLocs = priorState.payee_locations;
  const carry: Record<string, { fingerprints?: Record<string, string> }> =
    priorPayeeLocs && typeof priorPayeeLocs === "object" && !Array.isArray(priorPayeeLocs)
      ? { ...(priorPayeeLocs as Record<string, { fingerprints?: Record<string, string> }>) }
      : {};
  carry[budgetId] = { fingerprints: cursor.toState() };
  return { emitted, state: { ...priorState, payee_locations: carry } };
}

test("two identical passes emit each location exactly once — load-bearing churn fix", () => {
  const locations = [
    loc({ id: "L1", payee_id: "P1" }),
    loc({ id: "L2", payee_id: "P2", latitude: "40.7128", longitude: "-74.0060" }),
    loc({ id: "L3", payee_id: "P3", latitude: "34.0522", longitude: "-118.2437" }),
  ];

  const run1 = runPass({}, "budget-A", locations);
  assert.equal(run1.emitted.length, 3, "first run emits every location");

  const run2 = runPass(run1.state, "budget-A", locations);
  assert.equal(run2.emitted.length, 0, "second run with unchanged source emits nothing");

  const run3 = runPass(run2.state, "budget-A", locations);
  assert.equal(run3.emitted.length, 0, "subsequent runs continue to no-op");
});

test("real source-field change re-emits only the changed location", () => {
  const original = [loc({ id: "L1" }), loc({ id: "L2", payee_id: "P2" })];
  const run1 = runPass({}, "budget-A", original);
  assert.equal(run1.emitted.length, 2);

  // L2's payee_id changes upstream (re-association); L1 is untouched.
  const changed = [loc({ id: "L1" }), loc({ id: "L2", payee_id: "P-renamed" })];
  const run2 = runPass(run1.state, "budget-A", changed);
  assert.equal(run2.emitted.length, 1, "only the changed location re-emits");
  assert.equal(run2.emitted[0]?.id, "L2");
});

test("carry-forward: a skipped location remains in next STATE so a third run still no-ops", () => {
  const locations = [loc({ id: "L1" }), loc({ id: "L2" })];
  const run1 = runPass({}, "budget-A", locations);
  const run2 = runPass(run1.state, "budget-A", locations);

  const after2 = (run2.state.payee_locations as Record<string, { fingerprints?: Record<string, string> }>)["budget-A"]
    ?.fingerprints;
  assert.ok(after2);
  assert.equal(Object.keys(after2).length, 2, "both ids carried forward despite zero emits this run");

  const run3 = runPass(run2.state, "budget-A", locations);
  assert.equal(run3.emitted.length, 0, "third no-op pass still emits zero");
});

test("multi-budget: per-budget cursor isolation — budget-A does not gate budget-B", () => {
  const aLocations = [loc({ id: "L1", payee_id: "P-A" })];
  const bLocations = [loc({ id: "L1", payee_id: "P-B" })];

  // Seed: budget-A has L1 known; budget-B has nothing.
  const seedA = runPass({}, "budget-A", aLocations);

  // Second pass against budget-B with shared id "L1" — must emit even
  // though budget-A already wrote a fingerprint for "L1". Cross-budget
  // contamination would cause budget-B's first run to silently skip the
  // record.
  const runB = runPass(seedA.state, "budget-B", bLocations);
  assert.equal(runB.emitted.length, 1, "budget-B emits its own L1 despite budget-A having one");

  // Budget-A's fingerprint map survives the budget-B write.
  const aAfter = (runB.state.payee_locations as Record<string, { fingerprints?: Record<string, string> }>)["budget-A"]
    ?.fingerprints;
  assert.ok(aAfter);
  assert.equal(Object.keys(aAfter).length, 1, "budget-A fingerprint preserved");
});

test("prune: a location that disappears from the source is dropped from the next cursor", () => {
  const seeded = [loc({ id: "L1" }), loc({ id: "L2" })];
  const run1 = runPass({}, "budget-A", seeded);

  // L2 deleted at the source between runs.
  const reduced = [loc({ id: "L1" })];
  const run2 = runPass(run1.state, "budget-A", reduced);
  assert.equal(run2.emitted.length, 0, "remaining L1 is unchanged — no emit");

  const fps = (run2.state.payee_locations as Record<string, { fingerprints?: Record<string, string> }>)["budget-A"]
    ?.fingerprints;
  assert.ok(fps);
  assert.equal(fps.L1 !== undefined, true);
  assert.equal(fps.L2, undefined, "deleted source row pruned from cursor");

  // If L2 is recreated upstream later, the next run must emit it again
  // rather than no-op against a stale carried-forward fingerprint.
  const recreated = [loc({ id: "L1" }), loc({ id: "L2" })];
  const run3 = runPass(run2.state, "budget-A", recreated);
  assert.equal(run3.emitted.length, 1, "resurrected L2 re-emits");
  assert.equal(run3.emitted[0]?.id, "L2");
});

test("legacy / malformed prior state is tolerated and yields one full re-emit", () => {
  const locations = [loc({ id: "L1" }), loc({ id: "L2" })];

  // Legacy: payee_locations key present, per-budget entry empty.
  const legacy1 = runPass({ payee_locations: { "budget-A": {} } }, "budget-A", locations);
  assert.equal(legacy1.emitted.length, 2, "empty per-budget entry → full re-emit");

  // Legacy: fingerprints value is the wrong shape (array). Must not throw.
  const legacy2 = runPass(
    { payee_locations: { "budget-A": { fingerprints: ["bogus"] } } } as Record<string, unknown>,
    "budget-A",
    locations
  );
  assert.equal(legacy2.emitted.length, 2, "malformed fingerprints shape → full re-emit");

  // Legacy: malformed individual entries dropped silently.
  const partial = runPass(
    {
      payee_locations: {
        "budget-A": {
          fingerprints: {
            L1: 42, // wrong type — dropped → L1 re-emits
            L2: "", // empty — dropped → L2 re-emits
          },
        },
      },
    } as Record<string, unknown>,
    "budget-A",
    locations
  );
  assert.equal(partial.emitted.length, 2, "all malformed entries treated as missing");
});

// ─── budgets ──────────────────────────────────────────────────────────────
//
// `/budgets` is a single full-collection fetch with no server_knowledge
// delta, so every run re-returns every budget. Without the gate each run
// appended a new version per budget (~273/budget in the 2026-05-26 churn
// report). The fingerprint excludes `last_month` and `last_modified_on`
// because YNAB advances both without a corresponding change to the
// budget-summary fields this stream projects.

interface BudgetInput {
  currency_format?: {
    iso_code?: string | null;
    currency_symbol?: string | null;
    symbol_first?: boolean | null;
    decimal_digits?: number | null;
    decimal_separator?: string | null;
    group_separator?: string | null;
  } | null;
  date_format?: { format?: string | null } | null;
  first_month?: string | null;
  id: string;
  last_modified_on?: string | null;
  last_month?: string | null;
  name: string;
}

function budget(overrides: Partial<BudgetInput> = {}): BudgetInput {
  return {
    id: "B1",
    name: "My Budget",
    last_modified_on: "2026-01-01T00:00:00+00:00",
    first_month: "2024-01-01",
    last_month: "2026-01-01",
    currency_format: {
      iso_code: "USD",
      currency_symbol: "$",
      symbol_first: true,
      decimal_digits: 2,
      decimal_separator: ".",
      group_separator: ",",
    },
    date_format: { format: "MM/DD/YYYY" },
    ...overrides,
  };
}

interface BudgetPassResult {
  emitted: RecordData[];
  state: Record<string, unknown>;
}

/**
 * Drive a single `budgets` pass: gate every budget through the cursor,
 * prune, and return what would have been emitted plus the next STATE shape.
 * Mirrors the production caller in `index.ts`.
 */
function runBudgetPass(priorState: Record<string, unknown>, budgets: readonly BudgetInput[]): BudgetPassResult {
  const cursor = openBudgetCursor(priorState);
  const emitted: RecordData[] = [];
  for (const b of budgets) {
    const record = budgetRecord(b);
    if (cursor.shouldEmit(record)) {
      emitted.push(record);
    }
  }
  cursor.pruneStale();
  return {
    emitted,
    state: { ...priorState, budgets: { fetched_at: "2026-01-01T00:00:00.000Z", fingerprints: cursor.toState() } },
  };
}

test("budgets: two identical passes emit each budget exactly once — load-bearing churn fix", () => {
  const budgets = [budget({ id: "B1", name: "Personal" }), budget({ id: "B2", name: "Business" })];

  const run1 = runBudgetPass({}, budgets);
  assert.equal(run1.emitted.length, 2, "first run emits every budget");

  const run2 = runBudgetPass(run1.state, budgets);
  assert.equal(run2.emitted.length, 0, "second run with unchanged source emits nothing");

  const run3 = runBudgetPass(run2.state, budgets);
  assert.equal(run3.emitted.length, 0, "subsequent runs continue to no-op");
});

test("budgets: last_month calendar rollover does NOT re-emit", () => {
  const initial = [budget({ id: "B1", last_month: "2026-01-01" })];
  const run1 = runBudgetPass({}, initial);
  assert.equal(run1.emitted.length, 1);

  // The 1st of the next month: YNAB advances last_month automatically with
  // no user edit to any emitted budget-summary field.
  const rolled = [budget({ id: "B1", last_month: "2026-02-01" })];
  const run2 = runBudgetPass(run1.state, rolled);
  assert.equal(run2.emitted.length, 0, "calendar rollover of last_month is not a budget change");
});

test("budgets: last_modified_on tick alone does NOT re-emit", () => {
  const initial = [budget({ id: "B1", last_modified_on: "2026-01-01T00:00:00+00:00" })];
  const run1 = runBudgetPass({}, initial);
  assert.equal(run1.emitted.length, 1);

  // A transaction or category edit elsewhere in the budget bumps
  // last_modified_on but changes none of the emitted budget-summary fields.
  const touched = [budget({ id: "B1", last_modified_on: "2026-03-15T12:34:56+00:00" })];
  const run2 = runBudgetPass(run1.state, touched);
  assert.equal(run2.emitted.length, 0, "last_modified_on tick without a summary-field change is a no-op");
});

test("budgets: a real summary-field change re-emits only the changed budget", () => {
  const original = [budget({ id: "B1", name: "Personal" }), budget({ id: "B2", name: "Business" })];
  const run1 = runBudgetPass({}, original);
  assert.equal(run1.emitted.length, 2);

  // B1 is renamed (a genuine budget-summary edit); B2 is untouched.
  const renamed = [budget({ id: "B1", name: "Household" }), budget({ id: "B2", name: "Business" })];
  const run2 = runBudgetPass(run1.state, renamed);
  assert.equal(run2.emitted.length, 1, "only the renamed budget re-emits");
  assert.equal(run2.emitted[0]?.id, "B1");
});

test("budgets: a currency-locale change re-emits the budget", () => {
  const original = [budget({ id: "B1", currency_format: { iso_code: "USD", currency_symbol: "$" } })];
  const run1 = runBudgetPass({}, original);
  assert.equal(run1.emitted.length, 1);

  const reCurrencied = [budget({ id: "B1", currency_format: { iso_code: "EUR", currency_symbol: "€" } })];
  const run2 = runBudgetPass(run1.state, reCurrencied);
  assert.equal(run2.emitted.length, 1, "currency change is a real source fact and re-emits");
});

test("budgets: carry-forward keeps a skipped budget gated across a third run", () => {
  const budgets = [budget({ id: "B1" }), budget({ id: "B2" })];
  const run1 = runBudgetPass({}, budgets);
  const run2 = runBudgetPass(run1.state, budgets);

  const fps = (run2.state.budgets as { fingerprints?: Record<string, string> }).fingerprints;
  assert.ok(fps);
  assert.equal(Object.keys(fps).length, 2, "both ids carried forward despite zero emits this run");

  const run3 = runBudgetPass(run2.state, budgets);
  assert.equal(run3.emitted.length, 0, "third no-op pass still emits zero");
});

test("budgets: a budget that disappears from the source is pruned and re-emits if resurrected", () => {
  const seeded = [budget({ id: "B1" }), budget({ id: "B2" })];
  const run1 = runBudgetPass({}, seeded);

  // B2 removed at the source (budget deleted / collaboration ended).
  const reduced = [budget({ id: "B1" })];
  const run2 = runBudgetPass(run1.state, reduced);
  assert.equal(run2.emitted.length, 0, "remaining B1 is unchanged — no emit");

  const fps = (run2.state.budgets as { fingerprints?: Record<string, string> }).fingerprints;
  assert.ok(fps);
  assert.equal(fps.B1 !== undefined, true);
  assert.equal(fps.B2, undefined, "disappeared budget pruned from cursor");

  const recreated = [budget({ id: "B1" }), budget({ id: "B2" })];
  const run3 = runBudgetPass(run2.state, recreated);
  assert.equal(run3.emitted.length, 1, "resurrected B2 re-emits");
  assert.equal(run3.emitted[0]?.id, "B2");
});

test("budgets: legacy state with only fetched_at (no fingerprints) yields one full re-emit", () => {
  const budgets = [budget({ id: "B1" }), budget({ id: "B2" })];

  // Pre-fingerprint cursor shape: { fetched_at } with no fingerprints key.
  const legacy = runBudgetPass({ budgets: { fetched_at: "2025-12-31T00:00:00.000Z" } }, budgets);
  assert.equal(legacy.emitted.length, 2, "legacy fetched_at-only state → full re-emit");

  // After the first run the fingerprints are seeded, so the next run no-ops.
  const next = runBudgetPass(legacy.state, budgets);
  assert.equal(next.emitted.length, 0, "subsequent run no-ops once fingerprints exist");
});
