import { type StreamCollectionFacts, streamOwnerActionCueNeeded } from "../../lib/collection-report.ts";
import type { EvidenceTone } from "../../lib/connection-evidence.ts";

/**
 * Per-stream collection facts rendered under a stream row on the connector
 * detail page. Surfaces the reference's derived Collection Report
 * (`define-connector-progress-evidence-contract`) so an operator sees, per
 * stream, whether the last run's coverage is complete / resuming / won't
 * backfill, what the next run will do, and the objective collected count —
 * not just a record total.
 *
 * Honest-by-default (the formatter enforces it): an unknown considered
 * denominator never renders a fabricated fraction, and the coverage chip reuses
 * the same vocabulary as the connection headline, so a stream entry never
 * disagrees with the connection-level disposition.
 *
 * Renders `null` when there is nothing to say (no entry for this stream), so a
 * reference predating the field — or a stream with no report entry — leaves the
 * row exactly as it was.
 */
export function StreamCollectionFactsLine({
  facts,
  ownerActionAvailable = true,
}: {
  facts: StreamCollectionFacts | null;
  ownerActionAvailable?: boolean;
}) {
  if (!facts) {
    return null;
  }
  const { coverage, disposition, countsLabel, countsTitle, pendingDetailGaps, pendingDetailGapsLabel, skipLabel } =
    facts;
  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1"
      data-stream={facts.stream}
      data-testid="stream-collection-facts"
    >
      <span
        className={`pdpp-caption inline-flex items-center gap-0 px-2 py-0.5 ${streamFactsChipClass(coverage.tone)}`}
        data-axis-tone={coverage.tone}
        data-testid="stream-coverage-chip"
        title={coverage.title}
      >
        <span className="sr-only">{coverage.label}</span>
        <span aria-hidden className="opacity-60">
          {coverage.dimension}
        </span>
        <span aria-hidden className="mx-1 opacity-40">
          ·
        </span>
        <span aria-hidden className="font-medium">
          {coverage.value}
        </span>
      </span>

      {disposition ? (
        <span
          className="pdpp-caption text-muted-foreground"
          data-disposition={disposition.value}
          data-testid="stream-forward-disposition"
          title={disposition.title}
        >
          Next run: <span className={streamFactsTextClass(disposition.tone)}>{disposition.label}</span>
          {streamOwnerActionCueNeeded(disposition, ownerActionAvailable) ? (
            <span className="ml-1 text-muted-foreground">(needs you)</span>
          ) : null}
        </span>
      ) : null}

      {countsLabel ? (
        <span
          className="pdpp-caption text-muted-foreground tabular-nums"
          data-testid="stream-collected-counts"
          title={countsTitle}
        >
          {countsLabel}
        </span>
      ) : null}

      {pendingDetailGaps > 0 ? (
        <span
          className="pdpp-caption text-[color:var(--warning)] tabular-nums"
          data-testid="stream-pending-gaps"
          title={
            facts.pendingDetailGapsIsFloor
              ? "Recoverable detail gaps from a bounded read; there may be more beyond this count. Records already collected stay valid."
              : "Recoverable detail gaps the next ordinary run is expected to fill. Records already collected stay valid."
          }
        >
          {pendingDetailGapsLabel ?? "pending gaps"}
        </span>
      ) : null}

      {skipLabel ? (
        <span
          className="pdpp-caption text-muted-foreground"
          data-testid="stream-skip-label"
          title="The runtime reported this stream as skipped on the last run; the coverage chip carries what that means for completeness."
        >
          {skipLabel}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Chip background/border/text by tone. Mirrors `axisChipClass` in
 * `connector-row.tsx` and `diagnosticsAxisChipClass` in
 * `connection-diagnostics.tsx` — the established per-surface idiom in this
 * codebase keeps a tiny local copy rather than a shared chip abstraction.
 */
function streamFactsChipClass(tone: EvidenceTone): string {
  if (tone === "success") {
    return "border border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "warning") {
    return "border border-[color:var(--warning)]/40 bg-[color:var(--warning)]/5 text-[color:var(--warning)]";
  }
  if (tone === "danger") {
    return "border border-destructive/40 bg-destructive/5 text-destructive";
  }
  return "border border-muted-foreground/30 bg-muted/40 text-muted-foreground";
}

/** Inline text colour for the forward-disposition word (mirrors the detail diagnostics block). */
function streamFactsTextClass(tone: EvidenceTone): string {
  if (tone === "success") {
    return "text-emerald-700 dark:text-emerald-300";
  }
  if (tone === "warning") {
    return "text-[color:var(--warning)]";
  }
  if (tone === "danger") {
    return "text-destructive";
  }
  return "text-foreground";
}
