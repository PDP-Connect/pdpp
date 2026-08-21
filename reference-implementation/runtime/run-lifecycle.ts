// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The run-lifecycle owner module — the ONE code path for run-state mutation.
 *
 * D1 is specific about what "single writer" means here, and it is worth
 * restating because the tempting reading is the wrong one: a `transitionRun()`
 * helper that five modules import is today's distributed writes wearing a
 * uniform. The GroupMe 503 was two components mutating run state through "the
 * same" per-instance mutex — the mutex was the uniform. So this module owns
 * the DECISION (which transitions are legal, what the fence is, how a refusal
 * is reported), and the callers become consumers that hand it an intent.
 *
 * What lives here
 * ---------------
 *  - The legal transition table T1-T11 (`LEGAL_TRANSITIONS`), declared once.
 *  - `evaluateTransition`: the pure legality decision. No I/O, so the machine
 *    is testable without a database and cannot acquire a lock while "reading".
 *  - `buildTransitionStatement`: the epoch-fenced compare-and-swap predicate,
 *    rendered identically for both backends.
 *  - `TransitionOutcome`: `committed` or `refused`, with a reason. A refusal
 *    is an ORDINARY outcome, never an exception and never an owner-facing
 *    error — someone else already moved the run.
 *
 * What deliberately does NOT live here
 * ------------------------------------
 * Scheduling policy of any kind (D4's guard). Backoff curves, fairness
 * rotation, cooling-off, admission deadlines and per-statement budgets stay in
 * the planner. The machine answers "is this transition legal". It never
 * answers "which connector runs next". `needsHumanAttention` is not absorbed
 * for exactly this reason: it reads like run state and is actually a
 * per-connection automation-suppression policy.
 *
 * Why compare-and-swap rather than a lock
 * ---------------------------------------
 * An advisory lock answers "may I proceed?" at a moment. A CAS answers "was
 * the world still as I assumed when I wrote?" — which is the actual question
 * after an `await`. This repo already contains several independently-invented
 * admission mechanisms; a sixth lock would extend that list. The CAS adds no
 * new mechanism: it is a WHERE clause on writes that already happen.
 */

import { isTerminalRunState, RUN_STATES, type RunState, toDurableStatus } from "./run-lifecycle-states.ts";

/**
 * The identifiers of the transition table, kept as data so tests can read the
 * table from the module rather than re-typing a literal copy. A test that
 * hardcodes its own table stops being able to catch a table change.
 */
export type TransitionId = "T1" | "T2" | "T3" | "T4" | "T5" | "T6" | "T7" | "T8" | "T9" | "T10" | "T11";

/**
 * Who is permitted to perform a transition.
 *
 * `executor` is the sole writer of T1-T9. The boot adjudicator is the ONE
 * exception to "executor only" (T10/T11) and exists because the actor that
 * must terminalize an orphaned run is by definition not the actor that owns
 * it — the owner is gone. That is why it is a role in the table rather than a
 * special case hidden in a caller.
 *
 * `planner` appears in this union only so the table can state that it owns NO
 * transitions. Its presence is the enforcement point for F1.
 */
export type TransitionActor = "executor" | "boot_adjudicator" | "planner";

export interface TransitionRule {
  readonly actor: Exclude<TransitionActor, "planner">;
  readonly from: readonly RunState[];
  readonly id: TransitionId;
  readonly to: RunState;
}

/**
 * The legal transition table (design.md (b)). Terminal states have no
 * outgoing transitions, which is the whole point of the set being closed.
 */
export const LEGAL_TRANSITIONS: readonly TransitionRule[] = [
  { actor: "executor", from: [], id: "T1", to: "pending" },
  { actor: "executor", from: ["pending"], id: "T2", to: "running" },
  { actor: "executor", from: ["running"], id: "T3", to: "awaiting_interaction" },
  { actor: "executor", from: ["awaiting_interaction"], id: "T4", to: "running" },
  { actor: "executor", from: ["running"], id: "T5", to: "cancel_requested" },
  { actor: "executor", from: ["running"], id: "T6", to: "succeeded" },
  { actor: "executor", from: ["running"], id: "T7", to: "failed" },
  { actor: "executor", from: ["running", "pending"], id: "T8", to: "surface_failed" },
  { actor: "executor", from: ["cancel_requested"], id: "T9", to: "cancelled" },
  {
    actor: "boot_adjudicator",
    from: ["pending", "running", "cancel_requested"],
    id: "T10",
    to: "abandoned",
  },
  { actor: "boot_adjudicator", from: ["awaiting_interaction"], id: "T11", to: "abandoned" },
];

/** Why a transition was refused. Each maps to a forbidden row in design.md. */
export type RefusalReason =
  /** F8/F1: the planner has no write path. */
  | "actor_may_not_write"
  /** F4: only T10/T11 may terminalize an interrupted run, and only as abandoned. */
  | "actor_may_not_perform_transition"
  /** F7/F5: the run is already terminal. */
  | "run_already_terminal"
  /** F3: the observed state is not a legal source for this transition. */
  | "illegal_transition"
  /** F2/F3: the compare-and-swap matched no row. */
  | "cas_lost";

export interface TransitionRequest {
  readonly actor: TransitionActor;
  /** The state the caller believes the run is in. The CAS expected value. */
  readonly from: RunState;
  readonly to: RunState;
}

export type TransitionDecision =
  | { readonly legal: true; readonly rule: TransitionRule }
  | { readonly legal: false; readonly reason: RefusalReason };

/**
 * The pure legality decision — no I/O, so a "read" here cannot take a lock.
 *
 * That property is load-bearing rather than incidental. The GroupMe 503's
 * mechanism was a read-only-LOOKING eligibility probe that reconciled, took
 * the per-instance write mutex, and turned committed batches into retryable
 * `connector_instance_busy` failures. F1 therefore has to forbid
 * SIDE-EFFECTING READS, not merely direct writes. A planner that "only reads"
 * but whose read reconciles is a writer. Keeping this function pure is how
 * the module makes that structurally true for its own surface.
 */
export function evaluateTransition(request: TransitionRequest): TransitionDecision {
  if (request.actor === "planner") {
    // F1. The planner reads the machine and emits intents; it never writes
    // run state. There is no write path to guard because there is no write
    // path at all.
    return { legal: false, reason: "actor_may_not_write" };
  }

  if (isTerminalRunState(request.from)) {
    // F7. Terminal means terminal. This makes revising `records_emitted`
    // after a terminal event structurally impossible rather than forbidden
    // by convention.
    return { legal: false, reason: "run_already_terminal" };
  }

  const matching = LEGAL_TRANSITIONS.filter((rule) => rule.to === request.to && rule.from.includes(request.from));
  if (matching.length === 0) {
    return { legal: false, reason: "illegal_transition" };
  }

  const permitted = matching.find((rule) => rule.actor === request.actor);
  if (!permitted) {
    // F4. The boot path may not record an interrupted run as `failed`: of 134
    // production runs recorded as run.failed/controller_restarted, 55 had
    // staged a cursor and 34 had durably ingested a batch. Interruption is
    // not observed failure, and the two carry different remedies.
    return { legal: false, reason: "actor_may_not_perform_transition" };
  }

  return { legal: true, rule: permitted };
}

/** Every state a run may legally move to from `from`, for a given actor. */
export function legalTargetsFrom(from: RunState, actor: TransitionActor): readonly RunState[] {
  return RUN_STATES.filter((to) => evaluateTransition({ actor, from, to }).legal);
}

export interface TransitionStatement {
  readonly params: readonly unknown[];
  readonly sql: string;
}

export interface TransitionStatementInput {
  readonly completedAt: string | null;
  readonly connectorInstanceId: string;
  readonly expectedState: RunState;
  /** The actor's own epoch. The fence. */
  readonly ownerEpoch: string;
  readonly runId: string;
  readonly targetState: RunState;
  readonly terminalReason: string | null;
}

/**
 * Render the epoch-fenced compare-and-swap for a normal transition (T1-T9).
 *
 * Four properties of this predicate are load-bearing:
 *
 *  1. `changes`/`rowCount` = 0 means the transition was REFUSED, and the
 *     caller must treat that as an ordinary outcome. It is never retried
 *     blindly and never escalated to the owner.
 *  2. `connector_instance_id` is part of the fence, not decoration. `run_id`
 *     alone is not unique across connections — two connections can
 *     independently mint the same run_id, confirmed live — so a bare
 *     `WHERE run_id = ?` could finalize a DIFFERENT connection's row.
 *  3. The NULL arm is spelled `(owner_epoch = ? OR owner_epoch IS NULL)`,
 *     never `IS DISTINCT FROM`. On PostgreSQL `owner_epoch IS DISTINCT FROM
 *     NULL` reduces to `owner_epoch IS NOT NULL`, which would spare exactly
 *     the legacy rows that most need claiming. The sibling owner-epoch change
 *     was bitten by precisely this. The explicit spelling is identical on
 *     both backends and cannot silently reduce.
 *  4. The NULL arm is OR, not AND. A legacy row written before the column
 *     existed has no claimant, so any epoch may adjudicate it. A row WITH a
 *     different epoch may not.
 *
 * `placeholder` differs only in dialect (`?` vs `$n`); the predicate's shape
 * is identical, which is what keeps the two backends from disagreeing.
 *
 * One dialect difference is NOT abstracted away, because pretending it does
 * not exist is what produced a real defect here: PostgreSQL can reference one
 * bound parameter twice (`$7` in both the SET and the WHERE), while SQLite's
 * positional `?` consumes a fresh value per occurrence. Binding the epoch
 * once and interpolating it twice therefore worked on PostgreSQL and threw
 * "Too few parameter values were provided" on SQLite. `bind` is called once
 * per OCCURRENCE in SQL text order for exactly this reason.
 */
export function buildTransitionStatement(
  input: TransitionStatementInput,
  dialect: "sqlite" | "postgres"
): TransitionStatement {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return dialect === "postgres" ? `$${params.length}` : "?";
  };

  const status = bind(toDurableStatus(input.targetState));
  const completedAt = bind(input.completedAt);
  const terminalReason = bind(input.terminalReason);
  // Bound per occurrence, in SQL text order: the SET clause writes the
  // claimant's epoch, the WHERE clause fences on it.
  const epochForSet = bind(input.ownerEpoch);
  const runId = bind(input.runId);
  const connectorInstanceId = bind(input.connectorInstanceId);
  const expected = bind(toDurableStatus(input.expectedState));
  const epochForFence = bind(input.ownerEpoch);

  const sql = `UPDATE run_history
   SET status = ${status},
       completed_at = ${completedAt},
       terminal_reason = ${terminalReason},
       owner_epoch = ${epochForSet}
 WHERE run_id = ${runId}
   AND connector_instance_id = ${connectorInstanceId}
   AND status = ${expected}
   AND (owner_epoch = ${epochForFence} OR owner_epoch IS NULL)`;

  return { params, sql };
}

export interface AdjudicationStatementInput {
  readonly completedAt: string;
  readonly connectorInstanceId: string;
  readonly expectedState: RunState;
  /** The adjudicating (newest) boot epoch. */
  readonly myEpoch: string;
  readonly runId: string;
  readonly terminalReason: string;
}

/**
 * Render the compare-and-swap for successor adjudication (T10/T11).
 *
 * This INVERTS arm 4 of the normal predicate: it must match rows whose epoch
 * is NOT the actor's, because an orphan by definition belongs to a retired
 * epoch. It additionally excludes the newest boot epoch so live work is never
 * adjudicated.
 *
 * The newest-epoch exclusion is not a nicety. Without it, adjudication
 * declares live work abandoned and frees its resource for a competing run,
 * reintroducing the duplicate-execution hazard the fence exists to prevent.
 * The production dry run reported 123 rows before the exclusion and 121
 * after; the two extras were runs a live container had started ninety seconds
 * earlier.
 *
 * Eligibility is decided by EPOCH COMPARISON, never by an age threshold. A
 * very old run in the newest epoch must stay untouched, and a very recent run
 * in a retired epoch must be adjudicated. Age is not the discriminator.
 */
export function buildAdjudicationStatement(
  input: AdjudicationStatementInput,
  dialect: "sqlite" | "postgres"
): TransitionStatement {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return dialect === "postgres" ? `$${params.length}` : "?";
  };

  const status = bind(toDurableStatus("abandoned"));
  const completedAt = bind(input.completedAt);
  const terminalReason = bind(input.terminalReason);
  // Bound per occurrence in SQL text order — see buildTransitionStatement for
  // why binding once and interpolating twice is a dual-backend defect.
  const epochForSet = bind(input.myEpoch);
  const runId = bind(input.runId);
  const connectorInstanceId = bind(input.connectorInstanceId);
  const expected = bind(toDurableStatus(input.expectedState));
  const epochForFence = bind(input.myEpoch);

  // `records_emitted` is deliberately absent from the SET list. Records
  // durably ingested before the interruption stay committed; an abandon must
  // never rewrite a committed yield down.
  const sql = `UPDATE run_history
   SET status = ${status},
       completed_at = ${completedAt},
       terminal_reason = ${terminalReason},
       owner_epoch = ${epochForSet}
 WHERE run_id = ${runId}
   AND connector_instance_id = ${connectorInstanceId}
   AND status = ${expected}
   AND (owner_epoch IS NULL OR owner_epoch <> ${epochForFence})`;

  return { params, sql };
}

export type TransitionOutcome =
  | { readonly committed: true; readonly state: RunState }
  | { readonly committed: false; readonly reason: RefusalReason };

/**
 * Interpret a compare-and-swap result.
 *
 * A refusal must be DISTINGUISHABLE from a success by the caller. A refusal
 * that looks like success is how the collector-runner drain produced a false
 * "empty" exit: two clock reads with opposite boundary semantics let a
 * deadline landing between them look like nothing to do. The caller has to be
 * able to tell "I moved it" from "someone else already did".
 */
export function interpretCasResult(changedRows: number, targetState: RunState): TransitionOutcome {
  if (changedRows > 0) {
    return { committed: true, state: targetState };
  }
  return { committed: false, reason: "cas_lost" };
}
