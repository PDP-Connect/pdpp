// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The closed run-lifecycle state set — declared exactly once (D3).
 *
 * This module has NO imports. That is load-bearing, not stylistic: the
 * vocabulary has to be readable from `lib/` (spine, controller-boot), from
 * `server/` (db, postgres-storage, the stores) and from `runtime/` without
 * any of them forming a cycle. `lib/spine.ts` already imports `server/db.ts`,
 * so the declaration cannot live there and be imported back. The precedent is
 * `runtime/recovery-reason-codes.ts`, which is a dependency-free vocabulary
 * leaf for the same reason.
 *
 * Why a single declaration is the whole point
 * -------------------------------------------
 * `lib/spine.ts` already declared a canonical terminal set, and its own
 * comment said "All run-status projection code must read from this set; never
 * hardcode subset checks". It was not exported. Six other declarations were
 * then written by hand, and they disagree:
 *
 *   omitting `run.abandoned` (SQLite-side and shared):
 *     server/connector-summary-read-model.ts, server/db.ts
 *     (SPINE_TERMINAL_EVENT_TYPES_SQL), server/postgres-storage.ts,
 *     server/connector-summary-evidence-engine.ts
 *   omitting `run.browser_surface_failed` (PostgreSQL-side):
 *     lib/postgres-spine.ts, server/postgres-storage.ts
 *
 * The two backends therefore omitted DIFFERENT members, so SQLite and
 * PostgreSQL disagreed about what "terminal" means. The observable cost: an
 * abandoned run was invisible to the connector-summary fold, which is exactly
 * the population successor adjudication produces.
 *
 * A comment asking two constants to stay in sync is not a mechanism. An
 * exported constant is.
 */

/**
 * The nine run states. Terminal states have no outgoing transitions.
 *
 * `pending` is the only addition to the existing vocabulary; it exists so
 * admission has a durable pre-state to compare-and-swap against. Everything
 * else is already a `run_history.status` literal produced by the terminal
 * event fold.
 *
 * `awaiting_interaction` and `cancel_requested` project onto the durable
 * status `running` (see `toDurableStatus`) so no existing reader changes.
 * They are named because the machine must be able to REFUSE transitions out
 * of them.
 */
export const RUN_STATES = [
  "pending",
  "running",
  "awaiting_interaction",
  "cancel_requested",
  "succeeded",
  "failed",
  "surface_failed",
  "cancelled",
  "abandoned",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * The terminal subset. Derived from one place; every consumer reads this.
 *
 * `surface_failed` is terminal PRE-LAUNCH: the connector never receives a
 * browser surface, so no later `run.failed` arrives from connector execution
 * to repair the projection. Omitting it (as two PostgreSQL-side declarations
 * did) strands those runs non-terminal.
 *
 * `abandoned` is distinct from `failed` and must stay distinct. Of 134
 * production runs recorded as `run.failed`/`controller_restarted`, 55 had
 * staged a cursor and 34 had durably ingested a batch. Interruption is not
 * observed failure; the two carry different remedies.
 */
export const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>([
  "succeeded",
  "failed",
  "surface_failed",
  "cancelled",
  "abandoned",
]);

/** Non-terminal states, derived — never written down a second time. */
export const NON_TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set<RunState>(
  RUN_STATES.filter((state) => !TERMINAL_RUN_STATES.has(state))
);

export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalRunState(state: RunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

/**
 * The canonical terminal spine event types, derived from the state set rather
 * than listed independently. This is the set `lib/spine.ts` declared privately
 * and six other sites re-typed by hand.
 */
export const TERMINAL_RUN_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
]);

/** Stable ordering for SQL rendering, so generated literals are diffable. */
export const TERMINAL_RUN_EVENT_TYPE_LIST: readonly string[] = [
  "run.completed",
  "run.failed",
  "run.browser_surface_failed",
  "run.cancelled",
  "run.abandoned",
];

/**
 * The terminal event set rendered as a SQL `IN (...)` list body.
 *
 * Every SQL site that used to hand-type this literal calls this instead, so
 * adding a terminal state is one edit. Both backends call the same function,
 * which is what makes a backend-specific omission unrepresentable.
 *
 * Quoting is safe by construction: the members are compile-time constants in
 * this module, not caller input.
 */
export function terminalRunEventTypesSqlList(): string {
  return TERMINAL_RUN_EVENT_TYPE_LIST.map((type) => `'${type}'`).join(", ");
}

/** The same list wrapped in parentheses, for `event_type IN ${...}`. */
export function terminalRunEventTypesSqlGroup(): string {
  return `(${terminalRunEventTypesSqlList()})`;
}

/**
 * Map a terminal spine event type to the run state it projects to.
 *
 * Mirrors `toTerminalStatus` in server/stores/run-history-writer.ts, which
 * remains the durable writer. Declared here so the mapping is derivable from
 * the vocabulary rather than re-derived per call site.
 */
export function terminalStateForEventType(eventType: string): RunState | null {
  switch (eventType) {
    case "run.completed":
      return "succeeded";
    case "run.failed":
      return "failed";
    case "run.browser_surface_failed":
      return "surface_failed";
    case "run.cancelled":
      return "cancelled";
    case "run.abandoned":
      return "abandoned";
    default:
      return null;
  }
}

/**
 * The durable `run_history.status` projection of a machine state.
 *
 * `awaiting_interaction` and `cancel_requested` are machine states that carry
 * no separate durable status: they project onto `running` so that existing
 * readers, which filter `status <> 'running'`, see exactly what they saw
 * before. Introducing new status literals here would be an observable
 * behavior change, which D14 forbids for this refactor.
 */
export function toDurableStatus(state: RunState): string {
  if (state === "awaiting_interaction" || state === "cancel_requested") {
    return "running";
  }
  return state;
}

/**
 * `skipped` is deliberately NOT a run state.
 *
 * The scheduler writes it to `run_history.status` for attempts that never
 * started a run (scheduler/pre-run-gate.ts, scheduler/run-executor.ts). A
 * skipped attempt has no `run.started` event and no run to transition — it is
 * a DISPATCH OUTCOME, which is planner territory under D4.
 *
 * Recording it in the same column as run state is how scheduler-generated
 * `status:"skipped"` rows fed back into health classification (the Gmail
 * identity self-poisoning loop). The planner keeps writing it; the machine
 * must never read it as a run state. This predicate is how readers say so.
 */
export const DISPATCH_OUTCOME_STATUSES: ReadonlySet<string> = new Set(["skipped"]);

export function isDispatchOutcomeStatus(status: string): boolean {
  return DISPATCH_OUTCOME_STATUSES.has(status);
}
