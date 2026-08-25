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
 * The per-source status is NOT recomputed. It is read by dynamically
 * importing the console's own `projectSourceActionability`
 * (`apps/console/src/app/(console)/lib/source-actionability.ts`) — the SAME
 * function `/sources` calls for its dot, its pill, and its fused status line
 * — rather than re-deriving a THIRD copy of that ranking here.
 *
 * This module previously hand-ported a partial copy of
 * `deriveRenderedSourceStatus`: it read `rendered_verdict.pill.tone` directly
 * and reimplemented the archived/revoked/paused branches, but never learned
 * the `setup_failed`/`setup_in_progress`/`running` branches the console
 * added later. The concrete, reproduced defect: a `setup_failed` connection
 * (e.g. a revoked Venmo enrollment shell that never completed) is `status:
 * "revoked"` AND `source_visibility: "setup_failed"`; the console's ranking
 * checks `setup_failed` ahead of the bare `revoked` fallback and prints
 * "Setup never completed" with the server's specific forward statement, but
 * this module's old `deriveStatus` had no `isSetupFailedSource` branch at
 * all, so it fell into the generic `status === "revoked"` check and printed
 * the wrong, less specific "Revoked" — a second, independently-ranked copy of
 * the SAME lifecycle logic silently drifting from the first. Importing the
 * real function instead of restating its branches closes that class of
 * defect structurally: there is only one ranking to get right.
 *
 * `import type { ... } from "./ref-client.ts"` in that module is erased at
 * compile time (`verbatimModuleSyntax`), so the console's Next.js-coupled
 * modules (`next/headers`, `"server-only"`, cookie/session code) are types
 * only, never a runtime dependency of `projectSourceActionability` — the
 * dynamic import below pulls in nothing that requires a request context.
 * `reference-implementation/test/sources-report-model.test.ts` already
 * proved this pattern works by importing `connection-evidence.ts` the same
 * way.
 *
 * The axis keys → owner-facing words still come from `@pdpp/display/health`,
 * the one definition the console imports too.
 *
 * A source with no `rendered_verdict` reads an honest "Verdict unavailable" —
 * never a guess reconstructed from raw axes.
 */

import { formatCoverageAxis, formatFreshnessAxis, formatOutboxAxis } from "@pdpp/display/health";

export interface SourceStatusFlag {
  /** The glyph the console draws for this tone (`renderedStatus.dot`). */
  dot: string;
  kind: "archived" | "blocked" | "degraded" | "healthy" | "paused" | "pending" | "revoked" | "setup_failed" | "unknown";
  label: string;
}

/**
 * The console's `projectSourceActionability` (and the modules it composes
 * purely — no Next.js/network coupling) loaded once per process via dynamic
 * `import()`, exactly the pattern already proven by
 * `sources-report-model.test.ts`'s cross-surface parity test. A relative
 * specifier is used (not a string literal passed to a static analyzer) so
 * tsc never tries to resolve apps/console's module graph — and therefore
 * console's own stricter/looser compiler settings — under this package's
 * `tsconfig.json`.
 */
interface ConsoleSourceActionabilityModule {
  projectSourceActionability: (connector: unknown) => {
    fusedStatus: { line: string };
    renderedStatus: { dot: string; kind: SourceStatusFlag["kind"]; label: string };
  };
}

let consoleActionabilityModulePromise: Promise<ConsoleSourceActionabilityModule> | null = null;

/**
 * Loads the console's actionability module lazily (not at import time) so a
 * consumer of the pure helpers below (axis formatting, `uncommittedCompleteStreams`)
 * never pays for or depends on resolving apps/console's file tree.
 */
function loadConsoleSourceActionability(): Promise<ConsoleSourceActionabilityModule> {
  if (!consoleActionabilityModulePromise) {
    const specifier = ["..", "..", "apps", "console", "src", "app", "(console)", "lib", "source-actionability.ts"].join(
      "/"
    );
    consoleActionabilityModulePromise = import(specifier) as Promise<ConsoleSourceActionabilityModule>;
  }
  return consoleActionabilityModulePromise;
}

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
 * Shaped after `RefConnectorSummary`
 * (`apps/console/src/app/(console)/lib/ref-client.ts`) but kept structural
 * and mostly-optional: this is what a `/_ref/connectors` row looks like on
 * the wire, which is also exactly what `projectSourceActionability` expects
 * — the same object is passed to both this module's own stream/axis
 * projection AND (via `deriveStatus`, cast at that one call site) to the
 * console's real derivation. Extra fields beyond what this module's OWN
 * projection reads (`connector_instance_id`, `last_run`,
 * `last_successful_run`, `owner_state`, `revoked_at`,
 * `terminal_setup_disposition`) exist only so that cast is honest rather
 * than silently dropping data the console's ranking depends on.
 */
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
  readonly connector_instance_id?: string | null;
  readonly display_name?: string | null;
  readonly last_run?: { readonly status?: string | null } | null;
  readonly last_successful_run?: unknown;
  readonly owner_state?: { readonly resolver?: string | null } | null;
  readonly rendered_verdict?: SummaryRenderedVerdict | null;
  readonly revoked_at?: string | null;
  readonly source_visibility?: "active" | "archived" | "hidden_from_sources" | "setup_failed" | null;
  readonly status?: string | null;
  readonly terminal_setup_disposition?: string | null;
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
   * The console's fused status line (`fusedStatus.line` —
   * `fused-source-status.ts`): state, freshness, and activity composed under
   * the worst-honest-axis rule. This is the visible text on the `/sources`
   * card row, distinct from `status.label` (the bare pill/lifecycle label,
   * which drives the dot's tooltip).
   */
  readonly fusedLine: string;
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
 * `RefRenderedVerdict.pill.tone` is a closed 4-value union
 * (`RefVerdictTone`) — TypeScript enforces that on any value the CONSOLE
 * constructs. This CLI instead casts a raw, network-sourced JSON payload,
 * so an unrecognized 5th value (a newer server, a bug, a fixture) is a real
 * runtime possibility this module must defend against at ITS OWN network
 * boundary. The console's `VERDICT_TONE_STATUS[tone]` has no such guard —
 * an unrecognized tone spreads `{...undefined}` into `deriveRenderedSourceStatus`'s
 * return value, silently producing a `kind: undefined` status rather than
 * throwing OR degrading. That gap is real, but it is the console's to close
 * (same-repo console+server never actually disagree on the tone enum, so
 * the console has never needed to); this module does not "fix" it by
 * changing what `source-actionability.ts` does. Instead, an unrecognized
 * tone is normalized to "no pill" here, at the boundary, which
 * `deriveRenderedSourceStatus` already turns into the honest, existing
 * "Verdict unavailable" / grey / unknown fallback.
 */
const RECOGNIZED_VERDICT_TONES: ReadonlySet<string> = new Set(["amber", "green", "grey", "red"]);

/**
 * `RefRenderedVerdict` declares `annotations`, `forward_statement`, `pill`,
 * `required_actions`, and `streams` as always-present (never `undefined`).
 * This module's own `SummaryRenderedVerdict` makes every field optional (it
 * only needs a few for its own stream/axis projection), and its test
 * fixtures build partial verdicts — `projectSourceActionability` dereferences
 * several of these without an `undefined` guard (e.g.
 * `verdict?.required_actions[0]` guards only `verdict`, not
 * `required_actions` itself), so a verdict with a genuinely missing field
 * must be normalized to the console's contract here — never widened past
 * what `SummaryRenderedVerdict` promises, and never a guess at a VALUE the
 * console would treat as meaningful.
 */
function normalizeVerdictForConsoleActionability(verdict: SummaryRenderedVerdict | null | undefined): unknown {
  if (!verdict) {
    return verdict ?? null;
  }
  const tone = verdict.pill?.tone;
  const recognizedPill =
    verdict.pill && typeof tone === "string" && RECOGNIZED_VERDICT_TONES.has(tone) ? verdict.pill : null;
  return {
    ...verdict,
    annotations: verdict.annotations ?? [],
    // `SummaryRenderedVerdict` does not carry `channel` at all (this
    // module's own projection never reads it); `deriveRenderedSourceStatus`
    // does not read it either, so a fixed default is honest, not a guess.
    channel: "calm",
    forward_statement: verdict.forward_statement ?? "",
    pill: recognizedPill ?? { label: "Verdict unavailable", tone: "grey" },
    required_actions: verdict.required_actions ?? [],
    streams: verdict.streams ?? [],
  };
}

/**
 * The status dot/kind/label AND the fused summary line, both read from the
 * console's own `projectSourceActionability` rather than re-derived here.
 * See the module header for why this replaced a hand-ported partial copy of
 * `deriveRenderedSourceStatus`.
 *
 * `RefConnectorSummary` also declares `display_name`, `connection_id`,
 * `connector_id`, `connection_health`, `last_run`, `last_successful_run`,
 * `schedule`, `manifest_version`, `next_action`, and `freshness` as
 * always-present (never `undefined`, only optionally `null`). The real
 * `/_ref/connectors` wire payload always sends them, but this module's OWN
 * `ConnectorSummaryLike` makes most fields optional, and this module's tests
 * build minimal fixtures — `normalizeForConsoleActionability` fills the same
 * honest defaults one level up.
 */
function normalizeForConsoleActionability(summary: ConnectorSummaryLike): unknown {
  return {
    ...summary,
    connection_health: summary.connection_health ?? { axes: {}, state: "unknown" },
    connection_id: summary.connection_id ?? "",
    connector_id: summary.connector_id ?? "",
    display_name: summary.display_name ?? "",
    freshness: {},
    last_run: summary.last_run ?? null,
    last_successful_run: summary.last_successful_run ?? null,
    manifest_version: null,
    next_action: null,
    rendered_verdict: normalizeVerdictForConsoleActionability(summary.rendered_verdict),
    schedule: null,
  };
}

async function deriveStatus(summary: ConnectorSummaryLike): Promise<{ fusedLine: string; status: SourceStatusFlag }> {
  const { projectSourceActionability } = await loadConsoleSourceActionability();
  const projection = projectSourceActionability(normalizeForConsoleActionability(summary));
  return {
    fusedLine: projection.fusedStatus.line,
    status: {
      dot: projection.renderedStatus.dot,
      kind: projection.renderedStatus.kind,
      label: projection.renderedStatus.label,
    },
  };
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

export async function projectSourceRow(summary: ConnectorSummaryLike): Promise<SourceRow> {
  const verdict = summary.rendered_verdict ?? null;
  const axes = summary.connection_health?.axes ?? null;
  const streams = projectStreamRows(verdict, indexCollectionReport(summary.collection_report));
  const requiredActions = projectRequiredActions(verdict);
  const { fusedLine, status } = await deriveStatus(summary);

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
    fusedLine,
    headline: verdict?.progress?.headline ?? null,
    requiredActions,
    status,
    streams,
  };
}

export async function projectSourceRows(summaries: readonly ConnectorSummaryLike[]): Promise<readonly SourceRow[]> {
  const rows: SourceRow[] = [];
  for (const summary of summaries) {
    // biome-ignore lint/performance/noAwaitInLoops: the console module import is memoized after the first call; sequential awaits keep row order stable.
    rows.push(await projectSourceRow(summary));
  }
  return rows;
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
