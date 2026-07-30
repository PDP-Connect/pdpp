// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Live-origin runner for the stream-health machine audit.
//
// Fetches connector summaries from a running reference instance and feeds
// them through the same pure `auditStreamHealth` used by the seeded test,
// per openspec/changes/define-stream-coverage-freshness-evidence tasks.md
// 9.1: "a seeded local test plus a live mode reusing the owner-journey
// acceptance harness."
//
// Route: GET /_ref/connectors (mounted by `mountRefConnectorsList` in
// reference-implementation/server/routes/ref-connectors.ts). Verified
// against the route, its operation (`ref.connectors.list` /
// `executeRefConnectorsList` in
// reference-implementation/operations/ref-connectors-list/index.ts), and
// `ConnectorSummary` in reference-implementation/server/ref-control.ts
// (~line 540): the route calls `ctx.listConnectorSummaries()` (host read,
// returns `ConnectorSummary[]`) and the operation wraps it as
// `{ object: "list", data: ConnectorSummary[], has_more, next_cursor }` —
// the route forwards each item opaquely, so every `ConnectorSummary` field
// survives serialization even though the operation's own
// `RefConnectorsListItem` type doesn't re-declare them. The shared page-follow helper
// (below) PAGE-FOLLOWS this route at the reference's own page-size ceiling
// (`CONNECTOR_SUMMARY_PAGE_LIMIT_MAX` = 100 in
// reference-implementation/operations/ref-connectors-list/pagination.ts —
// the route REJECTS any `limit` above that, so a prior single-shot
// `limit=500` request here was invalid) until the fleet is exhausted; this
// audit's whole premise requires seeing every settled connection, so
// exhaustive paging is correct here (unlike a first-render UI path) — a
// malformed continuation or a safety-cap trip fails the run explicitly
// rather than silently under-reporting the fleet. The fields this audit
// reads: `connection_id`,
// `connector_id`, `connector_instance_id`, `display_name`,
// `connector_display_name`, `rendered_verdict` (`{ pill: { label, tone },
// ... }`), and `collection_report` (`CollectionReportEntry[]`: `stream`,
// `coverage_condition`, `forward_disposition`, `coverage_strategy`,
// `checkpoint`, `considered`, `covered`, `required`). Terminal-gate revision
// (2026-07-29): the connection list is now assembled by page-following the
// bounded `GET /_ref/connectors?limit=100[&cursor=...]` route to completion
// (`fetchAllConnectorSummaries`, scripts/lib/ref-connectors-page-follow.ts)
// rather than one bare/unbounded request.
//
// Failure rows carry a neutral evidence class (what the served entry
// shows), not an inferred cause. Investigation hints:
//   - `strategy_declaration_missing` — the served entry has no
//     `coverage_strategy`; SUGGESTS checking whether the instance's STORED
//     manifest predates the shipped strategy declarations (manifest
//     reconcile never ran or was skipped).
//   - `runtime_evidence_missing` — strategy declared but no checkpoint/
//     denominator/skip resolved the stream; SUGGESTS checking the
//     connector's coverage-evidence emission (producer side).
//   - `accepted_absence_on_required` — a required entry carries an
//     accepted-absence coverage condition; SUGGESTS a contradictory
//     manifest (`required: true` + accepted-absence `coverage_policy`).
//
// Auth is acquired through the shared `resolveOwnerAuthForLive` helper in
// scripts/lib/owner-session.ts — the same owner-session acquisition path
// scripts/owner-journey-acceptance/live.ts uses. Recognized environment
// variables (first match wins):
//   PDPP_ACCEPTANCE_ORIGIN or --origin   the instance origin
//   PDPP_OWNER_SESSION_COOKIE            full Cookie header for an owner session
//   PDPP_OWNER_PASSWORD                  owner password; logs in via /owner/login
//   PDPP_OWNER_TOKEN                     owner bearer token (unsupported here)
// This route family (/_ref/*) is cookie-only. A bearer token is rejected
// before any HTTP call instead of being claimed as supported — it is never
// sent as an Authorization header to a cookie-gated /_ref route.

import { type FetchImpl, resolveOwnerAuthForLive } from "../lib/owner-session.ts";
import { fetchAllConnectorSummaries } from "../lib/ref-connectors-page-follow.ts";
import { auditStreamHealth, type StreamHealthAuditResult } from "./audit.ts";

const REGEX_PATTERN = /\/+$/;

interface OwnerAuthForStreamHealth {
  error: string | null;
  header: Record<string, string>;
  mode: "bearer" | "cookie" | "none" | "password-session";
  supported: boolean;
}

/**
 * Resolve owner auth from the environment without exposing its value.
 * Cookie takes precedence over password; a bare PDPP_OWNER_TOKEN is reported
 * as unsupported rather than sent as a bearer header to a cookie-only route.
 *
 * @param args.base        origin, no trailing slash
 */
export async function resolveOwnerAuthForStreamHealth({
  base,
  env = process.env,
  fetchImpl = fetch as unknown as FetchImpl,
}: {
  base: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
}): Promise<OwnerAuthForStreamHealth> {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie", supported: true, error: null };
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    const result = await resolveOwnerAuthForLive({ base, env, fetchImpl });
    return { ...result, header: result.header as Record<string, string>, supported: !result.error };
  }

  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: {}, mode: "bearer", supported: false, error: null };
  }

  return { header: {}, mode: "none", supported: false, error: null };
}

interface LiveStreamHealthAuditResult {
  authCapability: string;
  authMode: string;
  connectionCount: number;
  error: string | null;
  failures: StreamHealthAuditResult["failures"];
  fetched: boolean;
  inconclusive: StreamHealthAuditResult["inconclusive"];
  ok: boolean;
  origin: string;
  status: StreamHealthAuditResult["status"];
}

/**
 * Fetch `/_ref/connectors` from a live origin and run the pure audit over
 * the result.
 *
 * @param args.origin   e.g. https://pdpp.example.com
 * @param [args.env]    defaults to process.env
 * @param [args.fetchImpl] injectable for tests; defaults to global fetch
 */
export async function runLiveStreamHealthAudit({
  origin,
  env = process.env,
  fetchImpl = fetch as unknown as FetchImpl,
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  origin: string;
}): Promise<LiveStreamHealthAuditResult> {
  const base = origin.replace(REGEX_PATTERN, "");
  const {
    header,
    mode,
    supported,
    error: authError,
  } = await resolveOwnerAuthForStreamHealth({
    base,
    env,
    fetchImpl,
  });

  if (!supported) {
    let error: string;
    if (mode === "bearer") {
      error =
        "PDPP_OWNER_TOKEN is not supported for /_ref/connectors; set PDPP_OWNER_SESSION_COOKIE or PDPP_OWNER_PASSWORD instead.";
    } else if (mode === "password-session") {
      error = `Owner login via PDPP_OWNER_PASSWORD failed: ${authError}`;
    } else {
      error =
        "No owner session supplied. Set PDPP_OWNER_SESSION_COOKIE or PDPP_OWNER_PASSWORD to audit /_ref/connectors.";
    }
    return {
      origin: base,
      authMode: mode,
      authCapability: "cookie_only",
      fetched: false,
      error,
      connectionCount: 0,
      ok: false,
      status: "inconclusive",
      failures: [],
      inconclusive: [],
    };
  }

  try {
  // Terminal-gate revision (2026-07-29): the bare `?limit=500` request
    // both exceeded the route's new maximum page size (100) and no longer
    // exists as a single-request "give me everything" contract. Page-follow
    // to completion instead — this audit genuinely needs the whole fleet.
    const paged = await fetchAllConnectorSummaries({
      base,
      fetchImpl,
      headers: { accept: "application/json", ...header },
    });
    if (!paged.ok) {
      return {
        origin: base,
        authMode: mode,
        authCapability: "cookie_only",
        fetched: false,
        error: paged.error ?? `GET /_ref/connectors returned status ${paged.status}`,
        connectionCount: 0,
        ok: false,
        status: "inconclusive",
        failures: [],
        inconclusive: [],
      };
    }
    const connections = [...paged.data];
    const { ok, status, failures, inconclusive } = auditStreamHealth(connections);
    return {
      origin: base,
      authMode: mode,
      authCapability: "cookie_only",
      fetched: true,
      error: null,
      connectionCount: connections.length,
      ok,
      status,
      failures,
      inconclusive,
    };
  } catch (err) {
    return {
      origin: base,
      authMode: mode,
      authCapability: "cookie_only",
      fetched: false,
      error: err instanceof Error ? err.message : String(err),
      connectionCount: 0,
      ok: false,
      status: "inconclusive",
      failures: [],
      inconclusive: [],
    };
  }
}
