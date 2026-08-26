// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure projection of one `/_ref/connectors` connection summary into the rows
 * the `sources-report` CLI prints.
 *
 * WHY THIS EXISTS
 * ---------------
 * An agent reading raw `connector_summary_evidence` rows from Postgres is
 * reading the INPUTS to the health computation. The owner reading `/sources`
 * is reading the OUTPUT. Those two diverged badly: the agent reported "amber"
 * where the page said "not measured", and "green data" where the page drew a
 * red "can't collect" marker. Every rendering-layer defect was invisible to
 * the agent. This module exists so both read the same OUTPUT.
 *
 * WHAT IS AND IS NOT COMPUTED HERE
 * --------------------------------
 * The per-source verdict is NOT recomputed, and — since 2026-08-25 — it is no
 * longer RE-RANKED here either. `@pdpp/display`'s `projectSourceVerdict` is the
 * one producer of the dot/tone/label and the fused status line, and the console
 * `/sources` page calls exactly the same function. This module used to hand-port
 * a partial copy of that ranking; it never learned the `setup_failed` branch, so
 * six setup-failed Venmo connections printed "Revoked" here and "Setup never
 * completed" on the page. One producer, two consumers: a divergence like that
 * can no longer be written.
 *
 * What remains this module's own work is CLI presentation: stream rows,
 * coverage counts, checkpoints, and required-action lines.
 */

import { projectSourceVerdict, type SourceStatusFlag, type SourceStatusInput } from "@pdpp/display";
import { formatCoverageAxis, formatFreshnessAxis, formatOutboxAxis } from "@pdpp/display/health";

/**
 * The row status the CLI prints. Re-exported from `@pdpp/display` so the CLI
 * and the console name the same shape; the CLI never declares a second one.
 */
export type { SourceStatusFlag, SourceStatusKind, SourceVerdictTone as VerdictTone } from "@pdpp/display";

export interface SummaryStreamVerdict {
  readonly collected?: number | null;
  readonly considered?: number | null;
  readonly coverage?: string | null;
  readonly disposition?: string | null;
  readonly statement?: string | null;
  readonly stream_id?: string | null;
}

export interface SummaryRenderedVerdict {
  readonly annotations?: readonly { readonly kind?: string; readonly text?: string }[] | null;
  readonly forward_statement?: string | null;
  readonly pill?: { readonly label?: string | null; readonly tone?: string | null } | null;
  readonly progress?: { readonly headline?: string | null; readonly retained_records?: number | null } | null;
  readonly required_actions?: readonly { readonly cta?: string | null; readonly affects?: readonly string[] }[] | null;
  readonly streams?: readonly SummaryStreamVerdict[] | null;
}

/**
 * Extends `SourceStatusInput` (@pdpp/display) rather than restating it: the
 * fields the status ranking reads are the package's to declare, and the
 * compiler now rejects a CLI payload that cannot be ranked.
 *
 * `source_visibility` is deliberately NOT narrowed to a union here. It used to
 * read `"active" | "archived" | "hidden_from_sources"`, which silently omitted
 * `"setup_failed"` — the very value that made six Venmo rows print "Revoked"
 * instead of "Setup never completed". A closed union that lags the server is
 * how a wire value becomes invisible to the instrument reading it.
 */
export interface ConnectorSummaryLike extends SourceStatusInput {
  readonly collection_report?: readonly CollectionReportEntryLike[] | null;
  readonly connection_health?: {
    readonly axes?: {
      readonly attention?: string | null;
      readonly coverage?: string | null;
      readonly freshness?: string | null;
      readonly outbox?: string | null;
    } | null;
    readonly state?: string | null;
  } | null;
  readonly connection_id?: string | null;
  readonly connector_id?: string | null;
  readonly display_name?: string | null;
  readonly rendered_verdict?: SummaryRenderedVerdict | null;
  readonly total_records?: number | null;
}

export interface CollectionReportEntryLike {
  readonly checkpoint?: string | null;
  readonly collected?: number | null;
  readonly considered?: number | null;
  readonly coverage_condition?: string | null;
  readonly covered?: number | null;
  readonly skipped?: string | null;
  readonly stream?: string | null;
}

export interface StreamRow {
  /**
   * The collection-report checkpoint for this stream, when the summary
   * carried one. Surfaced because a stream can render "coverage complete"
   * while its checkpoint is `not_committed` — see the CLI's `--checkpoints`
   * flag and ledger item B5.
   */
  readonly checkpoint: string | null;
  /** `"5 of 5 covered"`, or null when the denominator is unknown. */
  readonly countsLabel: string | null;
  /** The raw wire key, so a report can be diffed against evidence rows. */
  readonly coverageKey: string;
  /** `"coverage complete"` — the exact phrasing the source-detail page prints. */
  readonly coverageLabel: string;
  readonly skipped: string | null;
  readonly statement: string | null;
  readonly stream: string;
}

export interface SourceRow {
  readonly axes: {
    readonly coverage: string;
    readonly freshness: string;
    readonly outbox: string;
  };
  readonly connectionId: string | null;
  readonly connectorId: string | null;
  readonly displayName: string;
  readonly forwardStatement: string | null;
  readonly freshnessNote: string | null;
  /**
   * The SAME fused state/freshness/activity line the `/sources` card renders.
   * The CLI had no counterpart to it until 2026-08-25, so the text the owner
   * actually reads on the page had nothing to be compared against here.
   */
  readonly fusedLine: string;
  readonly headline: string | null;
  readonly requiredActions: readonly string[];
  readonly status: SourceStatusFlag;
  readonly streams: readonly StreamRow[];
}

/**
 * `"5 of 5 covered"`. Returns null rather than inventing a denominator: a
 * local-collector stream reports a blank `considered`, and printing "0 of 0"
 * there would read as a settled zero rather than an unmeasured one.
 */
function buildCountsLabel(collected: number | null | undefined, considered: number | null | undefined): string | null {
  if (typeof considered !== "number" || !Number.isFinite(considered)) {
    return null;
  }
  const covered = typeof collected === "number" && Number.isFinite(collected) ? collected : 0;
  return `${covered} of ${considered} covered`;
}

function indexCollectionReport(
  entries: readonly CollectionReportEntryLike[] | null | undefined
): Map<string, CollectionReportEntryLike> {
  const index = new Map<string, CollectionReportEntryLike>();
  for (const entry of entries ?? []) {
    if (typeof entry?.stream === "string" && entry.stream.length > 0) {
      index.set(entry.stream, entry);
    }
  }
  return index;
}

function projectStreamRows(
  verdict: SummaryRenderedVerdict | null,
  report: Map<string, CollectionReportEntryLike>
): StreamRow[] {
  const streams: StreamRow[] = [];
  for (const stream of verdict?.streams ?? []) {
    const streamId = typeof stream.stream_id === "string" ? stream.stream_id : "(unnamed stream)";
    const entry = report.get(streamId);
    const chip = formatCoverageAxis(stream.coverage ?? null);
    streams.push({
      checkpoint: typeof entry?.checkpoint === "string" ? entry.checkpoint : null,
      countsLabel: buildCountsLabel(stream.collected, stream.considered),
      coverageKey: typeof stream.coverage === "string" ? stream.coverage : "unknown",
      // `coverage ${chip.value}` is the exact phrasing the console's stream
      // page builds (apps/console/.../sources/[connector]/[stream]/page.tsx).
      coverageLabel: `coverage ${chip.value}`,
      skipped: typeof entry?.skipped === "string" ? entry.skipped : null,
      statement: typeof stream.statement === "string" ? stream.statement : null,
      stream: streamId,
    });
  }
  return streams;
}

function projectRequiredActions(verdict: SummaryRenderedVerdict | null): string[] {
  const requiredActions: string[] = [];
  for (const action of verdict?.required_actions ?? []) {
    if (typeof action?.cta === "string" && action.cta.length > 0) {
      const affects = action.affects?.length ? ` (${action.affects.join(", ")})` : "";
      requiredActions.push(`${action.cta}${affects}`);
    }
  }
  return requiredActions;
}

export function projectSourceRow(summary: ConnectorSummaryLike): SourceRow {
  const verdict = summary.rendered_verdict ?? null;
  const axes = summary.connection_health?.axes ?? null;
  const streams = projectStreamRows(verdict, indexCollectionReport(summary.collection_report));
  const requiredActions = projectRequiredActions(verdict);
  // The one producer the console `/sources` page also calls.
  const projection = projectSourceVerdict(summary);

  return {
    axes: {
      coverage: formatCoverageAxis(axes?.coverage ?? null).value,
      freshness: formatFreshnessAxis(axes?.freshness ?? null).value,
      outbox: formatOutboxAxis(axes?.outbox ?? null).value,
    },
    connectionId: summary.connection_id ?? null,
    connectorId: summary.connector_id ?? null,
    displayName: summary.display_name || summary.connector_id || "(unnamed source)",
    forwardStatement: verdict?.forward_statement ?? null,
    freshnessNote: projection.renderedStatus.freshnessNote,
    fusedLine: projection.fusedStatus.line,
    headline: verdict?.progress?.headline ?? null,
    requiredActions,
    status: projection.renderedStatus,
    streams,
  };
}

export function projectSourceRows(summaries: readonly ConnectorSummaryLike[]): readonly SourceRow[] {
  return summaries.map(projectSourceRow);
}

/**
 * Streams that render a settled "coverage complete" while their durable
 * checkpoint was never committed.
 *
 * This is ledger item B5 (owner: USAA `accounts` shows "coverage complete /
 * 5 of 5" but `checkpoint: not_committed`). Reported as a distinct list
 * rather than folded into the coverage word, because whether an uncommitted
 * checkpoint SHOULD downgrade the verdict is a product decision — this
 * function only makes the combination visible instead of invisible.
 */
export function uncommittedCompleteStreams(rows: readonly SourceRow[]): readonly {
  readonly displayName: string;
  readonly stream: string;
  readonly countsLabel: string | null;
}[] {
  const flagged: { displayName: string; stream: string; countsLabel: string | null }[] = [];
  for (const row of rows) {
    for (const stream of row.streams) {
      if (stream.coverageKey === "complete" && stream.checkpoint === "not_committed") {
        flagged.push({ countsLabel: stream.countsLabel, displayName: row.displayName, stream: stream.stream });
      }
    }
  }
  return flagged;
}
