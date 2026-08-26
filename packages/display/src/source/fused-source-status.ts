// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fused "what it is / when it last updated / whether it's syncing" status
 * line for one source.
 *
 * Owner-raised 2026-08-19: "why is there no product-standard fused
 * `Last updated X / Syncing now` status?" The design problem — and why the
 * obvious one-line fix is wrong — is written up in
 * `design-notes/fused-source-status-2026-08-22.md`. The short version:
 *
 * Freshness, activity, and the health verdict are THREE INDEPENDENT AXES that
 * routinely disagree. A source can be syncing right now and still be broken; it
 * can be fresh and have a failing run in flight; it can be stale precisely
 * because the sync that would refresh it keeps failing. Today's code resolves
 * that disagreement by LAST-WRITER-WINS: `deriveRenderedSourceStatus` returns
 * early on `running` with `label: "Syncing"`, `tone: "muted"`, and
 * `freshnessNote: null` (`source-status.ts`), so an in-flight run erases both
 * the freshness note and whatever the verdict said was wrong. That is the
 * fabricated-green defect in miniature: the most reassuring axis silently wins.
 *
 * This module fuses instead of overwriting, under one rule:
 *
 *   ACTIVITY IS ADDITIVE, NEVER SUBSTITUTIVE.
 *
 * "Syncing" is something a source is DOING, not something it IS. So the state
 * slot always keeps the worst honest verdict, and syncing is appended as
 * context. The fused line can never read cheerier than its worst axis.
 */

import type { SourceStatusFlag, SourceStatusKind, SourceStatusTone } from "./source-status.ts";

/**
 * How much confidence the fused line is entitled to. Ordered worst-to-best so
 * the worst axis can be selected by comparison rather than by branch order.
 */
const SEVERITY_BY_KIND: Record<SourceStatusKind, number> = {
  archived: 0,
  setup_failed: 0,
  blocked: 0,
  degraded: 1,
  unknown: 2,
  revoked: 3,
  paused: 4,
  pending: 5,
  healthy: 6,
};

export interface FusedSourceStatus {
  /** The freshness slot alone, or null when freshness is genuinely unknown. */
  freshness: string | null;
  kind: SourceStatusKind;
  /** The whole line, e.g. `"Needs attention · Last refreshed 3 days ago · Syncing now"`. */
  line: string;
  /** The state slot alone — the worst honest verdict, never "Syncing". */
  state: string;
  /** True when a run is in flight. Drives the animated dot, never the wording of `state`. */
  syncing: boolean;
  tone: SourceStatusTone;
}

/** The activity clause. Additive context, never the state itself. */
const SYNCING_CLAUSE = "Syncing now";

/** Trailing sentence period on a server freshness annotation. */
const TRAILING_PERIOD = /\.$/;
/** The server's activity-flavored freshness annotation; this module owns activity. */
const SERVER_REFRESHING_NOW = /^refreshing now$/i;

/**
 * Freshness copy for a source that has never produced a successful refresh.
 * "Never" is a real, honest answer; omitting the slot would let the line read
 * as though freshness simply wasn't applicable.
 */
const NEVER_UPDATED = "Never updated";

/**
 * Trims a server freshness annotation into the fused line's slot.
 *
 * The server's own annotation already fuses activity in some cases —
 * `rendered-verdict.ts` returns "Refreshing now." when `badges.syncing` — which
 * would double up with our activity clause. Fusing is this module's job, so the
 * activity-flavored annotation is dropped here and re-added from the actual
 * `syncing` flag, keeping one source of truth for the activity slot.
 */
function freshnessSlot(note: string | null, hasEverSucceeded: boolean): string | null {
  if (note === null) {
    return hasEverSucceeded ? null : NEVER_UPDATED;
  }
  const trimmed = note.trim().replace(TRAILING_PERIOD, "");
  if (trimmed === "") {
    return hasEverSucceeded ? null : NEVER_UPDATED;
  }
  // The server's activity-flavored freshness annotation; our own clause covers it.
  if (SERVER_REFRESHING_NOW.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Strips a pre-concatenated freshness note off a state label.
 *
 * `deriveRenderedSourceStatus` builds its `label` as
 * `` `${pill.label} · ${freshnessNote}` `` because its own consumers — the row
 * dot's tooltip and the passport status line — are SINGLE SLOTS that must carry
 * freshness inside the label or not at all. This module is the opposite: it
 * renders freshness in a slot of its own. Composing the concatenated label here
 * printed the freshness sentence twice, once with its trailing period and once
 * without (`freshnessSlot` strips the period), which is exactly what an owner
 * reported on 2026-08-23:
 *
 *   Can't collect · Freshness has not been measured yet. · Freshness has not been measured yet
 *
 * Stripping here rather than changing what `deriveRenderedSourceStatus` returns
 * keeps that function's contract intact for its single-slot consumers. Only an
 * EXACT trailing `" · <note>"` is removed, so a label that merely happens to
 * end in similar words is left alone.
 */
function stateLabelWithoutFreshness(label: string, note: string | null): string {
  if (note === null) {
    return label;
  }
  const suffix = ` · ${note}`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length) : label;
}

/**
 * Picks the state slot. `running` must never overwrite a worse verdict, so when
 * a source is both syncing and unhealthy the unhealthy label wins the slot and
 * syncing moves to its own clause.
 *
 * `flag` is what `deriveRenderedSourceStatus` produced. When it already
 * collapsed to "Syncing" (its `running` early-return), `verdictFallback`
 * carries the verdict label that collapse discarded — that is the honest state,
 * and it is used whenever it is no better than what the flag reported.
 */
function stateSlot(flag: SourceStatusFlag, verdictFallback: SourceStatusFlag | null): SourceStatusFlag {
  if (!verdictFallback) {
    return flag;
  }
  return SEVERITY_BY_KIND[verdictFallback.kind] <= SEVERITY_BY_KIND[flag.kind] ? verdictFallback : flag;
}

/**
 * Composes the fused status line.
 *
 * @param flag The status as rendered today (may already be the "Syncing" collapse).
 * @param options.syncing Whether a run is actually in flight.
 * @param options.verdictFallback The verdict-derived status that the "Syncing"
 *   collapse discarded, when there was one. Supplying it is what lets a failing
 *   source keep saying it is failing while it syncs.
 * @param options.hasEverSucceeded Whether any successful refresh exists, so a
 *   missing freshness note can be reported as "Never updated" rather than omitted.
 */
export function fuseSourceStatus(
  flag: SourceStatusFlag,
  options: {
    hasEverSucceeded?: boolean;
    syncing?: boolean;
    verdictFallback?: SourceStatusFlag | null;
  } = {}
): FusedSourceStatus {
  const syncing = options.syncing ?? false;
  const hasEverSucceeded = options.hasEverSucceeded ?? true;
  const state = stateSlot(flag, options.verdictFallback ?? null);

  // Freshness is taken from whichever slot actually carries it: the "Syncing"
  // collapse nulls its own note, so the recovered verdict is the only place it
  // survives.
  const freshness = freshnessSlot(state.freshnessNote ?? flag.freshnessNote, hasEverSucceeded);

  // The state slot is the BARE label. `deriveRenderedSourceStatus` may have
  // pre-concatenated the freshness note into it for its single-slot consumers;
  // freshness has its own slot here, so keeping it would print it twice.
  const stateLabel = stateLabelWithoutFreshness(state.label, state.freshnessNote);

  // A paused or revoked source is not syncing in any owner-meaningful sense,
  // and a stale in-flight run flag must not make it look like it is. Those
  // states already rank ahead of `running` in `deriveRenderedSourceStatus`;
  // this keeps the fused line consistent with that ranking.
  const showSyncing = syncing && state.kind !== "paused" && state.kind !== "revoked";

  const line = [stateLabel, freshness, showSyncing ? SYNCING_CLAUSE : null].filter(Boolean).join(" · ");

  return {
    freshness,
    kind: state.kind,
    line,
    state: stateLabel,
    syncing: showSyncing,
    tone: state.tone,
  };
}
