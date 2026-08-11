// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Live-origin runner for the stream-health acceptance authority.
//
// Fetches connector summaries from a running reference instance and feeds
// through the same pure authority used by the seeded regression tests.
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
// malformed continuation or a repeated cursor fails the run explicitly
// rather than silently under-reporting the fleet. The fields this authority
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
import {
  evaluateStreamHealthAuthority,
  type OwnerSourcesDomEvidence,
  parseOwnerSourcesDom,
  type StreamHealthAuthorityInput,
  type StreamHealthAuthorityResult,
} from "./authority.ts";

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

export interface LiveStreamHealthAuthorityResult extends StreamHealthAuthorityResult {
  authCapability: string;
  authMode: string;
  connectionCount: number;
  error: string | null;
  fetched: boolean;
  origin: string;
}

const REVISION_HEADER = "PDPP-Reference-Revision";

function responseHeader(res: { headers: { get?: (name: string) => string | null } }, name: string): string | null {
  return res.headers.get?.(name)?.trim() || null;
}

function exactRevision(values: readonly (string | null)[]): string | null {
  if (values.length === 0 || values.some((value) => value === null)) {
    return null;
  }
  const [first] = values;
  return first && values.every((value) => value === first) ? first : null;
}

function authorityFailureInput({
  authResolved,
  dom,
  expectedRevision,
  paginationComplete,
  revision,
}: {
  authResolved: boolean;
  dom: OwnerSourcesDomEvidence;
  expectedRevision: string | null;
  paginationComplete: boolean;
  revision: { dom: string | null; sha?: string | null; summaries: string | null };
}): Omit<StreamHealthAuthorityInput, "connections"> & { connections: readonly unknown[] } {
  return {
    auth: { authenticated: authResolved, mode: "cookie_only", resolved: authResolved },
    connections: [],
    dom,
    manifests: [],
    paginationComplete,
    revision: {
      dom: revision.dom,
      expected: expectedRevision,
      sha: revision.sha ?? null,
      summaries: revision.summaries,
    },
  };
}

function withLiveMetadata(
  result: StreamHealthAuthorityResult,
  metadata: Pick<
    LiveStreamHealthAuthorityResult,
    "authCapability" | "authMode" | "connectionCount" | "error" | "fetched" | "origin"
  >
): LiveStreamHealthAuthorityResult {
  return { ...result, ...metadata };
}

function ownerDomFailure({
  authenticated = true,
  reason,
  suspense = false,
}: {
  authenticated?: boolean;
  reason: string;
  suspense?: boolean;
}): OwnerSourcesDomEvidence {
  return {
    authenticated,
    connectionIds: [],
    nextPageHrefs: [],
    paginationComplete: false,
    renderedRows: false,
    resolved: false,
    streamKeys: [],
    suspense,
    reason,
  };
}

interface OwnerSourcesDomFetchResult {
  evidence: OwnerSourcesDomEvidence;
  revisions: (string | null)[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is one bounded, fail-closed pagination state machine whose branches each preserve an evidence gate.
async function fetchOwnerSourcesDom({
  base,
  fetchImpl,
  headers,
}: {
  base: string;
  fetchImpl: FetchImpl;
  headers: Record<string, string>;
}): Promise<OwnerSourcesDomFetchResult> {
  const connectionIds = new Set<string>();
  const streamKeys = new Set<string>();
  const revisions: (string | null)[] = [];
  const pending: string[] = [`${base}/sources`];
  const seen = new Set<string>();
  let firstEvidence: OwnerSourcesDomEvidence | null = null;
  let resolved = true;
  let authenticated = true;
  let renderedRows = false;
  let suspense = false;
  let paginationComplete = true;
  let reason: string | null = null;

  while (pending.length > 0) {
    const href = pending.shift();
    if (!href) {
      break;
    }
    const pageUrl = new URL(href, `${base}/sources`);
    if (pageUrl.origin !== new URL(base).origin) {
      paginationComplete = false;
      reason = "owner DOM pagination pointed outside the audited origin";
      continue;
    }
    const absolute = pageUrl.toString();
    if (seen.has(absolute)) {
      paginationComplete = false;
      reason = "owner DOM pagination repeated a page";
      continue;
    }
    seen.add(absolute);

    let response: Awaited<ReturnType<FetchImpl>>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each next DOM page is discovered from the prior page's rendered pager link.
      response = await fetchImpl(absolute, { headers: { accept: "text/html", ...headers } });
    } catch (err) {
      return {
        evidence: ownerDomFailure({ reason: err instanceof Error ? err.message : String(err) }),
        revisions,
      };
    }
    revisions.push(responseHeader(response, REVISION_HEADER));
    const html = await response.text();
    if (response.status < 200 || response.status >= 300) {
      return {
        evidence: ownerDomFailure({
          authenticated: response.status !== 401 && response.status !== 403,
          reason: `owner /sources returned status ${response.status}`,
        }),
        revisions,
      };
    }
    const pageEvidence = parseOwnerSourcesDom(html);
    firstEvidence ??= pageEvidence;
    resolved = resolved && pageEvidence.resolved;
    authenticated = authenticated && pageEvidence.authenticated !== false;
    renderedRows = renderedRows || pageEvidence.renderedRows;
    suspense = suspense || pageEvidence.suspense === true;
    if (!pageEvidence.resolved || pageEvidence.authenticated === false || pageEvidence.suspense === true) {
      reason = pageEvidence.reason ?? reason;
    }
    for (const id of pageEvidence.connectionIds) {
      connectionIds.add(id);
    }
    for (const key of pageEvidence.streamKeys) {
      streamKeys.add(`${key.connectionId}\u0000${key.stream}`);
    }
    for (const next of pageEvidence.nextPageHrefs) {
      pending.push(new URL(next, absolute).toString());
    }
  }

  const streamKeyValues = [...streamKeys].map((value) => {
    const [connectionId, stream] = value.split("\u0000");
    return { connectionId: connectionId ?? "", stream: stream ?? "" };
  });
  const baseEvidence = firstEvidence ?? ownerDomFailure({ reason: reason ?? "owner /sources did not resolve" });
  return {
    evidence: {
      authenticated,
      connectionIds: [...connectionIds],
      nextPageHrefs: [],
      paginationComplete: paginationComplete && baseEvidence.paginationComplete !== false,
      renderedRows,
      resolved,
      streamKeys: streamKeyValues,
      suspense,
      reason,
    },
    revisions,
  };
}

async function fetchCatalogManifest({
  base,
  connectorId,
  fetchImpl,
  headers,
  onRevision,
}: {
  base: string;
  connectorId: string;
  fetchImpl: FetchImpl;
  headers: Record<string, string>;
  onRevision: (revision: string | null) => void;
}): Promise<unknown | null> {
  const response = await fetchImpl(`${base}/connectors/${encodeURIComponent(connectorId)}`, {
    headers: { accept: "application/json", ...headers },
  });
  if (response.status === 404) {
    return { connector_id: connectorId, streams: [] };
  }
  onRevision(responseHeader(response, REVISION_HEADER));
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`connector manifest returned status ${response.status}`);
  }
  const body = JSON.parse(await response.text()) as unknown;
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? body
    : { connector_id: connectorId, streams: [] };
}

async function fetchCatalogManifests({
  base,
  connections,
  fetchImpl,
  headers,
  onRevision,
}: {
  base: string;
  connections: readonly unknown[];
  fetchImpl: FetchImpl;
  headers: Record<string, string>;
  onRevision: (revision: string | null) => void;
}): Promise<unknown[]> {
  const connectorIds = new Set<string>();
  for (const value of connections) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const object = value as Record<string, unknown>;
    for (const key of ["connector_id", "connector_key", "provider_id"]) {
      if (typeof object[key] === "string" && object[key].trim()) {
        connectorIds.add(object[key].trim());
        break;
      }
    }
  }
  const manifests = await Promise.all(
    [...connectorIds].map((connectorId) => fetchCatalogManifest({ base, connectorId, fetchImpl, headers, onRevision }))
  );
  return manifests;
}

/**
 * Run the final acceptance authority against a live owner session. This is
 * deliberately read-only: it exhausts the owner summary pages, resolves the
 * authenticated `/sources` DOM pages, and reads public connector manifests.
 */
export async function runLiveStreamHealthAuthority({
  env = process.env,
  expectedRevision = env.PDPP_EXPECTED_REFERENCE_REVISION?.trim() || null,
  expectedSha = env.PDPP_EXPECTED_SHA?.trim() || null,
  fetchImpl = fetch as unknown as FetchImpl,
  origin,
}: {
  env?: NodeJS.ProcessEnv;
  expectedRevision?: string | null;
  expectedSha?: string | null;
  fetchImpl?: FetchImpl;
  origin: string;
}): Promise<LiveStreamHealthAuthorityResult> {
  const base = origin.replace(REGEX_PATTERN, "");
  const metadataBase = {
    authCapability: "cookie_only",
    connectionCount: 0,
    error: null as string | null,
    fetched: false,
    origin: base,
  };
  let auth: OwnerAuthForStreamHealth;
  try {
    auth = await resolveOwnerAuthForStreamHealth({ base, env, fetchImpl });
  } catch (err) {
    const authority = evaluateStreamHealthAuthority({
      auth: { authenticated: false, mode: "none", resolved: false },
      connections: [],
      dom: ownerDomFailure({ authenticated: false, reason: "owner authentication transport failed" }),
      manifests: [],
      paginationComplete: false,
      revision: { dom: null, expected: expectedRevision, sha: expectedSha, summaries: null },
    });
    return withLiveMetadata(authority, {
      ...metadataBase,
      authMode: "none",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const metadata = { ...metadataBase, authMode: auth.mode };

  if (!auth.supported) {
    let error: string;
    if (auth.mode === "bearer") {
      error =
        "PDPP_OWNER_TOKEN is not supported for the cookie-gated owner routes; set PDPP_OWNER_SESSION_COOKIE or PDPP_OWNER_PASSWORD.";
    } else if (auth.mode === "password-session") {
      error = `Owner login via PDPP_OWNER_PASSWORD failed: ${auth.error}`;
    } else {
      error = "No owner session supplied. Set PDPP_OWNER_SESSION_COOKIE or PDPP_OWNER_PASSWORD.";
    }
    const authority = evaluateStreamHealthAuthority(
      authorityFailureInput({
        authResolved: false,
        dom: ownerDomFailure({ authenticated: false, reason: "owner authentication was not resolved" }),
        expectedRevision,
        paginationComplete: false,
        revision: { dom: null, sha: expectedSha, summaries: null },
      })
    );
    return withLiveMetadata(authority, { ...metadata, error });
  }

  const summaryRevisions: (string | null)[] = [];
  let connections: readonly unknown[] = [];
  try {
    const summaryFetch: FetchImpl = async (url, init) => {
      const response = await fetchImpl(url, init);
      summaryRevisions.push(responseHeader(response, REVISION_HEADER));
      return response;
    };
    const paged = await fetchAllConnectorSummaries({
      base,
      fetchImpl: summaryFetch,
      headers: { accept: "application/json", ...auth.header },
    });
    if (!paged.ok) {
      const authority = evaluateStreamHealthAuthority(
        authorityFailureInput({
          authResolved: paged.status !== 401 && paged.status !== 403,
          dom: ownerDomFailure({
            authenticated: paged.status !== 401 && paged.status !== 403,
            reason: "owner DOM was not resolved because the owner summary inventory did not complete",
          }),
          expectedRevision,
          paginationComplete: false,
          revision: { dom: null, sha: expectedSha, summaries: exactRevision(summaryRevisions) },
        })
      );
      return withLiveMetadata(authority, {
        ...metadata,
        error: paged.error ?? `GET /_ref/connectors returned status ${paged.status}`,
      });
    }
    connections = [...paged.data];
    const manifests = await fetchCatalogManifests({
      base,
      connections,
      fetchImpl,
      headers: { accept: "application/json", ...auth.header },
      onRevision: (revision) => summaryRevisions.push(revision),
    });
    const domResult = await fetchOwnerSourcesDom({
      base,
      fetchImpl,
      headers: auth.header,
    });
    const authority = evaluateStreamHealthAuthority({
      auth: { authenticated: true, mode: auth.mode, resolved: true },
      connections,
      dom: domResult.evidence,
      manifests,
      paginationComplete: domResult.evidence.paginationComplete,
      revision: {
        dom: exactRevision(domResult.revisions),
        expected: expectedRevision,
        sha: expectedSha,
        summaries: exactRevision(summaryRevisions),
      },
    });
    return withLiveMetadata(authority, {
      ...metadata,
      connectionCount: connections.length,
      error: null,
      fetched: true,
    });
  } catch (err) {
    const authority = evaluateStreamHealthAuthority({
      auth: { authenticated: true, mode: auth.mode, resolved: true },
      connections: [],
      dom: ownerDomFailure({ reason: "live stream-health evidence collection failed" }),
      manifests: [],
      paginationComplete: false,
      revision: {
        dom: null,
        expected: expectedRevision,
        sha: expectedSha,
        summaries: exactRevision(summaryRevisions),
      },
    });
    return withLiveMetadata(authority, {
      ...metadata,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
