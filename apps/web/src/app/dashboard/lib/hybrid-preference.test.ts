/**
 * Unit tests for hybrid retrieval preference decision logic.
 *
 * These tests cover the pure decision gate that searchRecords() implements:
 *   - Prefer hybrid when advertised (first page only)
 *   - Fall back to lexical+semantic blend when hybrid is absent
 *   - Fall back to lexical-only when neither hybrid nor semantic passes the gate
 *   - Hybrid is skipped on pages 2+ (cursor present) regardless of advertisement
 *
 * The tests are pure: they do not import server-only modules or make network
 * calls. They pin the decision invariant that the page.tsx searchRecords()
 * function is expected to satisfy.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shouldAttemptSemanticUplift } from "pdpp-reference-implementation/deployment-diagnostics";

// ─── Decision gate: hybrid preference ────────────────────────────────────────
//
// Mirrors the gate embedded in searchRecords() in page.tsx. Pure function
// extracted here for direct testing without importing server-only code.

interface HybridPreferenceInput {
  readonly cursor: string | null;
  readonly hybridAdvertised: boolean;
}

function shouldAttemptHybrid(input: HybridPreferenceInput): boolean {
  return input.hybridAdvertised && input.cursor === null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("hybrid is preferred when advertised on first page", () => {
  assert.equal(shouldAttemptHybrid({ hybridAdvertised: true, cursor: null }), true);
});

test("hybrid is skipped when not advertised", () => {
  assert.equal(shouldAttemptHybrid({ hybridAdvertised: false, cursor: null }), false);
});

test("hybrid is skipped on subsequent pages even when advertised", () => {
  assert.equal(shouldAttemptHybrid({ hybridAdvertised: true, cursor: "some-cursor" }), false);
});

test("hybrid is skipped on subsequent pages when not advertised", () => {
  assert.equal(shouldAttemptHybrid({ hybridAdvertised: false, cursor: "some-cursor" }), false);
});

// ─── Decision gate: semantic uplift fallback ──────────────────────────────────
//
// These pin the existing shouldAttemptSemanticUplift invariants that remain
// in force when hybrid is absent or fails.

test("semantic uplift requires advertised + nonzero participation", () => {
  assert.equal(shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 1 }), true);
});

test("semantic uplift is blocked when not advertised, even with participation", () => {
  assert.equal(shouldAttemptSemanticUplift({ advertised: false, participationFieldCount: 5 }), false);
});

test("semantic uplift is blocked when participation is zero, even when advertised", () => {
  assert.equal(shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 0 }), false);
});

test("semantic uplift is blocked when both advertised is false and participation is zero", () => {
  assert.equal(shouldAttemptSemanticUplift({ advertised: false, participationFieldCount: 0 }), false);
});

// ─── Combined: hybrid takes priority over semantic ───────────────────────────

test("when hybrid is advertised, semantic gate result does not matter for hybrid path", () => {
  // If hybrid is available, semantic should not be attempted regardless of gate.
  // This is enforced by searchRecords() returning early when hybrid succeeds.
  const hybridWouldRun = shouldAttemptHybrid({ hybridAdvertised: true, cursor: null });
  const semanticWouldRun = shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 3 });
  // Both gates are open, but the code path that reaches semantic uplift is
  // only entered when hybrid is NOT advertised or NOT on page 1. The test
  // confirms both predicates correctly describe their respective paths.
  assert.equal(hybridWouldRun, true);
  assert.equal(semanticWouldRun, true);
});

test("when hybrid is not advertised, semantic uplift can activate independently", () => {
  const hybridWouldRun = shouldAttemptHybrid({ hybridAdvertised: false, cursor: null });
  const semanticWouldRun = shouldAttemptSemanticUplift({ advertised: true, participationFieldCount: 3 });
  assert.equal(hybridWouldRun, false);
  assert.equal(semanticWouldRun, true);
});
