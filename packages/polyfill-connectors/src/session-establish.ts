// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Session establishment: the runtime-owned window between browser acquisition
 * and collect(), where a connector's `ensureSession`/`probeSession` hooks run
 * and any failure is classified retryable-or-not.
 *
 * This module owns the establishment flow and its terminal-error
 * classification — including the post-submit credential-safety invariant: once
 * a connector reports (via `EnsureSessionArgs.onCredentialSubmit`) that a
 * saved credential has been submitted to the provider's real sign-in form,
 * every subsequently propagated fault is forced non-retryable regardless of
 * the connector's `retryablePattern`, so a scheduler redispatch can never
 * resubmit a stored password from a fresh process.
 *
 * `connector-runtime.ts` is the production consumer (see `runInBrowser`);
 * tests exercise the same exports through this module boundary.
 */

import type {
  AssistanceCompletionStatus,
  AssistanceRequest,
  InteractionRequest,
  InteractionResponse,
} from "@pdpp/connector-protocol";
import type { ProgressExtra } from "@pdpp/connector-protocol/connector-runtime-protocol";
import type { BrowserContext, Page } from "playwright";
import { manualAction } from "./browser-handoff.ts";
import type { CaptureSession } from "./fixture-capture.ts";
import { TerminalError, type TerminalErrorDetails } from "./terminal-error.ts";

export const DEFAULT_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|timeout/i;

/**
 * Mark a named session-establishment phase. Calling this updates the run's
 * last-establishment-progress marker (which the watchdog reads) and, when
 * capture is active, triggers a best-effort durable diagnostic capture for the
 * phase. Best-effort and bounded: a checkpoint SHALL NOT be able to hang the
 * watchdog and a failed capture never fails the run.
 */
export type SessionCheckpointFn = (label: string) => Promise<void>;

export interface EnsureSessionArgs {
  assist: (req: AssistanceRequest) => Promise<string>;
  capture: CaptureSession | null;
  /**
   * Mark a session-establishment phase (e.g. "sign-in-loaded", "email-submit",
   * "2fa-decision", "final-verify"). Resets the watchdog's no-progress deadline
   * and captures a phase diagnostic. Optional for connectors that do not adopt
   * checkpoints; the runtime still frames the window with its own checkpoints.
   */
  checkpoint: SessionCheckpointFn;
  completeAssistance: (
    assistanceRequestId: string,
    status: AssistanceCompletionStatus,
    extra?: { message?: string }
  ) => Promise<void>;
  context: BrowserContext;
  /** Credentials resolved by the runtime's declared setup auth strategy. */
  credentials: Readonly<Record<string, string>>;
  /**
   * Call this at the exact line `ensureSession` submits a saved credential to
   * the provider's real sign-in form (the `.click()`/`.fill()` that sends the
   * password) — not before, not after. Once called, any error `ensureSession`
   * subsequently throws is forced non-retryable by the runtime regardless of
   * `retryablePattern`: a fault that happens after a password has already
   * been typed into a live form must never cause a fresh process to redispatch
   * and resubmit that same password. Calling this has no effect on errors
   * thrown BEFORE the call — those still go through the ordinary
   * `retryablePattern` classification untouched.
   */
  onCredentialSubmit: () => void;
  page: Page;
  progress: (message: string, extra?: ProgressExtra) => Promise<void>;
  sendInteraction: (req: InteractionRequest) => Promise<InteractionResponse>;
}

export interface ProbeSessionArgs {
  context: BrowserContext;
  page: Page;
}

export interface SessionEstablishArgs {
  assist: EnsureSessionArgs["assist"];
  capture: CaptureSession | null;
  checkpoint: SessionCheckpointFn;
  completeAssistance: EnsureSessionArgs["completeAssistance"];
  context: BrowserContext;
  credentials?: EnsureSessionArgs["credentials"];
  name: string;
  page: Page;
  progress: EnsureSessionArgs["progress"];
  retryablePattern: RegExp;
  sendInteraction: EnsureSessionArgs["sendInteraction"];
}

function retryablePatternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

/**
 * `postSubmit` forces `retryable: false` unconditionally, WITHOUT consulting
 * `retryablePattern` at all — a saved credential was already submitted to the
 * provider's real sign-in form, so a fault occurring after that point can
 * never be safely retried from a fresh process, no matter what vocabulary the
 * error message happens to share with the connector's legitimate pre-submit
 * retry patterns (e.g. a bare "timeout" or a shared transport-error term).
 * This is the single point that closes the naming-collision defect class: it
 * decides "did the credential already go out" once, centrally, instead of
 * leaving every connector's regex to (fail to) encode that distinction.
 */
export function buildSessionEstablishTerminalError(
  name: string,
  message: string,
  retryablePattern: RegExp = DEFAULT_RETRYABLE_PATTERN,
  postSubmit = false
): TerminalErrorDetails {
  const terminalMessage = `${name}_session_failed: ${message}`;
  return {
    message: terminalMessage,
    retryable:
      !postSubmit &&
      (retryablePatternMatches(retryablePattern, message) ||
        retryablePatternMatches(retryablePattern, terminalMessage)),
  };
}

/**
 * Run whichever session-management flow the connector configured.
 * Throws TerminalError if the session is dead and we couldn't recover.
 *
 * Priority: ensureSession (automated re-auth) > probeSession (read-only
 * + manual_action fallback) > nothing (connector assumes session is live).
 *
 * The runtime frames the window with a `begin` checkpoint before delegating
 * and a `probe` checkpoint around the read-only probe path so the watchdog
 * has progress markers even for connectors that do not checkpoint themselves.
 */
export async function establishSession(
  hooks: {
    ensureSession: ((args: EnsureSessionArgs) => Promise<void>) | undefined;
    probeSession: ((args: ProbeSessionArgs) => Promise<boolean>) | undefined;
  },
  args: SessionEstablishArgs
): Promise<void> {
  const { ensureSession, probeSession } = hooks;
  const {
    assist,
    capture,
    checkpoint,
    completeAssistance,
    context,
    credentials = {},
    page,
    name,
    retryablePattern,
    sendInteraction,
    progress,
  } = args;

  await checkpoint("session-establish:begin");

  if (typeof ensureSession === "function") {
    // Set once `ensureSession` reports it has submitted a saved credential to
    // the provider's real sign-in form. Scoped to this one establishSession()
    // call — a fresh process gets a fresh `false`, which is correct: the
    // credential wasn't submitted yet IN THIS process, even if a prior
    // process's submission is what's being retried. That's exactly the case
    // this primitive exists to stop: this call is the resubmission risk.
    let credentialSubmitted = false;
    try {
      await ensureSession({
        assist,
        capture,
        checkpoint,
        completeAssistance,
        context,
        credentials,
        onCredentialSubmit: () => {
          credentialSubmitted = true;
        },
        page,
        sendInteraction,
        progress,
      });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const terminalError = buildSessionEstablishTerminalError(name, message, retryablePattern, credentialSubmitted);
      throw new TerminalError(terminalError.message, { retryable: terminalError.retryable, cause: err });
    }
  }

  if (typeof probeSession !== "function") {
    return;
  }
  await checkpoint("session-establish:probe");
  if (await probeSession({ context, page })) {
    return;
  }

  await manualAction(
    {
      page,
      reason: "login",
      message: `${name} session expired. Open the browser and re-authenticate, then continue.`,
      timeoutSeconds: 1800,
    },
    sendInteraction
  );
  await checkpoint("session-establish:probe-after-manual");
  if (await probeSession({ context, page })) {
    return;
  }

  throw new TerminalError(`${name}_session_required`);
}
