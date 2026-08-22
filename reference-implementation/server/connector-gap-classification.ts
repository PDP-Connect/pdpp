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
  const proof = readClaimedSizeProof(gap);
  return proof !== null && proof.claimedBytes > proof.limitBytes;
}

/**
 * The size a terminal gap CLAIMS was observed, and the cap it was measured
 * against, when the row carries a parseable size-vs-cap message. `null` when
 * the row records no such numbers — a bare `class: "too_large"` tag is a hint
 * of where to look, never evidence.
 */
export function readClaimedSizeProof(
  gap: TerminalGapProofRow | null | undefined
): { claimedBytes: number; limitBytes: number } | null {
  if (!gap || typeof gap !== "object") {
    return null;
  }
  const lastError = gap.last_error;
  if (!lastError || typeof lastError !== "object" || Array.isArray(lastError)) {
    return null;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property access documents the durable row shape being read.
  const message = (lastError as { message?: unknown }).message;
  if (typeof message !== "string") {
    return null;
  }
  const match = OBSERVED_EXCEEDS_LIMIT_MESSAGE_RE.exec(message);
  if (!match) {
    return null;
  }
  const claimedBytes = Number(match[1]);
  const limitBytes = Number(match[2]);
  if (!(Number.isFinite(claimedBytes) && Number.isFinite(limitBytes))) {
    return null;
  }
  return { claimedBytes, limitBytes };
}

/**
 * Why a `too_large` terminal gap may or may not be requeued.
 *
 *   - `fabricated_proof` — the row's claimed size is CONTRADICTED by the
 *     item's own recorded size, which is within the cap. The impossibility
 *     proof is false, so the row is safe to requeue.
 *   - `proof_holds` — the item's own recorded size is genuinely over the cap.
 *     Retrying can never converge. STAYS terminal.
 *   - `no_corroborating_record` — there is no recorded item size to compare
 *     against. Absence of contradiction is NOT proof of fabrication, so the
 *     row STAYS terminal and is reported separately.
 *   - `not_a_size_proof` — the row records no parseable size-vs-cap numbers
 *     at all, so this classifier has no opinion; it is not a `too_large`
 *     impossibility claim this tool can adjudicate.
 */
export type TooLargeProofVerdict = "fabricated_proof" | "no_corroborating_record" | "not_a_size_proof" | "proof_holds";

/**
 * Adjudicate one `too_large` terminal gap against the item's OWN recorded size.
 *
 * This exists because `too_large` proofs turned out to be forgeable by an
 * ordinary bug rather than by malice. Gmail's attachment hydrator briefly used
 * imapflow's `meta.expectedSize`, which is populated from the FETCH
 * `RFC822.SIZE` item — the size of the ENTIRE MESSAGE, identical for every part
 * of a multipart message. Checking a message-scoped size against a per-part cap
 * condemned every attachment of a message whenever their SUM crossed the cap.
 * On the owner's mailbox that produced 32 terminal rows sharing just 7 distinct
 * "observed" sizes, each ≈ the sum of that message's parts; the smallest item so
 * condemned was 3,080 bytes against a 26,214,400-byte cap. The connector was
 * fixed to use the per-part BODYSTRUCTURE size, but the rows it had already
 * written stayed terminal, and `isProvenUnfillableGap` reads them as durable
 * per-item impossibility proof — so the owner is told those emails are
 * permanently unrecoverable when they are collectible.
 *
 * The invariant this preserves: a row is requeued ONLY when its proof is
 * affirmatively contradicted by independent evidence. A row whose recorded size
 * really does exceed the cap keeps its terminal status, exactly as
 * `TERMINAL_REQUEUE_REASON_ALLOWLIST` intends — this does not weaken the
 * refusal of genuine impossibility, it refuses to honor a proof that is false.
 * Equally, a row with NO corroborating record is left terminal: "we cannot find
 * evidence against it" is not "we have evidence for it", and requeuing on
 * missing evidence would be the same fabrication in the opposite direction.
 *
 * `recordedSizeBytes` is the item's own durable size (for Gmail attachments,
 * `records.record_json->>'size_bytes'`), or `null`/undefined when no such
 * record exists.
 */
export function classifyTooLargeProof(
  gap: TerminalGapProofRow | null | undefined,
  recordedSizeBytes: number | null | undefined
): TooLargeProofVerdict {
  const proof = readClaimedSizeProof(gap);
  if (!proof) {
    return "not_a_size_proof";
  }
  if (typeof recordedSizeBytes !== "number" || !Number.isFinite(recordedSizeBytes)) {
    return "no_corroborating_record";
  }
  return recordedSizeBytes > proof.limitBytes ? "proof_holds" : "fabricated_proof";
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
