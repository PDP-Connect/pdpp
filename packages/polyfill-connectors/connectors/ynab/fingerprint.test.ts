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
import { openPayeeLocationCursor, payeeLocationRecord } from "./index.ts";

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
