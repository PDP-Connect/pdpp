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

const OWNER_DOM_RESOLUTION_TIMEOUT_MS = 15_000;
const OWNER_DOM_PAGE_BUDGET = 512;

interface BrowserNavigationResponse {
  headers?: () => Record<string, string>;
}

interface OwnerSourcesBrowserPage {
  close: () => Promise<void>;
  content: () => Promise<string>;
  goto: (url: string, options: { waitUntil: "domcontentloaded" }) => Promise<BrowserNavigationResponse | null>;
  waitForFunction: (predicate: () => boolean, options: { timeout: number }) => Promise<unknown>;
}

interface OwnerSourcesBrowserContext {
  addCookies: (cookies: readonly { name: string; value: string; url: string }[]) => Promise<void>;
  close: () => Promise<void>;
  newPage: () => Promise<OwnerSourcesBrowserPage>;
}

interface OwnerSourcesBrowser {
  close: () => Promise<void>;
  newContext: () => Promise<OwnerSourcesBrowserContext>;
}

export type OwnerSourcesBrowserFactory = (args: { base: string; cookie: string }) => Promise<OwnerSourcesBrowser>;

function ownerSessionCookies(cookie: string, base: string): { name: string; value: string; url: string }[] {
  return cookie
    .split(";")
    .map((part) => part.trim())
    .map((part) => {
      const separator = part.indexOf("=");
      return separator > 0 ? { name: part.slice(0, separator), value: part.slice(separator + 1), url: base } : null;
    })
    .filter((value): value is { name: string; value: string; url: string } => value !== null);
}

async function launchOwnerSourcesBrowser(): Promise<OwnerSourcesBrowser> {
  const { chromium } = await import("patchright");
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
    headless: true,
  });
  return {
    newContext: () => browser.newContext(),
    close: () => browser.close(),
  };
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
    sourceScopes: [],
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

async function closeOwnerSourcesResources({
  browser,
  context,
  page,
}: {
  browser: OwnerSourcesBrowser | null;
  context: OwnerSourcesBrowserContext | null;
  page: OwnerSourcesBrowserPage | null;
}): Promise<string | null> {
  const failures: string[] = [];
  for (const [name, resource] of [
    ["page", page],
    ["context", context],
    ["browser", browser],
  ] as const) {
    if (!resource) {
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: cleanup is deliberately sequential so every later resource is attempted after an earlier cleanup failure.
      await resource.close();
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures.length > 0 ? failures.join("; ") : null;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is one bounded, fail-closed pagination state machine whose branches each preserve an evidence gate.
async function fetchOwnerSourcesDom({
  base,
  browserFactory = launchOwnerSourcesBrowser,
  cookie,
}: {
  base: string;
  browserFactory?: OwnerSourcesBrowserFactory;
  cookie: string;
}): Promise<OwnerSourcesDomFetchResult> {
  const connectionIds = new Set<string>();
  const sourceScopes = new Map<string, string>();
  const streamKeys = new Set<string>();
  const revisions: (string | null)[] = [];
  const pending: string[] = [`${base}/sources`];
  const seen = new Set<string>();
  let firstEvidence: OwnerSourcesDomEvidence | null = null;
  let resolved = true;
  let authenticated = true;
  let renderedRows = false;
  let selectedConnectionId: string | null = null;
  let suspense = false;
  let paginationComplete = true;
  let reason: string | null = null;
  let pageCount = 0;
  let terminalEvidence: OwnerSourcesDomEvidence | null = null;
  let browser: OwnerSourcesBrowser | null = null;
  let context: OwnerSourcesBrowserContext | null = null;
  let page: OwnerSourcesBrowserPage | null = null;
  try {
    browser = await browserFactory({ base, cookie });
    context = await browser.newContext();
    await context.addCookies(ownerSessionCookies(cookie, base));
    page = await context.newPage();
    while (pending.length > 0 && terminalEvidence === null) {
      if (pageCount >= OWNER_DOM_PAGE_BUDGET) {
        terminalEvidence = ownerDomFailure({
          reason: `owner DOM traversal budget exceeded: maximum ${OWNER_DOM_PAGE_BUDGET} pages`,
          suspense: true,
        });
        break;
      }
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
      pageCount += 1;

      let navigation: BrowserNavigationResponse | null;
      try {
        // The browser waits for the resolved semantic surface. No wall-clock sleep is used.
        // biome-ignore lint/performance/noAwaitInLoops: each next DOM page is discovered from the prior page's rendered pager link.
        navigation = await page.goto(absolute, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () =>
            !document.querySelector(
              '[aria-busy="true"], [data-testid*="loading" i], [data-testid*="suspense" i], .animate-pulse'
            ) &&
            Boolean(
              document.querySelector('[data-pdpp-source-row], [data-pdpp-stream-row], [data-testid="sources-empty"]')
            ),
          { timeout: OWNER_DOM_RESOLUTION_TIMEOUT_MS }
        );
      } catch {
        const html = await page.content();
        const observed = parseOwnerSourcesDom(html);
        terminalEvidence = ownerDomFailure({
          authenticated: observed.authenticated,
          reason: observed.authenticated
            ? `owner DOM did not resolve within ${OWNER_DOM_RESOLUTION_TIMEOUT_MS}ms`
            : "owner authentication was not resolved",
          suspense: true,
        });
        break;
      }
      const html = await page.content();
      const responseRevision = navigation?.headers?.()?.[REVISION_HEADER.toLowerCase()] ?? null;
      if (responseRevision) {
        revisions.push(responseRevision);
      }
      const pageEvidence = parseOwnerSourcesDom(html);
      if (pageEvidence.revision !== null && pageEvidence.revision !== undefined) {
        revisions.push(pageEvidence.revision);
      }
      firstEvidence ??= pageEvidence;
      resolved = resolved && pageEvidence.resolved;
      authenticated = authenticated && pageEvidence.authenticated !== false;
      renderedRows = renderedRows || pageEvidence.renderedRows;
      selectedConnectionId ??= pageEvidence.selectedConnectionId ?? null;
      suspense = suspense || pageEvidence.suspense === true;
      if (!pageEvidence.resolved || pageEvidence.authenticated === false || pageEvidence.suspense === true) {
        reason = pageEvidence.reason ?? reason;
      }
      for (const id of pageEvidence.connectionIds) {
        connectionIds.add(id);
      }
      for (const { connectionId, scope } of pageEvidence.sourceScopes) {
        const previous = sourceScopes.get(connectionId);
        sourceScopes.set(connectionId, previous && previous !== scope ? "<contradictory>" : scope);
      }
      for (const key of pageEvidence.streamKeys) {
        streamKeys.add(`${key.connectionId}\u0000${key.stream}`);
      }
      for (const next of pageEvidence.nextPageHrefs) {
        pending.push(new URL(next, absolute).toString());
      }
    }
  } catch (error) {
    terminalEvidence = ownerDomFailure({
      reason: `owner DOM browser setup failed: ${error instanceof Error ? error.message : String(error)}`,
      suspense: true,
    });
  }
  const cleanupFailure = await closeOwnerSourcesResources({ browser, context, page });
  if (cleanupFailure) {
    terminalEvidence = ownerDomFailure({
      reason: `owner DOM cleanup failed: ${cleanupFailure}`,
      suspense: true,
    });
  }
  if (terminalEvidence) {
    return { evidence: terminalEvidence, revisions };
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
      sourceScopes: [...sourceScopes].map(([connectionId, scope]) => ({ connectionId, scope })),
      nextPageHrefs: [],
      paginationComplete: paginationComplete && baseEvidence.paginationComplete !== false,
      renderedRows,
      resolved,
      selectedConnectionId,
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
    [...connectorIds].map(async (connectorId) => {
      try {
        return await fetchCatalogManifest({ base, connectorId, fetchImpl, headers, onRevision });
      } catch {
        // A malformed persisted manifest belongs to one connection. Preserve
        // that connection as manifest-unavailable without discarding evidence
        // for every other owner connection in the fleet.
        return { connector_id: connectorId, streams: [] };
      }
    })
  );
  return manifests;
}

/**
 * Run the final acceptance authority against a live owner session. This is
 * deliberately read-only: it exhausts the owner summary pages, resolves the
 * authenticated `/sources` DOM pages, and reads public connector manifests.
 */
export async function runLiveStreamHealthAuthority({
  browserFactory = launchOwnerSourcesBrowser,
  env = process.env,
  expectedRevision = env.PDPP_EXPECTED_REFERENCE_REVISION?.trim() || null,
  expectedSha = env.PDPP_EXPECTED_SHA?.trim() || null,
  fetchImpl = fetch as unknown as FetchImpl,
  origin,
}: {
  browserFactory?: OwnerSourcesBrowserFactory;
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
      // This authority reconciles against the resolved `/sources` DOM
      // (`compareDom` below), which the console renders from the
      // `sources_visibility=1` inventory, not the generic owner-visible one.
      // Omitting this opt-in here made a real, rendered, never-succeeded
      // setup-shell row (present in the DOM, absent from this fetch) read as
      // a spurious "extra" connection instead of the legitimate row it is.
      sourcesVisibility: true,
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
      browserFactory,
      cookie: auth.header.cookie,
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
