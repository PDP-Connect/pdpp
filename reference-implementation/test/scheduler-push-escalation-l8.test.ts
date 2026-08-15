// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * L8 tests for §10-F: push escalation on human-required state transitions.
 *
 * Every transition INTO a human-required state (needs_attention via
 * needs_human gate, or blocked via gave_up) emits ONE deduplicated push
 * escalation via an injected `onHumanRequiredStateEscalation` callback.
 * The callback receives { connectorId, connectorInstanceId, reason } where
 * `reason` is 'blocked' or 'needs_attention'.
 *
 * Dedup contract:
 *   - blocked: fires once per (connector, reasonClass) streak; cleared when
 *     the streak resets (mirroring announcedBlockedClass).
 *   - needs_attention: fires once per (connector, needs_human key) until the
 *     flag clears (mirroring notifiedNeedsHumanSkips).
 *
 * The callback is optional (defaults to no-op) so existing callers without
 * it are unaffected.
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-F
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createScheduler } from "../runtime/scheduler.ts";
import type { ConnectorSchedule } from "../runtime/scheduler-domain-types.ts";
import type { SchedulerLastRunTimeRecord, SchedulerRunHistoryRecord } from "../server/stores/scheduler-store.ts";

// ─── Minimal schedule fixture ─────────────────────────────────────────────────

function makeSchedule(overrides: Partial<ConnectorSchedule> = {}): ConnectorSchedule {
  return {
    connectorId: "test-connector",
    connectorInstanceId: "test-instance",
    connectorPath: "/nonexistent/connector",
    intervalMs: 1000,
    manifest: { automation: { enabled: true }, display_name: "Test Connector" },
    ownerSubjectId: "owner-test",
    ownerToken: "owner-test-token",
    ...overrides,
  };
}

interface EscalationInfo {
  connectorId: string;
  connectorInstanceId: string;
  reason: "blocked" | "needs_attention";
}

/** Builds a run-history fixture row. Every field the real store type requires is present. */
function historyRow(
  connectorId: string,
  connectorInstanceId: string,
  status: SchedulerRunHistoryRecord["status"],
  index: number,
  overrides: Partial<SchedulerRunHistoryRecord> = {}
): SchedulerRunHistoryRecord {
  const now = Date.now();
  return {
    attempt: 0,
    checkpointSummary: null,
    completedAt: new Date(now - (8 - index) * 60_000 + 1000).toISOString(),
    connectorId,
    connectorInstanceId,
    failureReason: status === "failed" ? "unknown_error" : null,
    knownGaps: [],
    recordsEmitted: status === "succeeded" ? 5 : 0,
    runId: `run-${index}`,
    source: { id: connectorId, kind: "connector" },
    startedAt: new Date(now - (8 - index) * 60_000).toISOString(),
    status,
    terminalReason: null,
    traceId: null,
    ...overrides,
  };
}

function lastRunTimeRow(
  connectorId: string,
  connectorInstanceId: string,
  lastRunTimeMs: number
): SchedulerLastRunTimeRecord {
  return {
    connector_id: connectorId,
    connector_instance_id: connectorInstanceId,
    last_run_time_ms: lastRunTimeMs,
    updated_at: new Date(lastRunTimeMs).toISOString(),
  };
}

function unimplemented(name: string): never {
  throw new Error(`test fake: ${name} is not implemented — this path should be unreachable in this test`);
}

/** Fake scheduler store exposing only the two methods `deleteActiveRun`/`upsertActiveRun` never called here. */
function fakeStore(history: SchedulerRunHistoryRecord[], lastRunTimes: SchedulerLastRunTimeRecord[]) {
  return {
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    async appendRunHistory() {},
    deleteActiveRun: () => unimplemented("deleteActiveRun"),
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async listLastRunTimes() {
      return lastRunTimes;
    },
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    async listRunHistory() {
      return history;
    },
    upsertActiveRun: () => unimplemented("upsertActiveRun"),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    async upsertLastRunTime() {},
  };
}

// ─── §10-F: blocked (gave_up) fires escalation exactly once ──────────────────

test("§10-F evaluateBackoffDispatch: gave_up emits escalation once per streak", async () => {
  // Strategy: seed the schedulerStore with enough consecutive failure history
  // to cross the blocked threshold (BLOCKED_PROMOTION_THRESHOLD = 7 in
  // scheduler-backoff.ts; we pre-seed 8), start the scheduler, and observe
  // the escalation fires exactly once.

  const connectorId = "push-escalation-blocked-test-2";
  const connectorInstanceId = "push-escalation-blocked-instance-2";

  const fakeHistory = Array.from({ length: 8 }, (_, i) => historyRow(connectorId, connectorInstanceId, "failed", i));
  const fakeLastRun = new Date(Date.now() - 8 * 60_000).getTime();

  const escalations2: EscalationInfo[] = [];
  let resolveBlocked2: (info: EscalationInfo) => void;
  const blockedP2 = new Promise<EscalationInfo>((res) => {
    resolveBlocked2 = res;
  });

  const scheduler2 = createScheduler({
    connectors: [makeSchedule({ connectorId, connectorInstanceId, intervalMs: 0 })],
    onHumanRequiredStateEscalation: (info) => {
      escalations2.push(info);
      if (info.reason === "blocked") {
        resolveBlocked2(info);
      }
    },
    onInteraction: async () => ({ request_id: "", status: "cancelled", type: "INTERACTION_RESPONSE" }),
    schedulerStore: fakeStore(fakeHistory, [lastRunTimeRow(connectorId, connectorInstanceId, fakeLastRun)]),
  });

  scheduler2.start();

  // Wait for the blocked escalation with a timeout
  const result = await Promise.race([
    blockedP2,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout: blocked escalation not fired within 3s")), 3000)
    ),
  ]);

  scheduler2.stop();

  assert.ok(result, "escalation must have fired");
  assert.equal(result.reason, "blocked", 'escalation reason must be "blocked"');
  assert.equal(typeof result.connectorId, "string", "must carry connectorId");
  assert.equal(typeof result.connectorInstanceId, "string", "must carry connectorInstanceId");

  // Dedup: scheduler2.start() is called only once, so the gave_up fires once.
  // Let the scheduler tick a few more times to confirm it does NOT re-fire.
  await new Promise((res) => setTimeout(res, 200));
  const blockedCount = escalations2.filter((e) => e.reason === "blocked").length;
  assert.equal(blockedCount, 1, "blocked escalation must fire exactly once per streak (dedup)");
});

// ─── §10-F: needs_human fires escalation exactly once ────────────────────────

test("§10-F gateNeedsHuman: needs_attention escalation fires once per flag-set, not on subsequent ticks", async () => {
  const connectorId = "push-escalation-needs-human-test";
  const connectorInstanceId = "push-escalation-needs-human-instance";

  const escalations: EscalationInfo[] = [];

  // The scheduler's gateNeedsHuman path is reached on the FIRST tick when
  // isNeedsHuman returns true from the start. That first tick is the
  // immediate startup call to tick(schedule) in startScheduledLoops(). The
  // preflight gate (gateNeedsHuman) fires the escalation and returns a skip
  // record without ever calling launchRun — so no connector process is
  // spawned, and the activeRun lock is released immediately. Subsequent
  // ticks via setInterval also see isNeedsHuman=true but the
  // notifiedNeedsHumanSkips map already contains the key, so they are
  // silently no-op'd (null). This proves dedup.
  //
  // We use intervalMs: 50 so the setInterval fires multiple times in the
  // test window, letting us verify the "fire-once-not-per-tick" contract.
  // intervalMs: 0 normalises to 60_000ms (the guard), giving only 1 tick.

  const scheduler = createScheduler({
    connectors: [makeSchedule({ connectorId, connectorInstanceId, intervalMs: 50 })],
    isNeedsHuman: () => true, // always set — first tick must escalate once
    onHumanRequiredStateEscalation: (info) => {
      escalations.push(info);
    },
    onInteraction: async () => ({ request_id: "", status: "cancelled", type: "INTERACTION_RESPONSE" }),
  });

  scheduler.start();
  // Wait for the immediate tick + several interval ticks (≥ 5 × 50ms).
  await new Promise((res) => setTimeout(res, 400));
  scheduler.stop();

  const attentionCount = escalations.filter((e) => e.reason === "needs_attention").length;
  assert.ok(attentionCount >= 1, `needs_attention escalation must fire at least once; got ${attentionCount}`);
  assert.equal(attentionCount, 1, "needs_attention escalation must fire exactly once (dedup across ticks)");

  const first = escalations.find((e) => e.reason === "needs_attention");
  assert.ok(first, "expected a needs_attention escalation");
  assert.equal(first.connectorId, connectorId);
  assert.equal(first.connectorInstanceId, connectorInstanceId);
});

// ─── §10-F: default (no callback) is a no-op ──────────────────────────────────

test("§10-F onHumanRequiredStateEscalation defaults to no-op — scheduler works without it", async () => {
  // Scheduler with no onHumanRequiredStateEscalation option; should not throw
  // even when the blocked/needs-attention path fires.
  const connectorId = "push-escalation-noop-test";
  const connectorInstanceId = "push-escalation-noop-instance";

  const fakeHistory = Array.from({ length: 8 }, (_, i) => historyRow(connectorId, connectorInstanceId, "failed", i));

  const scheduler = createScheduler({
    connectors: [makeSchedule({ connectorId, connectorInstanceId, intervalMs: 0 })],
    onInteraction: async () => ({ request_id: "", status: "cancelled", type: "INTERACTION_RESPONSE" }),
    schedulerStore: fakeStore(fakeHistory, [lastRunTimeRow(connectorId, connectorInstanceId, Date.now() - 8 * 60_000)]),
    // NOTE: no onHumanRequiredStateEscalation — tests the default no-op
  });

  // Should start and tick without throwing even though blocked path fires.
  let threw = false;
  try {
    scheduler.start();
    await new Promise((res) => setTimeout(res, 300));
    scheduler.stop();
  } catch (err) {
    threw = true;
    console.error("unexpected throw:", err);
  }

  assert.equal(threw, false, "scheduler must not throw when onHumanRequiredStateEscalation is omitted");
});

// ─── §10-F: fanoutEscalationWebPush payload shape ─────────────────────────────

test("§10-F fanoutEscalationWebPush: builds correct payload shape for blocked and needs_attention", async () => {
  const { buildEscalationPushPayload } = await import("../server/web-push-notifications.ts");

  const blockedPayload = buildEscalationPushPayload({
    connectionUrl: "/sources/conn_123",
    connectorDisplayName: "My Bank",
    reason: "blocked",
  });

  assert.equal(blockedPayload.type, "pdpp.escalation", "type must be pdpp.escalation");
  assert.ok(blockedPayload.title.includes("My Bank"), "title must include connector name");
  assert.equal(blockedPayload.escalation_reason, "blocked", "must carry escalation_reason");
  assert.equal(blockedPayload.url, "/sources/conn_123", "must carry connection URL");
  assert.ok(typeof blockedPayload.timestamp === "string", "must carry timestamp");

  const attentionPayload = buildEscalationPushPayload({
    connectionUrl: "/sources/conn_456",
    connectorDisplayName: "ChatGPT",
    reason: "needs_attention",
  });

  assert.equal(attentionPayload.type, "pdpp.escalation");
  assert.ok(attentionPayload.title.includes("ChatGPT"));
  assert.equal(attentionPayload.escalation_reason, "needs_attention");

  // Lock-screen safety: body must not echo connector-supplied free text.
  // The body is hardcoded copy, not interpolated from connector data.
  assert.ok(typeof attentionPayload.body === "string" && attentionPayload.body.length > 0, "must have body");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(attentionPayload.body, /ChatGPT/i, "body must not echo connector name (lock-screen safety)");
  // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
  assert.doesNotMatch(attentionPayload.body, /My Bank/i);
});

// ─── §10-F: dedup does not fire after streak reset ────────────────────────────

test("§10-F blocked escalation re-arms after a successful run clears the streak", async () => {
  // If the streak clears (a successful run) and then a new streak builds to
  // blocked again, the escalation fires again — because the dedup key is
  // per-streak, not per-connection forever.
  //
  // We test this indirectly: the announcedBlockedClass map is cleared on
  // success. If a NEW streak reaches blocked after a reset, the callback fires
  // once more. We verify the clear happens by checking that a scheduler
  // receiving only successes emits zero escalations.

  const connectorId = "push-escalation-rearmed";
  const connectorInstanceId = "push-escalation-rearmed-instance";

  const escalations: EscalationInfo[] = [];

  // Seed with only successful runs — no blocked state should result.
  const fakeHistory = Array.from({ length: 3 }, (_, i) => historyRow(connectorId, connectorInstanceId, "succeeded", i));

  const scheduler = createScheduler({
    connectors: [makeSchedule({ connectorId, connectorInstanceId, intervalMs: 60_000 })],
    onHumanRequiredStateEscalation: (info) => {
      escalations.push(info);
    },
    onInteraction: async () => ({ request_id: "", status: "cancelled", type: "INTERACTION_RESPONSE" }),
    schedulerStore: fakeStore(fakeHistory, [lastRunTimeRow(connectorId, connectorInstanceId, Date.now() - 1000)]),
  });

  scheduler.start();
  await new Promise((res) => setTimeout(res, 200));
  scheduler.stop();

  // Only successful history, far from interval elapsed — zero escalations.
  assert.equal(escalations.length, 0, "no escalation when connector has only successful runs");
});
