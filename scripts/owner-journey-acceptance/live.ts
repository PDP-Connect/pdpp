// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Optional live-origin probe for the owner-journey acceptance harness.
//
// When the owner supplies a live origin (and owner auth), the harness fetches
// the rendered owner setup surfaces over HTTP and runs the same forbidden-string
// rules over the served HTML. This catches a leak that only appears in the
// deployed render (e.g. a server-injected string) — without any browser
// automation; a plain authenticated fetch is enough for static-string checks.
//
// Auth is read from the environment and NEVER printed. The harness passes the
// owner session cookie or bearer through to the fetch and reports only whether
// auth was supplied, never its value.

import { loginWithOwnerPassword, type OwnerAuthResult } from "../lib/owner-session.ts";
import { fetchAllConnectorSummaries } from "../lib/ref-connectors-page-follow.ts";
import { type Finding, lineOf, scanForbiddenStrings } from "./scan.ts";
import { FORBIDDEN_STRING_RULES } from "./surface-manifest.ts";

const BREFRESH_PATTERN = /\brefresh\b/i;
const BCLIENT_CLI_PATTERN = /\bclient\s+cli_[a-z0-9]+\b/i;
const BCLIENT_HTTPS_PATTERN = /\bclient\s+https?:\/\/[^\s]+/i;
const BGRANTS_ARE_WITHIN_THEIR_PATTERN = /\bGrants are within their limits\b/i;
const BBACKUPS_ARE_PATTERN = /\bbackups are on\b/i;
const SOURCE_ISSUES_REVIEW_HERE_PATTERN =
  /No source issues to review here|Nothing needs you\.[^.]*sources are syncing\.|everything'?s syncing|All assessed sources are healthy\./i;
const BSTART_SESSION_PATTERN = /\bStart session\b/i;
const BSCHEDULES_PATTERN = /\bSchedules\b/i;
const BSCHEDULED_CONNECTIONS_BNO_SCHEDULED_PATTERN = /\bScheduled connections\b|\bNo scheduled connections yet\b/i;
const BSCHEDULED_BUNSCHEDULED_PATTERN = /\bscheduled\b.*\bunscheduled\b/i;
const BEXPLORE_PATTERN = /\bExplore\b/i;
const SEARCH_NAMES_FIELDS_AND_PATTERN =
  /Search names, fields, and values|Search records|text across every searchable stream|\boperators\b.*\bcon:/i;
const BFILTERS_PATTERN = /\bFilters\b/i;
const BNEWEST_BOLDEST_PATTERN = /\bnewest\b.*\boldest\b/i;
const BSOURCES_PATTERN = /\bSources\b/i;
const TURNED_AWAY_PATTERN = /turned away,\s+([a-z][a-z0-9_]*)\b/i;
const BDEAD_LETTER_PATTERN = /\bdead-letter(?:ed)?\b/i;
const FAILURES_OPEN_RUNS_PATTERN = /\b0 failures\s*·\s*Open runs\b/i;
const BWITH_GAPS_PATTERN = /\bwith gaps\b/i;
const BPARTIAL_PATTERN = /\bpartial\b/i;
const TRAILING_SLASHES_PATTERN = /\/+$/;
const ROOT_PATH_PREFIX_PATTERN = /^\//;
const HTML_SCRIPT_TAG_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const HTML_STYLE_TAG_PATTERN = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const HTML_NBSP_PATTERN = /&nbsp;/gi;
const HTML_AMP_PATTERN = /&amp;/gi;
const HTML_APOSTROPHE_PATTERN = /&#x27;|&#39;/gi;
const HTML_QUOTE_PATTERN = /&quot;/gi;
const HTML_LESS_THAN_PATTERN = /&lt;/gi;
const HTML_GREATER_THAN_PATTERN = /&gt;/gi;
const DOM_WHITESPACE_PATTERN = /\s+/g;
const DOM_CLASS_SPLIT_PATTERN = /\s+/;
const DOM_TAG_NAME_PATTERN = /^[a-z][a-z0-9:-]*/i;
const DOM_SELF_CLOSING_PATTERN = /\/\s*>$/;
const DOM_END_MARKER_PATTERN = />$/;
const LOGIN_ACTION_PATTERN = /login|sign[-_ ]?in/i;
const LOGIN_TEXT_PATTERN = /\b(?:owner )?(?:sign in|log in|login)\b/i;
const REGEXP_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;
const RENDERED_BROKEN_PATTERN = /\b(?:degraded|can't collect|needs attention)\b/i;
const SETUP_SURFACE_PATH_PATTERN = /^\/(connect\/(?:browser-session|manual-upload)\/[^/?#]+)/i;
const NEXT_PAGE_LABEL_PATTERN = /^Next page\b/i;
const START_SESSION_FORM_PATTERN = /<form\b[^>]*\bstart/i;
const OWNER_SETUP_TEXT_PATTERN = /\b(?:connect|source|setup|session|credential|upload|repair|open|start)\b/i;
const SOURCE_LIST_CONTENT_PATTERN = /\bNo sources yet\b|\brecords?\b[\s\S]*\bstreams?\b/i;
const SOURCE_DETAIL_CONTENT_PATTERN = /\b(?:source|records|streams|run|diagnostic|collection)\b/i;

interface FetchResponseLike {
  headers: { get?: (name: string) => string | null; getSetCookie?: () => string[] };
  status: number;
  text: () => Promise<string>;
}
/** Narrower than the DOM `fetch` type so tests can inject lightweight response mocks structurally. */
type FetchImpl = (url: string | URL, init?: RequestInit) => Promise<FetchResponseLike>;
/** Loosely-shaped connector summary from `/_ref/connectors` — read via optional chaining throughout, never assumed complete. */
type Connector = Record<string, unknown>;

/**
 * Owner setup surfaces to probe on a live origin. Path + tier; the forbidden
 * rules for that tier are applied to the served HTML.
 */
export const LIVE_SURFACES: readonly { path: string; tier: string }[] = [
  { path: "/", tier: "normal" },
  { path: "/connect", tier: "normal" },
  { path: "/sources", tier: "normal" },
  { path: "/sources/add", tier: "normal" },
  { path: "/explore", tier: "normal" },
  { path: "/grants", tier: "normal" },
  { path: "/audit", tier: "normal" },
  { path: "/syncs", tier: "normal" },
  { path: "/schedules", tier: "normal" },
  { path: "/search", tier: "normal" },
  { path: "/device-exporters", tier: "advanced" },
];

/**
 * Resolve owner auth from the environment without exposing its value.
 * Recognized (first match wins):
 *   PDPP_OWNER_SESSION_COOKIE — full Cookie header value for an owner session.
 *   PDPP_OWNER_TOKEN          — owner bearer token.
 *
 */
export function resolveOwnerAuthFromEnv(env: NodeJS.ProcessEnv = process.env): {
  header: Record<string, string>;
  mode: "cookie" | "bearer" | "none";
} {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return { header: { cookie }, mode: "cookie" };
  }
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return { header: { authorization: `Bearer ${token}` }, mode: "bearer" };
  }
  return { header: {}, mode: "none" };
}

type OwnerAuthForLive =
  | OwnerAuthResult<"password-session">
  | { error: null; header: Record<string, string>; mode: "bearer" | "cookie" | "none" };

function resolveOwnerAuthForLive({
  base,
  env,
  fetchImpl,
}: {
  base: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchImpl;
}): Promise<OwnerAuthForLive> {
  const cookie = env.PDPP_OWNER_SESSION_COOKIE?.trim();
  if (cookie) {
    return Promise.resolve({ header: { cookie }, mode: "cookie", error: null });
  }

  const password = env.PDPP_OWNER_PASSWORD?.trim();
  if (password) {
    return loginWithOwnerPassword({ base, password, fetchImpl });
  }

  // `_ref` owner-session routes do not generally accept owner bearer tokens on
  // the composed dashboard origin, but keep this as a best-effort fallback for
  // older/local references that did.
  const token = env.PDPP_OWNER_TOKEN?.trim();
  if (token) {
    return Promise.resolve({ header: { authorization: `Bearer ${token}` }, mode: "bearer", error: null });
  }

  return Promise.resolve({ header: {}, mode: "none", error: null });
}

function htmlToText(html: string): string {
  return String(html)
    .replace(HTML_SCRIPT_TAG_PATTERN, " ")
    .replace(HTML_STYLE_TAG_PATTERN, " ")
    .replace(HTML_TAG_PATTERN, " ")
    .replace(HTML_NBSP_PATTERN, " ")
    .replace(HTML_AMP_PATTERN, "&")
    .replace(HTML_APOSTROPHE_PATTERN, "'")
    .replace(HTML_QUOTE_PATTERN, '"')
    .replace(DOM_WHITESPACE_PATTERN, " ")
    .trim();
}

interface ResolvedDomNode {
  attrs: Partial<Record<string, string>>;
  children: ResolvedDomNode[];
  parent: ResolvedDomNode | null;
  tag: string;
  text: string;
}

const DOM_TOKEN_PATTERN = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][^>]*>|[^<]+/gi;
const DOM_ATTRIBUTE_PATTERN = /([a-z_:][a-z0-9:._-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gi;
const VOID_DOM_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const SKIP_DOM_TEXT_TAGS = new Set(["script", "style", "template"]);

function decodeHtml(value: string): string {
  return value
    .replace(HTML_NBSP_PATTERN, " ")
    .replace(HTML_AMP_PATTERN, "&")
    .replace(HTML_APOSTROPHE_PATTERN, "'")
    .replace(HTML_QUOTE_PATTERN, '"')
    .replace(HTML_LESS_THAN_PATTERN, "<")
    .replace(HTML_GREATER_THAN_PATTERN, ">");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this tiny parser keeps the acceptance oracle independent of a browser or HTML dependency.
function parseResolvedDom(html: string): ResolvedDomNode {
  const root: ResolvedDomNode = { attrs: {}, children: [], parent: null, tag: "#document", text: "" };
  const stack: ResolvedDomNode[] = [root];
  for (const match of String(html).matchAll(DOM_TOKEN_PATTERN)) {
    const token = match[0] ?? "";
    const current = stack.at(-1) ?? root;
    if (token.startsWith("<!--") || token.startsWith("<!")) {
      continue;
    }
    if (token.startsWith("</")) {
      const tag = token.slice(2).match(DOM_TAG_NAME_PATTERN)?.[0]?.toLowerCase();
      if (!tag) {
        continue;
      }
      const openIndex = stack.findLastIndex((node) => node.tag === tag);
      if (openIndex > 0) {
        stack.splice(openIndex);
      }
      continue;
    }
    if (token.startsWith("<")) {
      const tag = token.slice(1).match(DOM_TAG_NAME_PATTERN)?.[0]?.toLowerCase();
      if (!tag) {
        continue;
      }
      const attrs: Partial<Record<string, string>> = {};
      const attrSource = token
        .slice(1 + tag.length)
        .replace(DOM_SELF_CLOSING_PATTERN, "")
        .replace(DOM_END_MARKER_PATTERN, "");
      for (const attr of attrSource.matchAll(DOM_ATTRIBUTE_PATTERN)) {
        const name = (attr[1] ?? "").toLowerCase();
        if (!name) {
          continue;
        }
        attrs[name] = decodeHtml(attr[2] ?? attr[3] ?? attr[4] ?? "");
      }
      const node: ResolvedDomNode = { attrs, children: [], parent: current, tag, text: "" };
      current.children.push(node);
      if (!(VOID_DOM_TAGS.has(tag) || DOM_SELF_CLOSING_PATTERN.test(token))) {
        stack.push(node);
      }
      continue;
    }
    current.text += decodeHtml(token);
  }
  return root;
}

function domElements(root: ResolvedDomNode): ResolvedDomNode[] {
  const result: ResolvedDomNode[] = [];
  const visit = (node: ResolvedDomNode) => {
    if (node.tag !== "#document") {
      result.push(node);
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return result;
}

function domHasClass(node: ResolvedDomNode, className: string): boolean {
  return (node.attrs.class ?? "").split(DOM_CLASS_SPLIT_PATTERN).includes(className);
}

function domIsHidden(node: ResolvedDomNode): boolean {
  for (let current: ResolvedDomNode | null = node; current; current = current.parent) {
    if (current.attrs["aria-hidden"]?.toLowerCase() === "true") {
      return true;
    }
  }
  return false;
}

function domVisibleText(node: ResolvedDomNode): string {
  if (domIsHidden(node) || SKIP_DOM_TEXT_TAGS.has(node.tag)) {
    return "";
  }
  return [node.text, ...node.children.map((child) => domVisibleText(child))]
    .join(" ")
    .replace(DOM_WHITESPACE_PATTERN, " ")
    .trim();
}

function visibleDomElements(root: ResolvedDomNode): ResolvedDomNode[] {
  return domElements(root).filter((node) => !domIsHidden(node));
}

function isLoginDocument(root: ResolvedDomNode): boolean {
  const elements = visibleDomElements(root);
  return (
    elements.some((node) => node.tag === "form" && LOGIN_ACTION_PATTERN.test(node.attrs.action ?? "")) ||
    LOGIN_TEXT_PATTERN.test(domVisibleText(root))
  );
}

const RESOLVED_SURFACE_SKELETON_PATTERNS: readonly RegExp[] = [
  /\b(?:Loading(?:…|\.{3})|Skeleton)\b/i,
  /class=["'][^"']*(?:skeleton|animate-pulse|shimmer)[^"']*["']/i,
  /data-testid=["'][^"']*skeleton[^"']*["']/i,
];
interface ResolvedSurfaceRequirement {
  label: string;
  pattern: RegExp;
}

const RESOLVED_SURFACE_REQUIREMENTS: Readonly<Record<string, readonly ResolvedSurfaceRequirement[]>> = {
  "/": [
    { label: "Where you stand title", pattern: /\bWhere you stand\b/i },
    { label: "source attention block", pattern: /\bSource attention\b/i },
    { label: "notifications block", pattern: /\bNotifications\b/i },
  ],
  "/audit": [{ label: "Audit title", pattern: /\bAudit\b/i }],
  "/connect": [{ label: "Connect apps title", pattern: /\bConnect apps\b/i }],
  "/device-exporters": [
    { label: "device exporters title", pattern: /\b(?:Local device exporters|Enrolled devices)\b/i },
  ],
  "/explore": [
    { label: "Explore title", pattern: BEXPLORE_PATTERN },
    { label: "record query controls", pattern: SEARCH_NAMES_FIELDS_AND_PATTERN },
    { label: "record filters", pattern: BFILTERS_PATTERN },
    { label: "record sort controls", pattern: BNEWEST_BOLDEST_PATTERN },
  ],
  "/grants": [{ label: "Grants title", pattern: /\bGrants\b/i }],
  "/search": [{ label: "search controls", pattern: /\b(?:Search|trace|grant|run)\b/i }],
  "/schedules": [
    { label: "Schedules title", pattern: BSCHEDULES_PATTERN },
    { label: "schedule section", pattern: BSCHEDULED_CONNECTIONS_BNO_SCHEDULED_PATTERN },
    { label: "scheduled/unscheduled counts", pattern: BSCHEDULED_BUNSCHEDULED_PATTERN },
  ],
  "/sources": [
    { label: "Sources title", pattern: BSOURCES_PATTERN },
    { label: "source list or empty state", pattern: SOURCE_LIST_CONTENT_PATTERN },
  ],
  "/sources/add": [{ label: "Add source title", pattern: /\bAdd source\b/i }],
  "/syncs": [{ label: "Syncs title", pattern: /\bSyncs\b/i }],
};

function resolvedSurfaceRequirements(path: string): readonly ResolvedSurfaceRequirement[] {
  const declared = RESOLVED_SURFACE_REQUIREMENTS[path];
  if (declared) {
    return declared;
  }
  if (path.startsWith("/sources/") && path !== "/sources/add") {
    return [{ label: "source detail content", pattern: SOURCE_DETAIL_CONTENT_PATTERN }];
  }
  return [];
}

function resolvedSurfaceSkeletonMarkers(root: ResolvedDomNode): string[] {
  const visibleText = domVisibleText(root);
  const markers: string[] = [];
  for (const pattern of RESOLVED_SURFACE_SKELETON_PATTERNS) {
    if (pattern.source.includes("Loading") || pattern.source.includes("Skeleton")) {
      const match = pattern.exec(visibleText);
      pattern.lastIndex = 0;
      if (match?.[0]) {
        markers.push(match[0]);
      }
      continue;
    }
    for (const node of visibleDomElements(root)) {
      const attrs = Object.entries(node.attrs)
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ");
      const match = pattern.exec(attrs);
      pattern.lastIndex = 0;
      if (match?.[0]) {
        markers.push(match[0]);
        break;
      }
    }
  }
  return markers;
}

export interface ResolvedOwnerSurfaceCheck {
  missing: readonly string[];
  ok: boolean;
  path: string;
  skeletonMarkers: readonly string[];
  status: number;
}

/**
 * Deterministic render oracle for server responses. It reads only visible
 * text plus visible skeleton markers; RSC scripts and styles do not count as
 * proof that a React surface resolved.
 */
export function inspectResolvedOwnerSurface({
  html,
  path,
  status,
  requiredText = [],
}: {
  html: string;
  path: string;
  status: number;
  requiredText?: readonly ResolvedSurfaceRequirement[];
}): ResolvedOwnerSurfaceCheck {
  const root = parseResolvedDom(html);
  const text = domVisibleText(root);
  const missing = [...resolvedSurfaceRequirements(path), ...requiredText]
    .filter((requirement) => {
      requirement.pattern.lastIndex = 0;
      const matches = requirement.pattern.test(text);
      requirement.pattern.lastIndex = 0;
      return !matches;
    })
    .map((requirement) => requirement.label);
  const skeletonMarkers = resolvedSurfaceSkeletonMarkers(root);
  return {
    missing,
    ok:
      status >= 200 &&
      status < 300 &&
      text.length > 0 &&
      !isLoginDocument(root) &&
      missing.length === 0 &&
      skeletonMarkers.length === 0,
    path,
    skeletonMarkers,
    status,
  };
}

function visibleMonogramInitials(html: string): string[] {
  return visibleDomElements(parseResolvedDom(html))
    .filter((node) => node.tag === "span" && domHasClass(node, "pdpp-monogram"))
    .map((node) => domVisibleText(node))
    .filter((initials) => initials.length > 0);
}

function asArrayList(raw: unknown): Connector[] {
  if (Array.isArray(raw)) {
    return raw as Connector[];
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).data)) {
    return (raw as Record<string, unknown>).data as Connector[];
  }
  return [];
}

function ownerSatisfiableAction(verdict: Connector | null): boolean {
  const actions = Array.isArray(verdict?.required_actions) ? (verdict?.required_actions as Connector[]) : [];
  return actions.some(
    (action) => action?.audience === "owner" && (action?.satisfied_when as Connector | undefined)?.kind !== "none"
  );
}

function ownerSatisfiableActions(verdict: Connector | null): Connector[] {
  const actions = Array.isArray(verdict?.required_actions) ? (verdict?.required_actions as Connector[]) : [];
  return actions.filter(
    (action) => action?.audience === "owner" && (action?.satisfied_when as Connector | undefined)?.kind !== "none"
  );
}

function compactStrings(values: readonly unknown[]): string[] {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );
}

function nextStepTextCandidates(action: Connector): string[] {
  const remediation = action.remediation as Connector | undefined;
  return compactStrings([
    action.cta,
    remediation?.label,
    remediation?.summary,
    ...(Array.isArray(remediation?.commands)
      ? (remediation.commands as Connector[]).map((command) => command?.label)
      : []),
  ]);
}

function renderedVerdict(connector: Connector): Connector | null {
  const verdict = connector.rendered_verdict;
  return verdict && typeof verdict === "object" ? (verdict as Connector) : null;
}

function connectorLabel(connector: Connector): string {
  return String(
    connector.display_name ||
      connector.connector_display_name ||
      connector.connector_id ||
      connector.connection_id ||
      "A source"
  );
}

function sourceCountPhrase(connector: Connector): string | null {
  const totalRecordsState = String(connector.total_records_state ?? "").toLowerCase();
  // Sources shows the manifest-declared stream roster. `stream_count` is a
  // different protocol fact: streams with retained evidence, which is
  // legitimately zero for a fresh draft whose declared streams are visible.
  const rawStreamCount = Array.isArray(connector.streams)
    ? (connector.streams as unknown[]).length
    : connector.stream_count;
  const streams = Number(rawStreamCount);
  if (!Number.isFinite(streams)) {
    return null;
  }
  const streamCount = Math.max(0, Math.floor(streams));
  const records = Number(connector.total_records);
  let recordsLabel = "records unavailable";
  if (totalRecordsState !== "unobserved" && totalRecordsState !== "unknown" && Number.isFinite(records)) {
    const recordCount = Math.max(0, Math.floor(records));
    const recordNoun = recordCount === 1 ? "record" : "records";
    const qualifier = totalRecordsState === "stale" ? " (unverified)" : "";
    recordsLabel = `${recordCount.toLocaleString()} ${recordNoun}${qualifier}`;
  }
  return `${recordsLabel} · ${streamCount.toLocaleString()} ${streamCount === 1 ? "stream" : "streams"}`;
}

function connectorRouteId(connector: Connector): string | null {
  const id = connector.connector_instance_id ?? connector.connection_id ?? null;
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

const SERVER_SOURCE_WORK_GROUPS = new Set(["needs_owner", "not_measured", "review", "system_issue", "working", "none"]);

function serverSourceWork(connector: Connector): string | null {
  const value = connector.source_work;
  return typeof value === "string" && SERVER_SOURCE_WORK_GROUPS.has(value) ? value : null;
}

function isMaterialSourceIssue(connector: Connector): boolean {
  if (connector.revoked_at) {
    return false;
  }
  const serverWork = serverSourceWork(connector);
  if (!serverWork) {
    return true;
  }
  if (serverWork) {
    if (serverWork === "none" || serverWork === "working") {
      return false;
    }
    return serverWork !== "review" || !isHealthyRefreshAdvisory(connector);
  }
  const verdict = renderedVerdict(connector);
  if (!verdict) {
    return false;
  }
  if (verdict.channel === "attention" && ownerSatisfiableAction(verdict)) {
    return false;
  }
  const pill = (verdict.pill && typeof verdict.pill === "object" ? verdict.pill : {}) as Connector;
  return (
    pill.tone === "red" ||
    pill.label === "Can't collect" ||
    pill.tone === "amber" ||
    pill.label === "Missing data" ||
    verdict.channel === "attention"
  );
}

function isHealthyRefreshAdvisory(connector: Connector): boolean {
  if (connector.revoked_at) {
    return false;
  }
  const serverWork = serverSourceWork(connector);
  if (!serverWork) {
    return false;
  }
  if (serverWork && serverWork !== "review") {
    return false;
  }
  const verdict = renderedVerdict(connector);
  if (verdict?.channel !== "advisory") {
    return false;
  }
  const pill = (verdict.pill && typeof verdict.pill === "object" ? verdict.pill : {}) as Connector;
  if (pill.tone !== "green" && pill.label !== "Healthy") {
    return false;
  }
  const actionText = Array.isArray(verdict.required_actions)
    ? (verdict.required_actions as Connector[]).map((action) => `${action?.kind ?? ""} ${action?.cta ?? ""}`).join(" ")
    : "";
  return BREFRESH_PATTERN.test(`${verdict.forward_statement ?? ""} ${actionText}`);
}

interface DashboardRenderedRow {
  anchors: readonly { href: string; text: string }[];
  text: string;
}

interface UnavailableSourceWork {
  href: string;
  label: string;
  reason: string;
}

function renderedDashboardRows(html: string): DashboardRenderedRow[] {
  const root = parseResolvedDom(html);
  return visibleDomElements(root)
    .filter((node) => domHasClass(node, "rr-attn__row"))
    .map((node) => ({
      anchors: visibleDomElements(node)
        .filter((child) => child.tag === "a" && typeof child.attrs.href === "string")
        .map((child) => ({ href: child.attrs.href ?? "", text: domVisibleText(child) })),
      text: domVisibleText(node),
    }));
}

function rowRepresents(row: DashboardRenderedRow, issue: { forwardStatement: string; label: string }): boolean {
  if (!row.text.includes(issue.label)) {
    return false;
  }
  return issue.forwardStatement.length === 0 || row.text.includes(issue.forwardStatement);
}

interface RenderedSourceRow {
  id: string | null;
  label: string | null;
  text: string;
}

function renderedSourceRows(pages: readonly string[]): readonly RenderedSourceRow[] {
  const rows: RenderedSourceRow[] = [];
  const seen = new Set<string>();
  for (const html of pages) {
    const root = parseResolvedDom(html);
    for (const node of visibleDomElements(root)) {
      if (!domHasClass(node, "rr-s-item")) {
        continue;
      }
      const key = `${node.attrs["data-source-id"] ?? ""}|${node.attrs["data-source-label"] ?? ""}|${domVisibleText(node)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push({
        id: node.attrs["data-source-id"] ?? null,
        label: node.attrs["data-source-label"] ?? null,
        text: domVisibleText(node),
      });
    }
  }
  return rows;
}

function exactVisibleActionNodes(html: string, label: string): ResolvedDomNode[] {
  const root = parseResolvedDom(html);
  return visibleDomElements(root).filter((node) => domVisibleText(node) === label);
}

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_ESCAPE_PATTERN, "\\$&");
}

function hrefPath(href: string, base: string): string | null {
  try {
    return new URL(href, base).pathname;
  } catch {
    return null;
  }
}

function expectedActionHrefMatches(action: Connector, href: string, base: string, routeId: string): boolean {
  const path = hrefPath(href, base);
  const surface = (action.surface as Connector | undefined)?.kind;
  const connectionTargetMatches = (() => {
    try {
      const url = new URL(href, base);
      return url.searchParams.get("connectionId") === routeId || url.searchParams.get("connection_id") === routeId;
    } catch {
      return false;
    }
  })();
  if (action.kind === "add_info") {
    const runId = (action.target as Connector | undefined)?.run_id;
    return typeof runId === "string" && path === `/syncs/${encodeURIComponent(runId)}`;
  }
  if (action.kind === "reauth") {
    if (surface === "browser_session") {
      return path?.startsWith("/connect/browser-session/") === true && connectionTargetMatches;
    }
    if (surface === "stored_credential") {
      return path?.startsWith("/connect/static-secret/") === true && connectionTargetMatches;
    }
    return path?.startsWith("/sources/") === true || path?.startsWith("/connect/") === true;
  }
  return path === `/sources/${encodeURIComponent(routeId)}`;
}

export interface DashboardSourceTrustOracle {
  healthyRefreshAdvisories: readonly { forwardStatement: string; label: string }[];
  materialIssues: readonly { forwardStatement: string; label: string }[];
  overstatedHealthyAdvisories: readonly { forwardStatement: string; label: string }[];
  projectionDisagreements: readonly { label: string; reason: string }[];
  rawIssues: readonly { label: string; reason: string }[];
  sourceWorkUnavailable: readonly UnavailableSourceWork[];
  unrepresentedMaterialIssues: readonly { forwardStatement: string; label: string }[];
  unrepresentedRawIssues: readonly { label: string; reason: string }[];
  unrepresentedSourceWorkUnavailable: readonly UnavailableSourceWork[];
  unsupportedAllClearClaim: string | null;
}

/**
 * Compare the connector API's trust claims with resolved dashboard text. This
 * is intentionally provider-neutral: the API supplies labels and actions, and
 * the rendered page either discloses them or fails the oracle.
 */
export function evaluateDashboardSourceTrust(
  connectors: readonly Connector[],
  dashboardHtml: string
): DashboardSourceTrustOracle {
  // Claims must come from the resolved accessibility/render tree. Raw HTML
  // text can include hidden template/script content and would let a fixture
  // pass without proving that the owner can see the claim.
  const dashboardText = domVisibleText(parseResolvedDom(dashboardHtml));
  const rows = renderedDashboardRows(dashboardHtml);
  const materialIssues = connectors.filter(isMaterialSourceIssue).map((connector) => ({
    label: connectorLabel(connector),
    forwardStatement: String(renderedVerdict(connector)?.forward_statement ?? ""),
  }));
  const healthyRefreshAdvisories = connectors.filter(isHealthyRefreshAdvisory).map((connector) => ({
    label: connectorLabel(connector),
    forwardStatement: String(renderedVerdict(connector)?.forward_statement ?? ""),
  }));
  const rawIssues = connectors.filter(isRawMaterialSourceIssue).map((connector) => ({
    label: connectorLabel(connector),
    reason: String(
      (connector?.connection_health as Connector | undefined)?.reason_code ??
        (connector?.last_run as Connector | undefined)?.failure_reason ??
        "raw source issue"
    ),
  }));
  const sourceWorkUnavailable = connectors
    .filter((connector) => !(connector.revoked_at || serverSourceWork(connector)))
    .map((connector) => {
      const routeId = connectorRouteId(connector);
      return {
        href: routeId === null ? "" : `/sources/${encodeURIComponent(routeId)}`,
        label: connectorLabel(connector),
        reason: "source_work missing or unavailable",
      };
    });
  const projectionDisagreements = rawIssues
    .map((issue) => {
      const connector = connectors.find((candidate) => connectorLabel(candidate) === issue.label);
      const serverWork = connector ? serverSourceWork(connector) : null;
      if (serverWork === "none") {
        return {
          label: issue.label,
          reason: "source_work=none",
        };
      }
      return null;
    })
    .filter((issue): issue is { label: string; reason: string } => issue !== null);
  const unsupportedAllClearClaim =
    dashboardText.match(BGRANTS_ARE_WITHIN_THEIR_PATTERN)?.[0] ??
    dashboardText.match(BBACKUPS_ARE_PATTERN)?.[0] ??
    null;
  const overstatedHealthyAdvisories = healthyRefreshAdvisories.filter((issue) => {
    const row = rows.find((candidate) => candidate.text.includes(issue.label));
    const renderedAsBroken = Boolean(row && RENDERED_BROKEN_PATTERN.test(row.text));
    const renderedWithRefreshStatement = Boolean(row && rowRepresents(row, issue));
    return renderedAsBroken || renderedWithRefreshStatement;
  });
  return {
    healthyRefreshAdvisories,
    materialIssues,
    overstatedHealthyAdvisories,
    projectionDisagreements,
    sourceWorkUnavailable,
    rawIssues,
    unsupportedAllClearClaim,
    unrepresentedMaterialIssues: materialIssues.filter((issue) => !rows.some((row) => rowRepresents(row, issue))),
    unrepresentedRawIssues: rawIssues.filter((issue) => !rows.some((row) => row.text.includes(issue.label))),
    unrepresentedSourceWorkUnavailable: sourceWorkUnavailable.filter(
      (issue) =>
        !rows.some((row) => row.text.includes(issue.label) && row.anchors.some((anchor) => anchor.href === issue.href))
    ),
  };
}

function isRawMaterialSourceIssue(connector: Connector): boolean {
  if (connector.revoked_at) {
    return false;
  }
  const health = connector.connection_health as Connector | undefined;
  const state = String(health?.state ?? "").toLowerCase();
  if (state === "degraded" || state === "blocked") {
    return true;
  }
  const coverage = String((health?.axes as Connector | undefined)?.coverage ?? "").toLowerCase();
  if (coverage === "terminal_gap" || coverage === "retryable_gap" || coverage === "partial") {
    return true;
  }
  const outbox = String((health?.axes as Connector | undefined)?.outbox ?? "").toLowerCase();
  if (outbox === "stalled") {
    return true;
  }
  const runStatus = String((connector.last_run as Connector | undefined)?.status ?? "").toLowerCase();
  return runStatus === "failed" || runStatus === "rejected";
}

function shouldProbeSourceDetailRecoveryCopy(connector: Connector): boolean {
  if (connector.revoked_at) {
    return false;
  }
  const verdict = renderedVerdict(connector);
  if (!verdict) {
    return false;
  }
  return isMaterialSourceIssue(connector) || verdict.channel === "attention" || ownerSatisfiableAction(verdict);
}

const SUCCESS_RUN_STATUSES = new Set(["succeeded", "success", "completed"]);

function collectionReportHasOpenGaps(report: unknown): boolean {
  if (!Array.isArray(report)) {
    return false;
  }
  return (report as Connector[]).some((entry) => {
    if (entry?.coverage_condition !== "complete") {
      return true;
    }
    if (Number(entry?.pending_detail_gaps ?? 0) > 0) {
      return true;
    }
    return entry?.skipped !== null && entry?.skipped !== undefined;
  });
}

function shouldProbeSourceDetailRunGapHonesty(connector: Connector): boolean {
  if (connector.revoked_at) {
    return false;
  }
  const lastRunStatus = String((connector.last_run as Connector | undefined)?.status ?? "").toLowerCase();
  return SUCCESS_RUN_STATUSES.has(lastRunStatus) && collectionReportHasOpenGaps(connector.collection_report);
}

function runLiveGrantCaptionChecks({ htmlByPath }: { htmlByPath: Map<string, string> }): {
  checks: { detail: string; id: string; status: string }[];
  findings: Finding[];
} {
  const findings: Finding[] = [];
  const checks: { detail: string; id: string; status: string }[] = [];
  const grantsText = htmlToText(htmlByPath.get("/grants") ?? "");
  const rawClientCaption =
    grantsText.match(BCLIENT_CLI_PATTERN)?.[0] ?? grantsText.match(BCLIENT_HTTPS_PATTERN)?.[0] ?? null;

  if (rawClientCaption) {
    findings.push({
      ruleId: "grants-raw-client-caption",
      class: "dashboard-trust-claim",
      path: "live:/grants",
      line: 0,
      excerpt: rawClientCaption,
      rationale:
        "The grants list must not lead with raw technical client ids in visible row copy. Preserve ids as details, but render registered client names or a human fallback caption.",
    });
  }

  checks.push({
    id: "grants-client-caption-humanized",
    status: rawClientCaption ? "fail" : "pass",
    detail: rawClientCaption ? "raw technical client caption visible" : "no raw technical client caption visible",
  });

  return { findings, checks };
}

interface DeclaredSetupSurface {
  path: string;
  tier: string;
}

function declaredSetupSurfaces(html: string): DeclaredSetupSurface[] {
  const root = parseResolvedDom(html);
  const seen = new Set<string>();
  const surfaces: DeclaredSetupSurface[] = [];
  for (const node of visibleDomElements(root)) {
    if (node.tag !== "a") {
      continue;
    }
    const href = node.attrs.href ?? "";
    const match = href.match(SETUP_SURFACE_PATH_PATTERN);
    if (!match?.[1]) {
      continue;
    }
    const path = `/${match[1]}`;
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    surfaces.push({ path, tier: "normal" });
  }
  return surfaces;
}

function renderedNextPageHref(html: string, base: string): string | null {
  const root = parseResolvedDom(html);
  for (const node of visibleDomElements(root)) {
    if (node.tag !== "a" || !NEXT_PAGE_LABEL_PATTERN.test(domVisibleText(node))) {
      continue;
    }
    const { href } = node.attrs;
    if (!href) {
      continue;
    }
    try {
      const url = new URL(href, base);
      return `${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchRenderedContinuationPages({
  base,
  findings,
  fetchImpl,
  header,
  html,
  path,
  statusByPath,
  surfaces,
  htmlByPath,
}: {
  base: string;
  findings: Finding[];
  fetchImpl: FetchImpl;
  header: Record<string, string>;
  html: string;
  htmlByPath: Map<string, string>;
  path: string;
  statusByPath: Map<string, number>;
  surfaces: LiveSurfaceResult[];
}): Promise<string[]> {
  const pages = [html];
  const seen = new Set<string>([path]);
  let currentHtml = html;
  for (let page = 0; page < 200; page += 1) {
    const nextPath = renderedNextPageHref(currentHtml, base);
    if (!nextPath || seen.has(nextPath)) {
      break;
    }
    seen.add(nextPath);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each rendered continuation depends on the prior page's next link.
      const res = await fetchImpl(`${base}${nextPath}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const nextHtml = await res.text();
      statusByPath.set(nextPath, res.status);
      const resolved = inspectResolvedOwnerSurface({ html: nextHtml, path, status: res.status });
      const reached = resolved.ok;
      const surfaceFindings = reached
        ? scanForbiddenStrings({
            path: `live:${nextPath}`,
            src: nextHtml,
            tier: "normal",
            rules: FORBIDDEN_STRING_RULES,
          }).map((finding) => ({ ...finding, live: true, line: finding.line || lineOf(nextHtml, 0) }))
        : [];
      findingsForRenderedContinuation(surfaces, nextPath, res.status, nextHtml, reached, surfaceFindings);
      findings.push(...surfaceFindings);
      if (!reached) {
        findings.push({
          ruleId: "live-owner-surface-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${nextPath}`,
          line: 0,
          excerpt: [...resolved.missing, ...resolved.skeletonMarkers].join(", ") || `status ${res.status}`,
          rationale:
            "Every rendered continuation page must be an authenticated, resolved owner DOM. A broken or shell-only next page is not an honest pagination boundary.",
        });
        break;
      }
      htmlByPath.set(`${path}::${nextPath}`, nextHtml);
      pages.push(nextHtml);
      currentHtml = nextHtml;
    } catch (err) {
      findings.push({
        ruleId: "live-owner-pagination-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:${nextPath}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "A rendered Next page must resolve as an authenticated owner page. A fetch failure is not an honest end of pagination and cannot pass as a complete source or dashboard render.",
      });
      break;
    }
  }
  return pages;
}

function findingsForRenderedContinuation(
  surfaces: LiveSurfaceResult[],
  path: string,
  status: number,
  html: string,
  reachedOwnerSurface: boolean,
  surfaceFindings: readonly Finding[]
): void {
  surfaces.push({
    bytes: html.length,
    findingCount: surfaceFindings.length,
    path,
    reachedOwnerSurface,
    status,
    tier: "normal",
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the live semantic-probe orchestrator running ~10 independent trust-claim checks against the rendered dashboard — carried over unchanged from the .mjs source.
async function runLiveSemanticChecks({
  base,
  header,
  fetchImpl,
  htmlByPath,
  renderedPagesByPath,
  setupSurfaces,
  surfaceStatusByPath,
}: {
  base: string;
  fetchImpl: FetchImpl;
  header: Record<string, string>;
  htmlByPath: Map<string, string>;
  renderedPagesByPath: Map<string, readonly string[]>;
  setupSurfaces: readonly DeclaredSetupSurface[];
  surfaceStatusByPath: Map<string, number>;
}): Promise<{ checks: { detail: string; id: string; status: string }[]; findings: Finding[] }> {
  const findings: Finding[] = [];
  const checks: { detail: string; id: string; status: string }[] = [];

  // Terminal-gate revision (2026-07-29): `?limit=200` exceeded the route's
  // new maximum page size (100) and no longer exists as a single-request
  // "give me everything" contract. Page-follow the bounded route to
  // completion instead — this acceptance check genuinely needs the whole
  // fleet.
  const connectorsPaged = await fetchAllConnectorSummaries({
    base,
    fetchImpl,
    headers: { accept: "application/json", ...header },
    // Reconciles against the rendered `/sources` DOM below, which the
    // console fetches with `sources_visibility=1` — the same opt-in must
    // apply here or a legitimately-rendered, never-succeeded setup-shell row
    // reads as missing/extra against the wrong inventory.
    sourcesVisibility: true,
  });
  if (!connectorsPaged.ok) {
    findings.push({
      ruleId: "live-ref-surface-not-reached",
      class: "live-probe-inconclusive",
      path: "live:/_ref/connectors",
      line: 0,
      excerpt: `status ${connectorsPaged.status}`,
      rationale:
        "The live semantic probe could not reach the reference JSON surface. Owner-journey trust checks are inconclusive until the data source behind the rendered page is observed.",
    });
    checks.push({
      id: "dashboard-source-issue-all-clear",
      status: "inconclusive",
      detail: "connectors JSON unavailable",
    });
    return { findings, checks };
  }

  const connectors = asArrayList(connectorsPaged.data);
  const dashboardHtml = htmlByPath.get("/") ?? "";
  const dashboardText = domVisibleText(parseResolvedDom(dashboardHtml));
  const dashboardSourceTrust = evaluateDashboardSourceTrust(connectors, dashboardHtml);
  const {
    materialIssues: sourceIssues,
    overstatedHealthyAdvisories,
    rawIssues: rawSourceIssues,
    projectionDisagreements,
    unrepresentedSourceWorkUnavailable,
    unsupportedAllClearClaim,
    unrepresentedMaterialIssues,
    unrepresentedRawIssues,
  } = dashboardSourceTrust;
  const dashboardVisibleMonograms = visibleMonogramInitials(dashboardHtml);
  if (unsupportedAllClearClaim) {
    findings.push({
      ruleId: "dashboard-unsupported-all-clear-claim",
      class: "dashboard-trust-claim",
      path: "live:/",
      line: 0,
      excerpt: unsupportedAllClearClaim,
      rationale:
        "The dashboard all-clear must only state facts backed by the overview inputs. It must not claim backup state or grant-limit health unless those facts are actually derived.",
    });
  }
  if (dashboardVisibleMonograms.length > 0) {
    findings.push({
      ruleId: "dashboard-monogram-not-decorative",
      class: "dashboard-accessibility",
      path: "live:/",
      line: 0,
      excerpt: dashboardVisibleMonograms.slice(0, 5).join(", "),
      rationale:
        "Dashboard client monograms are visual marks. If their initials remain in the text/accessibility tree, owner-facing labels collapse into strings like CLCLaude instead of Claude.",
    });
  }

  if (sourceIssues.length > 0 || rawSourceIssues.length > 0) {
    const allClearRe = SOURCE_ISSUES_REVIEW_HERE_PATTERN;
    if (allClearRe.test(dashboardText)) {
      findings.push({
        ruleId: "dashboard-source-issue-all-clear",
        class: "dashboard-trust-claim",
        path: "live:/",
        line: 0,
        excerpt: dashboardText.match(allClearRe)?.[0] ?? "all-clear copy",
        rationale:
          "The dashboard must not claim sources are syncing when the reference connector summary contains material non-owner source issues. The hero may stay calm, but the Anything wrong panel must disclose the issue.",
      });
    }
  }

  if (overstatedHealthyAdvisories.length > 0) {
    findings.push({
      ruleId: "dashboard-healthy-advisory-overstated",
      class: "dashboard-trust-claim",
      path: "live:/",
      line: 0,
      excerpt: overstatedHealthyAdvisories
        .map((issue) => issue.label)
        .slice(0, 5)
        .join(", "),
      rationale:
        "A healthy source with a refresh-available advisory must not appear in the dashboard issue list as degraded or broken. The source detail may offer Refresh now, but the dashboard must not manufacture urgency.",
    });
  }

  if (sourceIssues.length > 0 && unrepresentedMaterialIssues.length > 0) {
    findings.push({
      ruleId: "dashboard-source-issue-missing",
      class: "dashboard-trust-claim",
      path: "live:/",
      line: 0,
      excerpt: unrepresentedMaterialIssues
        .map((issue) => issue.label)
        .slice(0, 5)
        .join(", "),
      rationale:
        "The dashboard reference data contains material source issues, but one or more source labels are absent from the rendered dashboard. The owner needs a visible row for every issue, not a silent calm state.",
    });
  }

  if (rawSourceIssues.length > 0 && unrepresentedRawIssues.length > 0) {
    findings.push({
      ruleId: "dashboard-raw-source-issue-missing",
      class: "dashboard-trust-claim",
      path: "live:/",
      line: 0,
      excerpt: unrepresentedRawIssues
        .map((issue) => `${issue.label}:${issue.reason}`)
        .slice(0, 5)
        .join(", "),
      rationale:
        "Raw connection-health evidence contains material source issues, but one or more source labels are absent from the rendered dashboard. The dashboard must disclose every broken-source fact even if a rendered verdict projection regresses.",
    });
  }

  if (projectionDisagreements.length > 0) {
    findings.push({
      ruleId: "dashboard-source-health-projection-disagreement",
      class: "dashboard-trust-claim",
      path: "live:/_ref/connectors",
      line: 0,
      excerpt: projectionDisagreements
        .map((issue) => `${issue.label} (${issue.reason})`)
        .slice(0, 5)
        .join(", "),
      rationale:
        "Raw health is diagnostic evidence, not a second client-side classifier. A raw material issue that disagrees with the server-owned source_work/rendered verdict must fail closed until the server projection is corrected.",
    });
  }

  if (unrepresentedSourceWorkUnavailable.length > 0) {
    findings.push({
      ruleId: "dashboard-source-work-unavailable",
      class: "dashboard-trust-claim",
      path: "live:/_ref/connectors",
      line: 0,
      excerpt: unrepresentedSourceWorkUnavailable
        .map((issue) => issue.label)
        .slice(0, 5)
        .join(", "),
      rationale:
        "The server-owned source_work projection is missing or invalid. The dashboard must retain that source as an explicit unavailable row; it must never silently drop the connector or classify it as healthy from a connector-specific fallback.",
    });
  }

  checks.push({
    id: "dashboard-source-issue-all-clear",
    status: findings.some(
      (f) =>
        f.ruleId === "dashboard-source-issue-all-clear" ||
        f.ruleId === "dashboard-source-issue-missing" ||
        f.ruleId === "dashboard-raw-source-issue-missing" ||
        f.ruleId === "dashboard-source-health-projection-disagreement" ||
        f.ruleId === "dashboard-source-work-unavailable" ||
        f.ruleId === "dashboard-healthy-advisory-overstated" ||
        f.ruleId === "dashboard-unsupported-all-clear-claim"
    )
      ? "fail"
      : "pass",
    detail: `${sourceIssues.length} rendered material source issue(s), ${rawSourceIssues.length} raw material source issue(s) in /_ref/connectors`,
  });
  checks.push({
    id: "dashboard-decorative-monograms",
    status: dashboardVisibleMonograms.length > 0 ? "fail" : "pass",
    detail:
      dashboardVisibleMonograms.length > 0
        ? `${dashboardVisibleMonograms.length} visible monogram initial(s) leaked into dashboard text`
        : "dashboard monogram initials are decorative",
  });

  const browserSetupSurfaces = setupSurfaces.filter((surface) => surface.path.includes("/browser-session/"));
  const directNewBrowserSources = browserSetupSurfaces.filter((surface) => {
    const html = htmlByPath.get(surface.path) ?? "";
    return BSTART_SESSION_PATTERN.test(domVisibleText(parseResolvedDom(html))) && START_SESSION_FORM_PATTERN.test(html);
  });
  for (const surface of directNewBrowserSources) {
    findings.push({
      ruleId: "browser-session-direct-new-source",
      class: "dashboard-setup-integrity",
      path: `live:${surface.path}`,
      line: 0,
      excerpt: "Start session",
      rationale:
        "A declared browser setup surface must not expose a new-source start control without an explicit add-another flow. The check follows the rendered setup roster and does not encode provider names.",
    });
  }
  checks.push({
    id: "browser-session-direct-new-source",
    status: directNewBrowserSources.length > 0 ? "fail" : "pass",
    detail: (() => {
      if (directNewBrowserSources.length > 0) {
        return `${directNewBrowserSources.length} declared browser setup surface(s) can start a new source`;
      }
      if (browserSetupSurfaces.length > 0) {
        return `${browserSetupSurfaces.length} declared browser setup surface(s) have repair-only guidance`;
      }
      return "no declared browser setup surfaces to probe";
    })(),
  });

  const contentExpectations = Array.from(
    new Map(
      [...LIVE_SURFACES, ...setupSurfaces].map((surface) => [
        surface.path,
        { ...surface, id: `${surface.path.replace(ROOT_PATH_PREFIX_PATTERN, "") || "dashboard"}-content-rendered` },
      ])
    ).values()
  );
  for (const expectation of contentExpectations) {
    const isDeclaredSetup =
      expectation.path.includes("/connect/browser-session/") || expectation.path.includes("/connect/manual-upload/");
    const resolved = inspectResolvedOwnerSurface({
      html: htmlByPath.get(expectation.path) ?? "",
      path: expectation.path,
      requiredText: isDeclaredSetup
        ? [
            {
              label: "declared setup controls",
              pattern: OWNER_SETUP_TEXT_PATTERN,
            },
          ]
        : [],
      status: surfaceStatusByPath.get(expectation.path) ?? 0,
    });
    const unresolved = [...resolved.missing, ...resolved.skeletonMarkers.map((marker) => `skeleton marker ${marker}`)];
    if (unresolved.length > 0 || !resolved.ok) {
      findings.push({
        ruleId: expectation.id,
        class: "dashboard-content-missing",
        path: `live:${expectation.path}`,
        line: 0,
        excerpt: unresolved.length > 0 ? unresolved.join(", ") : "empty or unresolved response",
        rationale: `${expectation.path} must render an authenticated, resolved owner DOM without a visible loading skeleton. A shell-only, login, or error-boundary page cannot prove the owner can use this journey.`,
      });
    }
    let contentDetail: string;
    if (resolved.ok) {
      contentDetail = `${expectation.path} rendered resolved core owner controls`;
    } else if (unresolved.length > 0) {
      contentDetail = `missing ${unresolved.join(", ")}`;
    } else {
      contentDetail = "empty or unresolved response";
    }
    checks.push({
      id: expectation.id,
      status: resolved.ok ? "pass" : "fail",
      detail: contentDetail,
    });
  }

  const sourcePages = renderedPagesByPath.get("/sources") ?? [htmlByPath.get("/sources") ?? ""];
  const sourceRows = renderedSourceRows(sourcePages);
  const sourceRowForConnector = (connector: Connector): RenderedSourceRow | null => {
    const routeId = connectorRouteId(connector);
    const label = connectorLabel(connector);
    // Prefer durable row identity. A label-only fallback is acceptable for
    // older renders, but it must still be scoped to one rendered row rather
    // than the page-wide text blob.
    if (routeId !== null) {
      return sourceRows.find((row) => row.id === routeId) ?? null;
    }
    return sourceRows.find((row) => row.label === label) ?? sourceRows.find((row) => row.text.includes(label)) ?? null;
  };
  const sourceRowsLookRendered =
    sourceRows.length > 0 || sourcePages.some((page) => renderedNextPageHref(page, base) !== null);
  const missingRenderedSourceRows = sourceRowsLookRendered
    ? connectors
        .filter((connector) => !connector.revoked_at)
        .filter((connector) => sourceRowForConnector(connector) === null)
        .map((connector) => ({ connector, label: connectorLabel(connector) }))
    : [];
  for (const missing of missingRenderedSourceRows) {
    findings.push({
      ruleId: "records-source-row-missing",
      class: "dashboard-data-claim",
      path: "live:/sources",
      line: 0,
      excerpt: missing.label,
      rationale:
        "Every non-revoked connector returned by the reference summary must appear in the rendered Sources row set. A continuation link without its resolved rows is silent omission, not honest pagination.",
    });
  }
  const recordsCountFindings: Finding[] = [];
  let checkedSourceCounts = 0;
  for (const connector of connectors) {
    if (connector.revoked_at) {
      continue;
    }
    const label = connectorLabel(connector);
    const row = sourceRowForConnector(connector);
    if (!row) {
      continue;
    }
    const expectedCountPhrase = sourceCountPhrase(connector);
    if (!expectedCountPhrase) {
      continue;
    }
    checkedSourceCounts += 1;
    if (!row.text.includes(expectedCountPhrase)) {
      const finding = {
        ruleId: "records-source-count-mismatch",
        class: "dashboard-data-claim",
        path: "live:/sources",
        line: 0,
        excerpt: `${label} expected ${expectedCountPhrase}`,
        rationale:
          "The Sources page must render source record and stream counts that match the reference connector summary. Wrong visible counts break the owner's ability to know what data they have.",
      };
      recordsCountFindings.push(finding);
      findings.push(finding);
    }
  }
  if (
    connectors.length > 0 &&
    sourceRows.length > 0 &&
    checkedSourceCounts === 0 &&
    BSOURCES_PATTERN.test(domVisibleText(parseResolvedDom(sourcePages.join("\n"))))
  ) {
    const finding = {
      ruleId: "records-source-counts-missing",
      class: "dashboard-data-claim",
      path: "live:/sources",
      line: 0,
      excerpt: "no configured source labels with counts found",
      rationale:
        "The Sources page looked like the owner source list but none of the configured source labels from the reference summary appeared with counts. The owner cannot verify what data they have.",
    };
    recordsCountFindings.push(finding);
    findings.push(finding);
  }
  checks.push({
    id: "records-counts-match-reality",
    status: recordsCountFindings.length > 0 || missingRenderedSourceRows.length > 0 ? "fail" : "pass",
    detail:
      checkedSourceCounts === 0
        ? "no rendered configured source count claims to compare"
        : `${checkedSourceCounts} rendered source count claim(s) matched /_ref/connectors`,
  });

  const renderedSourcePageCount = sourcePages.length;
  const renderedDashboardPageCount = (renderedPagesByPath.get("/") ?? [dashboardHtml]).length;
  const renderedPaginationMissing =
    connectorsPaged.pageCount > renderedDashboardPageCount || connectorsPaged.pageCount > renderedSourcePageCount;
  checks.push({
    id: "rendered-pagination-complete",
    status: renderedPaginationMissing ? "fail" : "pass",
    detail: `${renderedDashboardPageCount} dashboard page(s), ${renderedSourcePageCount} source page(s) rendered; JSON page-follow consumed ${connectorsPaged.pageCount} page(s) for ${connectors.length} connector row(s)`,
  });

  const nextActionFindings: Finding[] = [];
  const nextActionConnectors = connectors
    .filter((connector) => !connector?.revoked_at)
    .map((connector) => {
      const verdict = renderedVerdict(connector);
      const actions = ownerSatisfiableActions(verdict);
      const textCandidates = actions.flatMap(nextStepTextCandidates);
      return {
        actions,
        connector,
        label: connectorLabel(connector),
        routeId: connectorRouteId(connector),
        textCandidates,
        verdict,
      };
    })
    .filter((entry) => entry.routeId && entry.textCandidates.length > 0);

  for (const entry of nextActionConnectors) {
    if (entry.verdict?.channel === "attention") {
      const dashboardRow = renderedDashboardRows(dashboardHtml).find((row) => row.text.includes(entry.label));
      const action = entry.actions[0] ?? null;
      const expectedDashboardLabel = action?.cta ? `${entry.label}: ${action.cta}` : null;
      const dashboardAction = expectedDashboardLabel
        ? dashboardRow?.anchors.find((anchor) => anchor.text === expectedDashboardLabel)
        : null;
      const dashboardHasAction = Boolean(
        dashboardAction &&
          hrefPath(dashboardAction.href, base) === `/sources/${encodeURIComponent(entry.routeId ?? "")}`
      );
      if (!dashboardHasAction) {
        const finding = {
          ruleId: "dashboard-next-action-missing",
          class: "source-next-action",
          path: "live:/",
          line: 0,
          excerpt: `${entry.label}: ${entry.textCandidates[0]}`,
          rationale:
            "When the reference connector summary says an owner-satisfiable attention action exists, the dashboard must point the owner to that exact source and next step instead of leaving the action discoverable only by spelunking.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
      }
    }

    const path = `/sources/${encodeURIComponent(entry.routeId ?? "")}`;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential live HTTP probe against a real origin — avoids hammering the server and keeps findings deterministically ordered.
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const { status } = res;
      const html = await res.text();
      surfaceStatusByPath.set(path, status);
      htmlByPath.set(path, html);
      const action = entry.actions[0] ?? null;
      const requiredText = [{ label: "source detail label", pattern: new RegExp(escapeRegExp(entry.label), "i") }];
      const resolved = inspectResolvedOwnerSurface({ html, path, requiredText, status });
      if (!resolved.ok) {
        const finding = {
          ruleId: "source-next-action-detail-not-reached",
          class: "source-next-action",
          path: `live:${path}`,
          line: 0,
          excerpt: [...resolved.missing, ...resolved.skeletonMarkers].join(", ") || `status ${status}`,
          rationale:
            "The live probe could not reach the exact source detail route for an owner-satisfiable action. The owner cannot know what to do next if the action destination does not render.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
        continue;
      }
      const actionLabel = typeof action?.cta === "string" ? action.cta : (entry.textCandidates[0] ?? "");
      const exactActionNodes = exactVisibleActionNodes(html, actionLabel);
      const remediation = action?.remediation as Connector | undefined;
      const remediationTarget = remediation?.target;
      const localDevice =
        remediationTarget !== null &&
        typeof remediationTarget === "object" &&
        (remediationTarget as Connector).kind === "local_device";
      const routeAction = action?.kind === "reauth" || (action?.kind === "add_info" && !localDevice);
      const detailActionNode = localDevice
        ? visibleDomElements(parseResolvedDom(html)).find((node) => domVisibleText(node).startsWith(actionLabel))
        : exactActionNodes.find((node) => node.tag === "a");
      const detailHasAction = Boolean(detailActionNode);
      const actionHrefIsCorrect =
        !routeAction ||
        (detailActionNode?.tag === "a" &&
          expectedActionHrefMatches(action ?? {}, detailActionNode.attrs.href ?? "", base, entry.routeId ?? ""));
      if (!(detailHasAction && actionHrefIsCorrect)) {
        const finding = {
          ruleId:
            routeAction && detailHasAction ? "source-next-action-cta-href-invalid" : "source-next-action-copy-missing",
          class: "source-next-action",
          path: `live:${path}`,
          line: 0,
          excerpt: `${entry.label}: ${entry.textCandidates[0]}`,
          rationale: routeAction
            ? "The exact sanctioned owner CTA must be a visible anchor to the server-declared setup or sync target. A generic button, wrong href, or hidden label makes the next step unverifiable."
            : "The exact source detail route must render the owner-facing action from the reference verdict. A hidden or missing action breaks the owner's ability to decide the next step.",
        };
        nextActionFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      const finding = {
        ruleId: "source-next-action-detail-fetch-failed",
        class: "source-next-action",
        path: `live:${path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live probe could not fetch the exact source detail route for an owner-satisfiable action. The owner next-step check is inconclusive until the route is observable.",
      };
      nextActionFindings.push(finding);
      findings.push(finding);
    }
  }

  checks.push({
    id: "whats-next-actionable",
    status: nextActionFindings.length > 0 ? "fail" : "pass",
    detail:
      nextActionConnectors.length === 0
        ? "no server-declared owner next-step conditions to probe"
        : `${nextActionConnectors.length} server-declared owner action route(s) rendered their exact next step`,
  });

  const singleTokenDenialCodes = new Set([
    "blocked",
    "captcha",
    "consumed",
    "denied",
    "disabled",
    "expired",
    "forbidden",
    "revoked",
    "unauthorized",
    "unknown",
  ]);
  const rawDenialReasonCandidate = dashboardText.match(TURNED_AWAY_PATTERN)?.[1]?.toLowerCase() ?? null;
  const rawDenialReason =
    rawDenialReasonCandidate &&
    (rawDenialReasonCandidate.includes("_") || singleTokenDenialCodes.has(rawDenialReasonCandidate))
      ? rawDenialReasonCandidate
      : null;
  if (rawDenialReason) {
    findings.push({
      ruleId: "dashboard-raw-denial-reason",
      class: "dashboard-trust-claim",
      path: "live:/",
      line: 0,
      excerpt: rawDenialReason,
      rationale:
        "The dashboard's recent-read summary must not render raw diagnostic denial reason codes. Overview copy should explain the denial in owner language and leave exact codes to trace detail surfaces.",
    });
  }
  checks.push({
    id: "dashboard-denial-reasons-humanized",
    status: rawDenialReason ? "fail" : "pass",
    detail: rawDenialReason ? `raw denial reason visible: ${rawDenialReason}` : "no raw denial reason visible",
  });

  const recoveryRouteIds = Array.from(
    new Set(
      connectors
        .filter(shouldProbeSourceDetailRecoveryCopy)
        .map(connectorRouteId)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );
  const rawRecoveryTermFindings: Finding[] = [];
  for (const routeId of recoveryRouteIds) {
    try {
      const path = `/sources/${encodeURIComponent(routeId ?? "")}`;
      // biome-ignore lint/performance/noAwaitInLoops: sequential live HTTP probe against a real origin — avoids hammering the server and keeps findings deterministically ordered.
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const { status } = res;
      const html = await res.text();
      surfaceStatusByPath.set(path, status);
      htmlByPath.set(path, html);
      const resolved = inspectResolvedOwnerSurface({
        html,
        path,
        requiredText: [{ label: "source recovery content", pattern: SOURCE_DETAIL_CONTENT_PATTERN }],
        status,
      });
      if (!resolved.ok) {
        findings.push({
          ruleId: "source-detail-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${path}`,
          line: 0,
          excerpt: [...resolved.missing, ...resolved.skeletonMarkers].join(", ") || `status ${status}`,
          rationale:
            "The live semantic probe could not reach a source recovery detail page. Owner recovery copy is inconclusive until the exact source route renders.",
        });
        continue;
      }
      const detailText = domVisibleText(parseResolvedDom(html));
      const rawRecoveryTerm = detailText.match(BDEAD_LETTER_PATTERN)?.[0] ?? null;
      if (rawRecoveryTerm) {
        const finding = {
          ruleId: "source-detail-raw-recovery-jargon",
          class: "source-recovery-copy",
          path: `live:${path}`,
          line: 0,
          excerpt: rawRecoveryTerm,
          rationale:
            "Owner-facing recovery copy must not use durable-outbox jargon such as dead-letter. Use owner-language like failed uploads while preserving exact technical terms only in commands or engineering traces.",
        };
        rawRecoveryTermFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      findings.push({
        ruleId: "source-detail-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:/sources/${routeId}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live semantic probe could not fetch a source recovery detail page. Owner recovery copy is inconclusive until the exact source route renders.",
      });
    }
  }
  let recoveryDetail: string;
  if (recoveryRouteIds.length === 0) {
    recoveryDetail = "no source recovery detail routes to probe";
  } else if (rawRecoveryTermFindings.length > 0) {
    recoveryDetail = `${rawRecoveryTermFindings.length} detail page(s) render raw recovery jargon`;
  } else {
    recoveryDetail = `${recoveryRouteIds.length} source recovery detail route(s) render human recovery copy`;
  }
  checks.push({
    id: "source-detail-recovery-copy-humanized",
    status: rawRecoveryTermFindings.length > 0 ? "fail" : "pass",
    detail: recoveryDetail,
  });

  const runGapRouteIds = Array.from(
    new Set(
      connectors
        .filter(shouldProbeSourceDetailRunGapHonesty)
        .map(connectorRouteId)
        .filter((id) => typeof id === "string" && id.length > 0)
    )
  );
  const runGapFindings: Finding[] = [];
  for (const routeId of runGapRouteIds) {
    try {
      const path = `/sources/${encodeURIComponent(routeId ?? "")}`;
      // biome-ignore lint/performance/noAwaitInLoops: sequential live HTTP probe against a real origin — avoids hammering the server and keeps findings deterministically ordered.
      const res = await fetchImpl(`${base}${path}`, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const { status } = res;
      const html = await res.text();
      surfaceStatusByPath.set(path, status);
      htmlByPath.set(path, html);
      const resolved = inspectResolvedOwnerSurface({
        html,
        path,
        requiredText: [{ label: "source run content", pattern: SOURCE_DETAIL_CONTENT_PATTERN }],
        status,
      });
      if (!resolved.ok) {
        findings.push({
          ruleId: "source-detail-run-gap-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${path}`,
          line: 0,
          excerpt: [...resolved.missing, ...resolved.skeletonMarkers].join(", ") || `status ${status}`,
          rationale:
            "The live semantic probe could not reach a source detail page that has a successful latest run with unresolved collection gaps. Run-status honesty is inconclusive until the exact source route renders.",
        });
        continue;
      }
      const detailText = domVisibleText(parseResolvedDom(html));
      const cleanSuccessClaim = detailText.match(FAILURES_OPEN_RUNS_PATTERN)?.[0] ?? null;
      const rendersGapStatus = BWITH_GAPS_PATTERN.test(detailText) || BPARTIAL_PATTERN.test(detailText);
      if (cleanSuccessClaim || !rendersGapStatus) {
        const finding = {
          ruleId: "source-detail-clean-success-with-open-gaps",
          class: "source-run-honesty",
          path: `live:${path}`,
          line: 0,
          excerpt: cleanSuccessClaim ?? "missing partial/with gaps status",
          rationale:
            "A source detail page whose latest successful run has unresolved collection gaps must not render as a clean success. It must show a partial/with-gaps status so the owner can trust the run summary.",
        };
        runGapFindings.push(finding);
        findings.push(finding);
      }
    } catch (err) {
      findings.push({
        ruleId: "source-detail-run-gap-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:/sources/${routeId}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live semantic probe could not fetch a source detail page with unresolved collection gaps. Run-status honesty is inconclusive until the exact source route renders.",
      });
    }
  }
  let runGapDetail: string;
  if (runGapRouteIds.length === 0) {
    runGapDetail = "no successful source runs with unresolved gaps to probe";
  } else if (runGapFindings.length > 0) {
    runGapDetail = `${runGapFindings.length} detail page(s) render clean success despite open gaps`;
  } else {
    runGapDetail = `${runGapRouteIds.length} source detail route(s) render partial/with-gaps status`;
  }
  checks.push({
    id: "source-detail-run-gap-honesty",
    status: runGapFindings.length > 0 ? "fail" : "pass",
    detail: runGapDetail,
  });
  return { findings, checks };
}

interface LiveSurfaceResult {
  bytes?: number;
  error?: string;
  findingCount?: number;
  path: string;
  reachedOwnerSurface: boolean;
  status: number | null;
  tier: string;
}

/**
 * Fetch and scan the live owner surfaces. Network and auth failures are captured
 * as surface-level errors, not thrown, so the harness can still emit a report.
 *
 * @param args.origin   e.g. https://pdpp.example.com (no trailing slash required)
 * @param [args.env]    defaults to process.env
 * @param [args.fetchImpl] injectable for tests; defaults to global fetch
 */
export async function runLiveAcceptance({
  origin,
  env = process.env,
  fetchImpl = fetch,
}: {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchImpl;
  origin: string;
}): Promise<{
  authMode: string;
  findings: Finding[];
  mutationChecks: { detail: string; status: string };
  ok: boolean;
  origin: string;
  semanticChecks: { detail: string; id: string; status: string }[];
  surfaces: LiveSurfaceResult[];
}> {
  const base = origin.replace(TRAILING_SLASHES_PATTERN, "");
  const {
    header,
    mode,
    error: authError,
  } = (await resolveOwnerAuthForLive({ base, env, fetchImpl })) as {
    error: string | null;
    header: Record<string, string>;
    mode: string;
  };
  const findings: Finding[] = [];
  const surfaces: LiveSurfaceResult[] = [];
  const htmlByPath = new Map<string, string>();
  const surfaceStatusByPath = new Map<string, number>();
  const renderedPagesByPath = new Map<string, readonly string[]>();

  if (authError) {
    findings.push({
      ruleId: "live-owner-auth-failed",
      class: "live-probe-inconclusive",
      path: "live:owner-auth",
      line: 0,
      excerpt: authError,
      rationale:
        "The live acceptance gate must inspect authenticated owner renders. Login/auth failure makes the live probe inconclusive, not passing.",
    });
  }

  if (mode === "none") {
    findings.push({
      ruleId: "live-owner-auth-required",
      class: "live-probe-inconclusive",
      path: "live:owner-auth",
      line: 0,
      excerpt: "no owner session supplied",
      rationale:
        "Resolved DOM acceptance requires an authenticated owner session. Anonymous HTML, even when it returns HTTP 200, cannot prove any owner surface or detail route.",
    });
  }

  const authenticated = mode !== "none" && !authError;

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this helper keeps one authenticated fetch, resolved-DOM check, and finding record together for each declared surface.
  const fetchSurface = async (surface: { path: string; tier: string }): Promise<string | null> => {
    const url = `${base}${surface.path}`;
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "text/html", ...header },
        redirect: "manual",
      });
      const { status } = res;
      const html = await res.text();
      surfaceStatusByPath.set(surface.path, status);
      const resolved = authenticated
        ? inspectResolvedOwnerSurface({ html, path: surface.path, status })
        : { ok: false, missing: [], skeletonMarkers: [] };
      const ownerResponse = authenticated && status >= 200 && status < 300;
      const reachedOwnerSurface = ownerResponse && resolved.ok;
      const surfaceFindings = ownerResponse
        ? scanForbiddenStrings({
            path: `live:${surface.path}`,
            src: html,
            tier: surface.tier,
            rules: FORBIDDEN_STRING_RULES,
          }).map((finding) => ({ ...finding, live: true, line: finding.line || lineOf(html, 0) }))
        : [];
      findings.push(...surfaceFindings);
      if (ownerResponse) {
        htmlByPath.set(surface.path, html);
        renderedPagesByPath.set(surface.path, [html]);
      }
      if (!reachedOwnerSurface) {
        findings.push({
          ruleId: "live-owner-surface-not-reached",
          class: "live-probe-inconclusive",
          path: `live:${surface.path}`,
          line: 0,
          excerpt: authenticated
            ? [...resolved.missing, ...resolved.skeletonMarkers].join(", ") || `status ${status}`
            : "authenticated owner session required",
          rationale:
            "The live probe must observe an authenticated, resolved owner DOM for every declared surface. A login redirect, anonymous 200 shell, 401, 404, or server error cannot prove the rendered journey is clean.",
        });
      }
      surfaces.push({
        path: surface.path,
        tier: surface.tier,
        status,
        reachedOwnerSurface,
        bytes: html.length,
        findingCount: surfaceFindings.length,
      });
      return reachedOwnerSurface ? html : null;
    } catch (err) {
      surfaces.push({
        path: surface.path,
        tier: surface.tier,
        status: null,
        reachedOwnerSurface: false,
        error: err instanceof Error ? err.message : String(err),
      });
      findings.push({
        ruleId: "live-owner-surface-fetch-failed",
        class: "live-probe-inconclusive",
        path: `live:${surface.path}`,
        line: 0,
        excerpt: err instanceof Error ? err.message : String(err),
        rationale:
          "The live probe could not fetch the owner surface. Network or runtime failures are acceptance failures until the authenticated rendered journey is observed.",
      });
      return null;
    }
  };

  for (const surface of LIVE_SURFACES) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential live HTTP probe avoids hammering the origin and keeps findings ordered.
    await fetchSurface(surface);
  }

  const setupSurfaces = authenticated ? declaredSetupSurfaces(htmlByPath.get("/sources/add") ?? "") : [];
  for (const surface of setupSurfaces) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential live HTTP probe avoids hammering the origin and keeps findings ordered.
    await fetchSurface(surface);
  }

  if (authenticated) {
    for (const path of ["/", "/sources"] as const) {
      const html = htmlByPath.get(path);
      if (!html) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each continuation page depends on the previous rendered next link.
      const pages = await fetchRenderedContinuationPages({
        base,
        findings,
        fetchImpl,
        header,
        html,
        htmlByPath,
        path,
        statusByPath: surfaceStatusByPath,
        surfaces,
      });
      renderedPagesByPath.set(path, pages);
      htmlByPath.set(path, pages.join("\n"));
    }
  }

  const semantic = await runLiveSemanticChecks({
    base,
    fetchImpl,
    header,
    htmlByPath,
    renderedPagesByPath,
    setupSurfaces,
    surfaceStatusByPath,
  });
  const grantCaptions = runLiveGrantCaptionChecks({ htmlByPath });
  findings.push(...semantic.findings);
  findings.push(...grantCaptions.findings);

  return {
    origin: base,
    authMode: mode,
    surfaces,
    mutationChecks: {
      detail: "not run against live owner data; use the disposable/local mutation authority separately",
      status: "not-run",
    },
    semanticChecks: [...semantic.checks, ...grantCaptions.checks],
    findings,
    ok: findings.length === 0,
  };
}
