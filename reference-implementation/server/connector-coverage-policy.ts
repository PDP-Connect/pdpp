// Pure manifest accepted-coverage policy pickers shared by the connection-health
// coverage projection in `ref-control.ts`. A manifest stream may declare that an
// absence is *accepted* (unsupported / unavailable / deferred / inventory_only)
// rather than a gap; these helpers read that declaration off the manifest and
// resolve the most-precise policy by a fixed precedence.
//
// The functions type against a minimal structural manifest-stream shape rather
// than the full control-plane `ManifestStream` interface — keeping this a leaf
// module extracted from the `ref-control.ts` god-file with no dependency on its
// projection types.
//
// The per-stream coverage-condition derivation (SKIP_RESULT reason mapping +
// `deriveStreamCoverageCondition`) also lives here: it is the read-side coverage
// classification that the pickers feed. It reads the runtime fact shapes
// type-only (erased at runtime, so no module cycle with ref-control.ts).

import type { CoverageAxis } from "../runtime/connection-health.ts";
import type { RuntimeCollectionFact, RuntimeCollectionFactSkip } from "./ref-control.ts";

/** Accepted-coverage policy a manifest stream may declare for an absence. */
export type AcceptedCoveragePolicy = "deferred" | "inventory_only" | "unavailable" | "unsupported";

export type CoverageEvidenceStrategy =
  | "checkpoint_window"
  | "full_inventory"
  | "parent_detail_accounting"
  | "snapshot_import_receipt"
  | "singleton_presence";

export type FreshnessEvidenceStrategy =
  | "device_heartbeat"
  | "manual_as_of"
  | "not_trackable"
  | "scheduled_window"
  | "source_reported_as_of";

/** The minimal manifest-stream shape the coverage-policy pickers read. */
export interface AcceptedCoverageStream {
  coverage_policy?: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported";
  coverage_strategy?: CoverageEvidenceStrategy;
  freshness_strategy?: FreshnessEvidenceStrategy;
  required?: boolean;
}

/**
 * Precedence: `unsupported` is the strongest accepted-coverage claim
 * (connector cannot collect by design), then `unavailable` (source-side
 * limit), then `deferred` (intentionally postponed), then
 * `inventory_only` (least surprising — only inventory was ever owed).
 */
const ACCEPTED_COVERAGE_PRECEDENCE: readonly AcceptedCoveragePolicy[] = [
  "unsupported",
  "unavailable",
  "deferred",
  "inventory_only",
];

export function pickAcceptedCoverage(streams: readonly AcceptedCoverageStream[]): AcceptedCoveragePolicy | null {
  if (streams.length === 0) {
    return null;
  }
  const seen = new Set<AcceptedCoveragePolicy>();
  for (const stream of streams) {
    const policy = readAcceptedCoveragePolicy(stream);
    if (policy !== null) {
      seen.add(policy);
    }
  }
  for (const policy of ACCEPTED_COVERAGE_PRECEDENCE) {
    if (seen.has(policy)) {
      return policy;
    }
  }
  return null;
}

/**
 * Same precedence as `pickAcceptedCoverage`, but only considers streams
 * that are *both* declared `required: true` AND have an accepted-
 * coverage policy. This is the contradictory-manifest signal: the
 * connector simultaneously claims the stream is load-bearing AND
 * accepted-absent, so the projection refuses to project healthy.
 */
export function pickRequiredAcceptedCoverage(
  streams: readonly AcceptedCoverageStream[]
): AcceptedCoveragePolicy | null {
  if (streams.length === 0) {
    return null;
  }
  const seen = new Set<AcceptedCoveragePolicy>();
  for (const stream of streams) {
    if (!isRequiredStream(stream)) {
      continue;
    }
    const policy = readAcceptedCoveragePolicy(stream);
    if (policy !== null) {
      seen.add(policy);
    }
  }
  for (const policy of ACCEPTED_COVERAGE_PRECEDENCE) {
    if (seen.has(policy)) {
      return policy;
    }
  }
  return null;
}

export function readAcceptedCoveragePolicy(stream: AcceptedCoverageStream | undefined): AcceptedCoveragePolicy | null {
  if (!stream || typeof stream !== "object") {
    return null;
  }
  const value = stream.coverage_policy;
  if (value === "unsupported" || value === "unavailable" || value === "deferred" || value === "inventory_only") {
    return value;
  }
  return null;
}

export function readCoverageEvidenceStrategy(
  stream: AcceptedCoverageStream | undefined
): CoverageEvidenceStrategy | null {
  if (!stream || typeof stream !== "object") {
    return null;
  }
  const value = stream.coverage_strategy;
  return value === "checkpoint_window" ||
    value === "full_inventory" ||
    value === "parent_detail_accounting" ||
    value === "snapshot_import_receipt" ||
    value === "singleton_presence"
    ? value
    : null;
}

export function readFreshnessEvidenceStrategy(
  stream: AcceptedCoverageStream | undefined
): FreshnessEvidenceStrategy | null {
  if (!stream || typeof stream !== "object") {
    return null;
  }
  const value = stream.freshness_strategy;
  return value === "device_heartbeat" ||
    value === "manual_as_of" ||
    value === "not_trackable" ||
    value === "scheduled_window" ||
    value === "source_reported_as_of"
    ? value
    : null;
}

export function isRequiredStream(stream: AcceptedCoverageStream | undefined): boolean {
  if (!stream || typeof stream !== "object") {
    return false;
  }
  // Default to required when absent so a manifest-declared stream is
  // load-bearing unless explicitly opted out.
  return stream.required !== false;
}

function checkpointProvesCoverage(checkpoint: string | null): boolean {
  return checkpoint === "committed" || checkpoint === "disabled";
}

function strategyCanProveCoverageWithoutDenominator(strategy: CoverageEvidenceStrategy | null): boolean {
  return (
    strategy === "checkpoint_window" ||
    strategy === "full_inventory" ||
    strategy === "snapshot_import_receipt" ||
    strategy === "singleton_presence"
  );
}

const RETRYABLE_SKIP_REASON_PATTERN = /(429|rate|temporar|retry|upstream_pressure|pressure)/;
const DEFERRED_SKIP_REASON_PATTERN = /(out_of_scope|user_disabled|deferred|paused|postpon)/;
const UNAVAILABLE_SKIP_REASON_PATTERN = /(unavailable|not_available|blocked|locked|upstream)/;
const UNSUPPORTED_SKIP_REASON_PATTERN = /(unsupported|not_supported|capability|incapable)/;

/**
 * Map a `SKIP_RESULT` reason / recovery action to a coverage condition that is
 * consistent with the skip and is NEVER `complete`. A retryable skip (transient
 * upstream pressure, or a `retry_by_runtime` recovery action) reads `retryable_gap`;
 * an intentionally-deferred or out-of-scope skip reads `deferred`; an
 * upstream-unavailable skip reads `unavailable`; a connector-cannot-collect skip
 * reads `unsupported`; anything else with no recovery path reads `terminal_gap`.
 * The manifest's declared `coverage_policy` (an accepted-coverage claim) takes
 * precedence over this inference and is applied by the caller.
 */
export function mapSkipCoverageCondition(skip: RuntimeCollectionFactSkip): CoverageAxis {
  const reason = skip.reason.toLowerCase();
  if (skip.recovery_action === "retry_by_runtime") {
    return "retryable_gap";
  }
  if (RETRYABLE_SKIP_REASON_PATTERN.test(reason)) {
    return "retryable_gap";
  }
  if (DEFERRED_SKIP_REASON_PATTERN.test(reason)) {
    return "deferred";
  }
  if (UNAVAILABLE_SKIP_REASON_PATTERN.test(reason)) {
    return "unavailable";
  }
  if (UNSUPPORTED_SKIP_REASON_PATTERN.test(reason)) {
    return "unsupported";
  }
  return "terminal_gap";
}

/**
 * Derive one stream's coverage condition from its runtime fact entry plus the
 * stream's manifest policy. Precedence (first match wins), mirroring the
 * evidence order the contract requires:
 *
 *   1. contradictory manifest (required AND accepted-absent)  -> the accepted axis
 *   2. SKIP_RESULT present  -> manifest accepted-coverage axis, else skip-derived axis
 *   3. pending recoverable detail gap(s)  -> `retryable_gap`
 *   4. known considered denominator  -> `partial` (covered-or-collected < considered)
 *                                        else accepted axis / `complete`
 *   5. unknown considered denominator  -> accepted axis / strategy proof / `unknown`
 *
 * `complete` is reached ONLY when a known considered denominator is satisfied; a
 * collected-records / no-gaps / no-considered stream reads `unknown`, never
 * `complete`. Staleness is NEVER encoded here — it is a freshness axis the
 * disposition speaks to, not a coverage condition.
 */
export function deriveStreamCoverageCondition(
  fact: RuntimeCollectionFact,
  manifestStream: AcceptedCoverageStream | undefined
): CoverageAxis {
  const accepted = readAcceptedCoveragePolicy(manifestStream);
  // 1. A required stream that also declares an accepted-absent policy is a
  //    contradictory manifest; surface the accepted axis so it never paints
  //    green (the connection-level rollup refuses to go healthy for the same
  //    reason).
  if (accepted !== null && manifestStream && isRequiredStream(manifestStream)) {
    return accepted;
  }
  // 2. A skip is the connector's explicit statement that it did not collect the
  //    stream. The manifest's accepted-coverage claim wins; otherwise infer a
  //    skip-consistent, never-`complete` axis. When the same stream also carries
  //    a pending DETAIL_GAP, that durable retry contract wins over an otherwise
  //    terminal-looking diagnostic skip; unsupported/unavailable/deferred skip
  //    reasons stay precise and non-green.
  if (fact.skipped) {
    const skipCoverage = accepted ?? mapSkipCoverageCondition(fact.skipped);
    if (fact.pending_detail_gaps > 0 && skipCoverage === "terminal_gap") {
      return "retryable_gap";
    }
    return skipCoverage;
  }
  // 3. A pending recoverable detail gap is a retryable boundary.
  if (fact.pending_detail_gaps > 0) {
    return "retryable_gap";
  }
  // 4. A known considered denominator distinguishes `partial` from covered. The
  //    satisfying numerator is the connector-declared `covered` count when present
  //    (the in-boundary items the run accounted for: emitted +
  //    suppressed-because-unchanged), otherwise the raw `collected` count. The
  //    `covered` path is what lets a steady-state full-sync run — which
  //    re-enumerated its whole boundary and emitted nothing because every record
  //    was unchanged — read `complete` instead of a false `partial`. It cannot
  //    mask a dropped record: a weighed-but-dropped item is counted in neither
  //    `collected` nor `covered`, so a real shortfall still reads `partial`.
  if (fact.considered !== null) {
    const satisfied = fact.covered ?? fact.collected;
    if (satisfied < fact.considered) {
      return "partial";
    }
    // The numerator satisfies the considered denominator: covered. A declared
    // accepted-coverage policy (e.g. `inventory_only`, `deferred`) is the more
    // precise honest claim than a bare `complete`.
    return accepted ?? "complete";
  }
  // 5. No considered denominator: absence of evidence, NOT proof of completeness.
  //    A declared accepted-coverage policy is still precise (the manifest owes no
  //    further data). A declared coverage evidence strategy can also prove a
  //    bounded stream complete when the runtime committed that stream's boundary:
  //    the proof is the strategy + checkpoint, not `collected === considered`.
  if (accepted !== null) {
    return accepted;
  }
  const strategy = readCoverageEvidenceStrategy(manifestStream);
  if (strategyCanProveCoverageWithoutDenominator(strategy) && checkpointProvesCoverage(fact.checkpoint)) {
    return "complete";
  }
  return "unknown";
}
