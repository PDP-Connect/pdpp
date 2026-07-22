// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Explore search grammar — the owner-grade query language for the Explore view.
 *
 * Ported from the Recordroom design (`rr-explore.jsx` `parseQuery`) and bound to
 * the REAL records API surface. The grammar is free text + typed `k:v`
 * operators; everything composes:
 *
 *   con:<name>        connection name/id match           → server `connection=`
 *   stream:<name>     stream name                        → server `stream=`
 *   role:<value>      a role-shaped field value          → CLIENT-SIDE post-filter
 *   has:image         record declares a usable blob/img  → CLIENT-SIDE (declared blobAffordance)
 *   has:link          record has a url-shaped field      → CLIENT-SIDE post-filter
 *   is:folded         record is a folded/aggregate row   → CLIENT-SIDE post-filter
 *   <field>:<value>   declared exact-filterable field    → server `filter[field]=`
 *                     undeclared field                   → CLIENT-SIDE post-filter
 *   before:<DATE>     a date endpoint                    → canonical `until` (the Date chip)
 *   after:<DATE>      a date endpoint                    → canonical `since` (the Date chip)
 *   <bare word>       free text match                    → server `match=` (q)
 *
 * ── API MAPPING (honest by design) ────────────────────────────────
 * The records read surface accepts a free-text query (`q`), connection ids
 * (`connection`, repeatable), stream names (`stream`, repeatable), a date window
 * (`since` / `until`), and per-field exact-match filters (`filter[field]=value`,
 * see `queryRecords`). A `field:value` over a DECLARED exact-filterable field is
 * therefore a real server param — only fields the streams do not declare, and
 * `role` / `has:image` / `has:link` / `is:folded`, stay client-side.
 *
 * So tokens split into two honest buckets:
 *   - SERVER tokens (`con` `stream` `before`/`after`, bare text, AND a
 *     `field:value` whose field is declared exact-filterable) are pushed onto
 *     the URL the page navigates with; the SSR fetch applies them.
 *   - CLIENT tokens (`role` `has:image` `has:link` `is:folded`, and a
 *     `field:value` over an UNDECLARED field) are applied as a post-filter over
 *     the already-fetched feed, because the server cannot express them.
 *
 * The "compiled call" line shows the HONEST query a client *would* express. We
 * render every server-backed token (including declared `filter[field]=value`)
 * plainly, and render each client-only token with a leading `#` comment marker
 * ("# client-side:") so the line never claims the server did something it did
 * not. Nothing is silently dropped or misrepresented. See `buildCompiledQuery`.
 */

export interface ParsedToken {
  /** Chip label, e.g. "in Gmail (work)" or "has image". */
  label: string;
  /** The original whitespace-delimited token, so a chip can remove exactly it. */
  raw: string;
}

export interface ParsedFieldMatch {
  key: string;
  value: string;
}

export interface ParsedQuery {
  /** `after:DATE` — maps to server `since`. */
  after: string | null;
  /** `before:DATE` — maps to server `until`. */
  before: string | null;
  /** `con:<name>` connection name/id fragment (INCLUDE). */
  con: string | null;
  /**
   * `-con:<name>` excluded connection name/id fragment (EXCLUDE — Gmail/Stripe
   * leading `-` negation). "Everything except X" is expressed either by this
   * operator or by the facet "is not" toggle; both compile to the same query.
   */
  conNot: string | null;
  /** `<field>:<value>` fuzzy matches (client-side). */
  fields: ParsedFieldMatch[];
  /** `is:folded`. */
  folded: boolean;
  /** `has:image`. */
  hasImage: boolean;
  /** `has:link`. */
  hasLink: boolean;
  /** `role:<value>`. */
  role: string | null;
  /** `stream:<name>` (INCLUDE). */
  stream: string | null;
  /** `-stream:<name>` excluded stream name (EXCLUDE — Gmail/Stripe `-` negation). */
  streamNot: string | null;
  /** Bare words → free text match (server `q`). */
  text: string[];
  /** Every token in input order, for the chip bar. */
  tokens: ParsedToken[];
}

// A token may carry a leading `-` negation prefix (Gmail/Stripe `-from:x`); the
// outer group captures it so `parseQuery` can route `-con:`/`-stream:` to the
// EXCLUDE slots while leaving the `raw` token intact for chip removal.
const KV_RE = /^(-?)([a-z_]+):(.+)$/i;
const WHITESPACE_RE = /\s+/;

/**
 * Apply one parsed `k:v` (or `-k:v`) token to the accumulator. A leading `-`
 * negates con/stream into the EXCLUDE slots (Gmail/Stripe); other operators have
 * no defined negation, so they fall through to their un-negated handler and stay
 * visible (never silently dropped). Extracted from `parseQuery` to keep its
 * cognitive complexity bounded.
 */
function applyKvToken(out: ParsedQuery, tok: string, negated: boolean, key: string, value: string): void {
  const lower = value.toLowerCase();
  if (negated && key === "con") {
    out.conNot = lower;
    out.tokens.push({ label: `not in ${value}`, raw: tok });
    return;
  }
  if (negated && key === "stream") {
    out.streamNot = lower;
    out.tokens.push({ label: `not stream: ${value}`, raw: tok });
    return;
  }
  switch (key) {
    case "con":
      out.con = lower;
      out.tokens.push({ label: `in ${value}`, raw: tok });
      break;
    case "stream":
      out.stream = lower;
      out.tokens.push({ label: `stream: ${value}`, raw: tok });
      break;
    case "role":
      out.role = lower;
      out.tokens.push({ label: `role: ${value}`, raw: tok });
      break;
    case "has":
      if (lower === "image") {
        out.hasImage = true;
        out.tokens.push({ label: "has image", raw: tok });
      } else if (lower === "link") {
        out.hasLink = true;
        out.tokens.push({ label: "has link", raw: tok });
      } else {
        out.fields.push({ key, value: lower });
        out.tokens.push({ label: `${key}: ${value}`, raw: tok });
      }
      break;
    case "is":
      if (lower === "folded") {
        out.folded = true;
        out.tokens.push({ label: "folded", raw: tok });
      } else {
        out.fields.push({ key, value: lower });
        out.tokens.push({ label: `${key}: ${value}`, raw: tok });
      }
      break;
    case "before":
      out.before = value;
      out.tokens.push({ label: `before ${value}`, raw: tok });
      break;
    case "after":
      out.after = value;
      out.tokens.push({ label: `after ${value}`, raw: tok });
      break;
    default:
      out.fields.push({ key, value: lower });
      out.tokens.push({ label: `${key}: ${value}`, raw: tok });
  }
}

/** Parse a raw query string into structured tokens. Pure; never throws. */
export function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = {
    after: null,
    before: null,
    con: null,
    conNot: null,
    fields: [],
    folded: false,
    hasImage: false,
    hasLink: false,
    role: null,
    stream: null,
    streamNot: null,
    text: [],
    tokens: [],
  };
  for (const tok of input.trim().split(WHITESPACE_RE).filter(Boolean)) {
    const m = tok.match(KV_RE);
    if (!m) {
      out.text.push(tok.toLowerCase());
      out.tokens.push({ label: tok, raw: tok });
      continue;
    }
    applyKvToken(out, tok, m[1] === "-", (m[2] ?? "").toLowerCase(), m[3] ?? "");
  }
  return out;
}

/** Remove one whitespace-delimited token from a query string (chip × action). */
export function removeToken(query: string, raw: string): string {
  return query
    .split(WHITESPACE_RE)
    .filter((x) => x !== raw)
    .join(" ")
    .trim();
}

/** The operator keys that the dedicated Date chip owns (rendered ONCE, by it). */
const DATE_OPERATOR_KEYS = new Set(["before", "after"]);

/**
 * Whether a raw token is a date operator (`before:…` / `after:…`) — the canonical
 * window owns these, so they must NEVER render as a separate `rr-x-chip` beside the
 * Date chip. The single source of truth for the chip strip's date-token exclusion
 * (date-controls cell, canonical-date-object guarantee): the in-app commit path lifts
 * these into `since`/`until` before navigating, and on the URL/SSR/reload path the
 * mount-time normalizer lifts them too — but this predicate is the belt-and-suspenders
 * that keeps a date operator out of the chip strip on EVERY path, even the single
 * render between a URL-direct load and the normalize redirect settling. Pure; the
 * `-before:`/`-after:` forms have no defined negation but are still date-owned, so a
 * leading `-` is tolerated.
 */
export function isDateOperatorToken(raw: string): boolean {
  const m = raw.match(KV_RE);
  if (!m) {
    return false;
  }
  return DATE_OPERATOR_KEYS.has((m[2] ?? "").toLowerCase());
}

/**
 * The tokens the active-filter chip strip should render: every parsed token EXCEPT
 * the date operators the Date chip owns. So a URL-direct `?q=after:2026-01-01`, a
 * shared link, or a reload never produces a SECOND date representation (a token chip
 * lying about the window beside an "Any time" Date chip — the Part-0 double-render
 * defect, THE-LENS Gate 1). Pure + exported so the exclusion is one tested place and
 * `buildFilterChips` stays the consumer, not the definition.
 */
export function chipTokens(tokens: readonly ParsedToken[]): ParsedToken[] {
  return tokens.filter((t) => !isDateOperatorToken(t.raw));
}

/** Tokens whose key the canvas LIFTS out of the free-text query into a facet param. */
const FACET_LIFT_KEYS = new Set(["con", "stream"]);

export interface QueryFacetLift {
  /** Connection name/id fragments to ADD to the exclude facet (`-con:`). */
  excludeConnections: string[];
  /** Stream names to ADD to the exclude facet (`-stream:`). */
  excludeStreams: string[];
  /** Connection name/id fragments to ADD to the include facet (`con:`). */
  includeConnections: string[];
  /** Stream names to ADD to the include facet (`stream:`). */
  includeStreams: string[];
  /** The query with the lifted con/stream tokens removed (free text + other operators). */
  rest: string;
}

/**
 * Lift `con:`/`-con:`/`stream:`/`-stream:` tokens OUT of the free-text query and into
 * facet include/exclude lists, returning the remaining query. This is what makes the
 * TYPED operator equivalent to the CHIP: committing `-con:ynab` produces the same
 * canonical state (the `xconnection` facet param) as clicking the "is not" toggle,
 * instead of leaving `-con:ynab` as a literal `q` search string. The recent-lens feed
 * scopes by the facet params, so the operator must become a facet param to take effect.
 *
 * Pure; never throws. Other operators (`has:image`, `role:`, `before:`, free text)
 * are left untouched in `rest`.
 */
export function liftFacetTokens(query: string): QueryFacetLift {
  const lift: QueryFacetLift = {
    excludeConnections: [],
    excludeStreams: [],
    includeConnections: [],
    includeStreams: [],
    rest: "",
  };
  const kept: string[] = [];
  for (const tok of query.trim().split(WHITESPACE_RE).filter(Boolean)) {
    const m = tok.match(KV_RE);
    const key = m ? (m[2] ?? "").toLowerCase() : "";
    if (!(m && FACET_LIFT_KEYS.has(key))) {
      kept.push(tok);
      continue;
    }
    const negated = m[1] === "-";
    const value = (m[3] ?? "").trim();
    if (!value) {
      kept.push(tok);
      continue;
    }
    if (key === "con") {
      (negated ? lift.excludeConnections : lift.includeConnections).push(value);
    } else {
      (negated ? lift.excludeStreams : lift.includeStreams).push(value);
    }
  }
  lift.rest = kept.join(" ").trim();
  return lift;
}

export interface QueryDateLift {
  /** `after:<DATE>` value to fold into the canonical `since`, or null. */
  after: string | null;
  /** `before:<DATE>` value to fold into the canonical `until`, or null. */
  before: string | null;
  /** The query with the lifted before:/after: tokens removed. */
  rest: string;
}

/**
 * Lift `after:<DATE>` / `before:<DATE>` tokens OUT of the free-text query and into
 * the canonical date window (`since`/`until`). This makes a TYPED date operator
 * IMMEDIATELY become the single Date chip — never a second token chip beside it
 * (the canonical-date-object guarantee, date-controls cell). It mirrors
 * `liftFacetTokens`: `con:`/`stream:` become facet params, `after:`/`before:`
 * become the date window, so every entry path normalizes into ONE representation.
 *
 * Last-write-wins on conflict: if the same operator appears twice, the LAST value
 * survives (typing `after:X` over an active window REPLACES `since`, never stacks).
 * Other operators / free text are left untouched in `rest`. Pure; never throws.
 */
export function liftDateTokens(query: string): QueryDateLift {
  const lift: QueryDateLift = { after: null, before: null, rest: "" };
  const kept: string[] = [];
  for (const tok of query.trim().split(WHITESPACE_RE).filter(Boolean)) {
    const m = tok.match(KV_RE);
    const negated = m ? m[1] === "-" : false;
    const key = m ? (m[2] ?? "").toLowerCase() : "";
    const value = m ? (m[3] ?? "").trim() : "";
    // before:/after: have no defined negation; a `-before:`/`-after:` is left as-is.
    if (m && !negated && (key === "after" || key === "before") && value) {
      // Last-write-wins: a later token overwrites an earlier one (no stacking).
      if (key === "after") {
        lift.after = value;
      } else {
        lift.before = value;
      }
      continue;
    }
    kept.push(tok);
  }
  lift.rest = kept.join(" ").trim();
  return lift;
}

/**
 * Whether a parsed query has any token the server cannot express — used to
 * decide if the compiled line needs the "# client-side" annotations and the
 * UI should label rows as post-filtered.
 *
 * A `field:value` whose field is declared exact-filterable is a server `filter[]`
 * param, so it does NOT count as client-side. `serverFilterableFields` defaults
 * to empty (every `field:value` is client-side) so callers without stream
 * metadata stay honest.
 */
export function hasClientSideTokens(
  parsed: ParsedQuery,
  serverFilterableFields: ReadonlySet<string> = new Set()
): boolean {
  const clientFields = parsed.fields.some((f) => !serverFilterableFields.has(f.key.toLowerCase()));
  return Boolean(parsed.role) || parsed.hasImage || parsed.hasLink || parsed.folded || clientFields;
}

export interface CompiledQueryInput {
  /**
   * Connection ids EXCLUDED via the facet "is not" toggle (Linear) — rendered as
   * `connection!=` so the compiled line shows exclusion is a real server-scope
   * param, equivalent to the `-con:` operator. Defaults to empty.
   */
  excludedConnectionIds?: readonly string[];
  /** Stream names EXCLUDED via the facet "is not" toggle. Defaults to empty. */
  excludedStreams?: readonly string[];
  /** Per-page record cap the fan-out applies. */
  limit: number;
  /** "newest" | "oldest" — display order. */
  order: "newest" | "oldest";
  parsed: ParsedQuery;
  /** Connection display names already selected via the facet rail (chips). */
  selectedConnectionIds: readonly string[];
  /** Stream names already selected via the facet rail. */
  selectedStreams: readonly string[];
  /**
   * Field names declared exact-filterable across the in-scope streams. A
   * `field:value` over one of these renders as a real server `filter[field]=`
   * param; any other field renders behind the client-side marker. Defaults to
   * empty (every `field:value` is client-side) for callers without metadata.
   */
  serverFilterableFields?: ReadonlySet<string>;
  /** ISO `since` already applied by the date-range control / server. */
  since: string;
  /** ISO `until` already applied by the date-range control / server. */
  until: string;
}

/**
 * Split parsed `field:value` matches into declared server `filter[]=` params and
 * the client-side fallback tokens (undeclared fields). Keeps `buildCompiledQuery`
 * within its cognitive-complexity budget while preserving the honest split.
 */
function splitFieldFilters(
  fields: readonly ParsedFieldMatch[],
  serverFilterableFields: ReadonlySet<string>
): { clientFields: ParsedFieldMatch[]; serverFilters: string[] } {
  const serverFilters: string[] = [];
  const clientFields: ParsedFieldMatch[] = [];
  for (const f of fields) {
    if (serverFilterableFields.has(f.key.toLowerCase())) {
      serverFilters.push(`filter[${f.key}]=${f.value}`);
    } else {
      clientFields.push(f);
    }
  }
  return { clientFields, serverFilters };
}

/**
 * Render the include (`param=`) + exclude (`param!=`) scope params for one axis
 * (connection or stream). Facet selections and operator tokens compose into the
 * SAME params (chip == operator). For the connection axis the include token is a
 * fallback only when no facet id is selected (the facet wins); the stream axis
 * unions the token with the facet streams — both preserved from the original
 * inline logic. Extracted to keep `buildCompiledQuery` within its complexity budget.
 */
function renderScopeParams(args: {
  include: readonly string[];
  exclude: readonly string[];
  tokenInclude: string | null;
  tokenExclude: string | null;
  param: "connection" | "stream";
}): string[] {
  const out: string[] = [];
  const includeSet = new Set<string>(args.include);
  // connection: token is a fallback only when no facet id is selected (facet wins).
  // stream: the token unions with the selected facet streams.
  if (args.tokenInclude && (args.param === "stream" || args.include.length === 0)) {
    includeSet.add(args.tokenInclude);
  }
  for (const v of includeSet) {
    out.push(`${args.param}=${v}`);
  }
  const excludeSet = new Set<string>(args.exclude);
  if (args.tokenExclude) {
    excludeSet.add(args.tokenExclude);
  }
  for (const v of excludeSet) {
    out.push(`${args.param}!=${v}`);
  }
  return out;
}

/**
 * Build the inspectable read-request line for the current Explore view.
 *
 * Server-honored params are rendered plainly; client-only tokens are rendered
 * after a `# client-side:` marker so the line never overstates what the server
 * did. The base path mirrors the public records read endpoint.
 */
export function buildCompiledQuery(input: CompiledQueryInput): string {
  const { parsed, selectedConnectionIds, selectedStreams, since, until, order, limit } = input;
  const serverFilterableFields = input.serverFilterableFields ?? new Set<string>();
  const server: string[] = [
    // Connection/stream include + exclude scope (the chip toggle and the operator
    // render identically; exclusion is a first-class `!=` scope param).
    ...renderScopeParams({
      exclude: input.excludedConnectionIds ?? [],
      include: selectedConnectionIds,
      param: "connection",
      tokenExclude: parsed.conNot,
      tokenInclude: parsed.con,
    }),
    ...renderScopeParams({
      exclude: input.excludedStreams ?? [],
      include: selectedStreams,
      param: "stream",
      tokenExclude: parsed.streamNot,
      tokenInclude: parsed.stream,
    }),
  ];

  // Date window: facet range (since/until) and before:/after: tokens both map
  // to the server's since/until. Explicit tokens win the rendered value.
  const sinceParam = parsed.after ?? since;
  const untilParam = parsed.before ?? until;
  if (sinceParam) {
    server.push(`since=${sinceParam}`);
  }
  if (untilParam) {
    server.push(`until=${untilParam}`);
  }

  // Free text → match= (the q the server searches on).
  if (parsed.text.length > 0) {
    server.push(`match=${parsed.text.join("+")}`);
  }

  // A `field:value` whose field is declared exact-filterable is a REAL server
  // param (`filter[field]=value`); fields the streams do not declare fall through
  // to the client-side section below.
  const { serverFilters, clientFields } = splitFieldFilters(parsed.fields, serverFilterableFields);
  server.push(...serverFilters);

  server.push(`order=${order}`, `limit=${limit}`);

  // Client-only tokens — rendered honestly as a trailing comment, never as a
  // server param the API does not accept.
  const client: string[] = [];
  if (parsed.role) {
    client.push(`role=${parsed.role}`);
  }
  if (parsed.hasImage) {
    // Honest representation of the client-side declared-blob filter; the records
    // surface has no `content_type=` param, so this stays behind the marker.
    client.push("content_type=image/*");
  }
  if (parsed.hasLink) {
    client.push("has=link");
  }
  if (parsed.folded) {
    client.push("folded=true");
  }
  for (const f of clientFields) {
    client.push(`${f.key}~${f.value}`);
  }

  const base = `GET /v1/records?${server.join("&")}`;
  return client.length > 0 ? `${base}   # client-side: ${client.join(" ")}` : base;
}
