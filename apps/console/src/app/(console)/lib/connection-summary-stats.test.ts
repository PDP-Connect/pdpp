// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeConnectionHealth } from "./connection-summary-stats.ts";
import type { ConnectorOverview } from "./rs-client.ts";

/** The headline-state union from `RefConnectionHealthSnapshot.state`. */
type ConnectionHealthState = NonNullable<ConnectorOverview["connectionHealth"]>["state"];

function overview(partial: Partial<ConnectorOverview>): ConnectorOverview {
  return {
    connector: { connector_id: "test", display_name: "Test", name: "Test" },
    isRunning: false,
    lastRun: null,
    lastSuccessfulRun: null,
    streams: [],
    totalRecords: 0,
    ...partial,
  };
}

/**
 * A connection with durable progress (so it lands in the primary list) and a
 * given dominant health state plus freshness axis.
 */
function withDataInState(
  state: ConnectionHealthState,
  freshness: "fresh" | "stale" | "unknown" = "unknown",
  outbox: "active" | "idle" | "stalled" | "unknown" = "unknown"
): ConnectorOverview {
  return overview({
    connectionHealth: {
      axes: { attention: "none", coverage: "unknown", freshness, outbox, remote_surface: "none" },
      badges: { stale: freshness === "stale", syncing: false },
      last_success_at: null,
      next_attempt_at: null,
      reason_code: null,
      state,
    } as ConnectorOverview["connectionHealth"],
    totalRecords: 10,
  });
}

// ─── Degraded / cooling-off / stalled visibility ──────────────────────────

test("degraded connection is counted in the attention-visible degraded bucket", () => {
  const stats = summarizeConnectionHealth([withDataInState("degraded")]);
  assert.equal(stats.degraded, 1);
  // The summary must not read all-zero across attention buckets while a
  // degraded card is present.
  assert.equal(stats.needsAttention + stats.degraded > 0, true);
});

test("cooling_off connection is counted as degraded (retryable work is visible)", () => {
  const stats = summarizeConnectionHealth([withDataInState("cooling_off")]);
  assert.equal(stats.degraded, 1);
  assert.equal(stats.needsAttention, 0);
});

test("stalled local-device outbox surfaces as degraded, not as a scheduler failure", () => {
  // The projection promotes a stalled outbox to the `degraded` headline state;
  // the summary must keep it visible without reclassifying it as needs-attention
  // (which would read as owner-action / scheduler failure).
  const stats = summarizeConnectionHealth([withDataInState("degraded", "unknown", "stalled")]);
  assert.equal(stats.degraded, 1);
  assert.equal(stats.needsAttention, 0);
});

test("blocked and needs_attention stay in the needs-attention bucket, not degraded", () => {
  const stats = summarizeConnectionHealth([withDataInState("blocked"), withDataInState("needs_attention")]);
  assert.equal(stats.needsAttention, 2);
  assert.equal(stats.degraded, 0);
});

test("a healthy fleet reads zero across both attention buckets", () => {
  const stats = summarizeConnectionHealth([withDataInState("healthy", "fresh")]);
  assert.equal(stats.needsAttention, 0);
  assert.equal(stats.degraded, 0);
});

// ─── Unknown freshness is not stale ───────────────────────────────────────

test("unknown freshness is NOT counted as stale", () => {
  const stats = summarizeConnectionHealth([
    withDataInState("degraded", "unknown"),
    withDataInState("healthy", "unknown"),
  ]);
  assert.equal(stats.stale, 0);
});

test("stale is counted only when the freshness axis says stale", () => {
  const stats = summarizeConnectionHealth([
    withDataInState("healthy", "stale"),
    withDataInState("healthy", "fresh"),
    withDataInState("healthy", "unknown"),
  ]);
  assert.equal(stats.stale, 1);
});

// ─── Running ──────────────────────────────────────────────────────────────

test("running counts active runs and push-mode syncing badges", () => {
  const syncing = overview({
    connectionHealth: {
      axes: { attention: "none", coverage: "complete", freshness: "fresh", outbox: "active", remote_surface: "none" },
      badges: { stale: false, syncing: true },
      last_success_at: null,
      next_attempt_at: null,
      reason_code: null,
      state: "healthy",
    } as ConnectorOverview["connectionHealth"],
    totalRecords: 3,
  });
  const stats = summarizeConnectionHealth([overview({ isRunning: true, totalRecords: 1 }), syncing]);
  assert.equal(stats.running, 2);
});

// ─── Connection count population ──────────────────────────────────────────

test("counts name their population: primaryList, registeredTotal, noData", () => {
  const stats = summarizeConnectionHealth([
    withDataInState("healthy", "fresh"), // primary list, with data
    withDataInState("degraded"), // primary list, with data
    overview({
      lastRun: {
        event_count: 1,
        failure_reason: null,
        first_at: "2026-05-22T10:00:00Z",
        last_at: "2026-05-22T10:00:10Z",
        run_id: "run_failed",
        status: "failed",
      },
    }), // primary list, no records
    overview({}), // registered, no data, no actionable state -> no-data partition
    overview({}), // registered, no data
  ]);
  assert.equal(stats.primaryList, 3);
  assert.equal(stats.registeredTotal, 5);
  assert.equal(stats.noData, 2);
});

test("no-data registrations are excluded from the primary-list attention counts", () => {
  // A bare registration with no projection and no run must not inflate any
  // health bucket.
  const stats = summarizeConnectionHealth([overview({}), overview({})]);
  assert.equal(stats.primaryList, 0);
  assert.equal(stats.registeredTotal, 2);
  assert.equal(stats.needsAttention, 0);
  assert.equal(stats.degraded, 0);
  assert.equal(stats.running, 0);
  assert.equal(stats.stale, 0);
});

// ─── Regression: the audited contradiction cannot recur ───────────────────

test("a degraded card never coexists with an all-zero attention summary", () => {
  // This is the exact failure mode the change fixes: cards visible as degraded
  // while the summary claims nothing is attention-relevant.
  const stats = summarizeConnectionHealth([
    withDataInState("degraded", "unknown", "stalled"),
    withDataInState("healthy", "fresh"),
  ]);
  const attentionRelevant = stats.needsAttention + stats.degraded;
  assert.equal(attentionRelevant > 0, true);
});
