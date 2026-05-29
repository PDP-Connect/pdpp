/**
 * Pure, framework-free helpers for the Explorer feature.
 *
 * Extracted from records-explorer-view.tsx so that node --test can import
 * them without loading React or Next.js. The TSX file re-exports everything
 * from here; call-sites do not need to change their import paths.
 */
import type { RecordKind } from "../../lib/record-kind.ts";
import type { RecordPreview } from "../../lib/record-preview.ts";
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
   * card layout; absent for search hits, which fall back to the `summary` line.
   * Presentation metadata only — see `record-preview.ts`.
   */
  preview?: RecordPreview;
  recordId: string;
  /** Present when the entry came from a search hit, drives the badge. */
  retrievalMode?: "lexical" | "semantic" | "hybrid";
  stream: string;
  /** One-line summary of the record. */
  summary: string;
}

export interface ExplorerPeekData {
  /** Pretty-printed JSON body. `null` when the record could not be read. */
  bodyJson: string | null;
  connectionId: string | null;
  /** Human-readable connection label; falls back to `null` when identity is not resolved. */
  connectionDisplayName: string | null;
  connectorId: string;
  emittedAt: string;
  /** Error message when the body could not be fetched. */
  error: string | null;
  /** Full GET URL the dashboard issued to read this record. */
  readUrl: string;
  recordId: string;
  stream: string;
}

export interface ExplorerWarning {
  /** Stable code for tests + future structured `meta.warnings` mapping. */
  code: "partial_fan_in" | "hybrid_unavailable" | "peek_unreachable" | "search_meta_warning";
  message: string;
}

export interface RecordsExplorerData {
  /** Always present, sorted by display name. */
  connections: ExplorerConnectionFacet[];
  feed: ExplorerFeedEntry[];
  /** Whether feed came from a search call (true) or the recency/time-range fan-out (false). */
  fromSearch: boolean;
  /** Whether the hybrid retrieval endpoint was used for this load. */
  hybridUsed: boolean;
  /** Active feed lens — derived from `query` and `since`/`until` together. */
  lens: ExplorerLens;
  peek: ExplorerPeekData | null;
  query: string;
  /** Connection ids currently selected. */
  selectedConnectionIds: string[];
  /** Stream names currently selected. */
  selectedStreams: string[];
  /** ISO date (yyyy-mm-dd) for the `since` filter, or empty when unset. */
  since: string;
  /** True when the feed was truncated to the explorer's fan-out cap. */
  truncated: boolean;
  /** ISO date (yyyy-mm-dd) for the `until` filter, or empty when unset. */
  until: string;
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
  const verb = fromSearch ? "matches" : "records";
  const suffix = truncated ? "+" : "";
  return `${count.toLocaleString()}${suffix} ${verb}`;
}

export function feedDescription(lens: ExplorerLens, hybridUsed: boolean): string {
  if (lens === "time_range") {
    return "Time-anchored across every stream that declares a consent-time field, sorted by the owner's data time. Streams without a declared time field are excluded.";
  }
  if (lens === "search_with_ignored_time_window") {
    if (hybridUsed) {
      return "Hybrid retrieval (lexical + semantic). The time window in the URL is not applied to search — clear the query to fall back to the time-range lens.";
    }
    return "Lexical retrieval. The time window in the URL is not applied to search — clear the query to fall back to the time-range lens.";
  }
  if (lens === "search") {
    if (hybridUsed) {
      return "Hybrid retrieval (lexical + semantic), deduplicated by record key. Public search results do not yet carry connection identity, so rows are scoped to the connector unless exactly one connection of that type is configured.";
    }
    return "Lexical retrieval. Results match record text under the owner token. Public search results do not yet carry connection identity, so rows are scoped to the connector unless exactly one connection of that type is configured.";
  }
  return "Recent across every visible connection. Submit a query, or pick a date window, to narrow further.";
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
