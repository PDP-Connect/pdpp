// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

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

function readZeroRepairSampleEvery(value: number | undefined): number {
  const sampleEvery = value ?? ZERO_REPAIR_SAMPLE_EVERY;
  if (!(Number.isFinite(sampleEvery) && Number.isInteger(sampleEvery)) || sampleEvery < 1) {
    throw new RangeError("zeroRepairSampleEvery must be a finite positive integer");
  }
  return sampleEvery;
}

function readSamplingEpochStartedAt(value: string | undefined): string {
  const epoch = value ?? new Date().toISOString();
  if (new Date(epoch).toISOString() !== epoch) {
    throw new RangeError("samplingEpochStartedAt must be an ISO-8601 UTC timestamp");
  }
  return epoch;
}

/**
 * Select clean latency observations with a deterministic SHA-256 draw over
 * only the non-identity sampling epoch and a local counter. This avoids the
 * periodic request-position bias of every-N sampling while remaining exactly
 * reproducible from the safe fields emitted with a selected observation.
 */
export function shouldSampleCleanBarrier(
  samplingEpochStartedAt: string,
  cleanBarrierCount: number,
  zeroRepairSampleEvery: number
): boolean {
  const hash = createHash("sha256").update(`${samplingEpochStartedAt}\u0000${cleanBarrierCount}`).digest();
  return hash.readUInt32BE(0) % zeroRepairSampleEvery === 0;
}

/**
 * Create the server-owned observation sink. Every repair/failure/deferred
 * barrier is reported; clean zero-repair barriers are sampled one-in-N so
 * operators can estimate their rate without a request-log firehose.
 */
export function createConnectorSummaryReconcileObservationSink(
  logger: StructuredLogger,
  options: { readonly samplingEpochStartedAt?: string; readonly zeroRepairSampleEvery?: number } = {}
): (observation: ConnectorSummaryReconcileObservation) => void {
  const zeroRepairSampleEvery = readZeroRepairSampleEvery(options.zeroRepairSampleEvery);
  // This timestamp is a process-local sampling epoch, not an owner or
  // connection identifier. It lets analysis group cumulative lower bounds
  // without inventing volume from clean barriers lost at process restart.
  const samplingEpochStartedAt = readSamplingEpochStartedAt(options.samplingEpochStartedAt);
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
      if (!shouldSampleCleanBarrier(samplingEpochStartedAt, cleanBarrierCount, zeroRepairSampleEvery)) {
        return;
      }
    }
    try {
      logger.info(
        {
          candidate_reason_counts: sanitizedReasonCounts(observation.candidateReasonCounts),
          candidates_inspected: nonNegativeInteger(observation.candidatesInspected),
          clean_sample_algorithm: "sha256_epoch_counter_modulo_v1",
          duration_ms: nonNegativeInteger(observation.durationMs),
          failed: nonNegativeInteger(observation.failed),
          failure_classes: sanitizedFailureClasses(observation.failureClasses),
          incomplete: observation.incomplete === true,
          observation: "connector_summary_reconcile",
          repaired: nonNegativeInteger(observation.repaired),
          resume_state: observation.resumePending ? "pending" : "none",
          sampling_epoch_started_at: samplingEpochStartedAt,
          scope_kind: observation.scopeKind === "scoped" ? "scoped" : "complete",
          scope_size: nonNegativeInteger(observation.scopeSize),
          skipped: nonNegativeInteger(observation.skipped),
          ...(exceptional
            ? {}
            : {
                clean_barriers_since_epoch_lower_bound: cleanBarrierCount,
                zero_repair_sample_every: zeroRepairSampleEvery,
              }),
        },
        "connector summary reconcile observation"
      );
    } catch {
      // Observability is never permitted to alter the read barrier.
    }
  };
}
