/**
 * Saved views — pure, framework-free logic for the Explore saved-view tabs (R5).
 *
 * THE HONESTY CONTRACT (08-saved-views-design.md):
 *   A saved view is a USER-AUTHORED named query — NOT a guessed semantic preset.
 *   The user builds a filter (chips / operators / date), names it, and that named
 *   query becomes a tab. The system stores the LITERAL view href and never decides
 *   what a stream "means" by its name. The ONLY built-in tab is "All" (no filter).
 *   Shipping a guessed "Money"/"Messages" preset would require the system to decide
 *   which streams are money/messages by NAME — exactly the meaning-guessing the whole
 *   redesign forbids. So: user-authored only, localStorage-only, no server, no guess.
 *
 * A saved view = { id, name, href } where `href` is the shareable view URL that
 * `buildCurrentViewHref` produces (the same one "copy view link" yields) — it already
 * excludes the volatile cursor/anchor/peek params. Persisted as an array in
 * localStorage. A tab click just navigates to `href`; no new server round-trip.
 *
 * This module is the function-only core (read/write/parse/active-match) so the rules
 * are unit-testable without rendering the canvas — mirrors explore-navigation.ts.
 */

export interface SavedView {
  /** The shareable view href this tab navigates to (buildCurrentViewHref output). */
  href: string;
  /** Stable id (so React keys + delete are unambiguous). */
  id: string;
  /** The user-chosen name shown on the tab (sans — user content, never mono). */
  name: string;
}

/** localStorage key. Versioned so a future schema change can migrate cleanly. */
export const SAVED_VIEWS_STORAGE_KEY = "pdpp.explore.savedViews.v1";

/**
 * Params that do NOT define a view's IDENTITY — they are session/pagination state,
 * not what the owner saved. Two URLs that differ only in these point at the SAME
 * view, so active-tab matching and "already saved?" both ignore them.
 */
const VOLATILE_PARAMS = new Set(["peek", "cursor", "cursors", "ucursors", "anchor"]);

/**
 * Canonical identity of a view href: its non-volatile search params, sorted, so
 * param ORDER and pagination/peek state never affect equality. Returns a stable
 * string usable as a map key or for direct comparison. A bare path (no query) and
 * a path with only volatile params both canonicalize to the empty identity ("All").
 *
 * Accepts a relative href ("/explore?q=foo&order=oldest"). Parsing is done
 * against a dummy origin so URLSearchParams handles encoding/repeats correctly. The
 * trailing `order=oldest` suffix that buildCurrentViewHref appends is a normal param,
 * so it round-trips here without special-casing.
 */
export function canonicalViewIdentity(href: string): string {
  const qIndex = href.indexOf("?");
  if (qIndex < 0) {
    return "";
  }
  const params = new URLSearchParams(href.slice(qIndex + 1));
  const kept: [string, string][] = [];
  for (const [key, value] of params) {
    if (!VOLATILE_PARAMS.has(key)) {
      kept.push([key, value]);
    }
  }
  // Sort by key then value so repeated params (connection=a&connection=b) and any
  // param order canonicalize identically. Empty → "All".
  kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return kept.map(([k, v]) => `${k}=${v}`).join("&");
}

/** True when two hrefs point at the same view (ignoring pagination/peek/order-of-params). */
export function sameView(a: string, b: string): boolean {
  return canonicalViewIdentity(a) === canonicalViewIdentity(b);
}

/** True when the current href has NO view filters — the built-in "All" tab is active. */
export function isAllView(href: string): boolean {
  return canonicalViewIdentity(href) === "";
}

/**
 * Parse the persisted localStorage value into a clean SavedView[]. Defensive: any
 * malformed entry (missing fields, wrong types) is dropped, never thrown — a corrupt
 * blob must not break the feed. Returns [] on any parse failure.
 */
export function parseSavedViews(raw: string | null): SavedView[] {
  if (!raw) {
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: SavedView[] = [];
  for (const item of value) {
    if (
      item &&
      typeof item === "object" &&
      typeof (item as SavedView).id === "string" &&
      typeof (item as SavedView).name === "string" &&
      typeof (item as SavedView).href === "string" &&
      (item as SavedView).name.trim().length > 0
    ) {
      out.push({ id: (item as SavedView).id, name: (item as SavedView).name, href: (item as SavedView).href });
    }
  }
  return out;
}

/**
 * Add a saved view to the list, idempotent on (name, view-identity): if a view with
 * the same canonical identity already exists, the list is returned UNCHANGED (no
 * duplicate tabs for the same filter). The id is supplied by the caller (the client
 * can't use Math.random in this module's tests; the canvas passes a stable id).
 */
export function addSavedView(views: readonly SavedView[], next: SavedView): SavedView[] {
  const nextIdentity = canonicalViewIdentity(next.href);
  // Never let "All" (no-filter) be saved as a view — it is the built-in tab.
  if (nextIdentity === "") {
    return [...views];
  }
  if (views.some((v) => canonicalViewIdentity(v.href) === nextIdentity)) {
    return [...views];
  }
  return [...views, next];
}

/** Remove a saved view by id. */
export function removeSavedView(views: readonly SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id);
}

/**
 * The active saved view for the current href, or null when "All" (or an unsaved
 * filter) is active. Used to highlight the right tab and to decide whether
 * "+ Save view" should offer to save the CURRENT (unsaved, non-All) filter.
 */
export function activeSavedView(views: readonly SavedView[], currentHref: string): SavedView | null {
  const identity = canonicalViewIdentity(currentHref);
  if (identity === "") {
    return null;
  }
  return views.find((v) => canonicalViewIdentity(v.href) === identity) ?? null;
}

/**
 * Whether to offer "+ Save view": only when the current view is a NON-All filter that
 * is NOT already saved. (Saving "All" is meaningless; re-saving an existing view is a
 * no-op.) Keeps the affordance honest — it appears exactly when it would do something.
 */
export function canSaveCurrentView(views: readonly SavedView[], currentHref: string): boolean {
  if (isAllView(currentHref)) {
    return false;
  }
  return activeSavedView(views, currentHref) === null;
}
