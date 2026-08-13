// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

import { evaluateStreamCoherence } from "@pdpp/reference-contract/evidence";

import type { CoverageAxis } from "../runtime/connection-health.ts";
export type { CoverageAxis } from "../runtime/connection-health.ts";
import { classifyContinuationCoverage, resolveSkippedCoverage } from "./continuation-proof.ts";
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
 * Classify a stream once no contradictory manifest, explicit skip, or pending
 * recoverable detail gap takes precedence. At this point coverage rests entirely
 * on whether the evidence envelope carries POSITIVE coverage evidence, which is
 * the shared contract invariant — delegated to
 * `@pdpp/reference-contract/evidence` so conformance tooling reaches the same
 * verdict on the same facts.
 *
 * The contract's `proven` verdict maps onto this axis as follows:
 *   - proven via `enumeration_boundary` / `accepted_absence` -> accepted axis
 *     else `complete` (a measured `considered: 0` is how a zero-result run
 *     legitimately proves verified emptiness);
 *   - `boundary_shortfall` -> `partial` (the numerator missed a known
 *     denominator);
 *   - `checkpoint_only` / `no_proof_strategy` -> the accepted axis when the
 *     manifest declares one, else `unknown`. A committed checkpoint alone is
 *     NOT coverage evidence, so it can no longer reach `complete`.
 */
function deriveGapFreeStreamCoverageCondition(
  fact: RuntimeCollectionFact,
  accepted: AcceptedCoveragePolicy | null,
  strategy: CoverageEvidenceStrategy | null
): CoverageAxis {
  const verdict = evaluateStreamCoherence(
    {
      checkpoint: fact.checkpoint,
      collected: fact.collected,
      // Defensive normalization: the type contract is `number | null`, but a
      // caller that bypasses `readRuntimeCollectionFact`'s re-validation could
      // hand this an `undefined` denominator, which must read as "no
      // denominator" rather than as a known one.
      considered: fact.considered ?? null,
      covered: fact.covered ?? null,
      // A local collector that reported per-stream statuses reaches this branch
      // only when every status was `collected` (the caller returns earlier
      // otherwise), so that is an affirmative observation of collection.
      //
      // `scoped: false` withdraws it. Under a declared boundary that stream was
      // collected whole because the bound could not be enforced on it, so its
      // observation is not evidence about the declared region. Crediting it
      // would let a bounded run present whole-corpus coverage as
      // coverage-of-the-boundary — the fabricated watermark this contract
      // exists to prevent.
      observed_collected:
        fact.scoped !== false && fact.coverage_statuses !== undefined && fact.coverage_statuses.length > 0,
      // Skips and pending gaps are handled by the caller's earlier precedence
      // rules; this branch is reached only when neither is present.
      pending_detail_gaps: 0,
      skipped: null,
    },
    { accepted_absence: accepted, coverage_strategy: strategy }
  );

  if (verdict.proven) {
    // A declared accepted-coverage policy (e.g. `inventory_only`, `deferred`)
    // is the more precise honest claim than a bare `complete`.
    return accepted ?? "complete";
  }
  if (verdict.reason === "boundary_shortfall") {
    return "partial";
  }
  // Not proven: absence of evidence, NOT proof of completeness. A declared
  // accepted-coverage policy is still precise (the manifest owes no further
  // data); otherwise the honest answer is `unknown`.
  return accepted ?? "unknown";
}

/**
 * Whether a PERSISTED `known_zero` count claim is still backed by positive
 * coverage evidence at read time.
 *
 * `count_state` is derived once at write time and serialized; a row that is
 * never reclassified for repair keeps serving whatever it was written with.
 * The write path proves `known_zero` from a record-source checkpoint entry,
 * but Ruling R2 is explicit that checkpoint commitment ALONE never proves
 * coverage — so a row written before that proof was required, or written
 * against a checkpoint that no longer implies coverage, keeps asserting an
 * exact zero the evidence does not support. The read boundary re-asks the
 * question against the run's own facts.
 *
 * The judgement is NOT reimplemented here: it delegates to the same
 * `evaluateStreamCoherence` contract module `deriveGapFreeStreamCoverageCondition`
 * uses, so the RI cannot drift from conformance tooling on the same facts.
 * Skips and pending recoverable gaps are passed through rather than assumed
 * away — unlike that helper, this predicate is not reached behind precedence
 * rules that already excluded them, so an unresolved attempt must be able to
 * reach the contract's `unresolved_attempt` rule directly.
 *
 * A stream with NO runtime fact at all returns `false`: absence of evidence is
 * the honest `unobserved`, never a proven zero.
 */
export function persistedZeroRetainsCoverageProof(
  fact: RuntimeCollectionFact | null,
  manifestStream: AcceptedCoverageStream | undefined
): boolean {
  if (!fact) {
    return false;
  }
  return evaluateStreamCoherence(
    {
      checkpoint: fact.checkpoint,
      collected: fact.collected,
      considered: fact.considered ?? null,
      covered: fact.covered ?? null,
      observed_collected:
        fact.scoped !== false &&
        fact.coverage_statuses !== undefined &&
        fact.coverage_statuses.length > 0 &&
        fact.coverage_statuses.every((status) => status === "collected"),
      pending_detail_gaps: fact.pending_detail_gaps,
      skipped: fact.skipped,
    },
    {
      accepted_absence: readAcceptedCoveragePolicy(manifestStream),
      coverage_strategy: readCoverageEvidenceStrategy(manifestStream),
    }
  ).proven;
}

/**
 * Derive one stream's coverage condition from its runtime fact entry plus the
 * stream's manifest policy. Precedence (first match wins), mirroring the
 * evidence order the contract requires:
 *
 *   1. contradictory manifest (required AND accepted-absent)  -> the accepted axis
 *   2. SKIP_RESULT present  -> manifest accepted-coverage axis, else skip-derived axis
 *   3. pending recoverable detail gap(s)  -> `retryable_gap`
 *   4. known considered denominator + checkpoint strategy proof
 *                                     -> accepted axis / `complete`
 *   5. known considered denominator  -> `partial` (covered-or-collected < considered)
 *                                        else accepted axis / `complete`
 *   6. unknown considered denominator  -> accepted axis / strategy proof / `unknown`
 *
 * `complete` is reached only when either a known denominator is satisfied OR a
 * declared strategy proves the stream boundary with a committed checkpoint. A
 * collected-records / no-gaps stream with neither proof reads `unknown`, never
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
    return resolveSkippedCoverage(
      classifyContinuationCoverage(
        fact,
        deriveGapFreeStreamCoverageCondition(fact, null, readCoverageEvidenceStrategy(manifestStream)) === "complete"
      ),
      accepted ?? mapSkipCoverageCondition(fact.skipped),
      fact.pending_detail_gaps
    );
  }
  // 3. A pending recoverable detail gap is a retryable boundary.
  if (fact.pending_detail_gaps > 0) {
    return "retryable_gap";
  }
  // Local collectors preserve their observed status set instead of deciding
  // whether absence is owed at the device boundary. A manifest-declared
  // accepted policy is authoritative; without one, an observed non-collected
  // status is honest unknown rather than a manufactured complete claim. This
  // also leaves `excluded` to its declared manifest policy.
  if (fact.coverage_statuses?.some((status) => status !== "collected")) {
    return accepted ?? "unknown";
  }
  const strategy = readCoverageEvidenceStrategy(manifestStream);
  return deriveGapFreeStreamCoverageCondition(fact, accepted, strategy);
}
