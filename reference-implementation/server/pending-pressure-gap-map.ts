// Pure mapping of pending detail-gap summaries onto the source-pressure
// cooldown governor's `PendingPressureGap` shape, used by the connection-health
// projection in `ref-control.ts`. A leaf module: it reads only the gap-summary
// fields the governor needs and carries no store or projection dependency.

import type { PendingPressureGap } from "../runtime/scheduler-source-pressure-cooldown.ts";
import type { PendingDetailGapSummary } from "./ref-control.ts";

/** The most recent pressure timestamp on a gap — last attempt, else last update. */
export function readPendingGapLastPressureAt(gap: PendingDetailGapSummary): string | null {
  if (typeof gap.last_attempt_at === "string") {
    return gap.last_attempt_at;
  }
  if (typeof gap.updated_at === "string") {
    return gap.updated_at;
  }
  return null;
}

/** Project pending detail gaps onto the source-pressure cooldown governor's input shape. */
export function mapPendingPressureGaps(gaps: readonly PendingDetailGapSummary[]): readonly PendingPressureGap[] {
  return gaps.map((gap) => ({
    attemptCount: typeof gap.attempt_count === "number" ? gap.attempt_count : null,
    lastPressureAt: readPendingGapLastPressureAt(gap),
    nextAttemptAfter: typeof gap.next_attempt_after === "string" ? gap.next_attempt_after : null,
    reason: typeof gap.reason === "string" ? gap.reason : null,
  }));
}
