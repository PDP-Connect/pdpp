// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared bounded-page fetch + pager UI for every fleet-wide connector-summary
 * view (Sources, Schedules, Syncs, Add Source, Explore facets).
 *
 * The one first-render primitive is `loadConnectorSummaryPage`: ONE bounded
 * `listConnectorSummaries({ cursor, limit: 100 })` request. There is no
 * exhaustive "fetch every page" fold anywhere in this codebase — every
 * render path awaits exactly one page. A malformed, expired, or
 * otherwise-rejected continuation is never silently coerced into "no more
 * pages" — it surfaces as an explicit restart affordance, because a
 * generic empty state would look identical to a genuinely exhausted feed.
 *
 * Envelope validation is delegated to the shared `@pdpp/list-envelope`
 * validator (`object === "list"`, array `data`, boolean `has_more`, coherent
 * trimmed continuation) — the same validator the CLI and live-audit script
 * use, so none of the four can independently drift on what counts as a
 * valid page.
 *
 * ── The interactive-UI vs. autonomous-loop boundary (read before touching
 *    this file) ──
 *
 * A prior revision added a server-side `globalThis` session-store keyed by a
 * client-supplied `nav` token, to detect non-adjacent continuation cycles
 * (`a -> b -> a`) that a bare immediate-self-loop check cannot see. An
 * independent gate review correctly rejected it: the store accepted ANY
 * caller-supplied token with no format/signature/expiry/owner binding, so an
 * attacker (or just many bookmarked links) could grow the map unboundedly,
 * and a forged fresh token per request defeated the cycle check entirely.
 * The gate's own proposed fix — an HMAC-signed, expiry-bound cursor-history
 * token — solves that forgery problem, but it solves a problem this surface
 * doesn't have: this pager is a normal owner-interactive UI making one
 * request at a time against OUR OWN authenticated backend
 * (`verifyDashboardSession` gates every fetch — see `owner-token.ts`),
 * over a cursor that is already a signed, monotonic keyset contract
 * (`reference-implementation/server/ref-control.ts`). The client here is not
 * an adversary to cryptographically defend against; it's the owner clicking
 * Next. Adding client/server history machinery to defend a channel that is
 * already authenticated is exactly the wrong tool for this boundary — it
 * only reintroduces the unbounded-memory/forgery surface the gate found.
 *
 * So this file does NOT track cross-request history at all. It validates the
 * envelope strictly (shape + coherent continuation) and rejects only what a
 * SINGLE request can prove on its own: a `next_cursor` identical to the
 * cursor that produced it (an immediate self-loop — the monotonic keyset
 * contract guarantees a well-behaved server never returns this). A
 * non-adjacent cycle from an actively malicious/broken backend is not
 * defended against here, because defending against our own compromised
 * backend is not this surface's job — if the backend's cursor contract is
 * broken, the fix belongs in `ref-control.ts`'s cursor codec, not in a
 * client-held forgeable session map.
 *
 * The one place a FULL visited-cursor set legitimately belongs is an
 * AUTONOMOUS, unattended, single-process exhaustive loop with no user
 * interaction between pages and no risk of unbounded caller-supplied keys —
 * exactly `packages/cli/src/ref/commands/connectors.ts`'s `--all` page
 * follower and `scripts/stream-health-audit/live.ts`'s fleet fetch. Both
 * keep a plain function-scoped `Set` for the lifetime of one run; neither is
 * `globalThis`-backed, neither is keyed by anything a caller supplies, and
 * neither survives past the one loop that created it.
 *
 * Navigation model (no accumulated URL history, no session state):
 *   - "Next" is a plain link carrying the single opaque `page_cursor` the
 *     server just returned — bounded, not a growing stack.
 *   - "Previous" is the browser's OWN back button (ordinary navigation
 *     history) — never reconstructed from URL or server state.
 *   - "Restart" is an always-present explicit link back to page 1,
 *     preserving every other current search param (repeats included), for
 *     the case where there is no back history (a bookmark/shared link) or a
 *     continuation was rejected.
 */

import { validateListEnvelope } from "@pdpp/list-envelope";
import Link from "next/link";
import { unstable_rethrow } from "next/navigation";
import {
  buildNextPageHref,
  buildRestartHref,
  type ConnectorSummaryPageState,
  type RawSearchParams,
} from "./connector-summary-pager.ts";

export const CONNECTOR_SUMMARY_PAGE_SIZE = 100;

export interface ConnectorSummaryPageParams {
  page_cursor?: string;
}

/**
 * Outcome of the one bounded request a fleet view's page.tsx makes.
 * `kind: "error"` covers a malformed/rejected continuation as well as a
 * genuine transport failure — either way the view must show an explicit
 * restart, never a silently-empty or silently-truncated list.
 */
export type ConnectorSummaryPageResult<T, R = undefined, H = undefined> =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly hasMore: boolean;
      readonly items: readonly T[];
      readonly kind: "ok";
      readonly nextCursor?: string;
      readonly runtime: R;
      readonly fleetHealth?: H;
    };

/**
 * Fetch exactly one bounded page. `fetchPage` is the caller's real
 * `listConnectorSummaries({ cursor, limit })` (or `dataSource.listConnectorSummaries`)
 * call — this function does not import `ref-client.ts` itself so it stays
 * usable from any caller's own data-source binding.
 *
 * ENVELOPE VALIDATION (strict, shared): `validateListEnvelope` rejects a
 * wrong discriminator, non-array data, non-boolean `has_more`, and an
 * incoherent continuation (missing/blank cursor on `has_more: true`, or a
 * non-blank cursor on a claimed-terminal `has_more: false` page).
 *
 * IMMEDIATE SELF-LOOP REJECTION: a `next_cursor` equal to the cursor that
 * produced it is rejected — see the module doc above for why this file
 * stops there and does not track cross-request cycle history.
 */
export async function loadConnectorSummaryPage<T, R = undefined, H = undefined>(
  state: ConnectorSummaryPageState,
  fetchPage: (opts: { cursor?: string; limit: number }) => Promise<{
    data: readonly T[];
    has_more: boolean;
    next_cursor?: string;
    fleet_health?: H;
    runtime?: R;
  }>
): Promise<ConnectorSummaryPageResult<T, R | undefined, H | undefined>> {
  try {
    const response = await fetchPage({ cursor: state.cursor, limit: CONNECTOR_SUMMARY_PAGE_SIZE });
    const validation = validateListEnvelope<T>(response);
    if (validation.kind === "invalid") {
      return {
        kind: "error",
        message: `The server returned a malformed page (${validation.reason}). Please restart from page 1.`,
      };
    }
    if (validation.nextCursor && validation.nextCursor === state.cursor) {
      return {
        kind: "error",
        message: "The server returned a continuation that loops back to this same page. Please restart from page 1.",
      };
    }
    return {
      hasMore: validation.hasMore,
      items: validation.data,
      kind: "ok",
      nextCursor: validation.nextCursor,
      fleetHealth: response.fleet_health,
      runtime: response.runtime,
    };
  } catch (err) {
    // This shared loader is imported by a bare Node test suite, so it cannot
    // import the server-only wrapper used by page modules. Call the same public
    // Next.js primitive directly before converting real data errors.
    unstable_rethrow(err);
    // A rejected continuation (malformed/expired cursor) and a genuine
    // transport failure both land here. Both are "this page could not be
    // shown" — never silently reinterpreted as "no more pages" or "the
    // fleet is empty".
    return {
      kind: "error",
      message: err instanceof Error ? err.message : "Could not load this page.",
    };
  }
}

/**
 * Shared pager control: Next + Restart across the current bounded page.
 * "Previous" is deliberately NOT a link here — the browser's own back
 * button already does that job using ordinary navigation history, with no
 * URL-side state to grow unbounded. Renders nothing when this is the only
 * page (no cursor, no further page). Server-renderable — no client JS
 * required.
 */
export function ConnectorSummaryPager({
  basePath,
  currentParams,
  hasMore,
  isPaged,
  nextCursor,
}: {
  basePath: string;
  currentParams: RawSearchParams;
  hasMore: boolean;
  isPaged: boolean;
  nextCursor: string | undefined;
}) {
  const canAdvance = hasMore && Boolean(nextCursor);
  if (!(isPaged || canAdvance)) {
    return null;
  }
  return (
    <nav
      aria-label="Fleet pagination"
      className="rr-connector-pager"
      style={{ display: "flex", gap: 12, marginTop: 16 }}
    >
      {isPaged ? (
        <Link className="rr-connector-pager__restart" href={buildRestartHref(basePath, currentParams)}>
          Restart from page 1
        </Link>
      ) : null}
      {canAdvance && nextCursor ? (
        <Link className="rr-connector-pager__next" href={buildNextPageHref(basePath, currentParams, nextCursor)}>
          Next page →
        </Link>
      ) : null}
    </nav>
  );
}

/**
 * Explicit failure banner for a rejected/malformed continuation. Always
 * offers a restart to page 1 rather than degrading to an empty/partial list.
 */
export function ConnectorSummaryPageError({
  basePath,
  currentParams,
  message,
}: {
  basePath: string;
  currentParams: RawSearchParams;
  message: string;
}) {
  return (
    <div className="rr-s-toast" data-tone="error" role="alert" style={{ marginBottom: 16 }}>
      <p style={{ margin: "0 0 8px" }}>{message}</p>
      <Link href={buildRestartHref(basePath, currentParams)}>Restart from page 1</Link>
    </div>
  );
}
