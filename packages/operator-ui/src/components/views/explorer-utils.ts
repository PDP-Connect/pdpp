/**
 * Pure, framework-free helpers for the Explorer feature.
 *
 * Extracted from records-explorer-view.tsx so that node --test can import
 * them without loading React or Next.js. The TSX file re-exports everything
 * from here; call-sites do not need to change their import paths.
 */

import type { BucketSeries } from "../../explore/over-time-chart.ts";
import type { SetDescriptor } from "../../explore/set-descriptor.ts";
import type { RecordKind } from "../../lib/record-kind.ts";
import type { RecordPreview } from "../../lib/record-preview.ts";

export type { SetDescriptor } from "../../explore/set-descriptor.ts";

import type { Routes } from "./routes.ts";

/** Active feed lens. URL state (q + since/until) is the source of truth. */
export type ExplorerLens = "recent" | "search" | "time_range" | "search_with_ignored_time_window";

export interface ExplorerConnectionFacet {
  /** Stable connection identity. URL chips key on this. */
  connectionId: string;
  /** Connector identifier (e.g. `gmail`, `github`); rendered as the row-source label. */
  connectorId: string;
  /** Display name; falls back to `connector_display_name` then `connector_id`. */
  displayName: string;
  /** Streams visible on this connection, used to build the stream facet line. */
  streams: string[];
}

export interface ExplorerFeedEntry {
  /** Grant-aware blob link/unavailable marker, present only when declared by stream metadata. */
  blobAffordance?: ExplorerBlobAffordance;
  connectionDisplayName: string | null;
  connectionId: string | null;
  connectorId: string;
  /** Display timestamp picked via `pickSearchDisplayTimestamp` when known. */
  displayAt: string;
  emittedAt: string;
  /**
   * Coarse presentation kind (message / money / event / titled / generic),
   * derived from the connector::stream pair and - when the lens holds the
   * record body - its field names. Presentation metadata only; see
   * `record-kind.ts`. Defaults to `generic` when omitted.
   */
  kind?: RecordKind;
  /**
   * Kind-specific structured preview pulled from the record body, present only
   * for lenses that hold the body (recency / time-range). Drives the type-aware
   * card layout; absent for search hits, which carry only the matched `snippet`.
   * Presentation metadata only — see `record-preview.ts`.
   */
  preview?: RecordPreview;
  recordId: string;
  /** Present when the entry came from a search hit, drives the badge. */
  retrievalMode?: "lexical" | "semantic" | "hybrid";
  /**
   * The matched-text excerpt for a SEARCH HIT (lexical/semantic), already
   * plain-text-extracted from the server snippet. Present ONLY on retrieval rows
   * that have no record body — the row renders it as a clearly-LABELLED match
   * excerpt (never as a faked title), so a search result is scannable by its
   * matched text. Timeline rows (which carry a body-backed `preview`) leave this
   * absent. This deliberately REPLACES the old `summary` field: the row content
   * for body rows comes from declared-role `preview` slots, never a field-name
   * -guessing timeline summary.
   */
  snippet?: string;
  /**
   * The matched snippet parsed into ordered segments, where `marked` runs are the
   * server's match-highlight terms — rendered BOLD as real React elements (never via
   * dangerouslySetInnerHTML). Present alongside `snippet` on retrieval rows; the row
   * renders these for the bold-match excerpt, falling back to plain `snippet` if absent.
   */
  snippetSegments?: readonly { marked: boolean; text: string }[];
  stream: string;
}

export interface ExplorerPeekData {
  /** Pretty-printed JSON body. `null` when the record could not be read. */
  bodyJson: string | null;
  /** Human-readable connection label; falls back to `null` when identity is not resolved. */
  connectionDisplayName: string | null;
  connectionId: string | null;
  connectorId: string;
  emittedAt: string;
  /** Error message when the body could not be fetched. */
  error: string | null;
  /** Field-by-field rendering model; preferred over raw JSON when available. */
  fields: ExplorerPeekField[];
  /** Full GET URL the dashboard issued to read this record. */
  readUrl: string;
  recordId: string;
  /**
   * The semantic/authored timestamp for this record (from `consent_time_field` or
   * `cursor_field`). `null` when the stream declares no semantic field or when the
   * record body could not be read. Always shown alongside `emittedAt`, never as a
   * replacement — both are honest.
   */
  semanticTimestamp: { label: string; value: string } | null;
  stream: string;
}

export interface ExplorerFieldCapability {
  granted: boolean;
  name: string;
  /**
   * Declared presentation ROLE (field_capabilities[].role) — which card slot the
   * field fills (primary-title / secondary / actor / event-time / amount).
   * Distinct from `type`; never inferred.
   */
  role?: string;
  /** Declared presentation TYPE (field_capabilities[].type) — gates formatting. */
  type?: string;
}

export interface ExplorerBlobAffordance {
  fieldName: string;
  href?: string;
  reason?: string;
  state: "available" | "unavailable";
}

export interface ExplorerPeekField {
  blobAffordance?: ExplorerBlobAffordance;
  name: string;
  state: "visible" | "withheld";
  type?: string;
  valueJson: string | null;
}

export interface ExplorerActivitySummary {
  source: "exact_window" | "bounded_sample";
  text: string;
  /** Exact total only when the backend returned a whole-window aggregate. */
  total?: number;
}

export interface ExplorerWarning {
  /** Stable code for tests + future structured `meta.warnings` mapping. */
  code:
    | "partial_fan_in"
    | "partial_fan_in_error"
    // search-fallback coverage warning. The rendered code-label is humanized
    // ("search coverage reduced") — owner-facing copy carries no engine vocabulary.
    | "search_coverage_reduced"
    | "peek_unreachable"
    | "search_meta_warning"
    | "search_page_limited"
    | "search_cursor_unavailable";
  message: string;
}

/**
 * Per-source browse door for search results: "See all '<query>' records in <stream>".
 * Present when search results are attributable to a single connection+stream so the
 * owner can escape to the full paginated list. Only populated when the single-entity
 * case is detected (all hits from the same connector/stream).
 */
export interface ExplorerStreamDoor {
  connectionId: string;
  connectorId: string;
  /** Human-readable label for the source (e.g. "Chase - transactions"). */
  displayName: string;
  stream: string;
}

/**
 * Escape ramp for a bounded/truncated stream group in the fan-out feed.
 * Rendered as "Amazon - Orders - 1,183 records - See all" linking to the
 * stream's fully-paginated per-stream page. `total` is null when the exact
 * count could not be determined; in that case "See all" is shown without a
 * number rather than a wrong one.
 */
export interface ExplorerStreamSeeAllLink {
  connectionId: string;
  connectorId: string;
  /** Human-readable connection label (e.g. "Amazon"). */
  displayName: string;
  stream: string;
  /** Exact total record count for this stream, or null if not available. */
  total: number | null;
}

export interface RecordsExplorerData {
  /** Honest caption for activity/corpus summaries. Never synthesized as full-corpus from a bounded sample. */
  activitySummary: ExplorerActivitySummary | null;
  /**
   * Over-time chart volume band: TRUE per-bucket totals over the filtered,
   * grant-scoped corpus (server `group_by_time` aggregate, NOT loaded entries).
   * Null when the chart is suppressed (relevance_bounded set) or unavailable.
   * The brush overlay is derived in the canvas from `since`/`until`, never from
   * this — the band is a read/write skin on the ONE canonical Date object.
   */
  bucketSeries: BucketSeries | null;
  /** Always present, sorted by display name. */
  connections: ExplorerConnectionFacet[];
  /**
   * The accumulating cursor TRAIL backing the recent merged-timeline lens
   * (`cursors=c1,c2,…` in the URL). Each element is a `next_cursor` already
   * fetched and concatenated into `feed`. "Load more" APPENDS `nextCursor` to
   * this trail (so prior pages stay visible); any feed-defining change resets it
   * to empty. Empty in search / time-range lenses (those use `searchNextCursor`).
   */
  cursorTrail: readonly string[];
  /**
   * SET-DESCRIPTOR: typed discriminated union declaring the completeness and ordering of the
   * current result set. The canvas switches on descriptor.kind to decide what it may claim.
   * Structurally prevents a "newest first" or "complete" label on a relevance_bounded set.
   * Engine-level truth; presentation copy is a separate layer that consumes it.
   */
  descriptor: SetDescriptor;
  /**
   * Connection ids currently EXCLUDED (the facet "is not" toggle / `-con:`
   * operator). Part of the ONE canonical query state, carried in the `xconnection`
   * URL param. The recent-lens feed drops these client-side over the loaded window.
   */
  excludeConnectionIds: string[];
  /** Stream names currently EXCLUDED (facet "is not" / `-stream:`). `xstream` URL param. */
  excludeStreams: string[];
  feed: ExplorerFeedEntry[];
  /** Whether feed came from a search call (true) or the recency/time-range fan-out (false). */
  fromSearch: boolean;
  /** Whether the hybrid retrieval endpoint was used for this load. */
  hybridUsed: boolean;
  /** Active feed lens — derived from `query` and `since`/`until` together. */
  lens: ExplorerLens;
  /**
   * Count of records ingested after `snapshotAnchor` that are not in the current feed page.
   * When > 0, the canvas shows an "N new" pill that on click drops the cursor so the feed
   * refreshes to the live head (new anchor). Set to null when no anchor is active (first
   * load without a cursor) or in search mode.
   *
   * INTEGRATION POINT: when /v1/explore/records ships this comes from the endpoint's
   * `new_since_anchor` field. Today the assembler approximates it from per-stream emitted_at.
   */
  newSinceAnchor: number | null;
  /**
   * Opaque cursor for the NEXT page of the merged timeline, or null when all records in
   * the current lens have been returned. In search mode always null (use searchNextCursor).
   *
   * INTEGRATION POINT: when /v1/explore/records ships this is that endpoint's `next_cursor`.
   * Today the assembler encodes per-stream fan-out positions. See encodeFanOutCursor /
   * decodeFanOutCursor in explore-data-assembler.ts.
   */
  nextCursor: string | null;
  peek: ExplorerPeekData | null;
  query: string;
  /**
   * Whether there are more search results available via cursor (lexical mode only).
   * False for hybrid (no sound relevance cursor). When true, the UI renders a Load-more.
   */
  searchHasMore: boolean;
  /**
   * Opaque cursor for the next page of lexical search results. Null when not in search
   * mode, when hybrid was used (no cursor), or when there are no more results. Passed
   * back as `cursor` in the URL to advance the lexical result set.
   */
  searchNextCursor: string | null;
  /**
   * Active sort mode for search results: "relevance" (default, global top-N ranked)
   * or "recent" (chronological, exhaustively pageable via keyset cursor for single-stream).
   */
  searchSort: "relevance" | "recent";
  /** Connection ids currently selected (INCLUDE). */
  selectedConnectionIds: string[];
  /** Stream names currently selected (INCLUDE). */
  selectedStreams: string[];
  /**
   * Field names declared exact-filterable (`field_capabilities`, granted scalar
   * fields) across the loaded feed streams. A `field:value` operator over one of
   * these is a real server `filter[]` param; everything else is an honest
   * client-side fallback. Empty when no stream metadata was loaded (e.g. search
   * hits, which carry no per-stream capabilities), so those ops stay client-side.
   */
  serverFilterableFields: string[];
  /** ISO date (yyyy-mm-dd) for the `since` filter, or empty when unset. */
  since: string;
  /**
   * Per-source browse door: "See all in <source - stream>". Present when all visible
   * search hits share a single connection+stream (the single-entity case). Allows the
   * owner to escape to the full paginated stream list regardless of retrieval mode.
   * Null when results span multiple sources or there are no results.
   */
  /**
   * ISO timestamp anchoring this feed's point-in-time snapshot. Records ingested after
   * this time are counted in `newSinceAnchor`. On first load (no cursor) the assembler
   * sets this to the current time; on subsequent pages it is forwarded unchanged. Null in
   * search mode.
   */
  snapshotAnchor: string | null;
  streamDoor: ExplorerStreamDoor | null;
  /**
   * Escape ramps for streams whose view is bounded or truncated in the fan-out feed.
   * Each entry carries the stream identity and (when available) the exact total record
   * count so the owner can navigate to the fully-paginated per-stream page. Present
   * only for non-search lenses (recent, time_range). Empty for search results.
   */
  streamSeeAllLinks: ExplorerStreamSeeAllLink[];
  /** True when the feed was truncated to the explorer's fan-out cap. */
  truncated: boolean;
  /** ISO date (yyyy-mm-dd) for the `until` filter, or empty when unset. */
  until: string;
  /**
   * Server's separate Upcoming (future-dated) projection — records whose semantic
   * time is after the server's pinned past/future boundary, FORWARD-chronological
   * (soonest first). Rendered as the collapsed "Upcoming" section at the top of the
   * recent timeline. Empty for search/time-range lenses. The SERVER owns the split;
   * the canvas renders these and never re-derives the boundary client-side.
   */
  upcoming: ExplorerFeedEntry[];
  /** True when more future records exist beyond the loaded `upcoming` head. */
  upcomingHasMore: boolean;
  /**
   * Opaque cursor for the NEXT page of Upcoming (future) records, walking the
   * future projection to exhaustion (count==reachability: every one of the N
   * upcoming records is reachable, not just a capped head). Null when the future
   * set is fully loaded into `upcoming`.
   */
  upcomingNextCursor: string | null;
  /** True server-side count of ALL future records, for the "N upcoming" pill. */
  upcomingTotal: number;
  /**
   * Upcoming (future) accumulating cursor trail (`ucursors=u1,u2,…` in the URL).
   * Each element is an `upcoming_next_cursor` already fetched and concatenated into
   * `upcoming`. "Load more upcoming" APPENDS to this trail (count==reachability:
   * walk all N future records); any feed-defining change resets it to empty.
   */
  upcomingTrail: readonly string[];
  /**
   * Honest surfacing of partial fan-in failures, capability downgrades, and
   * (when the canonical read contract carries them) `meta.warnings` from the
   * underlying search/list responses. Never silently swallowed.
   */
  warnings: ExplorerWarning[];
}

const ROW_KEY_SEP = "::";
// Sentinel for "no concrete connection_id known for this row" (e.g. search
// hits today, where the public search response does not carry connection
// identity). Distinct token so legitimate ids never collide with absence.
const NO_CONNECTION = "~";

// Each component is percent-encoded before joining so the `::` separator
// stays unambiguous regardless of what characters a connector emits in
// record / stream / connection identifiers. `encodeURIComponent` never
// produces a `:` byte, so the split is reversible for any input string.
export function explorerPeekParam(entry: {
  connectorId: string;
  connectionId?: string | null;
  stream: string;
  recordId: string;
}): string {
  const conn = entry.connectionId && entry.connectionId.length > 0 ? entry.connectionId : NO_CONNECTION;
  return [entry.connectorId, conn, entry.stream, entry.recordId].map(encodeURIComponent).join(ROW_KEY_SEP);
}

export function parseExplorerPeekParam(raw: string | undefined | null): {
  connectorId: string;
  connectionId: string | null;
  stream: string;
  recordId: string;
} | null {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const parts = raw.split(ROW_KEY_SEP);
  if (parts.length !== 4) {
    return null;
  }
  let decoded: [string, string, string, string];
  try {
    decoded = parts.map((p) => decodeURIComponent(p)) as [string, string, string, string];
  } catch {
    return null;
  }
  const [connectorId, connectionToken, stream, recordId] = decoded;
  if (!(connectorId && connectionToken && stream && recordId)) {
    return null;
  }
  return {
    connectorId,
    connectionId: connectionToken === NO_CONNECTION ? null : connectionToken,
    stream,
    recordId,
  };
}

export interface ExplorerFeedDayGroup {
  /** ISO date key (yyyy-mm-dd) extracted from `displayAt`; "" when unparseable. */
  day: string;
  entries: ExplorerFeedEntry[];
  /** Human-readable label for the day header. Falls back to "Undated". */
  label: string;
}

// Server-deterministic day label. Locale-pinned so SSR and client agree.
const DAY_LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function dayKeyFromDisplayAt(displayAt: string): string {
  if (typeof displayAt !== "string" || displayAt.length < 10) {
    return "";
  }
  // ISO timestamps from pickSearchDisplayTimestamp lead with yyyy-mm-dd. We
  // group on that ISO date prefix so two entries from the same calendar day
  // (in their source timezone) bucket together regardless of clock time.
  const candidate = displayAt.slice(0, 10);
  return Number.isNaN(Date.parse(`${candidate}T00:00:00Z`)) ? "" : candidate;
}

function labelForDayKey(day: string): string {
  if (!day) {
    return "Undated";
  }
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(ms)) {
    return "Undated";
  }
  return DAY_LABEL_FMT.format(new Date(ms));
}

export function groupFeedByDay(entries: ExplorerFeedEntry[]): ExplorerFeedDayGroup[] {
  // The feed arrives sorted by displayAt desc; preserve that order by
  // walking the list once and starting a new group whenever the day key
  // changes. Re-sorting per-group would break the page-level ordering
  // contract the page applies after fan-in.
  const groups: ExplorerFeedDayGroup[] = [];
  let current: ExplorerFeedDayGroup | null = null;
  for (const entry of entries) {
    const day = dayKeyFromDisplayAt(entry.displayAt);
    if (!current || current.day !== day) {
      current = { day, label: labelForDayKey(day), entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

export interface ExplorerActivityCell {
  /** Number of feed entries whose `displayAt` falls on this day. */
  count: number;
  /** ISO date key (yyyy-mm-dd) for the day. */
  day: string;
  /** True when this cell is "today" relative to the reference clock. */
  isToday: boolean;
}

const MS_PER_DAY = 86_400_000;

export function isoDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Day-bucketed counts over the last `days` calendar days, sorted oldest →
 * newest. Cells with no matching entries render as zero, not as gaps, so the
 * strip is a stable shape regardless of how much data the bounded fan-out
 * found. The reference clock is `now` (defaulting to `Date.now()`) so SSR can
 * be deterministic and tests can pin a window.
 */
export function computeActivityStripCells(
  entries: ExplorerFeedEntry[],
  days = 30,
  now: number = Date.now()
): ExplorerActivityCell[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const day = dayKeyFromDisplayAt(e.displayAt);
    if (!day) {
      continue;
    }
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const todayKey = isoDayFromMs(now);
  const cells: ExplorerActivityCell[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const dayKey = isoDayFromMs(now - i * MS_PER_DAY);
    cells.push({
      day: dayKey,
      count: counts.get(dayKey) ?? 0,
      isToday: dayKey === todayKey,
    });
  }
  return cells;
}

function stableFieldNames(data: Record<string, unknown>, capabilities: readonly ExplorerFieldCapability[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (!seen.has(cap.name)) {
      seen.add(cap.name);
      out.push(cap.name);
    }
  }
  for (const name of Object.keys(data)) {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

function capabilityByName(capabilities: readonly ExplorerFieldCapability[]): Map<string, ExplorerFieldCapability> {
  return new Map(capabilities.map((cap) => [cap.name, cap]));
}

function prettyFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function parseBlobRef(value: unknown): { href: string | null } | null {
  if (!(value && typeof value === "object") || Array.isArray(value)) {
    return null;
  }
  const record = value as { blob_id?: unknown; fetch_url?: unknown };
  if (typeof record.fetch_url === "string" && record.fetch_url.length > 0) {
    return { href: record.fetch_url };
  }
  if (typeof record.blob_id === "string" && record.blob_id.length > 0) {
    return { href: `/v1/blobs/${encodeURIComponent(record.blob_id)}` };
  }
  return null;
}

export function buildBlobAffordance(
  data: Record<string, unknown>,
  capabilities: readonly ExplorerFieldCapability[]
): ExplorerBlobAffordance | null {
  const blobField = capabilities.find((cap) => cap.type?.toLowerCase() === "blob");
  if (!blobField) {
    return null;
  }
  if (!blobField.granted) {
    return {
      fieldName: blobField.name,
      reason: "Blob unavailable under active projection.",
      state: "unavailable",
    };
  }
  const parsed = parseBlobRef(data[blobField.name]);
  if (!parsed?.href) {
    return null;
  }
  return {
    fieldName: blobField.name,
    href: parsed.href,
    state: "available",
  };
}

export function buildPeekFields(
  data: Record<string, unknown>,
  capabilities: readonly ExplorerFieldCapability[]
): ExplorerPeekField[] {
  const caps = capabilityByName(capabilities);
  const blob = buildBlobAffordance(data, capabilities);
  const fields: ExplorerPeekField[] = [];
  for (const name of stableFieldNames(data, capabilities)) {
    const cap = caps.get(name);
    const type = cap?.type;
    if (cap && !cap.granted) {
      fields.push({
        blobAffordance: blob?.fieldName === name ? blob : undefined,
        name,
        state: "withheld",
        type,
        valueJson: null,
      });
      continue;
    }
    if (!Object.hasOwn(data, name)) {
      continue;
    }
    fields.push({
      blobAffordance: blob?.fieldName === name ? blob : undefined,
      name,
      state: "visible",
      type,
      valueJson: prettyFieldValue(data[name]),
    });
  }
  return fields;
}

export function exactWindowSummaryText(window: { earliestAt: string | null; latestAt: string | null; total: number }) {
  const count = window.total.toLocaleString();
  if (window.earliestAt && window.latestAt) {
    return `exact for loaded streams: ${count} records from ${window.earliestAt.slice(0, 10)} to ${window.latestAt.slice(0, 10)}`;
  }
  return `exact for loaded streams: ${count} records`;
}

export function buildExplorerHref(
  routes: Routes,
  opts: {
    query?: string;
    connectionIds?: string[];
    streams?: string[];
    peek?: string;
    since?: string;
    until?: string;
  }
): string {
  const params = new URLSearchParams();
  if (opts.query) {
    params.set("q", opts.query);
  }
  for (const id of opts.connectionIds ?? []) {
    params.append("connection", id);
  }
  for (const s of opts.streams ?? []) {
    params.append("stream", s);
  }
  if (opts.since) {
    params.set("since", opts.since);
  }
  if (opts.until) {
    params.set("until", opts.until);
  }
  if (opts.peek) {
    params.set("peek", opts.peek);
  }
  const qs = params.toString();
  return qs ? `${routes.section.explore}?${qs}` : routes.section.explore;
}

export function feedSectionTitle(lens: ExplorerLens): string {
  if (lens === "search" || lens === "search_with_ignored_time_window") {
    return "Search results";
  }
  if (lens === "time_range") {
    return "Records in range";
  }
  return "Recent records";
}

export function feedCountLabel(count: number, fromSearch: boolean, truncated: boolean): string {
  // Singular only when the count is exactly one *and* not truncated — a
  // truncated "1+" is still a plural ("1+ records"), never "1+ record".
  const singular = count === 1 && !truncated;
  let noun = singular ? "record" : "records";
  if (fromSearch) {
    noun = singular ? "match" : "matches";
  }
  const suffix = truncated ? "+" : "";
  return `${count.toLocaleString()}${suffix} ${noun}`;
}

export function feedDescription(lens: ExplorerLens): string {
  if (lens === "time_range") {
    // Honesty caveat preserved (sources without a time field are excluded from this
    // range view) but stated in owner terms — no "consent-time field" / "data time".
    return "Records from your sources in this date range, newest first. Sources without a time field aren't shown here.";
  }
  if (lens === "search_with_ignored_time_window") {
    // The time-window-not-applied caveat is owner-actionable (clear the search), so it
    // survives; the engine mode (hybrid/lexical) carried no owner meaning and is dropped.
    return "Best matches for your search across your sources. The date range isn't applied to search — clear the search to browse by date.";
  }
  if (lens === "search") {
    // Relevance-ranked, bounded set — copy says "best matches", never "newest first"
    // or "complete". The public-search-no-connection-identity limitation is a mechanism
    // detail, not owner-actionable, so it lives in code/docs, not the result surface.
    return "Best matches for your search across your sources, ranked by relevance.";
  }
  return "Recent activity across your sources, newest first. Search, or pick a date range, to narrow.";
}

export function emptyFeedMessage(lens: ExplorerLens): string {
  if (lens === "search" || lens === "search_with_ignored_time_window") {
    return "No records match this query. Try different terms, or clear the query to browse recent records.";
  }
  if (lens === "time_range") {
    return "No time-anchored records in this window. Widen the range, clear connection or stream chips, or run a connector to collect more data.";
  }
  return "No records yet on any visible connection. Run a connector to start collecting.";
}
