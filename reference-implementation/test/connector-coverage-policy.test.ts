// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { deriveStreamCoverageCondition } from "../server/connector-coverage-policy.ts";
import type { RuntimeCollectionFact } from "../server/ref-control.ts";
import { readCollectionFactsFromTerminalData } from "../server/runtime-collection-facts.ts";

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

test("terminal collection fact round-trips continuation through the active parser and policy", () => {
  const parsed = readCollectionFactsFromTerminalData({
    collection_facts: {
      collection_scope: "uidvalidity:1",
      streams: [
        {
          checkpoint: "committed",
          collected: 2,
          collection_scope: "uidvalidity:1",
          considered: 2,
          covered: 2,
          pending_detail_gaps: 0,
          skipped: {
            continuation: {
              boundary: "uidvalidity:1",
              considered: 2,
              covered: 2,
              owner: "runtime",
              remaining: true,
              slice_end: 2,
              slice_start: 1,
            },
            reason: "historical_backfill_pending",
            recovery_action: "retry_by_runtime",
          },
          stream: "messages",
        },
      ],
    },
  });
  assert.ok(parsed?.streams[0]?.skipped?.continuation);
  assert.equal(
    deriveStreamCoverageCondition(parsed.streams[0], { coverage_strategy: "parent_detail_accounting" }),
    "complete"
  );
});

test("active parser drops malformed continuation evidence", () => {
  const parsed = readCollectionFactsFromTerminalData({
    collection_facts: {
      streams: [
        {
          considered: 2,
          covered: 2,
          skipped: {
            continuation: {
              boundary: "uidvalidity:1",
              owner: "runtime",
              remaining: true,
              slice_end: 2,
              slice_start: -1,
            },
            reason: "historical_backfill_pending",
          },
          stream: "messages",
        },
      ],
    },
  });
  assert.equal(parsed?.streams[0]?.skipped?.continuation, undefined);
});

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

test("a retryable continuation with a proven page is complete coverage with background work", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        collection_scope: "uidvalidity:1",
        considered: 100,
        covered: 100,
        skipped: {
          continuation: {
            boundary: "uidvalidity:1",
            considered: 100,
            covered: 100,
            owner: "runtime",
            remaining: true,
            slice_end: 100,
            slice_start: 1,
          },
          reason: "opaque",
          recovery_action: "retry_by_runtime",
        },
      }),
      { coverage_strategy: "parent_detail_accounting", freshness_strategy: "scheduled_window" }
    ),
    "complete"
  );
});

test("an ordinary retryable skip stays non-green despite a complete denominator", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({ considered: 100, covered: 100, skipped: { reason: "rate_limited", recovery_action: "retry_by_runtime" } }),
      { coverage_strategy: "parent_detail_accounting" }
    ),
    "retryable_gap"
  );
});

test("a stalled continuation without progress stays non-green", () => {
  assert.equal(
    deriveStreamCoverageCondition(fact({ skipped: { reason: "opaque", recovery_action: "retry_by_runtime" } }), {
      coverage_strategy: "parent_detail_accounting",
    }),
    "retryable_gap"
  );
});

test("a continuation measured outside the declared boundary stays non-green", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        considered: 100,
        covered: 100,
        scoped: false,
        skipped: {
          continuation: {
            boundary: "uidvalidity:stale",
            considered: 100,
            covered: 100,
            owner: "runtime",
            remaining: true,
            slice_end: 100,
            slice_start: 1,
          },
          reason: "opaque",
          recovery_action: "retry_by_runtime",
        },
      }),
      { coverage_strategy: "parent_detail_accounting" }
    ),
    "unknown"
  );
});

test("a retryable continuation without page proof remains a retryable gap", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({ skipped: { reason: "historical_backfill_pending", recovery_action: "retry_by_runtime" } }),
      { coverage_strategy: "parent_detail_accounting" }
    ),
    "retryable_gap"
  );
});

test("an unaccounted record remains non-green even when continuation is scheduled", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        considered: 100,
        covered: 99,
        skipped: { reason: "historical_backfill_pending", recovery_action: "retry_by_runtime" },
      }),
      { coverage_strategy: "parent_detail_accounting" }
    ),
    "partial"
  );
});

// Guards the exact shape the Slack connector's runOptionalStream now emits
// for stars/user_groups/reminders/dm_read_states on a durable slack_auth_failed
// 401: `reason: "optional_stream_failed"` (matches no retryable/deferred/
// unavailable/unsupported reason pattern) with recovery_action OMITTED (not
// "retry_by_runtime", since retrying the same call against the same
// rejected session can never succeed). Must read terminal_gap, never
// retryable_gap — a retryable_gap misclassification would surface as
// "will self-heal" when the connector's own manifest disposition is that
// this stream needs a real credential fix, not a retry.
test("an optional-stream auth-failure skip with no recovery_action reads terminal_gap, not retryable_gap", () => {
  assert.equal(
    deriveStreamCoverageCondition(
      fact({
        skipped: {
          reason: "optional_stream_failed",
        },
      }),
      {
        coverage_strategy: "full_inventory",
        freshness_strategy: "scheduled_window",
      }
    ),
    "terminal_gap"
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
