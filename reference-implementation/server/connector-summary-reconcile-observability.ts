// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded, aggregate-safe telemetry for connector-summary observation
 * barriers. The server has no metrics sink, so this emits every useful
 * exception and a deterministic sample of clean barriers. It deliberately
 * accepts only counts and closed reason classes: callers cannot accidentally
 * pass owner, connection, cursor, credential, or raw-error data through.
 */

const ZERO_REPAIR_SAMPLE_EVERY = 100;

const CANDIDATE_REASON_CLASSES = new Set([
  "missing",
  "dirty",
  "record_checkpoint_mismatch",
  "identity_mismatch",
  "manifest_mismatch",
  "terminal_checkpoint_lag",
  "retained_bytes_changed_or_unavailable",
]);

const FAILURE_CLASSES = new Set(["discovery", "terminal_facts"]);

export interface ConnectorSummaryReconcileObservation {
  readonly candidateReasonCounts: Readonly<Record<string, number>>;
  readonly candidatesInspected: number;
  readonly durationMs: number;
  readonly failed: number;
  readonly failureClasses: readonly string[];
  readonly incomplete: boolean;
  readonly repaired: number;
  readonly resumePending: boolean;
  readonly scopeKind: "complete" | "scoped";
  readonly scopeSize: number;
  readonly skipped: number;
}

interface StructuredLogger {
  info: (record: Record<string, unknown>, message: string) => void;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function sanitizedReasonCounts(input: Readonly<Record<string, number>>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const reason of CANDIDATE_REASON_CLASSES) {
    const count = nonNegativeInteger(input[reason]);
    if (count > 0) {
      output[reason] = count;
    }
  }
  return output;
}

function sanitizedFailureClasses(input: readonly string[]): string[] {
  return [...new Set(input.filter((reason) => FAILURE_CLASSES.has(reason)))].sort();
}

/**
 * Create the server-owned observation sink. Every repair/failure/deferred
 * barrier is reported; clean zero-repair barriers are sampled one-in-N so
 * operators can estimate their rate without a request-log firehose.
 */
export function createConnectorSummaryReconcileObservationSink(
  logger: StructuredLogger,
  options: { readonly zeroRepairSampleEvery?: number } = {}
): (observation: ConnectorSummaryReconcileObservation) => void {
  const zeroRepairSampleEvery = Math.max(1, Math.floor(options.zeroRepairSampleEvery ?? ZERO_REPAIR_SAMPLE_EVERY));
  let cleanBarrierCount = 0;

  return (observation) => {
    const exceptional =
      observation.repaired > 0 ||
      observation.failed > 0 ||
      observation.skipped > 0 ||
      observation.incomplete ||
      observation.failureClasses.length > 0;
    if (!exceptional) {
      cleanBarrierCount += 1;
      if (cleanBarrierCount % zeroRepairSampleEvery !== 0) {
        return;
      }
    }
    try {
      logger.info(
        {
          candidate_reason_counts: sanitizedReasonCounts(observation.candidateReasonCounts),
          candidates_inspected: nonNegativeInteger(observation.candidatesInspected),
          duration_ms: nonNegativeInteger(observation.durationMs),
          failed: nonNegativeInteger(observation.failed),
          failure_classes: sanitizedFailureClasses(observation.failureClasses),
          incomplete: observation.incomplete === true,
          observation: "connector_summary_reconcile",
          repaired: nonNegativeInteger(observation.repaired),
          resume_state: observation.resumePending ? "pending" : "none",
          scope_kind: observation.scopeKind === "scoped" ? "scoped" : "complete",
          scope_size: nonNegativeInteger(observation.scopeSize),
          skipped: nonNegativeInteger(observation.skipped),
          ...(exceptional ? {} : { zero_repair_sample_every: zeroRepairSampleEvery }),
        },
        "connector summary reconcile observation"
      );
    } catch {
      // Observability is never permitted to alter the read barrier.
    }
  };
}
