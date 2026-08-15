// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// A named, terminal-friendly resolver for the three choices an owner is
// actually offered when declaring a collection boundary: "Recent history",
// "All history", or a custom `since`/`source_roots` pair.
//
// This exists so every caller that offers that choice — a console picker, a
// CLI wizard, an owner-agent script — computes the SAME `since` instant for
// "recent" from the SAME day count, rather than each embedding its own
// day-math and drifting apart. Like its siblings in this module, it is pure
// and injects the clock rather than reading one, so the same inputs always
// resolve to the same boundary.

import type { CollectionScope } from "./collection-scope.ts";

/** The three choices a terminal or UI picker offers for a new connection. */
export type NamedCollectionScopeChoice =
  | { readonly kind: "recent"; readonly days?: number }
  | { readonly kind: "all" }
  | { readonly kind: "custom"; readonly since?: string | null; readonly source_roots?: readonly string[] | null };

/** "Recent history" with no explicit day count defaults to this window. */
export const DEFAULT_RECENT_HISTORY_DAYS = 30;

function daysBefore(nowIso: string, days: number): string {
  const nowMs = Date.parse(nowIso);
  return new Date(nowMs - days * 86_400_000).toISOString();
}

/**
 * Resolve a named choice into the `CollectionScope` the owner-scope routes
 * (intent creation, `PUT .../collection-scope`) already accept.
 *
 * `now` is injected, not read from the system clock, so a picker can preview
 * the resulting boundary and the CLI/API call that later declares it computes
 * the identical value — no clock drift between preview and declaration.
 *
 * `"all"` returns `null` (unscoped) rather than an empty object: `null` is
 * this contract's single encoding for "no boundary," per
 * `normalizeCollectionScope`'s own rule, and a full pass is itself a real
 * declared choice, not an absence of one — the fingerprint for `null` is the
 * explicit `"unscoped"` string, never silence.
 */
export function resolveNamedCollectionScope(choice: NamedCollectionScopeChoice, now: string): CollectionScope | null {
  if (choice.kind === "all") {
    return null;
  }
  if (choice.kind === "recent") {
    const days = choice.days && choice.days > 0 ? choice.days : DEFAULT_RECENT_HISTORY_DAYS;
    return { since: daysBefore(now, days) };
  }
  const since = typeof choice.since === "string" && choice.since.trim() ? choice.since.trim() : null;
  const roots = Array.isArray(choice.source_roots)
    ? choice.source_roots.filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    : null;
  if (!since && (!roots || roots.length === 0)) {
    return null;
  }
  return {
    ...(since ? { since } : {}),
    ...(roots && roots.length > 0 ? { source_roots: roots } : {}),
  };
}
