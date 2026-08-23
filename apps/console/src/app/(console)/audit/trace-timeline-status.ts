// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Timeline-event and whole-trace status projections for the audit DETAIL page.
 *
 * Pure (no RSC / next imports) so the honesty discipline below is unit-testable,
 * the same reason `trace-endorse-status.ts` exists — and it builds on that
 * module rather than restating a second, divergent notion of "what does this
 * status mean". A status the console does not recognise is indeterminate; it
 * must render neutral `unknown`, never a definite tone.
 *
 * The defect this replaces: the detail page carried its own local mapping whose
 * `EndorseStatus` type omitted `unknown` entirely, so every unrecognised or
 * absent status fell through to `continuous`, and any non-empty event set
 * lacking the exact spellings `failed`/`rejected` was summarised as a green
 * "complete". `SpineEvent.status` is `string | null`, so an absent status is a
 * REAL input — the same page already renders those rows as "—" while the
 * summary above them claimed the trace had completed.
 */

import type { TraceEndorseVariant } from "./trace-endorse-status.ts";
import { traceEndorseStatus } from "./trace-endorse-status.ts";

/** The subset of a spine event this module needs. */
export interface TraceEventStatus {
  status: string | null;
}

/**
 * Statuses that mean "this event reached a successful end". Only these can
 * contribute to a trace being called complete.
 */
const TERMINAL_SUCCESS = new Set(["completed", "succeeded"]);

/** Statuses that mean "this event ended, but not successfully". */
const TERMINAL_FAILURE = new Set(["failed", "rejected"]);

/**
 * Statuses the console recognises as a definite, still-open state. Anything
 * outside this set plus the two terminal sets is genuinely unrecognised.
 */
const RECOGNISED_OPEN = new Set(["started", "in_progress", "pending", "cancelled", "revoked"]);

/**
 * One event's Endorse variant.
 *
 * `traceEndorseStatus` owns the recognised spellings. The two mappings this
 * function adds on top are detail-page vocabulary that the trace-list status
 * enum does not carry: `completed` as a synonym for `succeeded`, and
 * `cancelled`/`revoked`/`pending` as their own definite states. A null or
 * unrecognised status maps to `unknown` — it is not evidence of progress.
 */
export function eventEndorseStatus(status: string | null): TraceEndorseVariant {
  if (!status) {
    return "unknown";
  }
  if (status === "completed") {
    return "active";
  }
  if (status === "cancelled" || status === "revoked") {
    return "revoked";
  }
  if (status === "pending") {
    return "expiring";
  }
  return traceEndorseStatus(status);
}

export interface TraceOverall {
  label: string;
  status: TraceEndorseVariant;
}

/**
 * The whole-trace summary badge.
 *
 * Ranked worst-honest-first, and "complete" is now a CLAIM that must be earned:
 * it requires every event to have reached a recognised terminal success. A
 * trace holding any unknown or still-open event is reported as such, because
 * the console cannot see that it finished. Reporting an unfinished or
 * unreadable timeline as a green "complete" is the fabricated-green defect —
 * a REFUSED answer and a FABRICATED one are equally bad, so this returns a
 * neutral `unknown` rather than either guessing or going silent.
 */
export function traceOverall(events: readonly TraceEventStatus[]): TraceOverall {
  if (events.length === 0) {
    return { label: "empty", status: "unknown" };
  }
  if (events.some((event) => event.status !== null && TERMINAL_FAILURE.has(event.status))) {
    return { label: "has failures", status: "denied" };
  }

  const unreadable = events.filter(
    (event) =>
      event.status === null ||
      !(TERMINAL_SUCCESS.has(event.status) || TERMINAL_FAILURE.has(event.status) || RECOGNISED_OPEN.has(event.status))
  ).length;
  if (unreadable > 0) {
    return {
      label: unreadable === events.length ? "status unknown" : "partly unknown",
      status: "unknown",
    };
  }

  if (events.every((event) => event.status !== null && TERMINAL_SUCCESS.has(event.status))) {
    return { label: "complete", status: "active" };
  }
  return { label: "in progress", status: "continuous" };
}
