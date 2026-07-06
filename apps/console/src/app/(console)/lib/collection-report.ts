/**
 * Pure formatting helpers that turn the reference's per-stream Collection
 * Report (`collection_report` on a connector summary,
 * `define-connector-progress-evidence-contract` Tranche C) into the small set
 * of owner-facing strings the connector detail page renders next to each
 * stream's record count.
 *
 * The report is the reference's objective, derived-on-read answer to "what did
 * the last run actually collect per stream, and what is the next run expected
 * to do?". The console MUST render it without inventing state. These helpers
 * inherit the same honesty doctrine as `connection-evidence.ts`:
 *   - they NEVER turn an `unknown` considered denominator into a fabricated
 *     fraction — `considered: "unknown"` reads "considered: unknown", never a
 *     `collected / collected` that would imply completeness;
 *   - they show a declared `covered` numerator when the reference provides one,
 *     so steady-state full-sync streams do not look like false `0 / N collected`
 *     partials;
 *   - they NEVER label a stream `complete` the reference left `unknown`;
 *   - they reuse the existing coverage-axis and forward-disposition formatters
 *     verbatim, so a stream entry never disagrees with the connection-level
 *     vocabulary the same page already renders.
 *
 * Side-effect-free and JSX-free so the detail page stays thin and this is
 * unit-testable without a browser harness.
 */

import type { AxisChip, EvidenceTone, ForwardDispositionSummary } from "./connection-evidence.ts";
import { formatCoverageAxis, formatForwardDisposition } from "./connection-evidence.ts";
import type { RefCollectionReportEntry } from "./ref-client.ts";

export interface StreamCollectionFacts {
  /**
   * Owner-facing coverage/count line. When the connector declared a `covered`
   * numerator, show `covered / considered covered` plus the raw collected count.
   * Otherwise show `collected / considered`. The displayed numerator is clamped
   * to the considered denominator so an over-reported count can never render an
   * impossible fraction (e.g. "3 / 2 collected"); the raw count is preserved in
   * `countsTitle`. Unknown denominators stay explicit and never become
   * fabricated fractions. `null` when there is nothing honest to say (no
   * collected records and no considered denominator).
   */
  countsLabel: string | null;
  /** Long-form hover for the counts line. */
  countsTitle: string;
  /** Coverage-condition chip for this stream (reuses the connection-level vocabulary). */
  coverage: AxisChip;
  /** Forward disposition for this stream, or `null` when unrecognized/absent. */
  disposition: ForwardDispositionSummary | null;
  /** Count of pending recoverable detail gaps; `0` renders nothing. */
  pendingDetailGaps: number;
  /** True when the pending-gap count is a bounded-read floor, not an exact total. */
  pendingDetailGapsIsFloor: boolean;
  /** Owner-facing pending-gap label, or `null` when there are no pending gaps. */
  pendingDetailGapsLabel: string | null;
  /**
   * One-line skip note when the runtime reported a `SKIP_RESULT` for this
   * stream, e.g. "skipped · rate_limited". `null` when the stream was not
   * skipped.
   */
  skipLabel: string | null;
  /** The stream name (mirrors the entry; convenient for callers joining by name). */
  stream: string;
  /**
   * The single strongest tone for the stream line, so a caller that renders one
   * accent can pick it without re-deriving. Danger (won't-backfill / hard skip)
   * beats warning (resuming / gaps) beats success (complete) beats neutral.
   */
  tone: EvidenceTone;
}

export function formatPendingDetailGapsLabel(count: number, isFloor = false): string | null {
  if (!Number.isFinite(count) || count <= 0) {
    return null;
  }
  const safeCount = Math.floor(count);
  const noun = safeCount === 1 ? "pending gap" : "pending gaps";
  return `${isFloor ? "at least " : ""}${safeCount.toLocaleString()} ${noun}`;
}

/**
 * Index a Collection Report by stream name so the detail page can join it to
 * the resource-server stream list (which is keyed by name) in O(1). The
 * reference derives one entry per in-scope stream; a duplicate stream name
 * (should not happen) keeps the first entry.
 */
export function indexCollectionReportByStream(
  report: readonly RefCollectionReportEntry[] | null | undefined
): Map<string, RefCollectionReportEntry> {
  const byStream = new Map<string, RefCollectionReportEntry>();
  for (const entry of report ?? []) {
    if (typeof entry?.stream === "string" && !byStream.has(entry.stream)) {
      byStream.set(entry.stream, entry);
    }
  }
  return byStream;
}

/**
 * Returns true when the latest collection report contains unresolved stream
 * coverage. Used by owner-control surfaces to avoid rendering a completed run
 * as a clean green success when the same source detail page shows skipped
 * streams, retryable gaps, terminal gaps, or unknown coverage.
 */
export function collectionReportHasOpenGaps(report: readonly RefCollectionReportEntry[] | null | undefined): boolean {
  return (report ?? []).some((entry) => {
    if (entry.coverage_condition !== "complete") {
      return true;
    }
    if (entry.pending_detail_gaps > 0) {
      return true;
    }
    return entry.skipped !== null;
  });
}

const SUCCESS_RUN_STATUSES = new Set(["succeeded", "success", "completed"]);

export function runStatusWithCollectionReportGaps(
  status: string,
  report: readonly RefCollectionReportEntry[] | null | undefined
): string {
  return SUCCESS_RUN_STATUSES.has(status) && collectionReportHasOpenGaps(report) ? "succeeded_with_gaps" : status;
}

/**
 * Build the owner-facing counts line for one stream.
 *
 * The honesty gate: a known considered denominator renders either `covered /
 * considered` when the reference provided an accounted-for numerator or
 * `collected / considered` otherwise. An `unknown` denominator renders the raw
 * collected count plus an explicit "considered unknown" so the operator can
 * never read a fabricated fraction as completeness. A stream that collected
 * nothing and has no denominator returns `null` — there is no honest progress
 * number to show.
 */
function buildCountsLine(entry: RefCollectionReportEntry): { label: string | null; title: string } {
  const collected = Number.isFinite(entry.collected) ? entry.collected : 0;
  const collectedText = collected.toLocaleString();
  if (typeof entry.considered === "number" && Number.isFinite(entry.considered)) {
    const considered = entry.considered.toLocaleString();
    // Honesty clamp: the rendered fraction numerator can never exceed its
    // denominator. A `collected > considered` input (a connector that
    // over-reported, or a considered denominator that lagged the collected
    // count) would otherwise render an impossible tuple like "3 / 2 collected".
    // We clamp the displayed numerator to the denominator so the fraction
    // stays well-formed, and the long-form title states the raw collected
    // count verbatim so the discrepancy is disclosed, never silently dropped.
    const overReported = collected > entry.considered;
    const clampedNumerator = Math.min(collected, entry.considered).toLocaleString();
    if (typeof entry.covered === "number" && Number.isFinite(entry.covered)) {
      const covered = Math.min(entry.covered, entry.considered).toLocaleString();
      const overCovered = entry.covered > entry.considered;
      if (overCovered) {
        return {
          label: `${covered} / ${considered} covered · ${collectedText} collected`,
          title: `This run accounted for ${entry.covered.toLocaleString()} of ${considered} considered records for this stream — more than the considered denominator, so the displayed covered fraction is clamped to ${considered} / ${considered}. It collected ${collectedText}; covered also includes records deliberately suppressed because they were unchanged.`,
        };
      }
      return {
        label: `${covered} / ${considered} covered · ${collectedText} collected`,
        title: overReported
          ? `This run accounted for ${covered} of ${considered} considered records for this stream. It collected ${collectedText}, which is more than the ${considered} it considered; covered also includes records deliberately suppressed because they were unchanged.`
          : `This run accounted for ${covered} of ${considered} considered records for this stream. It collected ${collectedText}; covered also includes records deliberately suppressed because they were unchanged.`,
      };
    }
    return {
      label: `${clampedNumerator} / ${considered} collected`,
      title: overReported
        ? `This run collected ${collectedText} records for this stream — more than the ${considered} it considered, so the displayed fraction is clamped to ${considered} / ${considered}. The raw collected count is ${collectedText}.`
        : `This run collected ${collectedText} of ${considered} considered records for this stream.`,
    };
  }
  // Unknown considered denominator: never imply a fraction. Show the raw count
  // only, and say the denominator is unknown.
  if (collected > 0) {
    return {
      label: `${collectedText} collected · considered unknown`,
      title: `This run collected ${collectedText} records for this stream. The connector did not declare how many records it considered, so completeness cannot be derived from the count alone.`,
    };
  }
  return {
    label: null,
    title:
      "The connector did not declare a considered denominator for this stream, so completeness cannot be derived from the collected count.",
  };
}

/**
 * One-line skip note. The runtime reports a free-form `reason` (and optional
 * `recovery_action`); we surface the reason verbatim, humanized for spaces, and
 * keep it short. The coverage chip already carries the skip's coverage verdict,
 * so this line only names the cause.
 */
function buildSkipLabel(skip: RefCollectionReportEntry["skipped"]): string | null {
  if (!skip || typeof skip.reason !== "string" || skip.reason.trim().length === 0) {
    return null;
  }
  const reason = skip.reason.trim().replace(/[_-]+/g, " ");
  return `skipped · ${reason}`;
}

const TONE_RANK: Record<EvidenceTone, number> = {
  danger: 3,
  warning: 2,
  success: 1,
  neutral: 0,
};

/** The stronger of two tones (danger > warning > success > neutral). */
function strongerTone(a: EvidenceTone, b: EvidenceTone): EvidenceTone {
  return TONE_RANK[a] >= TONE_RANK[b] ? a : b;
}

/**
 * Format one Collection Report entry into the small view-model the detail page
 * renders next to a stream. Reuses the connection-level coverage and
 * forward-disposition formatters so the per-stream vocabulary never diverges
 * from the connection headline.
 */
export function formatStreamCollectionFacts(entry: RefCollectionReportEntry): StreamCollectionFacts {
  const coverage = formatCoverageAxis(entry.coverage_condition);
  const disposition = formatForwardDisposition(entry.forward_disposition);
  const counts = buildCountsLine(entry);
  const skipLabel = buildSkipLabel(entry.skipped);
  const pendingDetailGaps =
    typeof entry.pending_detail_gaps === "number" &&
    Number.isFinite(entry.pending_detail_gaps) &&
    entry.pending_detail_gaps > 0
      ? entry.pending_detail_gaps
      : 0;
  const pendingDetailGapsIsFloor = pendingDetailGaps > 0 && entry.pending_detail_gaps_is_floor === true;

  // The strongest tone across the signals that carry one. The coverage chip is
  // the primary verdict; a pending detail gap or a skip can only raise concern,
  // never lower it (and never invents success).
  let tone: EvidenceTone = coverage.tone;
  if (disposition) {
    tone = strongerTone(tone, disposition.tone);
  }
  if (pendingDetailGaps > 0) {
    tone = strongerTone(tone, "warning");
  }
  if (skipLabel) {
    tone = strongerTone(tone, "warning");
  }

  return {
    stream: entry.stream,
    coverage,
    disposition,
    countsLabel: counts.label,
    countsTitle: counts.title,
    pendingDetailGaps,
    pendingDetailGapsIsFloor,
    pendingDetailGapsLabel: formatPendingDetailGapsLabel(pendingDetailGaps, pendingDetailGapsIsFloor),
    skipLabel,
    tone,
  };
}

export function streamOwnerActionCueNeeded(
  disposition: ForwardDispositionSummary | null,
  ownerActionAvailable: boolean
): boolean {
  return Boolean(disposition?.ownerActionNeeded && ownerActionAvailable);
}
