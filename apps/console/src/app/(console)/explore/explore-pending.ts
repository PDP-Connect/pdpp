/**
 * Pure pending-state logic for the Explore canvas loading states — no React, no
 * Next, no client imports. The function-only core of the in-page navigation
 * feedback, mirroring the `explore-navigation.ts` precedent so the rules are
 * unit-testable without rendering the (`"use client"`) canvas.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────
 * Every in-page Explore interaction (filter, sort, range, search submit,
 * Load-more, peek, "N new" pill) navigates via a soft same-route `router.push`.
 * A soft same-route push does NOT trigger `loading.tsx`, so the canvas wraps the
 * push in `useTransition` and exposes `isPending` for its own loading affordances.
 *
 * `isPending` is GLOBAL to every navigation, but the Load-more button needs a
 * Load-more-specific "Loading…" affordance. So the canvas records WHICH action
 * started the transition (`PendingKind`) and these pure derivations decide what
 * each affordance shows for a given (`isPending`, `pendingKind`) pair. Keeping
 * them here means the loading contract is asserted against plain functions, not
 * a rendered component.
 */

/**
 * Which class of action started the in-flight transition. `"loadmore"` is
 * singled out because only the Load-more button gets a dedicated inline spinner;
 * every other navigation is `"navigation"` (drives the top progress bar + feed
 * dim only). `null` means no navigation is pending.
 */
export type PendingKind = "loadmore" | "navigation" | null;

/**
 * The EFFECTIVE pending kind: the recorded kind is only meaningful while a
 * transition is actually in flight. When `isPending` is false the navigation has
 * arrived (the transition completed), so the effective kind collapses to `null`
 * regardless of the last recorded value. This is the single source of truth the
 * affordance helpers below read, so a stale `pendingKind` can never leak a
 * spinner after navigation completes.
 */
export function effectivePendingKind(isPending: boolean, pendingKind: PendingKind): PendingKind {
  return isPending ? pendingKind : null;
}

/**
 * True when a Load-more push specifically is in flight — the only state that
 * shows the Load-more button's inline spinner + "Loading…" label. A non-Load-more
 * navigation (filter/sort/peek) does NOT spin the Load-more button; it only
 * disables it (see `loadMoreDisabled`).
 */
export function isLoadMorePending(isPending: boolean, pendingKind: PendingKind): boolean {
  return effectivePendingKind(isPending, pendingKind) === "loadmore";
}

/**
 * The Load-more button is disabled whenever ANY navigation is in flight: a
 * second push while one is pending would race the optimistic cursor trail. The
 * dedicated spinner still only renders for `isLoadMorePending`, so an unrelated
 * navigation greys the button without falsely claiming "more is loading".
 */
export function loadMoreDisabled(isPending: boolean): boolean {
  return isPending;
}

/** The Load-more button label: swaps to a busy label only for a Load-more push. */
export function loadMoreLabel(restingLabel: string, isPending: boolean, pendingKind: PendingKind): string {
  return isLoadMorePending(isPending, pendingKind) ? "Loading…" : restingLabel;
}

/**
 * The resting Load-more label for the current descriptor kind, preserving the
 * existing copy ("Load more →" for chronological accumulation, "Load more
 * results →" for the lexical pager). Centralised so the label is one source of
 * truth across the resting + busy states.
 */
export function loadMoreRestingLabel(descriptorKind: string): string {
  return descriptorKind === "complete_chronological" ? "Load more →" : "Load more results →";
}

/**
 * The feed region carries `aria-busy` while ANY navigation is in flight, so
 * assistive tech hears "this region is updating". The already-rendered records
 * stay at full opacity and full interactivity (useTransition keeps the current
 * UI live) — the owner can keep clicking / peeking / opening records while more
 * load. The loading signal lives in the progress bar + Load-more control, never
 * by dimming or disabling the interactive content. Returns "true" while pending,
 * otherwise undefined so the attribute is absent.
 */
export function feedAriaBusy(isPending: boolean): "true" | undefined {
  return isPending ? "true" : undefined;
}
