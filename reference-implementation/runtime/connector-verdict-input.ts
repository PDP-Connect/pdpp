/**
 * Maps the existing control-plane connection-health evidence onto the pure
 * {@link synthesizeRenderedVerdict} inputs.
 *
 * This is the deterministic glue between the projection the reference server
 * already computes (`ConnectionHealthSnapshot` + the per-stream Collection
 * Report + the manifest refresh policy) and the one server-owned verdict. It
 * introduces NO new evidence and NO clock read: every field is read off
 * evidence the projection already carries, exactly as `connection_health` is.
 *
 * Keeping the mapping here — not inline in `ref-control.ts` — lets the
 * stream-rollup derivation be unit-tested in isolation and keeps the
 * synthesizer a pure function of its declared input types.
 *
 * The `runtime_ok` input is NOT derived here. The projection does not yet take
 * a true runtime-liveness signal (design D7 / S4 names this as an open
 * dependency). The caller defaults it to `true` and threads a real signal in
 * when one exists; this module never fabricates a liveness heuristic.
 */

import {
  type ConnectionHealthSnapshot,
  type ConnectionRefreshEvidence,
  type CoverageAxis,
  isManualRefreshOnly,
} from "./connection-health.ts";
import {
  type ProgressEvidence,
  type ProgressMode,
  type RenderedVerdict,
  type StreamRollup,
  synthesizeRenderedVerdict,
} from "./rendered-verdict.ts";

/**
 * The subset of a Collection Report entry the rollup reads. Mirrors
 * `CollectionReportEntry` in `server/ref-control.ts` without importing the
 * server module (this module stays free of server/HTTP imports so it can be
 * exercised as a pure unit).
 */
export interface CollectionReportEntryLike {
  readonly collected: number;
  readonly considered: number | "unknown";
  readonly coverage_condition: CoverageAxis;
  readonly pending_detail_gaps: number;
  readonly stream: string;
}

/**
 * The subset of a manifest stream the rollup reads to weight worst-wins by
 * priority. `required` defaults to `true` when absent (a manifest-declared
 * stream is load-bearing unless opted out), matching `isRequiredStream` in
 * `server/ref-control.ts`. A declared accepted-coverage policy makes the stream
 * an `accepted_absence` so its non-red staleness annotates without downgrading.
 */
export interface ManifestStreamLike {
  readonly coverage_policy?: "collect" | "deferred" | "inventory_only" | "unavailable" | "unsupported";
  readonly name: string;
  readonly required?: boolean;
}

const RETRYABLE_COVERAGE: ReadonlySet<CoverageAxis> = new Set<CoverageAxis>([
  "retryable_gap",
  "partial",
  "gaps",
]);

/** A coverage axis the next ordinary run can still fill (vs. a terminal loss). */
function isRetryableCoverage(axis: CoverageAxis): boolean {
  return RETRYABLE_COVERAGE.has(axis);
}

/**
 * Weight a stream for the worst-wins rollup. A stream that declares an
 * accepted-coverage policy AND is not `required` is `accepted_absence`; an
 * explicitly non-required stream is `optional`; everything else is `required`.
 * A `required` stream that ALSO declares an accepted policy is a contradictory
 * manifest and is kept `required` so it cannot annotate-away its own gap.
 */
export function streamPriority(stream: ManifestStreamLike | undefined): StreamRollup["priority"] {
  if (!stream) {
    return "required";
  }
  const required = stream.required !== false;
  if (required) {
    return "required";
  }
  if (stream.coverage_policy && stream.coverage_policy !== "collect") {
    return "accepted_absence";
  }
  return "optional";
}

/**
 * Map the Collection Report + manifest streams + the connection-level attention
 * axis onto the synthesizer's per-stream rollups. There is no per-stream
 * attention signal in the projection, so the connection-level attention axis is
 * threaded onto each non-complete stream — the honest available signal.
 */
export function buildStreamRollups(
  report: readonly CollectionReportEntryLike[],
  manifestStreams: readonly ManifestStreamLike[],
  snapshot: ConnectionHealthSnapshot
): StreamRollup[] {
  const streamByName = new Map(manifestStreams.map((s) => [s.name, s]));
  const attentionOpen = snapshot.axes.attention !== "none";
  return report.map((entry) => {
    const manifestStream = streamByName.get(entry.stream);
    const retryable = isRetryableCoverage(entry.coverage_condition) || entry.pending_detail_gaps > 0;
    return {
      stream_id: entry.stream,
      collected: entry.collected,
      considered: entry.considered === "unknown" ? null : entry.considered,
      coverage: entry.coverage_condition,
      gap_retryable: retryable,
      // Connection-level attention is the only attention signal the projection
      // exposes; attribute it to a stream only when that stream is not complete,
      // so a complete stream never inherits a connection-level attention flag.
      attention_open: attentionOpen && entry.coverage_condition !== "complete",
      priority: streamPriority(manifestStream),
    };
  });
}

/**
 * Choose the collection model so {@link RenderedProgress} privileges the right
 * "did it work?" signal (design D9):
 *
 *   - `local_device` when the connection is backed by a device collector.
 *   - `deferred` for a scheduled connector that drains detail-gap backlog out of
 *     band (ChatGPT-shape: records_emitted is structurally zero per run; the
 *     real progress signal is gaps drained + retained records).
 *   - `manual` when the refresh contract is manual-only.
 *   - `scheduled` otherwise.
 */
export function progressMode(input: {
  readonly localDeviceBacked: boolean;
  readonly refresh: ConnectionRefreshEvidence | null;
  readonly scheduled: boolean;
  readonly hasDrainedDetailGaps: boolean;
}): ProgressMode {
  if (input.localDeviceBacked) {
    return "local_device";
  }
  if (input.scheduled && input.hasDrainedDetailGaps) {
    return "deferred";
  }
  if (isManualRefreshOnly(input.refresh)) {
    return "manual";
  }
  return "scheduled";
}

/**
 * Read durable progress evidence off the snapshot + the already-resolved
 * record/refresh facts. Every field is nullable; the caller passes `null` for
 * facts it does not hold, and the synthesizer never fabricates a number.
 */
export function buildProgressEvidence(input: {
  readonly mode: ProgressMode;
  readonly retainedRecords: number | null;
  readonly recordsCommittedLastRun: number | null;
  readonly gapsDrainedLastRun: number | null;
  readonly lastRefreshedAt: string | null;
}): ProgressEvidence {
  return {
    mode: input.mode,
    retained_records: input.retainedRecords,
    records_committed_last_run: input.recordsCommittedLastRun,
    gaps_drained_last_run: input.gapsDrainedLastRun,
    last_refreshed_at: input.lastRefreshedAt,
  };
}

/**
 * The one entry point the control plane calls: map evidence and synthesize the
 * verdict. `runtime_ok` defaults to `true` and is the seam where a real runtime
 * liveness signal is threaded once one exists.
 */
export function synthesizeConnectorVerdict(input: {
  readonly snapshot: ConnectionHealthSnapshot;
  readonly report: readonly CollectionReportEntryLike[];
  readonly manifestStreams: readonly ManifestStreamLike[];
  readonly refresh: ConnectionRefreshEvidence | null;
  readonly progress: ProgressEvidence | null;
  readonly runtimeOk?: boolean;
}): RenderedVerdict {
  const streams = buildStreamRollups(input.report, input.manifestStreams, input.snapshot);
  return synthesizeRenderedVerdict(
    input.snapshot,
    streams,
    input.refresh,
    input.runtimeOk ?? true,
    input.progress
  );
}
