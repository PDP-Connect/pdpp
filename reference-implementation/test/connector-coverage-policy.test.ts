// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { deriveStreamCoverageCondition } from "../server/connector-coverage-policy.ts";
import type { RuntimeCollectionFact } from "../server/ref-control.ts";

function fact(overrides: Partial<RuntimeCollectionFact> = {}): RuntimeCollectionFact {
  return {
    checkpoint: "committed",
    collected: 5,
    considered: 100,
    covered: null,
    pending_detail_gaps: 0,
    skipped: null,
    stream: "repositories",
    ...overrides,
  };
}

test("checkpoint-window streams treat collected as changed-record count, not coverage numerator", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact(), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "complete"
  );
});

test("checkpoint-window streams remain partial until the boundary checkpoint is committed", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ checkpoint: "pending" }), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "partial"
  );
});

test("parent-detail accounting still requires an accounted-for covered count", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact(), {
      coverage_strategy: "parent_detail_accounting",
      freshness_strategy: "scheduled_window",
    }),
    "partial"
  );

  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 0, considered: 1, covered: 1 }), {
      coverage_strategy: "parent_detail_accounting",
      freshness_strategy: "scheduled_window",
    }),
    "complete"
  );

  assert.equal(
    deriveStreamCoverageCondition(fact({ covered: 100 }), {
      coverage_strategy: "parent_detail_accounting",
      freshness_strategy: "scheduled_window",
    }),
    "complete"
  );
});

test("pending detail gaps outrank checkpoint strategy proof", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ pending_detail_gaps: 1 }), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "retryable_gap"
  );
});

test("skip facts outrank checkpoint strategy proof", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        skipped: {
          reason: "rate_limited",
          recovery_action: "retry_by_runtime",
        },
      }),
      {
        coverage_strategy: "checkpoint_window",
        freshness_strategy: "scheduled_window",
      }
    ),
    "retryable_gap"
  );
});

// Defensive normalization: the type contract is `considered: number | null`,
// but a caller that bypasses `readRuntimeCollectionFact`'s re-validation
// (this test constructs the fact directly, unchecked by TypeScript) could
// hand an `undefined` denominator. `undefined !== null` would otherwise read
// as a KNOWN denominator, and `0 < undefined` is `false`, so a zero-collected
// fact would wrongly read `complete` instead of `unknown`.
test("an undefined (not null) considered denominator still reads unknown, never fabricates complete", () => {
  assert.equal(
    // @ts-expect-error deliberately hands `considered: undefined`, a type
    // violation the runtime must still handle defensively per the comment
    // above — this IS the assertion, not a fixable input.
    deriveStreamCoverageCondition(fact({ checkpoint: "not_staged", collected: 0, considered: undefined }), {
      coverage_strategy: "checkpoint_window",
      freshness_strategy: "scheduled_window",
    }),
    "unknown"
  );
});

test("raw local coverage statuses defer accepted absence to manifest policy and retain true gaps", () => {
  const localFact = (coverage_statuses: readonly string[]): RuntimeCollectionFact =>
    fact({
      considered: null,
      coverage_statuses,
    });
  const accepted = (coverage_policy: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported") => ({
    coverage_policy,
    required: false,
  });

  assert.equal(
    deriveStreamCoverageCondition(localFact(["collected"]), { coverage_strategy: "checkpoint_window" }),
    "complete"
  );
  assert.equal(
    deriveStreamCoverageCondition(localFact(["inventory_only"]), accepted("inventory_only")),
    "inventory_only"
  );
  assert.equal(deriveStreamCoverageCondition(localFact(["deferred"]), accepted("deferred")), "deferred");
  assert.equal(deriveStreamCoverageCondition(localFact(["unsupported"]), accepted("unsupported")), "unsupported");
  assert.equal(
    deriveStreamCoverageCondition(localFact(["excluded"]), accepted("inventory_only")),
    "inventory_only",
    "excluded follows its declared policy rather than a local status mapping"
  );
  assert.equal(
    deriveStreamCoverageCondition(localFact(["excluded"]), { coverage_strategy: "checkpoint_window" }),
    "unknown",
    "an undeclared excluded absence must not become complete"
  );
  assert.equal(
    deriveStreamCoverageCondition(localFact(["missing"]), { coverage_strategy: "checkpoint_window" }),
    "unknown",
    "raw status alone is not a gap; the handoff must supply concrete pending-gap evidence"
  );
  assert.equal(
    deriveStreamCoverageCondition(fact({ coverage_statuses: ["missing"], pending_detail_gaps: 1 }), {
      coverage_strategy: "checkpoint_window",
    }),
    "retryable_gap"
  );
  assert.equal(
    deriveStreamCoverageCondition(fact({ coverage_statuses: ["unaccounted"], pending_detail_gaps: 1 }), {
      coverage_strategy: "checkpoint_window",
    }),
    "retryable_gap"
  );
});

// --- Ruling 2: a committed checkpoint alone never proves coverage. ---
// The invariant lives in `@pdpp/reference-contract/evidence`; these pin the
// projection's use of it. Before the fix, (b) and (c)'s no-denominator streams
// read `complete` off the checkpoint alone.

test("a zero-collection run with a measured enumeration boundary is legitimately verified-empty", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 0, considered: 0, covered: 0 }), {
      coverage_strategy: "full_inventory",
    }),
    "complete"
  );
});

test("a zero-collection run with a committed checkpoint but no coverage evidence is not complete", () => {
  for (const strategy of [
    "checkpoint_window",
    "full_inventory",
    "snapshot_import_receipt",
    "singleton_presence",
  ] as const) {
    assert.equal(
      deriveStreamCoverageCondition(fact({ checkpoint: "committed", collected: 0, considered: null }), {
        coverage_strategy: strategy,
      }),
      "unknown",
      `checkpoint alone must not prove ${strategy}`
    );
  }
});

test("a committed checkpoint does not prove coverage for a collected-records stream either", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ checkpoint: "committed", collected: 900, considered: null }), {
      coverage_strategy: "checkpoint_window",
    }),
    "unknown"
  );
});

test("an unresolved attempt is never laundered into complete by a committed checkpoint", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({ checkpoint: "committed", collected: 0, considered: null, skipped: { reason: "opaque_failure" } }),
      { coverage_strategy: "full_inventory" }
    ),
    "terminal_gap"
  );
  assert.equal(
    deriveStreamCoverageCondition(
      fact({ checkpoint: "committed", collected: 0, considered: null, pending_detail_gaps: 4 }),
      { coverage_strategy: "full_inventory" }
    ),
    "retryable_gap"
  );
});

test("a genuinely complete run stays complete (no over-correction)", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 100, considered: 100 }), { coverage_strategy: "full_inventory" }),
    "complete"
  );
  // Steady-state full sync: everything suppressed as unchanged, boundary still covered.
  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 0, considered: 40, covered: 40 }), {
      coverage_strategy: "checkpoint_window",
    }),
    "complete"
  );
  // A shortfall under a per-item accounting strategy still reads partial: that
  // strategy owes a numerator, so `collected`/`covered` must satisfy it.
  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 7, considered: 40 }), {
      coverage_strategy: "parent_detail_accounting",
    }),
    "partial"
  );
  // A window-bounding strategy whose window has NOT closed cannot lean on the
  // boundary alone either.
  assert.equal(
    deriveStreamCoverageCondition(fact({ checkpoint: "pending", collected: 7, considered: 40 }), {
      coverage_strategy: "full_inventory",
    }),
    "partial"
  );
});

test("a manifest-declared accepted absence remains the precise axis without a denominator", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ collected: 0, considered: null }), {
      coverage_policy: "unsupported",
      required: false,
    }),
    "unsupported"
  );
});
