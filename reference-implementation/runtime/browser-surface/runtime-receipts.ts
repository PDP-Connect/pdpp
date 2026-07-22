// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { LastSuccessfulRuntimeReceipt } from "./ephemeral-health-projection.ts";

export interface RuntimeReceiptContext {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly generation: number;
  readonly lease_id: string;
  readonly max_age_ms: number;
  readonly now: string;
  readonly profile_key: string;
  readonly run_id: string;
  readonly surface_id: string;
  readonly surface_subject_id: string;
}

export interface LastSuccessfulRuntimeReceiptEvaluation {
  readonly authority: "historical_only";
  readonly lifecycle: readonly ["ready", "succeeded", "released"] | null;
  readonly receipt: LastSuccessfulRuntimeReceipt | null;
  readonly valid: boolean;
}

export interface RuntimeLifecycleEvent {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly event_type: "run.browser_surface_ready" | "run.browser_surface_released" | "run.completed";
  readonly generation: number;
  readonly lease_id: string;
  readonly occurred_at: string;
  readonly profile_key: string;
  readonly run_id: string;
  readonly succeeded?: boolean;
  readonly surface_id: string;
  readonly surface_subject_id: string;
}

/** Minimal persisted spine shape required to admit a successful completion. */
export interface RuntimeCompletedSpineEvent {
  readonly actor_id: string;
  readonly event_type: string;
  readonly run_id: string | null;
  readonly status: string | null;
}

const REQUIRED_LIFECYCLE = ["ready", "succeeded", "released"] as const;

/**
 * `runtime/index.js` records event_type `run.completed` with the child DONE
 * status `succeeded`. Both fields, plus the exact actor/run scope, are needed:
 * accepting merely a generic terminal status would admit another event shape.
 */
export function isSucceededRunCompletionEvent(
  event: RuntimeCompletedSpineEvent,
  context: Pick<RuntimeReceiptContext, "connector_id" | "run_id">
): boolean {
  return (
    event.event_type === "run.completed" &&
    event.status === "succeeded" &&
    event.actor_id === context.connector_id &&
    event.run_id === context.run_id
  );
}

function sameIdentity(receipt: LastSuccessfulRuntimeReceipt, context: RuntimeReceiptContext): boolean {
  return (
    receipt.connection_id === context.connection_id &&
    receipt.connector_id === context.connector_id &&
    receipt.profile_key === context.profile_key &&
    receipt.run_id === context.run_id &&
    receipt.surface_subject_id === context.surface_subject_id &&
    receipt.surface_id === context.surface_id &&
    receipt.lease_id === context.lease_id &&
    receipt.generation === context.generation
  );
}

function hasBoundedCompletion(receipt: LastSuccessfulRuntimeReceipt, context: RuntimeReceiptContext): boolean {
  const completedAt = Date.parse(receipt.completed_at);
  const now = Date.parse(context.now);
  if (!(Number.isFinite(completedAt) && Number.isFinite(now)) || completedAt > now) {
    return false;
  }
  return now - completedAt <= context.max_age_ms;
}

/** Validate a normalised diagnostic receipt; it has no health authority. */
export function evaluateLastSuccessfulRuntimeReceipt(
  receipt: LastSuccessfulRuntimeReceipt | null | undefined,
  context: RuntimeReceiptContext
): LastSuccessfulRuntimeReceiptEvaluation {
  const valid =
    receipt !== null &&
    receipt !== undefined &&
    sameIdentity(receipt, context) &&
    receipt.lifecycle.length === REQUIRED_LIFECYCLE.length &&
    receipt.lifecycle.every((phase, index) => phase === REQUIRED_LIFECYCLE[index]) &&
    hasBoundedCompletion(receipt, context);
  if (!valid) {
    return { valid: false, authority: "historical_only", lifecycle: null, receipt: null };
  }
  return { valid: true, authority: "historical_only", lifecycle: REQUIRED_LIFECYCLE, receipt };
}

function eventMatchesContext(event: RuntimeLifecycleEvent, context: RuntimeReceiptContext): boolean {
  return (
    event.connection_id === context.connection_id &&
    event.connector_id === context.connector_id &&
    event.profile_key === context.profile_key &&
    event.run_id === context.run_id &&
    event.surface_subject_id === context.surface_subject_id &&
    event.surface_id === context.surface_id &&
    event.lease_id === context.lease_id &&
    event.generation === context.generation
  );
}

/**
 * Build a receipt only from one exact, ordered lifecycle chain. The caller
 * supplies a bounded per-run event snapshot; this module intentionally never
 * performs history I/O or expands an unbounded timeline.
 */
export function buildLastSuccessfulRuntimeReceipt(
  events: readonly RuntimeLifecycleEvent[],
  context: RuntimeReceiptContext
): LastSuccessfulRuntimeReceiptEvaluation {
  const matching = events.filter((event) => eventMatchesContext(event, context));
  const [ready, completed, released] = matching;
  if (
    matching.length !== 3 ||
    ready?.event_type !== "run.browser_surface_ready" ||
    completed?.event_type !== "run.completed" ||
    completed.succeeded !== true ||
    released?.event_type !== "run.browser_surface_released"
  ) {
    return { valid: false, authority: "historical_only", lifecycle: null, receipt: null };
  }
  const readyAt = Date.parse(ready.occurred_at);
  const completedAt = Date.parse(completed.occurred_at);
  const releasedAt = Date.parse(released.occurred_at);
  if (!(Number.isFinite(readyAt) && readyAt <= completedAt && completedAt <= releasedAt)) {
    return { valid: false, authority: "historical_only", lifecycle: null, receipt: null };
  }
  const receipt: LastSuccessfulRuntimeReceipt = {
    connection_id: context.connection_id,
    connector_id: context.connector_id,
    profile_key: context.profile_key,
    run_id: context.run_id,
    surface_subject_id: context.surface_subject_id,
    surface_id: context.surface_id,
    lease_id: context.lease_id,
    generation: context.generation,
    lifecycle: REQUIRED_LIFECYCLE,
    completed_at: completed.occurred_at,
  };
  return evaluateLastSuccessfulRuntimeReceipt(receipt, context);
}
