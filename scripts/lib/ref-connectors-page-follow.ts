// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared page-following helper for first-party scripts that need the
// COMPLETE connector-summary list from a live reference origin.
//
// Terminal-gate revision (2026-07-29): `GET /_ref/connectors` no longer
// serves an unbounded fleet response — it requires `limit` (max 100) and
// fails closed with HTTP 400 without it. Every first-party ops/diagnostic
// script that previously called the route bare or with `limit` above the
// new maximum must page-follow it to completion instead.

import { validateListEnvelope } from "@pdpp/list-envelope";
import type { FetchImpl } from "./owner-session.ts";

const REF_CONNECTORS_PAGE_LIMIT = 100;

export interface RefConnectorsPageFollowResult {
  readonly data: readonly unknown[];
  readonly error?: string;
  /** The last page's raw parsed body, in case a caller wants envelope metadata (e.g. `object`). */
  readonly lastPageBody: unknown;
  readonly ok: boolean;
  /** Number of bounded JSON pages consumed; useful to compare against rendered pagers. */
  readonly pageCount: number;
  readonly status: number | null;
}

/**
 * Pages `GET /_ref/connectors?limit=100[&cursor=...]` at `base` to
 * completion, using the caller-supplied auth header, and returns every row
 * across every page. `ok: false` (with `status` set to the failing page's
 * HTTP status) short-circuits after the first non-2xx page — the same
 * "best-effort, do not fail the whole run" posture every caller of this
 * helper already had for the single bare request it replaces.
 *
 * `sourcesVisibility` forwards `sources_visibility=1`, the same opt-in
 * `sources-report.ts` sets and the console `/sources` page sends via
 * `liveDashboardDataSource.listConnectorSummaries({ sourcesVisibility: true })`.
 * It asks the reference to apply the Sources page's own visibility rule
 * (including a revoked, never-succeeded setup shell that has no other
 * visible row) BEFORE its own `limit`, not to filter the page afterward. A
 * caller reconciling against the rendered `/sources` DOM must set this, or
 * it fetches a different, narrower inventory than the page renders from and
 * every such row reads as a spurious "extra" row instead of a real one this
 * fetch never asked for.
 */
export async function fetchAllConnectorSummaries({
  base,
  headers,
  fetchImpl,
  sourcesVisibility = false,
}: {
  base: string;
  headers: Record<string, string>;
  fetchImpl: FetchImpl;
  sourcesVisibility?: boolean;
}): Promise<RefConnectorsPageFollowResult> {
  const data: unknown[] = [];
  let cursor: string | null = null;
  let lastPageBody: unknown = null;
  let pageCount = 0;
  // This is one unattended traversal, unlike interactive console paging:
  // keep the visited set local to this invocation and fail closed on any
  // repeated opaque continuation rather than reporting a partial audit.
  const seenCursors = new Set<string>();
  for (;;) {
    const params = new URLSearchParams({ limit: String(REF_CONNECTORS_PAGE_LIMIT) });
    if (sourcesVisibility) {
      params.set("sources_visibility", "1");
    }
    if (cursor) {
      params.set("cursor", cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: each page's cursor depends on the previous page's response.
    const res = await fetchImpl(`${base}/_ref/connectors?${params.toString()}`, { headers });
    if (res.status < 200 || res.status >= 300) {
      return {
        data,
        lastPageBody,
        ok: false,
        pageCount,
        status: res.status,
        error: "malformed connector-summary page",
      };
    }
    const bodyText = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      return {
        data,
        lastPageBody,
        ok: false,
        pageCount,
        status: res.status,
        error: "malformed connector-summary page",
      };
    }
    lastPageBody = body;
    pageCount += 1;
    const validation = validateListEnvelope<unknown>(body !== null && typeof body === "object" ? body : {});
    if (validation.kind === "invalid") {
      return {
        data,
        lastPageBody,
        ok: false,
        pageCount,
        status: res.status,
        error: "malformed connector-summary page",
      };
    }
    data.push(...validation.data);
    if (!validation.hasMore) {
      return { data, lastPageBody, ok: true, pageCount, status: res.status };
    }
    const { nextCursor } = validation;
    if (nextCursor === undefined || seenCursors.has(nextCursor)) {
      return {
        data,
        lastPageBody,
        ok: false,
        pageCount,
        status: res.status,
        error: "repeated/self-looping next_cursor",
      };
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
}
