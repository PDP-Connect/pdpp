// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The paved road for "I need the owner to do something in the browser".
 *
 * ## Why this exists
 *
 * A connector that cannot finish sign-in alone asks the owner for help. There
 * are two ways to ask, and they are not equal:
 *
 *  1. **Detect-and-resume** — emit NON-BLOCKING assistance, then poll the
 *     connector's own success marker. The moment the marker appears the run
 *     resumes. The owner never confirms anything the connector could see.
 *  2. **Blocking Continue** — emit a `manual_action` INTERACTION and stop until
 *     the owner clicks. Only THEN re-check.
 *
 * Shape 2 makes the owner's click the trigger for a check the connector could
 * have run itself, so an owner who has already signed in successfully sits
 * clicking Continue on a login that demonstrably worked. That is a real
 * production event, on a live Venmo run.
 *
 * `chatgpt.ts` had solved this for its own flows. Venmo and Amazon had not —
 * and the reason is structural, not an oversight by whoever wrote them:
 * `requestManualLoginForChallenge` was defined TWICE, PRIVATELY (once in
 * venmo.ts, once in amazon.ts). There was no shared handoff layer, so the
 * handoff offered both shapes with no default and no enforcement, and a new
 * connector picked the footgun silently by writing the obvious thing.
 *
 * This module is that missing layer. The default is detect-and-resume.
 * Choosing the blocking path requires a DECLARED, TYPED justification that a
 * conformance test can see — see {@link UnobservableJustification}.
 *
 * ## Why the poll checkpoints on EVERY iteration
 *
 * The session-establishment watchdog fails a run that makes no progress for its
 * deadline (120s by default). An observation budget deliberately exceeds that,
 * because it must cover realistic human latency. A poll that did not checkpoint
 * would convert a working assist into a watchdog kill — the run IS progressing
 * (it is actively probing readiness), and the watchdog cannot know that unless
 * told. So {@link pollForObservedLogin} checkpoints at the TOP of every
 * iteration. A genuinely wedged page whose probe hangs stops advancing the
 * checkpoint, so the watchdog still catches the failure it exists to catch.
 */

import type { AssistanceRequest, SessionCheckpointFn } from "../connector-runtime.ts";

/** Assistance completion status, mirrored from the runtime's own union. */
type AssistanceCompletionStatus = "escalated" | "resolved";

/**
 * The reasons a handoff genuinely cannot be settled by observation.
 *
 * This is a CLOSED union on purpose. A connector cannot invent a new excuse
 * inline; adding one is a deliberate edit to this file, which is where a
 * reviewer will look. Each member names a structural property of the state,
 * not a mood about it:
 *
 *  - `success_is_not_session_liveness` — the owner's completion does NOT end in
 *    a live session, so a liveness probe is the wrong question entirely.
 *    Venmo's DataDome interstitial is the case: clearing the bot check makes
 *    the SIGN-IN FORM appear. The connector must then still type the password.
 *    Polling for liveness there would burn the whole budget waiting for a state
 *    that cannot arrive until the connector acts.
 *  - `owner_supplies_a_secret` — resolution requires a value only the owner
 *    holds (an OTP code). No probe can read it; asking is the honest path.
 *  - `no_success_marker_exists` — the connector has no reachable signal that
 *    distinguishes success from failure for this state.
 */
export type UnobservableReason =
  | "no_success_marker_exists"
  | "owner_supplies_a_secret"
  | "success_is_not_session_liveness";

/**
 * A declared, reviewable justification for taking the BLOCKING path.
 *
 * Required — not optional, not defaulted — by {@link requestOwnerBrowserAction}
 * whenever `observe` is absent. That is what makes the footgun unavailable by
 * accident: the blocking path cannot be reached without constructing one of
 * these, and `connector-conformance.test.ts` asserts every declaration is
 * well-formed and non-boilerplate.
 */
export interface UnobservableJustification {
  /**
   * What the connector actually looked at, and why that state cannot be
   * settled by a probe. Free text, but the conformance gate enforces a
   * minimum specificity so "n/a" or "TODO" cannot pass.
   */
  readonly evidence: string;
  readonly reason: UnobservableReason;
  /** Stable id for the handoff site, used by the conformance roster. */
  readonly site: string;
}

/** The connector-specific success marker. Present == the observable path. */
export interface ObservedLoginProbe<Result> {
  /**
   * Reads the connector's post-login success marker. Returns the result when
   * success is OBSERVED, or `null` when it is not yet.
   *
   * MUST NOT throw for an ordinary "not done yet" reading — that is a `null`.
   * A throw propagates, because a probe that cannot run at all is a real fault
   * the caller classifies (venmo's B4 transport-error naming depends on this).
   */
  readonly observe: () => Promise<Result | null>;
}

export interface ObservationBudget {
  readonly attempts: number;
  readonly intervalMs: number;
  /** Sleeps `ms`. Injected so tests advance a logical clock with no real sleep. */
  readonly wait: (ms: number) => Promise<void>;
}

/**
 * The two ways to ask the owner for help, as a discriminated union.
 *
 * There is no third option and no default-to-blocking: a call site either
 * supplies a probe (and gets detect-and-resume) or supplies a justification
 * (and gets the blocking ask). The type system makes the choice explicit at
 * every call site, which is precisely what was missing when venmo was written.
 */
export type OwnerBrowserActionMode<Result> =
  | {
      readonly kind: "observable";
      /** Budget and cadence for the observation window. */
      readonly budget: ObservationBudget;
      readonly probe: ObservedLoginProbe<Result>;
      /** Checkpoint label emitted on each poll iteration. */
      readonly waitingCheckpointLabel: string;
    }
  | {
      readonly kind: "unobservable";
      readonly justification: UnobservableJustification;
    };

export interface OwnerBrowserActionArgs<Result> {
  /** Emits non-blocking assistance; resolves to the assistance request id. */
  readonly assist?: ((req: AssistanceRequest) => Promise<string>) | undefined;
  /** Runs the blocking Continue ask. The fallback, never the default. */
  readonly blockingAsk: () => Promise<Result>;
  /**
   * Watchdog progress hook, called on EVERY poll iteration so a long-but-
   * progressing observation window does not trip the no-progress deadline.
   */
  readonly checkpoint?: SessionCheckpointFn | undefined;
  readonly completeAssistance?:
    | ((assistanceRequestId: string, status: AssistanceCompletionStatus, extra?: { message?: string }) => Promise<void>)
    | undefined;
  /** Owner-facing sentence. */
  readonly message: string;
  readonly mode: OwnerBrowserActionMode<Result>;
  /** Durable progress channel used when no `assist` hook is wired. */
  readonly progress?: ((message: string) => Promise<void>) | undefined;
}

/**
 * Poll a connector's success marker, checkpointing every iteration.
 *
 * Returns the observed result, or `null` when the budget is exhausted.
 *
 * The checkpoint is at the TOP of the loop, BEFORE the wait: the watchdog's
 * deadline must be reset before the gap that would otherwise exhaust it.
 * Checkpointing after the wait would leave one full interval of silence on the
 * first iteration.
 */
export async function pollForObservedLogin<Result>({
  budget,
  checkpoint,
  probe,
  waitingCheckpointLabel,
}: {
  readonly budget: ObservationBudget;
  readonly checkpoint?: SessionCheckpointFn | undefined;
  readonly probe: ObservedLoginProbe<Result>;
  readonly waitingCheckpointLabel: string;
}): Promise<Result | null> {
  for (let attempt = 0; attempt < budget.attempts; attempt += 1) {
    // Every iteration, unconditionally. See this module's header: the budget
    // exceeds the watchdog deadline by design, so a missed checkpoint here is
    // a killed run, not a slow one.
    await checkpoint?.(waitingCheckpointLabel);
    await budget.wait(budget.intervalMs);
    const observed = await probe.observe();
    if (observed !== null) {
      return observed;
    }
  }
  return null;
}

/**
 * Ask the owner to act in the browser — observing the outcome by default.
 *
 * THE PAVED ROAD. Every connector handoff goes through here. With
 * `mode.kind === "observable"` the ask is non-blocking and resolves the moment
 * the success marker appears; the blocking ask is the fallback for an expired
 * budget. With `mode.kind === "unobservable"` the blocking ask runs
 * immediately — and only a declared {@link UnobservableJustification} can
 * select that.
 */
export async function requestOwnerBrowserAction<Result>({
  assist,
  blockingAsk,
  checkpoint,
  completeAssistance,
  message,
  mode,
  progress,
}: OwnerBrowserActionArgs<Result>): Promise<Result> {
  if (mode.kind === "unobservable") {
    // Declared unobservable: there is nothing to watch for, so polling would
    // only delay the ask the owner has to answer anyway.
    return await blockingAsk();
  }

  // Detect-and-resume needs a NON-BLOCKING surface to put the ask on. Without
  // an `assist` channel there is none: the only way to reach the owner is the
  // blocking interaction, so polling first would delay their prompt by the
  // whole budget while showing them nothing. Ask immediately instead.
  if (!assist) {
    await progress?.(message);
    return await blockingAsk();
  }

  const assistanceRequestId = await assist(observedLoginAssistance(message, mode.budget));
  const observed = await pollForObservedLogin({
    budget: mode.budget,
    ...(checkpoint ? { checkpoint } : {}),
    probe: mode.probe,
    waitingCheckpointLabel: mode.waitingCheckpointLabel,
  });
  if (observed !== null) {
    await completeAssistance?.(assistanceRequestId, "resolved", {
      message: "Sign-in was observed to complete and the connector is continuing.",
    });
    return observed;
  }

  // Budget spent without observing success. Escalate the open assistance BEFORE
  // the blocking ask, so the owner's surface never shows a live non-blocking
  // assist and a blocking interaction for the same step at once.
  await completeAssistance?.(assistanceRequestId, "escalated", {
    message: "Sign-in did not complete automatically; falling back to explicit owner confirmation.",
  });
  return await blockingAsk();
}

/**
 * The non-blocking assistance envelope.
 *
 * `progress_posture: "running"` + `response_contract: "none"` is the pair the
 * runtime reads as "this does not block the watchdog and expects no answer"
 * (see `assistancePausesWatchdog` in connector-runtime.ts). Both are required:
 * either alone still reads as a blocking ask.
 */
function observedLoginAssistance(message: string, budget: ObservationBudget): AssistanceRequest {
  return {
    attachments: [{ kind: "browser_surface", role: "streaming_companion" }],
    message,
    owner_action: "operate_attachment",
    progress_posture: "running",
    response_contract: "none",
    sensitivity: "non_secret",
    timeout_seconds: Math.ceil((budget.attempts * budget.intervalMs) / 1000),
  };
}

/**
 * Resolve an observation budget in ms from an env override.
 *
 * A non-positive or unparseable override is IGNORED rather than honored: a
 * budget of 0 would silently disable detect-and-resume and put the owner
 * straight back on the Continue button.
 */
export function resolveObservationBudgetMs(env: NodeJS.ProcessEnv, variable: string, defaultMs: number): number {
  const raw = env[variable]?.trim();
  if (!raw) {
    return defaultMs;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!(Number.isFinite(parsed) && parsed > 0)) {
    return defaultMs;
  }
  return parsed;
}

/** Poll iteration count for a budget, always at least one. */
export function observationAttempts(budgetMs: number, intervalMs: number): number {
  return Math.max(1, Math.ceil(budgetMs / intervalMs));
}
