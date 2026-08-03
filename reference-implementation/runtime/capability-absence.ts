// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** The bounded skip facts that can prove a capability absence. */
export interface CapabilityAbsenceSkip {
  readonly recovery_action?: string;
  readonly recovery_retryable?: boolean;
  readonly severity?: string;
}

/** Minimal known-gap projection used when collection facts retain a skip. */
export interface KnownGapSkip {
  readonly reason?: string;
  readonly recovery_hint?: unknown;
  readonly severity?: string;
}

export function recoveryHintAction(recoveryHint: unknown): string | null {
  if (typeof recoveryHint === "string") {
    return recoveryHint;
  }
  if (!recoveryHint || typeof recoveryHint !== "object" || Array.isArray(recoveryHint)) {
    return null;
  }
  const action = (recoveryHint as { action?: unknown }).action;
  return typeof action === "string" ? action : null;
}

export function recoveryHintRetryable(recoveryHint: unknown): boolean | null {
  if (!recoveryHint || typeof recoveryHint !== "object" || Array.isArray(recoveryHint)) {
    return null;
  }
  const retryable = (recoveryHint as { retryable?: unknown }).retryable;
  return typeof retryable === "boolean" ? retryable : null;
}

/** Preserve the bounded action, retryability, and severity needed downstream. */
export function collectionFactSkipFromGap(gap: KnownGapSkip): CapabilityAbsenceSkip & { reason: string | undefined } {
  const action = recoveryHintAction(gap.recovery_hint);
  const retryable = recoveryHintRetryable(gap.recovery_hint);
  return {
    reason: gap.reason,
    ...(action ? { recovery_action: action } : {}),
    ...(retryable === null ? {} : { recovery_retryable: retryable }),
    ...(typeof gap.severity === "string" ? { severity: gap.severity } : {}),
  };
}

/** True only for an explicit browser-runtime capability declaration. */
export function isBrowserRuntimeCapability(recoveryHint: unknown, retryable: boolean): boolean {
  if (!recoveryHint || typeof recoveryHint !== "object" || Array.isArray(recoveryHint)) {
    return false;
  }
  const hint = recoveryHint as { action?: unknown; retryable?: unknown };
  return hint.action === "requires_browser_runtime" && hint.retryable === retryable;
}

/** A manifest-optional, informational, non-retryable capability absence. */
export function isAcceptedOptionalCapabilityAbsence(
  streamRequired: boolean | undefined,
  skipped: CapabilityAbsenceSkip | null | undefined
): boolean {
  return (
    streamRequired === false &&
    skipped?.recovery_action === "requires_browser_runtime" &&
    skipped.recovery_retryable === false &&
    skipped.severity === "informational"
  );
}

/** Whether terminal coverage is still load-bearing at the connection level. */
export function isLoadBearingTerminalCoverage(
  priority: string,
  coverage: "terminal_gap" | "unsupported" | "unavailable" | string
): boolean {
  return priority !== "accepted_absence" && (coverage === "terminal_gap" || coverage === "unsupported" || coverage === "unavailable");
}

/** Whether a terminal stream disposition still contributes to the connection. */
export function isLoadBearingTerminalDisposition(priority: string, disposition: string): boolean {
  return priority !== "accepted_absence" && disposition === "terminal";
}
