// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { CONNECTOR_SUMMARY_PAGE_SIZE } from "../components/connector-summary-page.tsx";
import { listConnectorSummaries, type RefConnectorSummary } from "../lib/ref-client.ts";

/**
 * Case-insensitive, exact `display_name` match within one bounded page of
 * connectors. A connector's `connector_id` matching its route slug is
 * coincidence (`/sources/gmail` works only because gmail's connector_id
 * happens to equal its display slug); a connector whose `display_name`
 * diverges from its `connector_id` (e.g. "claude-test" / `claude-code`) had
 * no path to resolve at all and 404'd with a misleading HTTP 200 (red-team
 * finding, docs/inbox/redteam-slvp-findings.md P3 #6).
 *
 * Deliberately does NOT fan out past one page — this app's stated
 * discipline (`connector-summary-page.tsx`'s module doc) is exactly one
 * bounded `listConnectorSummaries` request, never an exhaustive fetch-every-
 * page loop. A display-name route to a connection beyond the first page (or
 * one sharing its display name with another connection) falls through to
 * the existing not-found path rather than growing an unbounded fan-out to
 * chase it.
 */
async function resolveByDisplayNameInFirstPage(routeId: string): Promise<RefConnectorSummary | null> {
  const needle = routeId.trim().toLowerCase();
  if (!needle) {
    return null;
  }
  const page = await listConnectorSummaries({ limit: CONNECTOR_SUMMARY_PAGE_SIZE });
  const matches = page.data.filter((summary) => summary.display_name.trim().toLowerCase() === needle);
  // Ambiguous (2+ connections sharing a display name) resolves to null, same
  // discipline as the reference's own connector_id ambiguity rule
  // (`resolveUnambiguousConnectionForConnectorId`, ref-control.ts) — never an
  // arbitrary first pick.
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export async function resolveConnectionForRecordsRoute(
  routeId: string,
  explicitConnectionId?: string | null
): Promise<RefConnectorSummary | null> {
  // An explicit connection_id disambiguates a connector-key route (e.g.
  // /sources/steam?connection_id=cin_...) that would otherwise fall back to
  // resolveUnambiguousConnectionForConnectorId and 404 whenever the owner has
  // more than one connection for that connector type — the exact scenario a
  // stuck draft plus an older/revoked attempt produces. Try the exact id
  // first; if it does not resolve (wrong owner, deleted, typo'd link), fall
  // through to the normal route-id resolution rather than failing outright.
  if (explicitConnectionId) {
    const scoped = await listConnectorSummaries({ connectionRouteId: explicitConnectionId });
    const exact = scoped.data.find(
      (summary) =>
        summary.connection_id === explicitConnectionId || summary.connector_instance_id === explicitConnectionId
    );
    if (exact) {
      return exact;
    }
  }
  // Scope the reference projection to this one route id. The reference resolves
  // exact connection identity first and allows connector-id fallback only when
  // unambiguous. This returns a 0-or-1 list and the record subpage no longer
  // hydrates every connector to find one. The local fallback below is defensive
  // for older references; current references should already have made the
  // ambiguity decision before returning data.
  const response = await listConnectorSummaries({ connectionRouteId: routeId });
  const byIdentityOrConnectorId =
    response.data.find((summary) => summary.connection_id === routeId || summary.connector_instance_id === routeId) ??
    response.data.find((summary) => summary.connector_id === routeId) ??
    null;
  if (byIdentityOrConnectorId) {
    return byIdentityOrConnectorId;
  }
  // Neither an exact identity nor a connector_id happened to match the route
  // segment — try it as a display_name (the case a bookmarked/typed
  // "/sources/claude-test" URL hits, since claude-test's connector_id is
  // claude-code and only its display_name is "claude-test").
  return resolveByDisplayNameInFirstPage(routeId);
}

export function connectorInstanceIdForConnection(summary: RefConnectorSummary): string {
  return summary.connector_instance_id ?? summary.connection_id;
}

export function sourceLabelForConnection(summary: RefConnectorSummary): string {
  return summary.display_name.trim() || summary.connector_display_name?.trim() || summary.connection_id;
}
