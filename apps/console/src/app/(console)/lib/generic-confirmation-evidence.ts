// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic, provider-agnostic evidence derivation for the owner-facing
 * coverage-horizon confirmation and loss-acknowledgement controls.
 *
 * Both controls confirm facts the reference already computed and put on the
 * wire (`known_gaps`, `coverage_horizons`); neither branches on connector
 * id anywhere — eligibility is derived purely from the evidence shape.
 *
 * COVERAGE HORIZON: eligible when the latest run's `known_gaps` contains a
 * gap the connector itself typed with `boundary_claim: "provider_history_boundary"`,
 * for a stream with no CURRENT (non-superseded) coverage horizon on record.
 * A horizon never classifies the gap away — it is disclosure only — so this
 * predicate exists purely to decide whether the confirmation control has
 * something bounded to show.
 *
 * LOSS ACKNOWLEDGEMENT: eligible when the latest run's `known_gaps` contains a
 * gap typed with `recovery_action: "not_retriable"` and the rendered verdict's
 * forward statement does not already match the fixed acknowledged-loss template.
 */

export type KnownGapLike = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is KnownGapLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(gap: KnownGapLike, key: string): string | null {
  const value = gap[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A gap typed by the connector as a provider-retention boundary.
 * The connector itself makes this claim via `boundary_claim`; we never infer it.
 */
export function isBoundaryClaimGap(gap: unknown): boolean {
  if (!isRecord(gap)) {
    return false;
  }
  return stringField(gap, "boundary_claim") === "provider_history_boundary";
}

/**
 * A gap typed by the connector as terminal and non-retriable loss.
 */
export function isTerminalLossGap(gap: unknown): boolean {
  if (!isRecord(gap)) {
    return false;
  }
  return stringField(gap, "recovery_action") === "not_retriable";
}

export interface CoverageHorizonLike {
  readonly stream: string;
  readonly supersededAt: string | null;
}

/**
 * Streams already covered by a CURRENT (non-superseded) horizon.
 */
function streamsWithCurrentHorizon(horizons: readonly CoverageHorizonLike[] | null | undefined): {
  readonly all: boolean;
  readonly streams: ReadonlySet<string>;
} {
  const streams = new Set<string>();
  let all = false;
  for (const horizon of horizons ?? []) {
    if (horizon.supersededAt !== null) {
      continue;
    }
    if (horizon.stream === "*") {
      all = true;
      break;
    }
    streams.add(horizon.stream);
  }
  return { all, streams };
}

/**
 * True when the gap is a boundary claim and has no current horizon covering it.
 */
export function isPendingHorizonConfirmation(gap: unknown, horizons: readonly CoverageHorizonLike[] | null | undefined): boolean {
  if (!isBoundaryClaimGap(gap)) {
    return false;
  }
  const stream = stringField(gap as KnownGapLike, "stream");
  if (!stream) {
    return false;
  }
  const { all, streams } = streamsWithCurrentHorizon(horizons);
  return !all && !streams.has(stream);
}

/**
 * The fixed sentence template that marks an acknowledged loss in the
 * rendered verdict's forward statement. Mirrors
 * `reference-implementation/runtime/acknowledged-loss.ts#acknowledgedLossStatement`.
 */
const ACKNOWLEDGED_LOSS_STATEMENT_TEMPLATE = /^Provider deleted this data upstream — owner-confirmed \d{4}-\d{2}-\d{2}\.$/;

/**
 * True when the forward statement matches the fixed acknowledged-loss template.
 */
export function isAcknowledgedLossStatement(statement: string | null | undefined): boolean {
  return typeof statement === "string" && ACKNOWLEDGED_LOSS_STATEMENT_TEMPLATE.test(statement);
}

/**
 * True when the gap is terminal and NOT already acknowledged.
 */
export function isPendingLossAcknowledgement(gap: unknown, forwardStatement: string | null | undefined): boolean {
  if (!isTerminalLossGap(gap)) {
    return false;
  }
  return !isAcknowledgedLossStatement(forwardStatement);
}

/**
 * Collect all boundary-claim gaps from a list, one per stream.
 */
export function boundaryClaimGaps(knownGaps: readonly unknown[] | null | undefined): readonly KnownGapLike[] {
  const seen = new Set<string>();
  const results: KnownGapLike[] = [];
  for (const gap of knownGaps ?? []) {
    if (!isBoundaryClaimGap(gap)) {
      continue;
    }
    const stream = stringField(gap as KnownGapLike, "stream");
    if (!stream || seen.has(stream)) {
      continue;
    }
    seen.add(stream);
    results.push(gap as KnownGapLike);
  }
  return results;
}

/**
 * Collect all terminal-loss gaps from a list, one per stream.
 */
export function terminalLossGaps(knownGaps: readonly unknown[] | null | undefined): readonly KnownGapLike[] {
  const seen = new Set<string>();
  const results: KnownGapLike[] = [];
  for (const gap of knownGaps ?? []) {
    if (!isTerminalLossGap(gap)) {
      continue;
    }
    const stream = stringField(gap as KnownGapLike, "stream");
    if (!stream || seen.has(stream)) {
      continue;
    }
    seen.add(stream);
    results.push(gap as KnownGapLike);
  }
  return results;
}

/**
 * Pending horizon confirmations from the latest run, given the current
 * horizon records.
 */
export function pendingHorizonConfirmations(
  knownGaps: readonly unknown[] | null | undefined,
  horizons: readonly CoverageHorizonLike[] | null | undefined
): readonly KnownGapLike[] {
  return boundaryClaimGaps(knownGaps).filter((gap) => isPendingHorizonConfirmation(gap, horizons));
}

/**
 * Pending loss acknowledgements from the latest run, given the current
 * forward verdict statement.
 */
export function pendingLossAcknowledgements(
  knownGaps: readonly unknown[] | null | undefined,
  forwardStatement: string | null | undefined
): readonly KnownGapLike[] {
  return terminalLossGaps(knownGaps).filter((gap) => isPendingLossAcknowledgement(gap, forwardStatement));
}
