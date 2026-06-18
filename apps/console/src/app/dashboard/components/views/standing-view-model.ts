/**
 * Standing (Overview) view-model — pure mapping from the REAL dashboard data
 * shapes to the calm, person-first "Standing" presentation.
 *
 * This module holds NO React and NO data fetching — only typed functions that
 * turn `DatasetSummary` / `OwnerIssuedClient` / `GrantSummary` / `TraceSummary`
 * / `PendingApproval` / attention counts into the small, honest view objects
 * the `StandingOverview` component renders. Keeping it pure makes the hero-tone
 * logic and the scope→human lexicon unit-testable without a browser.
 *
 * Design source: docs/design/ink-carbon/project/recordroom/rr-overview.jsx.
 * The design used fictional fixtures; here every field binds to a real shape.
 */

import type {
  DatasetSummary,
  GrantSummary,
  OwnerIssuedClient,
  PendingApproval,
  RefConnectorSummary,
  RunSummary,
  TraceSummary,
} from "../../lib/ref-client.ts";

// ─── Plain-language lexicon: scope/stream → what it means to a person ──
//
// HONESTY RULE (from the task contract): there is no owner profile identity to
// read, and grant summaries do not carry a full scope string — they carry
// `kinds[]` (event kinds) + `connector_id`. So we humanize at the STREAM level:
// a known stream maps to a warm phrase ("your pay"); an unknown stream falls
// back to its own prettified name. We never invent a meaning we can't justify.

const SCOPE_HUMAN: Record<string, string> = {
  pay_statements: "your pay",
  paystubs: "your pay",
  income: "your pay",
  employment: "your employment history",
  listening_history: "what you listen to",
  watch_history: "what you watch",
  transactions: "your spending",
  current_activity: "your spending",
  statements: "your statements",
  tax_docs: "your tax documents",
  tax_documents: "your tax documents",
  browsing: "your browsing",
  browser_history: "your browsing",
  messages: "your messages",
  conversations: "your conversations",
  emails: "your email",
  orders: "your orders",
  purchases: "your purchases",
  health: "your health records",
  location: "where you've been",
  "consent.approved": "grant decisions",
  "disclosure.served": "data disclosures",
  "query.received": "read requests",
  "query.rejected": "rejected reads",
  "token.issued": "token activity",
};

const READ_SUFFIX_RE = /\.read$/;
const STREAM_PREFIX_RE = /^[a-z0-9-]+:/;
const UNDERSCORE_RE = /_/g;

/**
 * Humanize one scope/stream identifier. Strips a `.read` suffix and any
 * `connector:` prefix, looks up the warm phrase, and — when there is no honest
 * mapping — returns the identifier with underscores spaced out. The caller
 * always gets readable text; we never show a raw `pay_statements.read`.
 */
export function scopeHuman(name: string): string {
  const bare = name.replace(READ_SUFFIX_RE, "").replace(STREAM_PREFIX_RE, "");
  const known = SCOPE_HUMAN[bare];
  if (known) {
    return known;
  }
  return bare.replace(UNDERSCORE_RE, " ").trim() || name;
}

/** Oxford-comma join of human phrases: "a", "a and b", "a, b, and c". */
export function joinHuman(parts: readonly string[]): string {
  const list = parts.filter(Boolean);
  if (list.length <= 1) {
    return list[0] ?? "";
  }
  if (list.length === 2) {
    return `${list[0]} and ${list[1]}`;
  }
  return `${list.slice(0, -1).join(", ")}, and ${list.at(-1)}`;
}

const STREAM_RECORD_NOUN: Record<string, string> = {
  pay_statements: "pay records",
  employment: "employment records",
  listening_history: "listening records",
  tax_docs: "tax records",
  transactions: "transactions",
  current_activity: "transactions",
  messages: "messages",
  emails: "emails",
  orders: "orders",
};

/** "transactions" / "pay records" — the plural noun for a stream of records. */
export function recordNoun(stream: string): string {
  const bare = stream.replace(STREAM_PREFIX_RE, "");
  return STREAM_RECORD_NOUN[bare] ?? `${bare.replace(UNDERSCORE_RE, " ").trim()} records`;
}

// ─── View objects ─────────────────────────────────────────────────────

export type HeroTone = "calm" | "decide" | "alarm";

export interface StandingHero {
  /** Optional CTA: label + href to the place that resolves the state. */
  cta?: { href: string; label: string; human?: boolean };
  /** Eyebrow line above the truth. */
  kicker: string;
  /** The one truth. May contain a single emphasized run (rendered <em>). */
  line: { text: string; emphasis?: string; tail?: string };
  /** The reassuring/explaining sub-line. */
  sub: string;
  tone: HeroTone;
}

export interface BearerView {
  clientId: string;
  /** "owner token · MCP · created 2026-06-09" — protocol meta line. */
  how: string;
  /** href to the deployment/tokens revoke surface. */
  revokeHref: string;
  who: string;
}

export interface RelationshipView {
  actionHref: string;
  actionLabel: string;
  clientId: string;
  /** "reads only your pay and your spending" — humanized scope summary. */
  reads: string;
  status: GrantEndorseStatus;
  /** "last active today · 3 grants" — meta line. */
  terms: string;
  who: string;
}

export type GrantEndorseStatus = "active" | "continuous" | "expiring" | "revoked" | "denied";

export interface LatelyView {
  deny: boolean;
  id: string;
  /** "Claude Desktop read 412 transactions" or deny copy. */
  text: { who: string; rest: string };
  when: string;
}

export interface AttentionRowView {
  href: string;
  id: string;
  what: string;
  why: string;
}

export interface StandingData {
  attention: AttentionRowView[];
  bearers: BearerView[];
  hero: StandingHero;
  lately: LatelyView[];
  relationships: RelationshipView[];
  sourceIssues: AttentionRowView[];
}

// ─── Inputs ────────────────────────────────────────────────────────────

export interface StandingInputs {
  /**
   * Connections the owner genuinely needs to act on, derived from the rendered
   * verdict attention channel (the SAME source `/runs` uses). This — not failed
   * runs/traces — drives the hero alarm, its count, its CTA, and the "anything
   * wrong" list, so all four agree with `/runs`.
   */
  attentionConnections: AttentionConnection[];
  bearerClients: OwnerIssuedClient[];
  failedRuns: RunSummary[];
  failedTraces: TraceSummary[];
  grants: GrantSummary[];
  /** href builders (bound to dashboardRoutes by the page). */
  hrefs: StandingHrefs;
  /** Relative-time formatter (injected so the view-model stays clock-pure). */
  now: Date;
  pendingApprovals: PendingApproval[];
  /**
   * Connections with material source issues that do NOT ask the owner to do
   * anything. These must still suppress "everything is syncing" all-clears.
   */
  sourceIssues: SourceIssueConnection[];
  summary: DatasetSummary | null;
  traces: TraceSummary[];
}

export interface StandingHrefs {
  /** Per-connection recovery destination — the connection detail page that
   *  carries the focused recovery panel. NOT /traces (an audit log). */
  connection: (connectorKey: string) => string;
  deployment: string;
  deploymentTokens: string;
  grant: (id: string) => string;
  grants: string;
  run: (id: string) => string;
  /** The syncs/runs list — the triage destination when several connections need the owner. */
  runs: string;
  trace: (id: string) => string;
  traces: string;
}

/**
 * A connection the owner genuinely needs to act on — the SINGLE source of
 * attention truth shared by the dashboard hero and `/runs`. Derived from the
 * rendered verdict's attention channel (an owner-satisfiable required action),
 * NOT from failed runs/traces. See {@link attentionConnectionsFromConnectors}.
 */
export interface AttentionConnection {
  /** The owner-resolvable action label (the CTA verb). */
  actionLabel: string;
  /** Owner-facing connector type, for the human label ("Chase needs you"). */
  connectorKey: string;
  /**
   * True when the action is a DEVICE-LOCAL recovery — the owner runs commands on
   * the host that holds the data; the dashboard cannot perform it. The CTA then
   * only NAVIGATES to where the commands are shown, so its label must read as
   * navigation ("See what to do"), never restate the action as if a click runs
   * it (which sends the owner in a circle).
   */
  deviceLocal: boolean;
  /**
   * The records-route id that resolves to THIS exact connection — the
   * connection identity (`connector_instance_id ?? connection_id`), NOT the
   * connector type. Routing by connector type lands on whichever connection
   * of that type is first, which is wrong when several accounts/devices share
   * a type (e.g. three Claude Code devices: only peregrine is in attention).
   */
  routeId: string;
  /** Owner-facing "what's wrong" line, from the verdict's forward statement. */
  what: string;
}

export interface SourceIssueConnection {
  /** Owner-facing source name ("Chase", "Gmail - work"). */
  label: string;
  routeId: string;
  /** Source-state label derived from the server-owned verdict pill. */
  status: "can't collect" | "is degraded";
  /** Owner-facing "what's wrong" line, from the verdict's forward statement. */
  what: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Compact, calm relative time: "today", "yesterday", "3 days ago", date. */
export function relDay(iso: string | null, now: Date): string {
  if (!iso) {
    return "—";
  }
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) {
    return "—";
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfThen = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const days = Math.round((startOfToday - startOfThen) / DAY_MS);
  if (days <= 0) {
    return "today";
  }
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return t.toISOString().slice(0, 10);
}

/** Compact integer formatting: 48120 → "48,120". */
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * Grant decision vocab → an Endorse status. Per the task contract:
 * succeeded | issued | approved | active → active.
 */
export function grantEndorseStatus(status: string): GrantEndorseStatus {
  const s = status.toLowerCase();
  if (s === "revoked") {
    return "revoked";
  }
  if (s === "denied" || s === "failed" || s === "rejected") {
    return "denied";
  }
  if (s === "expiring") {
    return "expiring";
  }
  if (s === "continuous" || s === "indefinite") {
    return "continuous";
  }
  // succeeded | issued | approved | active | anything else live → active
  return "active";
}

const REVOKED_STATES = new Set(["revoked", "denied", "rejected", "expired"]);

function isLiveGrant(g: GrantSummary): boolean {
  return !REVOKED_STATES.has(g.status.toLowerCase());
}

/**
 * Humanize the slices a grant can read. Grant summaries don't carry a full
 * scope list; we derive readable phrases from the grant's `kinds[]` and
 * `connector_id`. We strip protocol noise (`grant.*`, `read`, `trace.*`) and
 * humanize what's left; if nothing survives, we fall back to the connector
 * name, and finally to a calm generic phrase. Always honest — never invented.
 */
const PROTOCOL_KIND_PREFIX_RE = /^(grant|trace|run|event)\./;
const PROTOCOL_KIND_WORDS = new Set(["read", "issued", "approved", "revoked", "denied"]);

export function grantReads(g: GrantSummary): string {
  const phrases = grantReadPhrases(g);
  if (phrases.length > 0) {
    return `reads only ${joinHuman(phrases)}`;
  }
  return "reads a scoped slice of your data";
}

function grantReadPhrases(g: GrantSummary): string[] {
  const meaningfulKinds = g.kinds
    .map((k) => k.replace(PROTOCOL_KIND_PREFIX_RE, ""))
    .filter((k) => k && !PROTOCOL_KIND_WORDS.has(k));
  const phrases = Array.from(new Set(meaningfulKinds.map(scopeHuman))).filter(Boolean);
  if (phrases.length > 0) {
    return phrases;
  }
  return g.connector_id ? [scopeHuman(g.connector_id)] : [];
}

/** Humanize the streams a pending approval previews. */
function approvalReads(a: PendingApproval): string {
  const streams = (a.grant_preview?.streams ?? [])
    .map((s) => (typeof s === "string" ? s : (s.name ?? "")))
    .filter(Boolean);
  const phrases = Array.from(new Set(streams.map(scopeHuman)));
  if (phrases.length > 0) {
    return joinHuman(phrases);
  }
  return "parts of your data";
}

function clientLabel(name: string | null, clientId: string): string {
  return name?.trim() || clientId;
}

// ─── Bearer view ("what can act as you") ──────────────────────────────────

function activeBearerClients(clients: readonly OwnerIssuedClient[]): OwnerIssuedClient[] {
  return clients.filter((c) => c.active_token_count > 0);
}

function activeOwnerTokenCount(clients: readonly OwnerIssuedClient[]): number {
  return clients.reduce((sum, c) => sum + Math.max(0, c.active_token_count), 0);
}

function toBearers(clients: OwnerIssuedClient[], hrefs: StandingHrefs, now: Date): BearerView[] {
  return activeBearerClients(clients).map((c) => {
    const count = c.active_token_count;
    const tokenWord = count === 1 ? "token" : "tokens";
    return {
      clientId: c.client_id,
      who: clientLabel(c.client_name, c.client_id),
      how: `owner token · ${count} active ${tokenWord} · issued ${relDay(c.created_at, now)}`,
      revokeHref: hrefs.deploymentTokens,
    };
  });
}

// ─── Relationships view ("who can read parts of you") ────────────────────

function newerIso(a: string | null, b: string | null): string | null {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function clientNamesById(clients: readonly OwnerIssuedClient[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const client of clients) {
    const name = client.client_name?.trim();
    if (name) {
      out.set(client.client_id, name);
    }
  }
  return out;
}

function toRelationships(
  grants: GrantSummary[],
  hrefs: StandingHrefs,
  now: Date,
  knownClientNames: ReadonlyMap<string, string> = new Map()
): RelationshipView[] {
  const groups = new Map<
    string,
    {
      clientId: string;
      grantIds: string[];
      lastAt: string | null;
      phrases: Set<string>;
      statuses: GrantEndorseStatus[];
      who: string;
    }
  >();
  for (const grant of grants.filter(isLiveGrant)) {
    const clientId = grant.client_id || grant.grant_id;
    const grantClientName = grant.client?.client_name?.trim() || null;
    const knownClientName = grant.client_id ? (knownClientNames.get(grant.client_id) ?? null) : null;
    const existing =
      groups.get(clientId) ??
      {
        clientId,
        grantIds: [],
        lastAt: null,
        phrases: new Set<string>(),
        statuses: [],
        who: clientLabel(grantClientName ?? knownClientName ?? grant.client_id, grant.grant_id),
      };
    existing.grantIds.push(grant.grant_id);
    existing.lastAt = newerIso(existing.lastAt, grant.last_at);
    for (const phrase of grantReadPhrases(grant)) {
      existing.phrases.add(phrase);
    }
    existing.statuses.push(grantEndorseStatus(grant.status));
    groups.set(clientId, existing);
  }

  return Array.from(groups.values()).map((group) => {
    const grantCount = group.grantIds.length;
    const grantWord = grantCount === 1 ? "grant" : "grants";
    const status = group.statuses.includes("expiring") ? "expiring" : (group.statuses[0] ?? "active");
    return {
      actionHref: grantCount === 1 ? hrefs.grant(group.grantIds[0] ?? "") : hrefs.grants,
      actionLabel: "review",
      clientId: group.clientId,
      reads: group.phrases.size > 0 ? `reads only ${joinHuman(Array.from(group.phrases))}` : "reads a scoped slice of your data",
      status,
      terms: `last active ${relDay(group.lastAt, now)} · ${grantCount} ${grantWord}`,
      who: group.who,
    };
  });
}

// ─── Lately view ("what's been read") ────────────────────────────────────

function denyReason(reason: string | null): string {
  if (!reason) {
    return "it wasn't allowed";
  }
  const r = reason.toLowerCase();
  if (r.includes("scope")) {
    return "you never allowed it";
  }
  if (r.includes("revoked")) {
    return "you'd revoked it";
  }
  if (r.includes("expired")) {
    return "the grant had expired";
  }
  return reason;
}

function looksLikeTechnicalId(value: string | null | undefined): boolean {
  const v = value?.trim() ?? "";
  return /^(cli|grt|trc|run|req|cin|dsrc|dexp|ldt)_[A-Za-z0-9_-]+$/.test(v);
}

function traceActorFallback(trace: TraceSummary): string {
  const actorType = trace.actor_type?.trim().toLowerCase() ?? "";
  if (actorType === "subject" || actorType === "owner") {
    return "You";
  }
  if (actorType === "client") {
    return "An app";
  }
  const actorId = trace.actor_id?.trim() ?? "";
  if (actorId && !looksLikeTechnicalId(actorId) && actorId !== "owner_local") {
    return actorId;
  }
  if (actorType === "runtime" || actorType === "system") {
    return "The server";
  }
  return "Someone";
}

function traceWho(trace: TraceSummary): string {
  const traceClientName = trace.client?.client_name?.trim() || null;
  if (traceClientName) {
    return traceClientName;
  }
  const clientId = trace.client_id?.trim() ?? "";
  if (clientId && !looksLikeTechnicalId(clientId)) {
    return clientId;
  }
  return traceActorFallback(trace);
}

function repeatedLatelyRest(rest: string, count: number): string {
  const base = rest.replace(/\.$/, "");
  return `${base} ${count === 2 ? "twice" : `${count} times`}.`;
}

function toLately(traces: TraceSummary[], now: Date): LatelyView[] {
  const groups: Array<LatelyView & { count: number; key: string; originalRest: string }> = [];
  for (const tr of traces.slice(0, 6)) {
    const who = traceWho(tr);
    const isDeny = tr.status.toLowerCase() === "denied" || tr.failure !== null;
    let row: LatelyView;
    if (isDeny) {
      row = {
        id: tr.trace_id,
        when: relDay(tr.last_at, now),
        deny: true,
        text: { who, rest: `tried to read — turned away, ${denyReason(tr.failure?.reason ?? null)}.` },
      };
    } else {
      const noun = tr.event_count === 1 ? "record" : "records";
      row = {
        id: tr.trace_id,
        when: relDay(tr.last_at, now),
        deny: false,
        text: { who, rest: `read ${fmtInt(tr.event_count)} ${noun}.` },
      };
    }
    const key = `${row.deny ? "deny" : "read"}|${row.when}|${row.text.who}|${row.text.rest}`;
    const existing = groups.find((group) => group.key === key);
    if (existing) {
      existing.count += 1;
      existing.id = `${existing.id}+${tr.trace_id}`;
      continue;
    }
    groups.push({ ...row, count: 1, key, originalRest: row.text.rest });
  }

  return groups.slice(0, 6).map(({ count, key: _key, originalRest, ...row }) => ({
    ...row,
    text: {
      ...row.text,
      rest: count > 1 ? repeatedLatelyRest(originalRest, count) : row.text.rest,
    },
  }));
}

// ─── Attention truth (shared with /runs) ──────────────────────────────────

/**
 * The SINGLE source of attention truth: connections whose rendered verdict is
 * on the `attention` channel with an owner-satisfiable required action. This is
 * the same predicate `/runs` uses, so the hero, its count, its CTA, and the
 * "anything wrong" list all agree with the syncs surface — no more counting
 * failed runs/traces (which surfaced healthy connections as "broken" and missed
 * the genuinely-attention ones). Revoked connections are excluded.
 */
export function attentionConnectionsFromConnectors(connectors: readonly RefConnectorSummary[]): AttentionConnection[] {
  const out: AttentionConnection[] = [];
  for (const connector of connectors) {
    if (connector.revoked_at) {
      continue; // revoked rows stay owner-visible but never alarm.
    }
    const verdict = connector.rendered_verdict;
    if (verdict?.channel !== "attention") {
      continue;
    }
    const action = ownerSatisfiableAction(verdict);
    if (!action) {
      continue; // attention with no owner-resolvable action is a synthesis error (S1) — never alarm the owner here.
    }
    out.push({
      connectorKey: connector.connector_id,
      routeId: connector.connector_instance_id ?? connector.connection_id,
      deviceLocal: action.remediation?.target.kind === "local_device",
      what: verdict.forward_statement,
      actionLabel: action.cta,
    });
  }
  return out;
}

function ownerSatisfiableAction(verdict: NonNullable<RefConnectorSummary["rendered_verdict"]>) {
  return verdict.required_actions.find((a) => a.audience === "owner" && a.satisfied_when.kind !== "none") ?? null;
}

function connectionRouteId(connector: RefConnectorSummary): string {
  return connector.connector_instance_id ?? connector.connection_id;
}

function connectorLabel(connector: RefConnectorSummary): string {
  return connector.display_name?.trim() || connector.connector_display_name?.trim() || scopeHuman(connector.connector_id);
}

function sourceIssueStatus(verdict: NonNullable<RefConnectorSummary["rendered_verdict"]>): SourceIssueConnection["status"] | null {
  if (verdict.pill.tone === "red" || verdict.pill.label === "Can't collect") {
    return "can't collect";
  }
  if (verdict.channel !== "calm" || verdict.pill.tone === "amber" || verdict.pill.label === "Degraded") {
    return "is degraded";
  }
  return null;
}

/**
 * Non-owner source issues for the dashboard "Anything wrong" panel. These are
 * deliberately NOT owner-action attention rows: a maintainer/code-fix source
 * should not alarm as "needs you", but it must also not disappear behind an
 * all-clear that claims everything is syncing.
 */
export function sourceIssueConnectionsFromConnectors(connectors: readonly RefConnectorSummary[]): SourceIssueConnection[] {
  const out: SourceIssueConnection[] = [];
  for (const connector of connectors) {
    if (connector.revoked_at) {
      continue;
    }
    const verdict = connector.rendered_verdict;
    if (!verdict) {
      continue;
    }
    if (verdict.channel === "attention" && ownerSatisfiableAction(verdict)) {
      continue;
    }
    const status = sourceIssueStatus(verdict);
    if (!status) {
      continue;
    }
    out.push({
      label: connectorLabel(connector),
      routeId: connectionRouteId(connector),
      status,
      what: verdict.forward_statement,
    });
  }
  return out;
}

// ─── Attention view ("anything wrong") ───────────────────────────────────

function toAttention(attention: AttentionConnection[], hrefs: StandingHrefs): AttentionRowView[] {
  return attention.map((a) => ({
    id: `connection:${a.routeId}`,
    what: `${scopeHuman(a.connectorKey)} needs you`,
    why: a.what,
    href: hrefs.connection(a.routeId),
  }));
}

function toSourceIssues(sourceIssues: SourceIssueConnection[], hrefs: StandingHrefs): AttentionRowView[] {
  return sourceIssues.map((issue) => ({
    id: `source-issue:${issue.routeId}`,
    what: `${issue.label} ${issue.status}`,
    why: issue.what,
    href: hrefs.connection(issue.routeId),
  }));
}

// ─── Hero tone (the one truth, computed from real state) ─────────────────

/** DECIDE — a request is waiting on the owner. */
function buildDecideHero(pending: PendingApproval[], hrefs: StandingHrefs): StandingHero {
  const first = pending[0];
  const more = pending.length - 1;
  const who = first ? clientLabel(first.client_id ?? null, first.approval_id) : "An app";
  const reads = first ? approvalReads(first) : "parts of your data";
  const moreSub = `Nothing leaves until you say so — review each request one at a time. ${more} more after this one.`;
  return {
    tone: "decide",
    kicker: pending.length === 1 ? "A request is waiting on you" : `${pending.length} requests are waiting`,
    line: { text: `${who} wants to read `, emphasis: reads, tail: "." },
    sub: more > 0 ? moreSub : "Nothing leaves until you say so — approve it one piece at a time.",
    cta: { label: "Review the request", href: hrefs.grants, human: true },
  };
}

/** ALARM — one or more connections need the owner. Derived from the attention
 *  truth, so the count, the line, and the CTA all name the SAME connections the
 *  "anything wrong" list and `/runs` show. The CTA lands on the focused recovery
 *  panel (single connection) or the syncs triage list (several) — never /traces. */
function buildFailureHero(attention: AttentionConnection[], hrefs: StandingHrefs): StandingHero {
  const count = attention.length;
  const [only] = attention;
  if (count === 1 && only) {
    return {
      tone: "alarm",
      kicker: "One thing needs you",
      line: { text: `${scopeHuman(only.connectorKey)} `, emphasis: "needs you", tail: "." },
      sub: only.what,
      // A device-local recovery is not performed by clicking — the CTA only
      // navigates to where the commands are. Use a navigation label ("See what
      // to do") so the owner doesn't click expecting the dashboard to run it.
      // A dashboard-actionable verdict (reauth, refresh) keeps its action verb.
      cta: {
        label: only.deviceLocal ? "See what to do" : only.actionLabel,
        href: hrefs.connection(only.routeId),
        human: true,
      },
    };
  }
  return {
    tone: "alarm",
    kicker: `${count} things need you`,
    line: { text: `${count} connections `, emphasis: "need a look", tail: "." },
    sub: "Nothing you already have is lost — open each one to see what it needs.",
    cta: { label: "See what needs you", href: hrefs.runs },
  };
}

/** ALARM — the summary projection is stale. */
function buildStaleHero(summary: DatasetSummary | null, hrefs: StandingHrefs): StandingHero {
  return {
    tone: "alarm",
    kicker: "Standing may be out of date",
    line: { text: "Your overview ", emphasis: "hasn't refreshed", tail: " recently." },
    sub:
      summary?.projection?.last_error ??
      "The summary projection is stale. The numbers below may lag until it rebuilds.",
    cta: { label: "Open deployment", href: hrefs.deployment },
  };
}

/** CALM — the reassurance moment. */
function buildCalmHero(input: StandingInputs): StandingHero {
  const { summary, bearerClients } = input;
  const activeClients = activeBearerClients(bearerClients);
  const activeTokenCount = activeOwnerTokenCount(activeClients);
  const liveGrants = input.grants.filter(isLiveGrant);
  const records = summary ? fmtInt(summary.record_count) : "0";
  const sources = summary?.connector_count ?? 0;
  const sourceWord = sources === 1 ? "source" : "sources";
  const grantWord = liveGrants.length === 1 ? "app reads" : "apps read";
  const tokenWord = activeTokenCount === 1 ? "token" : "tokens";
  const clientWord = activeClients.length === 1 ? "client holds" : "clients hold";
  const withBearers = `${activeClients.length} ${clientWord} ${fmtInt(activeTokenCount)} active owner ${tokenWord} with full access. ${liveGrants.length} ${grantWord} only the slices you granted. Revoke any of them instantly.`;
  const noBearers = `No owner token can act as you yet. ${liveGrants.length} ${grantWord} only the slices you granted. Revoke any of them instantly.`;
  return {
    tone: "calm",
    kicker: "Where you stand",
    line: { text: `${records} records from ${sources} ${sourceWord} — `, emphasis: "all yours to read", tail: "." },
    sub: activeTokenCount > 0 ? withBearers : noBearers,
  };
}

/**
 * Compute the hero. Precedence: a pending approval is a DECIDE (it needs a
 * yes/no), a failure is an ALARM (something broke), a stale projection is a
 * soft ALARM (so we never claim the overview is current when the summary is
 * stale), otherwise CALM with the reassurance line.
 */
export function computeHero(input: StandingInputs): StandingHero {
  if (input.pendingApprovals.length > 0) {
    return buildDecideHero(input.pendingApprovals, input.hrefs);
  }
  if (input.attentionConnections.length > 0) {
    return buildFailureHero(input.attentionConnections, input.hrefs);
  }
  const projectionState = input.summary?.projection?.state;
  if (projectionState === "stale" || projectionState === "failed") {
    return buildStaleHero(input.summary, input.hrefs);
  }
  return buildCalmHero(input);
}

// ─── Top-level builder ───────────────────────────────────────────────────

export function buildStandingData(input: StandingInputs): StandingData {
  return {
    hero: computeHero(input),
    bearers: toBearers(input.bearerClients, input.hrefs, input.now),
    relationships: toRelationships(input.grants, input.hrefs, input.now, clientNamesById(input.bearerClients)),
    lately: toLately(input.traces, input.now),
    attention: toAttention(input.attentionConnections, input.hrefs),
    sourceIssues: toSourceIssues(input.sourceIssues, input.hrefs),
  };
}
