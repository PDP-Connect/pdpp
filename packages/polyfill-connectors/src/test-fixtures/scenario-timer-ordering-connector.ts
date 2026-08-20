// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-cli.test.ts`'s replay
 * time-scaling coverage (`src/scenario/subprocess-fetch-preloads.ts`'s
 * `writeReplayBridgePreload` REPLAY TIME SCALING patch).
 *
 * Schedules two `setTimeout` timers CONCURRENTLY (both armed before either
 * is awaited) — a LONG one (`PDPP_TIMER_ORDER_LONG_MS`, default 3000) is
 * started first but takes longer, and a SHORT one
 * (`PDPP_TIMER_ORDER_SHORT_MS`, default 1000) is started second but takes
 * less time. Each emits one record when its timer fires. The emitted RECORD
 * order (not the scheduling order in source) is what a scenario replay
 * proves: "short" must always be emitted before "long".
 *
 * This is the ordering proof the time-scaling patch must preserve: scaling
 * every delay by a constant factor (REPLAY_TIME_SCALE) keeps "short still
 * shorter than long" true after scaling (1000ms/3000ms -> 10ms/30ms) even
 * though both wall-clock delays shrink. A broken scaling implementation that
 * instead collapsed every delay toward zero, or fired timers in registration
 * order regardless of delay, could flip this order — exactly the kind of
 * observable-control-flow change replay must never introduce.
 *
 * No network calls — pure timers, so this fixture works for both the
 * scenario-record (`--entrypoint`) and scenario-verify (replay) paths
 * without a synthetic HTTP provider, the same shape
 * `scenario-watchdog-paced-connector.ts` uses.
 *
 * NOT registered in src/orchestrator.ts — fixture-only, never a production
 * connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected a string id" }] };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runConnector({
  name: "scenario-timer-ordering-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const shortMs = Number(process.env.PDPP_TIMER_ORDER_SHORT_MS ?? "1000");
    const longMs = Number(process.env.PDPP_TIMER_ORDER_LONG_MS ?? "3000");

    await emit({ type: "PROGRESS", stream: "items", message: "scheduling ordered timers" });

    // Both timers are armed here, before either is awaited — genuinely
    // concurrent scheduling, not a sequential await-then-await chain. The
    // LONG timer is started FIRST (so source order alone would predict
    // "long" emits first, if scaling broke relative ordering) but its delay
    // is larger, so it must still emit SECOND.
    const longEmitted = sleep(longMs).then(() => emitRecord("items", { id: "long" }));
    const shortEmitted = sleep(shortMs).then(() => emitRecord("items", { id: "short" }));
    await Promise.all([longEmitted, shortEmitted]);

    await emit({ type: "STATE", stream: "items", cursor: { done: true } });
  },
});
