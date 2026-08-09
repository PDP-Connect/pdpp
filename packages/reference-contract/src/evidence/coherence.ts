// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Evidence-envelope coherence validation: the pure, zero-I/O rules that decide
// whether a run's per-stream facts actually PROVE the coverage claim made about
// them.
//
// This module is deliberately a leaf. It imports nothing — not the reference
// implementation, not the server, not even sibling contract modules — so both
// the RI (at its projection boundary) and future conformance tooling can import
// the same function and reach the same verdict on the same facts. Every export
// is a total function of its arguments: no clocks, no filesystem, no network,
// no module-level mutable state.
//
// The single invariant it enforces:
//
//   A committed checkpoint is NOT, by itself, proof of coverage.
//
// A checkpoint records where a cursor stopped. That is a fact about the
// connector's own bookkeeping, not a measurement of the source. A zero-result
// run may legitimately commit a cursor AND prove verified emptiness — but the
// proof has to come from positive, strategy-specific coverage evidence
// (a measured `considered` boundary, a `covered` accounting, or a declared
// accepted-absence policy), never from the checkpoint alone. An unresolved or
// failed attempt must never be laundered into `proven` merely because a
// checkpoint committed.
//
// Which evidence counts is driven by MANIFEST FACTS interpreted here, never by
// a per-connector branch: this module contains no connector identifiers and no
// knowledge of any specific connector. A manifest that declares no proof
// strategy yields the honest verdict `not_proven` — never a synthesized
// completeness.

/**
 * A manifest-declared coverage proof strategy. Each names the KIND of positive
 * evidence the stream owes; none of them is satisfied by a checkpoint alone.
 */
export type CoverageProofStrategy =
  | "checkpoint_window"
  | "full_inventory"
  | "parent_detail_accounting"
  | "snapshot_import_receipt"
  | "singleton_presence";

/**
 * A manifest-declared accepted-absence policy: the manifest's statement that
 * the stream owes no data, so absence is the correct outcome rather than a gap.
 * This is itself positive evidence — it is a declaration, not a silence.
 */
export type AcceptedAbsencePolicy = "deferred" | "inventory_only" | "unavailable" | "unsupported";

/**
 * The evidence envelope for one stream of one run: the objective run-local
 * facts, with no coverage condition baked in. Mirrors the shape the runtime
 * stamps, reduced to the fields the coherence rules actually read.
 */
export interface StreamEvidenceEnvelope {
  /**
   * The checkpoint state for this stream's cursor. Recorded for coherence
   * reporting; it is NEVER sufficient evidence on its own.
   */
  readonly checkpoint?: string | null;
  /** Records emitted this run. Never a coverage numerator on its own. */
  readonly collected?: number | null;
  /**
   * The measured enumeration boundary: how many in-boundary items the run
   * weighed. MUST be measured independently at the enumeration site and never
   * aliased to the collected count.
   */
  readonly considered?: number | null;
  /**
   * In-boundary items the run accounted for (emitted + deliberately suppressed
   * as unchanged). When present it is the numerator compared against
   * `considered`; never inferred from `collected`.
   */
  readonly covered?: number | null;
  /** Pending recoverable detail gaps: an open boundary, not a proven one. */
  readonly pending_detail_gaps?: number | null;
  /** Set when the connector explicitly did not collect this stream. */
  readonly skipped?: { readonly reason?: string } | null;
}

/**
 * The manifest facts the coherence rules interpret. Supplying neither strategy
 * nor accepted-absence policy is a manifest that declares no proof strategy —
 * which yields `not_proven`, by design.
 */
export interface StreamProofDeclaration {
  readonly accepted_absence?: AcceptedAbsencePolicy | null;
  readonly coverage_strategy?: CoverageProofStrategy | null;
}

/**
 * Why a stream's coverage is or is not proven.
 *
 * - `enumeration_boundary` — a measured `considered` denominator was satisfied
 *   by the `covered`/`collected` numerator. Proves verified-empty at `0/0`.
 * - `accepted_absence` — the manifest declares the stream owes no data.
 * - `no_proof_strategy` — the manifest declared none; honest silence.
 * - `checkpoint_only` — a checkpoint committed and nothing else was offered.
 *   This is the laundering case the invariant exists to reject.
 * - `boundary_shortfall` — the numerator did not satisfy the denominator.
 * - `unresolved_attempt` — the run skipped the stream or left recoverable gaps
 *   open; no checkpoint can substitute for the missing measurement.
 */
export type CoherenceReason =
  | "accepted_absence"
  | "boundary_shortfall"
  | "checkpoint_only"
  | "enumeration_boundary"
  | "no_proof_strategy"
  | "unresolved_attempt";

/**
 * The coherence verdict on one stream's evidence envelope.
 *
 * `proven` means the envelope carries positive coverage evidence sufficient for
 * a `complete` / verified-empty claim. `not_proven` means it does not — which
 * is a statement about the EVIDENCE, not an accusation that data is missing.
 */
export interface StreamCoherenceVerdict {
  readonly proven: boolean;
  readonly reason: CoherenceReason;
}

function readCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function hasUnresolvedAttempt(envelope: StreamEvidenceEnvelope): boolean {
  if (envelope.skipped) {
    return true;
  }
  const pending = readCount(envelope.pending_detail_gaps);
  return pending !== null && pending > 0;
}

/**
 * Whether a committed checkpoint is being asked to carry the whole proof.
 * Exported because conformance tooling wants to report this case by name: it is
 * the precise shape of the rejected claim, not merely an absence of evidence.
 */
export function isCheckpointOnlyClaim(
  envelope: StreamEvidenceEnvelope,
  declaration: StreamProofDeclaration
): boolean {
  if (declaration.accepted_absence) {
    return false;
  }
  if (readCount(envelope.considered) !== null) {
    return false;
  }
  return envelope.checkpoint === "committed" || envelope.checkpoint === "disabled";
}

/**
 * Decide whether one stream's evidence envelope proves its coverage claim.
 *
 * Precedence (first match wins):
 *   1. unresolved attempt (skip / open recoverable gap)  -> not proven
 *   2. manifest declares no proof strategy               -> not proven
 *   3. measured enumeration boundary                     -> satisfied ? proven : shortfall
 *   4. manifest-declared accepted absence                -> proven
 *   5. anything left, incl. a committed checkpoint       -> not proven
 *
 * Rule 3 is what lets a legitimate zero-result run prove verified emptiness: a
 * measured `considered: 0` is a positive statement ("I enumerated the boundary
 * and it held nothing"), satisfied by `covered`/`collected` of 0. Rule 5 is the
 * invariant: a committed checkpoint that reaches this point proves nothing.
 */
export function evaluateStreamCoherence(
  envelope: StreamEvidenceEnvelope,
  declaration: StreamProofDeclaration
): StreamCoherenceVerdict {
  // 1. An unresolved or failed attempt is never laundered into proven, no
  //    matter what the checkpoint did.
  if (hasUnresolvedAttempt(envelope)) {
    return { proven: false, reason: "unresolved_attempt" };
  }

  const accepted = declaration.accepted_absence ?? null;
  const strategy = declaration.coverage_strategy ?? null;

  // 2. No declared proof strategy of any kind: the honest answer is that
  //    nothing was proven, not a synthesized completeness.
  if (accepted === null && strategy === null) {
    return { proven: false, reason: "no_proof_strategy" };
  }

  // 3. A measured enumeration boundary is the strongest positive evidence, and
  //    the only one that can prove verified-empty on a zero-result run.
  const considered = readCount(envelope.considered);
  if (considered !== null) {
    const satisfied = readCount(envelope.covered) ?? readCount(envelope.collected) ?? 0;
    return satisfied < considered
      ? { proven: false, reason: "boundary_shortfall" }
      : { proven: true, reason: "enumeration_boundary" };
  }

  // 4. A declared accepted absence is a manifest statement that no data is
  //    owed — positive evidence in its own right.
  if (accepted !== null) {
    return { proven: true, reason: "accepted_absence" };
  }

  // 5. A declared strategy with no measurement behind it. If a checkpoint is
  //    all that is on offer, name that explicitly; either way it is not proof.
  return {
    proven: false,
    reason: isCheckpointOnlyClaim(envelope, declaration) ? "checkpoint_only" : "no_proof_strategy",
  };
}
