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
 * The per-source verdict is NOT recomputed. The reference server already
 * owns it: `rendered_verdict.pill` ({label, tone}) arrives pre-computed over
 * the wire, and the console does not second-guess it either (see
 * `apps/console/src/app/(console)/lib/source-actionability.ts`, whose header
 * records the 2026-07-09 state-model convergence: "There is no client-side
 * fallback to raw connection-health `state`"). This module reproduces only
 * the console's own thin presentation step:
 *
 *   1. `pill.tone` → the dot glyph and status kind, via the SAME table shape
 *      the console uses (`VERDICT_TONE_STATUS`), and
 *   2. the axis keys → owner-facing words, via `@pdpp/display/health`, which is the
 *      one definition the console imports too.
 *
 * A source with no `rendered_verdict` reads an honest "Verdict unavailable" —
 * never a guess reconstructed from raw axes.
 */

import { formatCoverageAxis, formatFreshnessAxis, formatOutboxAxis } from "@pdpp/display/health";

/** The four tones the reference's `rendered_verdict.pill` can carry. */
export type VerdictTone = "amber" | "green" | "grey" | "red";

export interface SourceStatusFlag {
  /** The glyph the console draws for this tone. */
  dot: string;
  kind: "archived" | "blocked" | "degraded" | "healthy" | "pending" | "revoked" | "unknown";
  label: string;
}

/**
 * Mirrors `VERDICT_TONE_STATUS` in
 * `apps/console/src/app/(console)/lib/source-actionability.ts`.
 *
 * This is the one piece of console presentation the CLI restates rather than
 * imports: the console's table also carries a CSS tone token ("destructive",
 * "muted") that means nothing in a terminal, and that module additionally
 * pulls in console-local `rs-client`/`next-action` types. The GLYPHS and the
 * KINDS are the load-bearing part and are asserted against the console's
 * table by `sources-report-model.test.ts`, so a change on either side fails
 * the build rather than silently drifting.
 */
const VERDICT_TONE_STATUS: Record<VerdictTone, Pick<SourceStatusFlag, "dot" | "kind">> = {
  amber: { dot: "◐", kind: "degraded" },
  green: { dot: "●", kind: "healthy" },
  grey: { dot: "○", kind: "unknown" },
  red: { dot: "⊘", kind: "blocked" },
};

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

export interface ConnectorSummaryLike {
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
  readonly source_visibility?: "active" | "archived" | "hidden_from_sources" | null;
  readonly status?: string | null;
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
  readonly headline: string | null;
  readonly requiredActions: readonly string[];
  readonly status: SourceStatusFlag;
  readonly streams: readonly StreamRow[];
}

/**
 * Mirrors the console's `labelWithFreshness`: the row label an owner reads is
 * the pill label plus the co-required freshness annotation, so a red
 * "Can't collect" row reads "Can't collect · freshness has not been measured
 * yet" exactly as it does on the page.
 */
function freshnessNoteFromVerdict(verdict: SummaryRenderedVerdict): string | null {
  for (const annotation of verdict.annotations ?? []) {
    if (annotation?.kind === "freshness" && typeof annotation.text === "string" && annotation.text.length > 0) {
      return annotation.text;
    }
  }
  return null;
}

/**
 * `"archived"` is the current spelling; `"hidden_from_sources"` is the retired
 * one, still accepted so a report run against an older reference classifies
 * those rows as archived instead of rendering them as live sources.
 */
function isArchivedSource(summary: ConnectorSummaryLike): boolean {
  return summary.source_visibility === "archived" || summary.source_visibility === "hidden_from_sources";
}

function deriveStatus(summary: ConnectorSummaryLike): SourceStatusFlag {
  // Lifecycle outranks the verdict, exactly as `deriveRenderedSourceStatus`
  // ranks it: a revoked or paused connection is not collecting, so a stale
  // verdict tone must never be shown as its health.
  //
  // Archived is ranked FIRST, ahead of even `revoked`, matching the console.
  // An archived row is usually `paused` carrying a stored verdict from when it
  // was live, so ranking `paused` first printed "⏸ Paused" — and, before the
  // server-side fix, "Reconnect this account", a promise that leads nowhere
  // because reconnecting mints a new connection and resumes nothing. The
  // records are real; the collection is over.
  if (isArchivedSource(summary)) {
    return { dot: "⊘", kind: "archived", label: "Archived · not collecting" };
  }
  if (summary.status === "revoked") {
    return { dot: "⊘", kind: "revoked", label: "Revoked" };
  }
  if (summary.status === "paused") {
    return { dot: "⏸", kind: "pending", label: "Paused" };
  }
  const verdict = summary.rendered_verdict;
  const tone = verdict?.pill?.tone;
  if (!verdict || typeof tone !== "string" || !Object.hasOwn(VERDICT_TONE_STATUS, tone)) {
    return { dot: "○", kind: "unknown", label: "Verdict unavailable" };
  }
  const base = VERDICT_TONE_STATUS[tone as VerdictTone];
  const pillLabel = typeof verdict.pill?.label === "string" ? verdict.pill.label : "Verdict unavailable";
  const note = freshnessNoteFromVerdict(verdict);
  return { ...base, label: note ? `${pillLabel} · ${note}` : pillLabel };
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
    freshnessNote: verdict ? freshnessNoteFromVerdict(verdict) : null,
    headline: verdict?.progress?.headline ?? null,
    requiredActions,
    status: deriveStatus(summary),
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
