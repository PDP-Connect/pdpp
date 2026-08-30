// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  RefAcknowledgedLossCause,
  RefAcknowledgedLossRecord,
  RefAcknowledgedLossScope,
  RefCoverageHorizon,
} from "./ref-client.ts";

export type KnownGapLike = Readonly<Record<string, unknown>>;
export type CoverageHorizonBasis = RefCoverageHorizon["basis"];
export type CoverageHorizonReason = RefCoverageHorizon["reason"];

export const COVERAGE_HORIZON_BASES: readonly CoverageHorizonBasis[] = [
  "inferred_from_stable_boundary",
  "provider_confirmed",
  "provider_stated",
];
export const COVERAGE_HORIZON_REASONS: readonly CoverageHorizonReason[] = [
  "consent_window",
  "provider_deleted_history",
  "provider_never_had_data",
  "provider_retention_policy",
];
export const LOSS_CAUSES: readonly RefAcknowledgedLossCause[] = [
  "provider_access_withdrawn",
  "provider_data_contradictory",
  "provider_deleted_upstream",
];
export const LOSS_SCOPES: readonly RefAcknowledgedLossScope[] = ["partial", "total"];

function isRecord(value: unknown): value is KnownGapLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: KnownGapLike, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

function enumField<T extends string>(value: KnownGapLike, key: string, values: readonly T[]): T | null {
  const field = stringField(value, key);
  return field && values.includes(field as T) ? (field as T) : null;
}

function recoveryAction(gap: KnownGapLike): string | null {
  const direct = stringField(gap, "recovery_action");
  if (direct) {
    return direct;
  }
  const hint = gap.recovery_hint;
  if (typeof hint === "string") {
    return hint;
  }
  return isRecord(hint) ? stringField(hint, "action") : null;
}

export function isBoundaryClaimGap(gap: unknown): boolean {
  return isRecord(gap) && stringField(gap, "boundary_claim") === "provider_history_boundary";
}

export function isTerminalLossGap(gap: unknown): boolean {
  return isRecord(gap) && recoveryAction(gap) === "not_retriable";
}

export interface CoverageHorizonLike {
  readonly stream: string;
  readonly supersededAt: string | null;
}

export interface CoverageHorizonCandidate {
  readonly basis: CoverageHorizonBasis | null;
  readonly earliestAvailable: string | null;
  readonly note: string | null;
  readonly reason: CoverageHorizonReason | null;
  readonly stream: string;
}

function horizonCoversStream(horizons: readonly CoverageHorizonLike[] | null | undefined, stream: string): boolean {
  return (horizons ?? []).some(
    (horizon) => horizon.supersededAt === null && (horizon.stream === "*" || horizon.stream === stream)
  );
}

function horizonCandidate(gap: KnownGapLike): CoverageHorizonCandidate | null {
  const stream = stringField(gap, "stream");
  return stream
    ? {
        basis: enumField(gap, "basis", COVERAGE_HORIZON_BASES),
        earliestAvailable: stringField(gap, "earliest_available"),
        note: stringField(gap, "note"),
        reason:
          enumField(gap, "reason_code", COVERAGE_HORIZON_REASONS) ??
          enumField(gap, "horizon_reason", COVERAGE_HORIZON_REASONS),
        stream,
      }
    : null;
}

export function boundaryClaimGaps(
  knownGaps: readonly unknown[] | null | undefined
): readonly CoverageHorizonCandidate[] {
  const seen = new Set<string>();
  const candidates: CoverageHorizonCandidate[] = [];
  for (const gap of knownGaps ?? []) {
    if (!isBoundaryClaimGap(gap)) {
      continue;
    }
    const candidate = horizonCandidate(gap as KnownGapLike);
    if (candidate && !seen.has(candidate.stream)) {
      seen.add(candidate.stream);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function pendingHorizonConfirmations(
  knownGaps: readonly unknown[] | null | undefined,
  horizons: readonly CoverageHorizonLike[] | null | undefined
): readonly CoverageHorizonCandidate[] {
  return boundaryClaimGaps(knownGaps).filter((candidate) => !horizonCoversStream(horizons, candidate.stream));
}

export function isValidAcknowledgedLossRecord(value: unknown): value is RefAcknowledgedLossRecord {
  if (!isRecord(value)) {
    return false;
  }
  const cause = stringField(value, "cause");
  const scope = stringField(value, "scope");
  const actor = stringField(value, "acknowledgedBy");
  const at = stringField(value, "acknowledgedAt");
  if (
    !(
      cause &&
      LOSS_CAUSES.includes(cause as RefAcknowledgedLossCause) &&
      scope &&
      LOSS_SCOPES.includes(scope as RefAcknowledgedLossScope) &&
      actor &&
      at &&
      !Number.isNaN(Date.parse(at))
    )
  ) {
    return false;
  }
  if (value.note !== undefined && value.note !== null && typeof value.note !== "string") {
    return false;
  }
  return (
    value.streams === undefined ||
    (Array.isArray(value.streams) && value.streams.every((stream) => typeof stream === "string"))
  );
}

function lossCoversStream(record: RefAcknowledgedLossRecord, stream: string): boolean {
  return !record.streams || record.streams.length === 0 || record.streams.includes(stream);
}

export interface LossAcknowledgementCandidate {
  readonly cause: RefAcknowledgedLossCause | null;
  readonly note: string | null;
  readonly scope: RefAcknowledgedLossScope | null;
  readonly stream: string;
}

function lossCandidate(gap: KnownGapLike): LossAcknowledgementCandidate | null {
  const stream = stringField(gap, "stream");
  return stream
    ? {
        cause: enumField(gap, "cause", LOSS_CAUSES),
        note: stringField(gap, "note"),
        scope: enumField(gap, "scope", LOSS_SCOPES),
        stream,
      }
    : null;
}

export function pendingLossAcknowledgements(
  knownGaps: readonly unknown[] | null | undefined,
  acknowledgedLoss: unknown
): readonly LossAcknowledgementCandidate[] {
  const record = isValidAcknowledgedLossRecord(acknowledgedLoss) ? acknowledgedLoss : null;
  const seen = new Set<string>();
  const candidates: LossAcknowledgementCandidate[] = [];
  for (const gap of knownGaps ?? []) {
    if (!isTerminalLossGap(gap)) {
      continue;
    }
    const candidate = lossCandidate(gap as KnownGapLike);
    if (candidate && !seen.has(candidate.stream) && !(record && lossCoversStream(record, candidate.stream))) {
      seen.add(candidate.stream);
      candidates.push(candidate);
    }
  }
  return candidates;
}

export function coverageHorizonCandidateDisclosure(candidate: CoverageHorizonCandidate): string {
  return `The provider marked the ${candidate.stream} history as bounded. Confirming this records a disclosure only; it does not change what is retained or the connection's health.`;
}

export function lossAcknowledgementCandidateDisclosure(candidate: LossAcknowledgementCandidate): string {
  return `The backend marked missing ${candidate.stream} data as not retriable. Acknowledging it records your review; it does not recover data or change the connection's health.`;
}
