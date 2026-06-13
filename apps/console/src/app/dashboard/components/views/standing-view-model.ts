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
  /** "reads only your pay and your spending" — humanized scope summary. */
  reads: string;
  /** href to the grant detail (revoke lives there). */
  revokeHref: string;
  status: GrantEndorseStatus;
  /** "expires in 12 days" / "open-ended" — meta line. */
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
}

// ─── Inputs ────────────────────────────────────────────────────────────

export interface StandingInputs {
  attentionCount: number;
  bearerClients: OwnerIssuedClient[];
  failedRuns: RunSummary[];
  failedTraces: TraceSummary[];
  grants: GrantSummary[];
  /** href builders (bound to dashboardRoutes by the page). */
  hrefs: StandingHrefs;
  /** Relative-time formatter (injected so the view-model stays clock-pure). */
  now: Date;
  pendingApprovals: PendingApproval[];
  summary: DatasetSummary | null;
  traces: TraceSummary[];
}

export interface StandingHrefs {
  deployment: string;
  deploymentTokens: string;
  grant: (id: string) => string;
  grants: string;
  run: (id: string) => string;
  trace: (id: string) => string;
  traces: string;
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
  const meaningfulKinds = g.kinds
    .map((k) => k.replace(PROTOCOL_KIND_PREFIX_RE, ""))
    .filter((k) => k && !PROTOCOL_KIND_WORDS.has(k));
  const phrases = Array.from(new Set(meaningfulKinds.map(scopeHuman))).filter(Boolean);
  if (phrases.length > 0) {
    return `reads only ${joinHuman(phrases)}`;
  }
  if (g.connector_id) {
    return `reads only ${scopeHuman(g.connector_id)}`;
  }
  return "reads a scoped slice of your data";
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

function toBearers(clients: OwnerIssuedClient[], hrefs: StandingHrefs, now: Date): BearerView[] {
  return clients.map((c) => {
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

function toRelationships(grants: GrantSummary[], hrefs: StandingHrefs, now: Date): RelationshipView[] {
  return grants.filter(isLiveGrant).map((g) => ({
    who: clientLabel(g.client_id, g.grant_id),
    reads: grantReads(g),
    status: grantEndorseStatus(g.status),
    terms: `last active ${relDay(g.last_at, now)}`,
    revokeHref: hrefs.grant(g.grant_id),
  }));
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

function toLately(traces: TraceSummary[], now: Date): LatelyView[] {
  return traces.slice(0, 6).map((tr) => {
    const who = tr.client_id ?? tr.actor_id ?? "Someone";
    const isDeny = tr.status.toLowerCase() === "denied" || tr.failure !== null;
    if (isDeny) {
      return {
        id: tr.trace_id,
        when: relDay(tr.last_at, now),
        deny: true,
        text: { who, rest: `tried to read — turned away, ${denyReason(tr.failure?.reason ?? null)}.` },
      };
    }
    const noun = tr.event_count === 1 ? "record" : "records";
    return {
      id: tr.trace_id,
      when: relDay(tr.last_at, now),
      deny: false,
      text: { who, rest: `read ${fmtInt(tr.event_count)} ${noun}.` },
    };
  });
}

// ─── Attention view ("anything wrong") ───────────────────────────────────

function toAttention(failedTraces: TraceSummary[], failedRuns: RunSummary[], hrefs: StandingHrefs): AttentionRowView[] {
  const fromRuns = failedRuns.map((r) => ({
    id: `run:${r.run_id}`,
    what: r.connector_id ? `${scopeHuman(r.connector_id)} stopped syncing` : "A sync failed",
    why: r.failure_reason ?? "The last run did not complete.",
    href: hrefs.run(r.run_id),
  }));
  const fromTraces = failedTraces.map((t) => ({
    id: `trace:${t.trace_id}`,
    what: `${t.client_id ?? "A reader"} could not read`,
    why: t.failure?.reason ?? "A read attempt failed.",
    href: hrefs.trace(t.trace_id),
  }));
  return [...fromRuns, ...fromTraces];
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

/** ALARM — a run or trace failed. */
function buildFailureHero(count: number, hrefs: StandingHrefs): StandingHero {
  const noun = count === 1 ? "thing" : "things";
  return {
    tone: "alarm",
    kicker: count === 1 ? "One thing needs you" : `${count} ${noun} need you`,
    line: { text: "Something ", emphasis: "stopped working", tail: "." },
    sub: "Nothing you already have is lost — but new data may not be arriving until you take a look.",
    cta: { label: "See what's wrong", href: hrefs.traces },
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
  const liveGrants = input.grants.filter(isLiveGrant);
  const records = summary ? fmtInt(summary.record_count) : "0";
  const sources = summary?.connector_count ?? 0;
  const sourceWord = sources === 1 ? "source" : "sources";
  const bearerWord = bearerClients.length === 1 ? "token" : "tokens";
  const grantWord = liveGrants.length === 1 ? "app reads" : "apps read";
  const withBearers = `${bearerClients.length} ${bearerWord} can act as you, with full access. ${liveGrants.length} ${grantWord} only the slices you granted. Revoke any of them instantly.`;
  const noBearers = `No token can act as you yet. ${liveGrants.length} ${grantWord} only the slices you granted. Revoke any of them instantly.`;
  return {
    tone: "calm",
    kicker: "Where you stand",
    line: { text: `${records} records from ${sources} ${sourceWord} — `, emphasis: "all yours to read", tail: "." },
    sub: bearerClients.length > 0 ? withBearers : noBearers,
  };
}

/**
 * Compute the hero. Precedence: a pending approval is a DECIDE (it needs a
 * yes/no), a failure is an ALARM (something broke), a stale projection is a
 * soft ALARM (so we never claim "everything's syncing" when the summary is
 * stale), otherwise CALM with the reassurance line.
 */
export function computeHero(input: StandingInputs): StandingHero {
  if (input.pendingApprovals.length > 0) {
    return buildDecideHero(input.pendingApprovals, input.hrefs);
  }
  if (input.attentionCount > 0) {
    return buildFailureHero(input.attentionCount, input.hrefs);
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
    relationships: toRelationships(input.grants, input.hrefs, input.now),
    lately: toLately(input.traces, input.now),
    attention: toAttention(input.failedTraces, input.failedRuns, input.hrefs),
  };
}
