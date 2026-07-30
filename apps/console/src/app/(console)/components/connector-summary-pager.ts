// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure URL-state logic for the shared connector-summary pager.
 *
 * Every fleet-wide view (Sources, Schedules, Syncs, Add Source, Explore
 * facets) renders exactly ONE bounded `listConnectorSummaries({ cursor,
 * limit: 100 })` page per request — never an exhaustive fold.
 *
 * URL contract: `?page_cursor=<opaque>` ONLY.
 *   - `page_cursor` is the opaque, owner-scoped cursor for the CURRENT page
 *     (absent on page 1). It is the server's one most-recent `next_cursor`
 *     — a single bounded value, never an accumulated history.
 *   - There is deliberately NO session/navigation token and NO
 *     `page_stack`/history param. This app's pagination is a normal
 *     interactive UI talking to our own authenticated backend over a signed,
 *     monotonic keyset-cursor contract (`reference-implementation/server/
 *     ref-control.ts`'s cursor codec) — not an untrusted channel that needs
 *     a client-held cryptographic session to defend. "Previous" is the
 *     browser's own back button (ordinary navigation history), which is
 *     bounded by the browser itself and cannot be forged into an unbounded
 *     URL. A caller that arrives at a page via a bookmark/shared link (no
 *     back history) gets the explicit Restart link instead — never a
 *     fabricated "previous page" guess. See `connector-summary-page.tsx`'s
 *     module doc for the full boundary rationale (interactive UI vs.
 *     autonomous exhaustive loop).
 *   - Every OTHER search param on the current URL (query text, filters,
 *     in-flight selections) is preserved VERBATIM on the Next/Restart link
 *     — including every value of a REPEATED param (e.g. `?tag=a&tag=b`).
 *     Paging the fleet must never silently reset or truncate an unrelated
 *     part of the page's own state.
 *
 * No React, no Next, no client imports — mirrors `explore-navigation.ts`'s
 * separation so the URL rules are unit-testable without rendering anything.
 */

/** A raw Next.js `searchParams` object: values may be `string`, `string[]`, or `undefined`. */
export type RawSearchParams = Readonly<Record<string, readonly string[] | string | undefined>>;

export interface ConnectorSummaryPageParams {
  page_cursor?: string;
}

export interface ConnectorSummaryPageState {
  /** Cursor to request for the CURRENT page; undefined means page 1 (no cursor). */
  readonly cursor: string | undefined;
}

/** Parse the current page's cursor from raw search params. No history is parsed — there is none in the URL. */
export function parseConnectorSummaryPageState(params: ConnectorSummaryPageParams): ConnectorSummaryPageState {
  return {
    cursor: params.page_cursor || undefined,
  };
}

/**
 * Build a `URLSearchParams` carrying EVERY value of EVERY current param
 * (repeats included), excluding the pager-owned key(s) so a caller can set
 * its own replacement value(s). This is the shared primitive both
 * `buildNextPageHref` and `buildRestartHref` use — the actual fix for the
 * gate's finding that the generic pager dropped repeated query values:
 * previously, an intermediate flattened `Record<string, string | undefined>`
 * collapsed `?tag=a&tag=b` down to one `tag` before the href builders ever
 * ran. Building directly from the raw params object (still `string[]`
 * where the caller repeated a key) means nothing is lost.
 */
function buildParamsExcluding(rawParams: RawSearchParams, excludeKeys: ReadonlySet<string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    if (excludeKeys.has(key) || value === undefined) {
      continue;
    }
    for (const v of Array.isArray(value) ? value : [value]) {
      params.append(key, v);
    }
  }
  return params;
}

const PAGE_CURSOR_KEY = "page_cursor";
const PAGER_OWNED_KEYS = new Set([PAGE_CURSOR_KEY]);

/**
 * Build the href for advancing to the next page. Preserves every OTHER
 * current search param VERBATIM, including every value of a repeated param
 * — only `page_cursor` changes.
 */
export function buildNextPageHref(basePath: string, rawParams: RawSearchParams, nextCursor: string): string {
  const params = buildParamsExcluding(rawParams, PAGER_OWNED_KEYS);
  params.set(PAGE_CURSOR_KEY, nextCursor);
  return `${basePath}?${params.toString()}`;
}

/**
 * Build the href that restarts pagination at page 1, preserving every OTHER
 * current search param verbatim (repeats included). Drops `page_cursor` only.
 */
export function buildRestartHref(basePath: string, rawParams: RawSearchParams): string {
  const params = buildParamsExcluding(rawParams, PAGER_OWNED_KEYS);
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/** True when the current URL requests a page beyond page 1 (has a cursor). */
export function isPagedRequest(state: ConnectorSummaryPageState): boolean {
  return state.cursor !== undefined;
}
