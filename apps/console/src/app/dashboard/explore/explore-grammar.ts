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
 *   before:<DATE>     emitted strictly before DATE       → server `until=`
 *   after:<DATE>      emitted strictly after DATE        → server `since=`
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
  /** `con:<name>` connection name/id fragment. */
  con: string | null;
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
  /** `stream:<name>`. */
  stream: string | null;
  /** Bare words → free text match (server `q`). */
  text: string[];
  /** Every token in input order, for the chip bar. */
  tokens: ParsedToken[];
}

const KV_RE = /^([a-z_]+):(.+)$/i;
const WHITESPACE_RE = /\s+/;

/** Parse a raw query string into structured tokens. Pure; never throws. */
export function parseQuery(input: string): ParsedQuery {
  const out: ParsedQuery = {
    text: [],
    con: null,
    stream: null,
    role: null,
    hasImage: false,
    hasLink: false,
    folded: false,
    before: null,
    after: null,
    fields: [],
    tokens: [],
  };
  for (const tok of input.trim().split(WHITESPACE_RE).filter(Boolean)) {
    const m = tok.match(KV_RE);
    if (!m) {
      out.text.push(tok.toLowerCase());
      out.tokens.push({ raw: tok, label: tok });
      continue;
    }
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    const lower = value.toLowerCase();
    switch (key) {
      case "con":
        out.con = lower;
        out.tokens.push({ raw: tok, label: `in ${value}` });
        break;
      case "stream":
        out.stream = lower;
        out.tokens.push({ raw: tok, label: `stream: ${value}` });
        break;
      case "role":
        out.role = lower;
        out.tokens.push({ raw: tok, label: `role: ${value}` });
        break;
      case "has":
        if (lower === "image") {
          out.hasImage = true;
          out.tokens.push({ raw: tok, label: "has image" });
        } else if (lower === "link") {
          out.hasLink = true;
          out.tokens.push({ raw: tok, label: "has link" });
        } else {
          out.fields.push({ key, value: lower });
          out.tokens.push({ raw: tok, label: `${key}: ${value}` });
        }
        break;
      case "is":
        if (lower === "folded") {
          out.folded = true;
          out.tokens.push({ raw: tok, label: "folded" });
        } else {
          out.fields.push({ key, value: lower });
          out.tokens.push({ raw: tok, label: `${key}: ${value}` });
        }
        break;
      case "before":
        out.before = value;
        out.tokens.push({ raw: tok, label: `before ${value}` });
        break;
      case "after":
        out.after = value;
        out.tokens.push({ raw: tok, label: `after ${value}` });
        break;
      default:
        out.fields.push({ key, value: lower });
        out.tokens.push({ raw: tok, label: `${key}: ${value}` });
    }
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
  return { serverFilters, clientFields };
}

/**
 * Build the machine-parity "the same call any client makes" line.
 *
 * Server-honored params are rendered plainly; client-only tokens are rendered
 * after a `# client-side:` marker so the line never overstates what the server
 * did. The base path mirrors the public records read endpoint.
 */
export function buildCompiledQuery(input: CompiledQueryInput): string {
  const { parsed, selectedConnectionIds, selectedStreams, since, until, order, limit } = input;
  const serverFilterableFields = input.serverFilterableFields ?? new Set<string>();
  const server: string[] = [];

  // con: token OR facet-selected connection ids → connection= (repeatable).
  for (const id of selectedConnectionIds) {
    server.push(`connection=${id}`);
  }
  if (parsed.con && selectedConnectionIds.length === 0) {
    server.push(`connection=${parsed.con}`);
  }

  // stream: token OR facet-selected streams → stream= (repeatable).
  const streams = new Set<string>(selectedStreams);
  if (parsed.stream) {
    streams.add(parsed.stream);
  }
  for (const s of streams) {
    server.push(`stream=${s}`);
  }

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
