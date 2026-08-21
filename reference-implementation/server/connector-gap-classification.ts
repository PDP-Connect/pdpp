// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure known-gap classification predicates and run-level gap rollups shared by
// the connection-health coverage projection in `ref-control.ts`. The per-gap
// predicates take an opaque gap value (the runtime stamps these on terminal
// events as free-form objects) and return a primitive verdict; the run-level
// rollups fold a run's `known_gaps` / a connection's pending detail gaps into a
// single terminal/degrading/reason verdict. Extracted from `ref-control.ts` to
// keep that god-file focused on projection assembly rather than gap taxonomy.
// The run/gap summary shapes are imported type-only (erased at runtime, so no
// module cycle with ref-control.ts).

import type { ConnectorRunSummary, PendingDetailGapSummary } from "./ref-control.ts";

/**
 * A gap degrades health unless it is explicitly `informational` or
 * `recoverable`. An unreadable gap shape is treated as degrading so we never
 * silently paint over evidence we cannot classify.
 */
export function isDegradingKnownGap(gap: unknown): boolean {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return true;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const severity = (gap as { severity?: unknown }).severity;
  return severity !== "informational" && severity !== "recoverable";
}

/**
 * Read a gap's recovery-hint action string, whether the hint is a bare string
 * or a `{ action }` object. Returns `null` for any other shape.
 */
export function gapRecoveryAction(gap: unknown): string | null {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return null;
  }
  const hint = (gap as { recovery_hint?: unknown }).recovery_hint;
  if (typeof hint === "string") {
    return hint;
  }
  if (hint && typeof hint === "object" && !Array.isArray(hint)) {
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const action = (hint as { action?: unknown }).action;
    return typeof action === "string" ? action : null;
  }
  return null;
}

/**
 * Flatten a gap's `kind`/`reason`/`message` fields into a lowercase,
 * alphanumeric-normalised string for keyword matching.
 */
export function gapClassifierText(gap: unknown): string {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return "";
  }
  const fields = gap as { kind?: unknown; message?: unknown; reason?: unknown };
  return [fields.kind, fields.reason, fields.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

const OWNER_RECOVERABLE_GAP_RE = /\b(otp|mfa|2fa|manual|captcha|anti bot)\b/;
const OWNER_ASSISTANCE_TIMEOUT_GAP_RE =
  /\b(assistance timed out|assistance timeout|assistance_timed_out|owner assistance timed out|finish login|streaming companion)\b/;
const SOURCE_UNAVAILABLE_GAP_RE = /\bsource unavailable\b/;

/**
 * A gap the owner can clear by hand — an explicit `manual_action_required`
 * hint, or a message that mentions OTP/MFA/captcha/manual intervention.
 */
export function isOwnerRecoverableKnownGap(gap: unknown): boolean {
  if (gapRecoveryAction(gap) === "manual_action_required") {
    return true;
  }
  const text = gapClassifierText(gap);
  return OWNER_RECOVERABLE_GAP_RE.test(text) || OWNER_ASSISTANCE_TIMEOUT_GAP_RE.test(text);
}

/** A gap the runtime retries on its own (`retry_by_runtime` recovery hint). */
export function isRuntimeRetryableKnownGap(gap: unknown): boolean {
  return gapRecoveryAction(gap) === "retry_by_runtime";
}

/**
 * A source availability failure means the upstream source could not serve the
 * login/data surface. Old runtime versions could persist this as an actionable
 * connector failure with a stale credential-repair hint. Classify the durable
 * evidence itself as retryable so historical rows read the same way as fixed
 * runtime output.
 */
function isSourceUnavailableKnownGap(gap: unknown): boolean {
  return SOURCE_UNAVAILABLE_GAP_RE.test(gapClassifierText(gap));
}

/**
 * A gap that resolves without terminal owner intervention — owner-recoverable,
 * runtime-retryable, or `transient` severity.
 *
 * `transient` severity is the runtime's signal that the gap is actively being
 * re-tried without owner intervention. Per the connection-health coverage
 * policy, `recoverable` means the gap has already been recovered
 * (non-degrading) and `informational` means the gap is out of scope by design
 * (non-degrading); neither counts as a retryable gap for the coverage axis
 * rollup.
 */
export function isRetryableKnownGap(gap: unknown): boolean {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return false;
  }
  if (isOwnerRecoverableKnownGap(gap)) {
    return true;
  }
  if (isRuntimeRetryableKnownGap(gap)) {
    return true;
  }
  if (isSourceUnavailableKnownGap(gap)) {
    return true;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const severity = (gap as { severity?: unknown }).severity;
  return severity === "transient";
}

/** True when a run carries at least one degrading known-gap. */
export function hasDegradingKnownGap(run: ConnectorRunSummary | null): boolean {
  if (!run) {
    return false;
  }
  return run.known_gaps.some(isDegradingKnownGap);
}

/** The set of stream names that have a pending detail gap. */
export function pendingDetailGapStreams(gaps: readonly PendingDetailGapSummary[] = []): ReadonlySet<string> {
  const streams = new Set<string>();
  for (const gap of gaps) {
    if (gap && typeof gap.stream === "string" && gap.stream.length > 0) {
      streams.add(gap.stream);
    }
  }
  return streams;
}

export function filterRequiredStreamEvidence<T>(
  evidence: readonly T[],
  streamOf: (item: T) => unknown,
  isRequired: (stream: unknown) => boolean
): T[] {
  return evidence.filter((item) => {
    const stream = streamOf(item);
    return typeof stream !== "string" || isRequired(stream);
  });
}

export function filterRunCoverageEvidence(
  run: ConnectorRunSummary | null,
  pendingDetailGaps: readonly PendingDetailGapSummary[],
  isRequired: (stream: unknown) => boolean
): { readonly run: ConnectorRunSummary | null; readonly pendingDetailGaps: PendingDetailGapSummary[] } {
  const filteredPending = filterRequiredStreamEvidence(pendingDetailGaps, (gap) => gap.stream, isRequired);
  if (!run) {
    return { pendingDetailGaps: filteredPending, run: null };
  }
  const filteredGaps = filterRequiredStreamEvidence(
    run.known_gaps,
    (gap) => (gap && typeof gap === "object" && !Array.isArray(gap) ? (gap as { stream?: unknown }).stream : null),
    isRequired
  );
  return { pendingDetailGaps: filteredPending, run: { ...run, known_gaps: filteredGaps } };
}

export function isKnownSkipShadowedByPendingDetailGap(gap: unknown, pendingStreams: ReadonlySet<string>): boolean {
  if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
    return false;
  }
  const knownGap = gap as { kind?: unknown; stream?: unknown };
  if (knownGap.kind !== "skip_result" || typeof knownGap.stream !== "string" || !pendingStreams.has(knownGap.stream)) {
    return false;
  }
  const action = gapRecoveryAction(gap);
  // A stream-level SKIP_RESULT is only a diagnostic when the same stream has a
  // pending DETAIL_GAP: the detail gap is the durable retry contract. Do not let
  // an older skip with an absent/unknown hint turn that retryable contract into
  // terminal/code-fix. Explicit owner/maintainer actions remain load-bearing.
  return action === null || action === "unknown" || action === "retry_by_runtime";
}

/**
 * Decide whether `run.known_gaps` contains at least one *terminal* gap —
 * one whose severity is `actionable` (owner-fixable, no automated retry)
 * or unclassified. `transient` gaps are runtime-retried so they roll up
 * under `retryable_gap` instead. `informational` and `recoverable`
 * gaps don't degrade health per the connection-health coverage policy
 * and are ignored here.
 */
export function hasTerminalKnownGap(
  run: ConnectorRunSummary | null,
  pendingDetailGaps: readonly PendingDetailGapSummary[] = []
): boolean {
  if (!run) {
    return false;
  }
  const pendingStreams = pendingDetailGapStreams(pendingDetailGaps);
  return run.known_gaps.some((gap) => {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      // Unclassified gap shape — be conservative and treat as terminal so
      // we never silently paint over evidence we can't read.
      return true;
    }
    if (isKnownSkipShadowedByPendingDetailGap(gap, pendingStreams)) {
      return false;
    }
    if (isOwnerRecoverableKnownGap(gap)) {
      return false;
    }
    if (isRuntimeRetryableKnownGap(gap)) {
      return false;
    }
    if (isSourceUnavailableKnownGap(gap)) {
      return false;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const severity = (gap as { severity?: unknown }).severity;
    if (severity === "actionable") {
      return true;
    }
    // Any other unknown severity counts as terminal (conservative);
    // recognized non-degrading and retryable severities are not terminal.
    return severity !== "informational" && severity !== "recoverable" && severity !== "transient";
  });
}

export function firstPendingDetailGapReason(gaps: readonly PendingDetailGapSummary[] = []): string | null {
  for (const gap of gaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      continue;
    }
    if (typeof gap.reason === "string" && gap.reason.length > 0) {
      return gap.reason;
    }
    if (typeof gap.stream === "string" && gap.stream.length > 0) {
      return `detail_gap:${gap.stream}`;
    }
  }
  return gaps.length > 0 ? "detail_gap_pending" : null;
}

export function firstDegradingKnownGapReason(run: ConnectorRunSummary | null): string | null {
  if (!run) {
    return null;
  }
  for (const gap of run.known_gaps) {
    if (!gap || typeof gap !== "object" || Array.isArray(gap)) {
      return null;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const severity = (gap as { severity?: unknown }).severity;
    if (severity === "informational" || severity === "recoverable") {
      continue;
    }
    // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
    const reason = (gap as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason;
    }
  }
  return null;
}

// ─── Durable unfillable-gap proof (§10-A / `unfillableAccounted`) ─────────────
//
// A `connector_detail_gaps` row this predicate reads. Matches the projected
// `DetailGap.last_error` shape (`server/stores/connector-detail-gap-store.ts`
// `rowToGap`) — the durable, actively-written field. `policy_disposition_json`
// exists on a handful of legacy rows from an abandoned branch but no shipped
// writer populates it, so it is deliberately NOT read here; resurrecting an
// unmaintained column would make the classifier depend on evidence no current
// code path can reproduce for a new gap.
export interface TerminalGapProofRow {
  readonly last_error?: unknown;
  readonly status?: unknown;
}

const OBSERVED_EXCEEDS_LIMIT_MESSAGE_RE = /exceeds max size:\s*(\d+)\s*>\s*(\d+)\s*bytes/i;

/**
 * True when a single terminal gap row carries durable, per-item proof that the
 * item can never be collected — a recorded observed size strictly greater than
 * a recorded cap, both present in the same error record. This is deliberately
 * narrow: an attempt count, a bare error class with no numbers, or a message
 * that fails to parse are NOT proof, however many times the item was retried.
 *
 * The message format (`"... exceeds max size: <observed> > <limit> bytes"`) is
 * `AttachmentTooLargeError`'s wire shape (`connectors/gmail/index.ts`) — a
 * connector-neutral convention, not a Gmail-specific string match, so any
 * connector that reports a byte-cap shortfall the same way is read the same
 * way. A `class: "too_large"` tag alone (no parseable numbers) is NOT proof —
 * the numbers are the evidence; the tag is only a hint of where to look.
 */
export function isProvenUnfillableGap(gap: TerminalGapProofRow | null | undefined): boolean {
  if (!gap || typeof gap !== "object") {
    return false;
  }
  const lastError = gap.last_error;
  if (!lastError || typeof lastError !== "object" || Array.isArray(lastError)) {
    return false;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property access documents the durable row shape being read.
  const message = (lastError as { message?: unknown }).message;
  if (typeof message !== "string") {
    return false;
  }
  const match = OBSERVED_EXCEEDS_LIMIT_MESSAGE_RE.exec(message);
  if (!match) {
    return false;
  }
  const observed = Number(match[1]);
  const limit = Number(match[2]);
  return Number.isFinite(observed) && Number.isFinite(limit) && observed > limit;
}

/**
 * Whether an entire stream's terminal detail gaps are unfillable-accounted:
 * at least one terminal gap exists AND every single one of them carries
 * durable per-item impossibility proof ({@link isProvenUnfillableGap}). A
 * stream with even one unproven terminal gap (e.g. a retry-exhausted row with
 * no recorded size-vs-cap evidence) does NOT qualify — partial proof is not
 * proof, it is the false-green this predicate exists to refuse.
 *
 * Returns `false` for an empty gap list: "no terminal gaps" is not the same
 * claim as "coverage is unfillable-accounted" (the caller's coverage axis
 * would not be `terminal_gap` in that case anyway).
 */
export function isStreamFullyUnfillableAccounted(terminalGaps: readonly TerminalGapProofRow[]): boolean {
  return terminalGaps.length > 0 && terminalGaps.every(isProvenUnfillableGap);
}
