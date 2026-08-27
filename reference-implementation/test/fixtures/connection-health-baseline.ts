// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE known-green connection-health baseline shared by every cross-surface
 * acceptance oracle.
 *
 * Test-only: this module imports nothing from production beyond the types and
 * builders under test, and nothing in production imports it.
 *
 * WHY THIS EXISTS. `health-authority-cross-surface.test.ts` owned a private
 * `input()` helper whose output is genuinely `healthy` — proven by its own
 * assertions over many cases. A second oracle (cadence lateness) hand-built its
 * own "otherwise-healthy" input and got it wrong four separate ways: an
 * invented `resolver`, an invented `schedule_mode`, wrong evidence
 * `source`/`lifecycle`, and finally an input that simply never reached
 * `healthy` at all — its CONTROL asserted green and got `unknown`.
 *
 * Every one of those produced a confident, WRONG reading of the product: a
 * source that looked mis-grouped or wrongly bannered when the real defect was
 * the fixture. A baseline that is green by construction removes that whole
 * class. Each oracle overrides ONLY its own subject.
 *
 * NOT preserved verbatim. The original helper defaulted to `backoffApplied:
 * true` with an unexpired `nextRunAt`, which computes `cooling_off` — NOT
 * `healthy`. A comment calling it a healthy baseline was simply wrong, and the
 * first control that asserted green caught it.
 *
 * `backoff: null` is the correct encoding of "no retry backoff":
 * `retryPolicyClearCondition` tests whether the backoff record is ABSENT or
 * EXPIRED, and never reads `backoffApplied`, so a record with
 * `backoffApplied: false` and `nextRunAt: null` still reads as an active,
 * unexpired backoff. The invariant below pins the corrected shape so this
 * cannot silently rot again; cases that genuinely exercise passive
 * cooling/retry pass their own backoff facts explicitly.
 */

import type { ComputeConnectionHealthInput } from "../../runtime/connection-health.ts";

export const BASELINE_OBSERVED_AT = "2026-08-12T12:00:00.000Z";
export const BASELINE_SUCCESS_AT = "2026-08-12T11:55:00.000Z";
export const BASELINE_RETRY_AT = "2026-08-12T12:30:00.000Z";

export const BASELINE_AUTOMATIC_REFRESH = {
  backgroundSafe: true,
  interactionPosture: "none" as const,
  recommendedMode: "automatic" as const,
};

export const BASELINE_MANUAL_REFRESH = {
  backgroundSafe: false,
  interactionPosture: "none" as const,
  recommendedMode: "manual" as const,
};

export const BASELINE_ACTIVE_SCHEDULE = { hasPriorSuccess: true, mode: "scheduled-active" as const };

/**
 * An otherwise-healthy connection: coverage complete, outbox idle, projection
 * reliable, no open attention, latest run succeeded, freshness fresh.
 *
 * `computeConnectionHealth(healthyConnectionInput())` MUST be `healthy`. Every
 * consumer asserts that as its control before drawing any conclusion from an
 * override — if the baseline is not green, nothing built on it means anything.
 */
export function healthyConnectionInput(
  overrides: Partial<ComputeConnectionHealthInput> = {}
): ComputeConnectionHealthInput {
  return {
    activity: { active: false },
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    outbox: { axis: "idle" },
    projection: { unreliableSources: [] },
    refresh: BASELINE_AUTOMATIC_REFRESH,
    run: {
      hasDegradingGaps: false,
      lastSuccessAt: BASELINE_SUCCESS_AT,
      latestStatus: "succeeded",
      reasonCode: null,
    },
    schedule: { enabled: true },
    ...overrides,
  };
}
