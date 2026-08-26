// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The ONE derivation of a source's owner-facing status.
 *
 * WHY THIS LIVES IN A PACKAGE
 * ---------------------------
 * Two surfaces show an owner the verdict for the same connection: the console
 * `/sources` page and the `sources-report` CLI. Until 2026-08-25 each derived
 * that verdict independently — the CLI hand-ported a PARTIAL copy of the
 * console's ranking that never learned the `setup_failed`/`setup_in_progress`/
 * `running` branches the console added later. Six `setup_failed` Venmo
 * connections (status `revoked` AND `source_visibility` `setup_failed`) printed
 * "Revoked" from the CLI and "Setup never completed" on the page, and the CLI's
 * fleet green-count matched the owner's by coincidence rather than by
 * measurement.
 *
 * "The measurement instrument lying is worse than any single row lying." So the
 * ranking lives here, once, and both surfaces import it. Two copies of a
 * lifecycle ranking are free to drift; one is not.
 *
 * WHY THE INPUT IS STRUCTURAL
 * ---------------------------
 * The console's `RefConnectorSummary` is a large wire type owned by
 * `ref-client.ts`, a module that imports `server-only`. Moving it here would
 * drag a Next-coupled surface into a framework-independent package. Instead
 * this module declares {@link SourceStatusInput} — only the fields the ranking
 * actually reads — and `RefConnectorSummary` satisfies it structurally. There
 * is no second declaration of the wire shape: this is a narrower VIEW of it,
 * and TypeScript proves the view is honest at every call site.
 */

/** The lifecycle/health states a source row can be in. */
export type SourceStatusKind =
  | "archived"
  | "blocked"
  | "degraded"
  | "healthy"
  | "paused"
  | "pending"
  | "revoked"
  | "setup_failed"
  | "unknown";

export type SourceStatusTone = "destructive" | "muted" | "success" | "warning";

/** The four tones the reference's `rendered_verdict.pill` can carry. */
export type SourceVerdictTone = "amber" | "green" | "grey" | "red";

export interface SourceStatusFlag {
  dot: string;
  freshnessNote: string | null;
  kind: SourceStatusKind;
  label: string;
  tone: SourceStatusTone;
}

/** Terminal dispositions for a first sync that returned nothing. */
export type SourceTerminalSetupDisposition = "unverified_missing_counts" | "unverified_zero" | "verified_empty";

export interface TerminalSetupDispositionCopy {
  actionLabel: string;
  statusLabel: string;
  what: string;
}

export const TERMINAL_SETUP_DISPOSITION_COPY: Record<SourceTerminalSetupDisposition, TerminalSetupDispositionCopy> = {
  unverified_missing_counts: {
    actionLabel: "Review setup",
    statusLabel: "needs review",
    what: "The first sync completed without durable count evidence. Review the connection before retrying.",
  },
  unverified_zero: {
    actionLabel: "Retry first sync",
    statusLabel: "needs review",
    what: "The first sync returned zero records without proving the account was empty. Review the connection and retry.",
  },
  verified_empty: {
    actionLabel: "Review empty result",
    statusLabel: "verified empty",
    what: "The first sync verified that this source has no records. Review the setup result before trying again.",
  },
};

const VERDICT_TONE_STATUS: Record<SourceVerdictTone, Pick<SourceStatusFlag, "dot" | "kind" | "tone">> = {
  amber: { dot: "◐", kind: "degraded", tone: "warning" },
  green: { dot: "●", kind: "healthy", tone: "success" },
  grey: { dot: "○", kind: "unknown", tone: "muted" },
  red: { dot: "⊘", kind: "blocked", tone: "destructive" },
};

/**
 * The verdict fields the status ranking reads. A structural view of the
 * console's `RefRenderedVerdict` and of the reference's `/_ref/connectors`
 * `rendered_verdict` — never a second declaration of either.
 */
export interface SourceVerdictInput {
  readonly annotations?: readonly { readonly kind?: string | null; readonly text?: string | null }[] | null;
  readonly pill?: { readonly label?: string | null; readonly tone?: string | null } | null;
}

/**
 * The connection fields the status ranking reads. Deliberately narrow: every
 * field here is one the ranking below actually branches on, so a reader can
 * see the whole input to the decision without opening the wire contract.
 */
export interface SourceStatusInput {
  readonly last_run?: { readonly status: string } | null;
  readonly last_successful_run?: unknown;
  readonly owner_state?: { readonly resolver?: string | null } | null;
  readonly rendered_verdict?: SourceVerdictInput | null;
  readonly revoked_at?: unknown;
  readonly source_visibility?: string | null;
  readonly status?: string | null;
  readonly terminal_setup_disposition?: SourceTerminalSetupDisposition | null;
}

const ACTIVE_RUN_SUMMARY_STATUSES = new Set(["pending", "started", "in_progress"]);

/** Connector-summary liveness from ref-control's `isActiveRunSummaryStatus`. */
export function isActiveSourceRunStatus(status: string): boolean {
  return ACTIVE_RUN_SUMMARY_STATUSES.has(status);
}

export function isRevokedSource(connector: SourceStatusInput): boolean {
  return connector.status === "revoked" || Boolean(connector.revoked_at);
}

/**
 * A `paused` connection: collection is stopped, but nothing was given up —
 * records, grants, schedule, and the stored credential all survive. Like
 * {@link isRevokedSource} this is a LIFECYCLE check independent of the verdict,
 * because `rendered_verdict` carries no lifecycle concept: a paused row's
 * health/coverage evidence describes the collection that stopped, and rendering
 * that as the source's status would tell the owner about a state the connection
 * is no longer in.
 */
export function isPausedSource(connector: SourceStatusInput): boolean {
  return connector.status === "paused";
}

/**
 * A `draft` connection has completed neither its credential capture nor its
 * first ingest. Prefers the server-derived `owner_state.resolver` (the closed,
 * exhaustively-tested source of truth — `runtime/owner-state.ts`). A missing
 * server state is not reconstructed from the raw lifecycle field.
 */
export function isSetupInProgressSource(connector: SourceStatusInput): boolean {
  return connector.owner_state?.resolver === "setup_in_progress";
}

/**
 * `"archived"` is the current spelling; `"hidden_from_sources"` is the retired
 * one, still accepted so a report run against an older reference classifies
 * those rows as archived instead of rendering them as live sources.
 */
export function isArchivedSource(connector: SourceStatusInput): boolean {
  return connector.source_visibility === "archived" || connector.source_visibility === "hidden_from_sources";
}

/**
 * A SETUP-FAILED source: a revoked retired-setup-shell binding that never had a
 * successful run. Server-derived in `deriveSourceVisibility` (`ref-control.ts`)
 * as `source_visibility: "setup_failed"`. Distinct from
 * {@link isArchivedSource}: an archived source once collected and is now
 * terminal; a setup-failed source never collected at all.
 */
export function isSetupFailedSource(connector: SourceStatusInput): boolean {
  return connector.source_visibility === "setup_failed";
}

export function freshnessNoteFromVerdict(verdict: SourceVerdictInput): string | null {
  const note = verdict.annotations?.find((annotation) => annotation.kind === "freshness")?.text;
  return typeof note === "string" && note.length > 0 ? note : null;
}

/**
 * An unrecognized tone from a NEWER server degrades to "unknown" rather than
 * throwing. The console's wire type narrows `pill.tone` to four values, but the
 * CLI reads whatever the reference actually sent — and this module now serves
 * both, so it must survive a tone (or an absent pill) its types did not
 * anticipate. Failing closed to "unknown" is the honest reading: we cannot show
 * a health colour we do not understand.
 */
function verdictToneStatus(tone: string | null | undefined): Pick<SourceStatusFlag, "dot" | "kind" | "tone"> {
  return typeof tone === "string" && Object.hasOwn(VERDICT_TONE_STATUS, tone)
    ? (VERDICT_TONE_STATUS[tone as SourceVerdictTone] as Pick<SourceStatusFlag, "dot" | "kind" | "tone">)
    : { dot: "○", kind: "unknown", tone: "muted" };
}

/** The honest placeholder for a verdict this build cannot read. */
const VERDICT_UNAVAILABLE = "Verdict unavailable";

/**
 * The pill label, or the honest placeholder.
 *
 * An UNRECOGNIZED tone degrades the label too, not just the glyph. A newer
 * server's `{ label: "Sparkling", tone: "chartreuse" }` would otherwise print
 * its label beside a neutral "unknown" dot, which reads as a verdict this build
 * understood and rated neutral. It did not understand it at all, and saying so
 * is the only honest option.
 */
function verdictPillLabel(verdict: SourceVerdictInput): string {
  const tone = verdict.pill?.tone;
  if (typeof tone !== "string" || !Object.hasOwn(VERDICT_TONE_STATUS, tone)) {
    return VERDICT_UNAVAILABLE;
  }
  const label = verdict.pill?.label;
  return typeof label === "string" && label.length > 0 ? label : VERDICT_UNAVAILABLE;
}

/**
 * The status a verdict alone implies, ignoring lifecycle and activity.
 *
 * {@link deriveRenderedSourceStatus} returns early on `running` (and on
 * paused/revoked/pending) and throws the verdict away. That is right for the
 * single-slot dot, but it means an in-flight run hides a "Needs attention" or
 * "Blocked" verdict entirely. The fused status line needs the discarded verdict
 * back so activity can be shown ALONGSIDE the real state instead of replacing
 * it — see {@link fuseSourceStatus}.
 *
 * Returns null when there is no verdict to recover, in which case the caller
 * should keep whatever {@link deriveRenderedSourceStatus} decided.
 */
export function deriveSourceVerdictStatus(verdict: SourceVerdictInput | null | undefined): SourceStatusFlag | null {
  if (!verdict) {
    return null;
  }
  const status = verdictToneStatus(verdict.pill?.tone);
  // `label` is the BARE pill label here, unlike `deriveRenderedSourceStatus`,
  // which concatenates the freshness note into it. The fused line renders
  // freshness in its own slot, so pre-concatenating would print it twice.
  return {
    ...status,
    freshnessNote: freshnessNoteFromVerdict(verdict),
    label: verdictPillLabel(verdict),
  };
}

function labelWithFreshness(base: string, note: string | null): string {
  return note ? `${base} · ${note}` : base;
}

export function deriveRenderedSourceStatus(
  verdict: SourceVerdictInput | null | undefined,
  revoked: boolean,
  pending = false,
  terminalSetupDisposition: SourceTerminalSetupDisposition | null = null,
  running = false,
  paused = false,
  archived = false,
  setupFailed = false
): SourceStatusFlag {
  // Ranked FIRST, ahead of every verdict-derived tone. An archived source's
  // last run may well have succeeded, so its stored verdict can still be
  // green — rendering that would tell the owner a source that will never
  // collect again is healthy, which is exactly the fabricated-green defect
  // class. Archived is terminal and muted: the records are real, the
  // collection is over, and no tone implies otherwise.
  if (archived) {
    return { dot: "⊘", freshnessNote: null, kind: "archived", label: "Archived · not collecting", tone: "muted" };
  }
  // Ranked alongside archived, ahead of plain `revoked`: a setup-failed
  // source is a MORE SPECIFIC terminal state than "Revoked" — it says the
  // connection never worked in the first place, not that a working one was
  // taken away. Muted, never a warning/destructive tone: the owner already
  // knows this attempt did not finish (server-side `archiveRenderedVerdict`
  // built this label), so there is nothing new to flag as a problem here.
  if (setupFailed) {
    return { dot: "⊘", freshnessNote: null, kind: "setup_failed", label: "Setup never completed", tone: "muted" };
  }
  if (revoked) {
    return { dot: "⊘", freshnessNote: null, kind: "revoked", label: "Revoked", tone: "muted" };
  }
  // Ranked directly after `revoked` and ahead of `running`/`pending`: a paused
  // connection is not collecting, so a stale in-flight run flag or a verdict
  // tone must never render it as "Syncing" or as a health colour. Muted (not
  // a warning tone) because pause is a state the owner chose, not a problem
  // to fix — the way back is an action, which the detail page offers.
  if (paused) {
    return { dot: "⏸", freshnessNote: null, kind: "paused", label: "Paused", tone: "muted" };
  }
  if (running) {
    return { dot: "◌", freshnessNote: null, kind: "pending", label: "Syncing", tone: "muted" };
  }
  // NOTE: the `running` collapse above intentionally discards the verdict, so a
  // caller that wants the fused status line must recover it via
  // `deriveSourceVerdictStatus` and pass it to `fuseSourceStatus` as the
  // fallback. See `fused-source-status.ts` for why activity must not overwrite
  // a worse verdict.
  if (terminalSetupDisposition) {
    return {
      dot: "◐",
      freshnessNote: null,
      kind: "degraded",
      label: TERMINAL_SETUP_DISPOSITION_COPY[terminalSetupDisposition].statusLabel,
      tone: "warning",
    };
  }
  // Setup-in-progress overrides any verdict shape, same priority as revoked:
  // a draft has no meaningful health/coverage evidence yet, so its verdict
  // tone (if any) must never be shown as the status.
  if (pending) {
    return { dot: "◌", freshnessNote: null, kind: "pending", label: "Setup in progress", tone: "muted" };
  }
  if (!verdict) {
    return {
      dot: "○",
      freshnessNote: null,
      kind: "unknown",
      label: VERDICT_UNAVAILABLE,
      tone: "muted",
    };
  }
  const status = verdictToneStatus(verdict.pill?.tone);
  const freshnessNote = freshnessNoteFromVerdict(verdict);
  return {
    ...status,
    freshnessNote,
    label: labelWithFreshness(verdictPillLabel(verdict), freshnessNote),
  };
}

/**
 * The lifecycle facts the ranking derives from one connection, computed once so
 * every consumer branches on the SAME booleans.
 *
 * `projectSourceActionability` used to compute these inline and then pass them
 * to `deriveRenderedSourceStatus` and `fuseSourceStatus` separately; when a
 * caller omitted one, the two projections disagreed (an archived source with a
 * green stored verdict fused to a green "Healthy" line while its dot read
 * archived). Deriving them in one place removes the chance to pass a different
 * set to each.
 */
export interface SourceLifecycleFacts {
  archived: boolean;
  paused: boolean;
  pending: boolean;
  revoked: boolean;
  running: boolean;
  setupFailed: boolean;
  terminalSetupDisposition: SourceTerminalSetupDisposition | null;
}

export function deriveSourceLifecycleFacts(connector: SourceStatusInput): SourceLifecycleFacts {
  const revoked = isRevokedSource(connector);
  const terminalSetupDisposition = connector.terminal_setup_disposition ?? null;
  return {
    archived: isArchivedSource(connector),
    paused: !revoked && isPausedSource(connector),
    pending: !revoked && isSetupInProgressSource(connector) && terminalSetupDisposition === null,
    revoked,
    running:
      connector.last_run !== null &&
      connector.last_run !== undefined &&
      isActiveSourceRunStatus(connector.last_run.status),
    setupFailed: isSetupFailedSource(connector),
    terminalSetupDisposition,
  };
}

/**
 * The status a source row renders, ranked over its lifecycle and its verdict.
 *
 * This is the single entry point both the console `/sources` page and the
 * `sources-report` CLI call. Passing the whole connection (rather than eight
 * positional booleans) is what makes it impossible for one surface to omit a
 * lifecycle fact the other passes.
 */
export function renderedSourceStatus(connector: SourceStatusInput): SourceStatusFlag {
  const facts = deriveSourceLifecycleFacts(connector);
  return deriveRenderedSourceStatus(
    connector.rendered_verdict,
    facts.revoked,
    facts.pending,
    facts.terminalSetupDisposition,
    facts.running,
    facts.paused,
    facts.archived,
    facts.setupFailed
  );
}
