/**
 * Records explorer view.
 *
 * A query-driven, connection-aware records browser. Reads through the
 * existing typed RS/_ref wrappers — no new endpoints. Connection identity
 * is preserved: two Gmail connections appear as two facet chips and two
 * row-source attributions, never collapsed to a single "gmail" entry.
 *
 * The page resolves search params, fetches feed entries and (when a row
 * is selected) the record body, then passes a flat shape here. The view
 * does not call any data source itself.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { RecordKind } from "../../lib/record-kind.ts";
import type { RecordPreview } from "../../lib/record-preview.ts";
import { defaultWindow } from "../../lib/timeline.ts";
import { EmptyState } from "../shell.tsx";
import { Callout, FilterSummary, PageHeader, Section, SplitLayout } from "../primitives.tsx";
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
  connectorId: string;
  emittedAt: string;
  /** Error message when the body could not be fetched. */
  error: string | null;
  /** Full GET URL the dashboard issued to read this record. Includes the
   *  `connector_id` and `connector_instance_id` query params actually used. */
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

interface ExplorerFeedDayGroup {
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

function isoDayFromMs(ms: number): string {
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

export function RecordsExplorerView({ data, routes }: { data: RecordsExplorerData; routes: Routes }) {
  const {
    query,
    connections,
    selectedConnectionIds,
    selectedStreams,
    since,
    until,
    feed,
    peek,
    fromSearch,
    hybridUsed,
    lens,
    truncated,
    warnings,
  } = data;

  const main = (
    <ExplorerMain
      connections={connections}
      feed={feed}
      hybridUsed={hybridUsed}
      lens={lens}
      peekId={peek ? explorerPeekParam(peek) : null}
      query={query}
      routes={routes}
      selectedConnectionIds={selectedConnectionIds}
      selectedStreams={selectedStreams}
      since={since}
      truncated={truncated}
      until={until}
      warnings={warnings}
    />
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Explore" }]}
        count={feedCountLabel(feed.length, fromSearch, truncated)}
        description="Browse recent records, search by text, or filter by date window. Each connection stays distinct — two Gmail accounts stay two."
        title="Explore"
      />

      {peek ? (
        <SplitLayout
          main={main}
          peek={
            <ExplorerPeek
              closeHref={buildExplorerHref(routes, {
                query,
                connectionIds: selectedConnectionIds,
                streams: selectedStreams,
                since,
                until,
              })}
              peek={peek}
              routes={routes}
            />
          }
        />
      ) : (
        main
      )}
    </>
  );
}

function feedCountLabel(count: number, fromSearch: boolean, truncated: boolean): string {
  const verb = fromSearch ? "matches" : "records";
  const suffix = truncated ? "+" : "";
  return `${count.toLocaleString()}${suffix} ${verb}`;
}

function feedDescription(lens: ExplorerLens, hybridUsed: boolean): string {
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

function ExplorerMain({
  query,
  connections,
  selectedConnectionIds,
  selectedStreams,
  since,
  until,
  feed,
  hybridUsed,
  lens,
  truncated,
  peekId,
  routes,
  warnings,
}: {
  query: string;
  connections: ExplorerConnectionFacet[];
  selectedConnectionIds: string[];
  selectedStreams: string[];
  since: string;
  until: string;
  feed: ExplorerFeedEntry[];
  hybridUsed: boolean;
  lens: ExplorerLens;
  truncated: boolean;
  peekId: string | null;
  routes: Routes;
  warnings: ExplorerWarning[];
}) {
  // In search mode we cannot enforce per-connection scope (public search
  // does not yet accept `connection_id`), so the chip label is honest:
  // it narrows by connector type for the underlying request.
  const connectionLabel = query ? "connector (from connection)" : "connection";
  const filterItems: Array<{ label: string; value: string }> = [];
  for (const id of selectedConnectionIds) {
    const conn = connections.find((c) => c.connectionId === id);
    filterItems.push({ label: connectionLabel, value: conn?.displayName ?? id });
  }
  for (const s of selectedStreams) {
    filterItems.push({ label: "stream", value: s });
  }
  if (since) {
    filterItems.push({ label: "since", value: since });
  }
  if (until) {
    filterItems.push({ label: "until", value: until });
  }

  const resetHref = filterItems.length > 0 || query ? buildExplorerHref(routes, {}) : undefined;
  const exploreHref = routes.section.explore;

  return (
    <>
      <ExplorerControls
        exploreHref={exploreHref}
        query={query}
        routes={routes}
        selectedConnectionIds={selectedConnectionIds}
        selectedStreams={selectedStreams}
        since={since}
        until={until}
      />

      <FilterSummary items={filterItems} resetHref={resetHref} />

      <ConnectionFacets
        connections={connections}
        query={query}
        routes={routes}
        selectedConnectionIds={selectedConnectionIds}
        selectedStreams={selectedStreams}
        since={since}
        until={until}
      />

      <StreamFacets
        connections={connections}
        query={query}
        routes={routes}
        selectedConnectionIds={selectedConnectionIds}
        selectedStreams={selectedStreams}
        since={since}
        until={until}
      />

      <ExplorerWarnings warnings={warnings} />

      {lens === "recent" && feed.length > 0 ? (
        <ActivityStrip
          cells={computeActivityStripCells(feed)}
          query={query}
          routes={routes}
          selectedConnectionIds={selectedConnectionIds}
          selectedStreams={selectedStreams}
          totalRecords={feed.length}
        />
      ) : null}

      <Section description={feedDescription(lens, hybridUsed)} title={feedSectionTitle(lens)}>
        {feed.length === 0 ? (
          <EmptyState hint={emptyFeedMessage(lens)} title="No records" />
        ) : (
          <div className="flex flex-col gap-5">
            {groupFeedByDay(feed).map((group) => (
              <section aria-label={group.label} key={`${group.day || "undated"}:${group.entries[0]?.recordId ?? ""}`}>
                <header className="mb-1.5 flex items-baseline justify-between gap-3 border-border/60 border-b pb-1">
                  <h3 className="pdpp-eyebrow text-muted-foreground">{group.label}</h3>
                  <span className="pdpp-caption text-muted-foreground tabular-nums">
                    {group.entries.length.toLocaleString()}
                  </span>
                </header>
                <ul className="flex flex-col gap-2">
                  {group.entries.map((entry) => {
                    const key = explorerPeekParam(entry);
                    return (
                      <li key={key}>
                        <ExplorerCard
                          entry={entry}
                          peekHref={buildExplorerHref(routes, {
                            query,
                            connectionIds: selectedConnectionIds,
                            streams: selectedStreams,
                            since,
                            until,
                            peek: key,
                          })}
                          recordHref={routes.record(
                            entry.connectionId ?? entry.connectorId,
                            entry.stream,
                            entry.recordId
                          )}
                          selected={peekId === key}
                        />
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
        {truncated && lens === "recent" ? (
          <p className="pdpp-caption mt-3 text-muted-foreground italic">
            Showing the most recent {feed.length.toLocaleString()} records across visible connections. Submit a query or
            pick a date window to narrow further.
          </p>
        ) : null}
        {truncated && lens === "time_range" ? (
          <p className="pdpp-caption mt-3 text-muted-foreground italic">
            Showing the first {feed.length.toLocaleString()} time-anchored records in this window. Narrow by connection,
            stream, or date window to inspect more precisely.
          </p>
        ) : null}
      </Section>
    </>
  );
}

function emptyFeedMessage(lens: ExplorerLens): string {
  if (lens === "search" || lens === "search_with_ignored_time_window") {
    return "No records match this query. Try different terms, or clear the query to browse recent records.";
  }
  if (lens === "time_range") {
    return "No time-anchored records in this window. Widen the range, clear connection or stream chips, or run a connector to collect more data.";
  }
  return "No records yet on any visible connection. Run a connector to start collecting.";
}

function ExplorerControls({
  exploreHref,
  query,
  routes,
  selectedConnectionIds,
  selectedStreams,
  since,
  until,
}: {
  exploreHref: string;
  query: string;
  routes: Routes;
  selectedConnectionIds: string[];
  selectedStreams: string[];
  since: string;
  until: string;
}) {
  const hasDateWindow = since || until;
  return (
    <form action={exploreHref} className="mb-5" method="get">
      {/* Preserve chip state on form submit. */}
      {selectedConnectionIds.map((id) => (
        <input key={`c:${id}`} name="connection" type="hidden" value={id} />
      ))}
      {selectedStreams.map((s) => (
        <input key={`s:${s}`} name="stream" type="hidden" value={s} />
      ))}

      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1" htmlFor="records-explorer-q">
          <span className="pdpp-eyebrow text-muted-foreground">Search records</span>
          <Input
            defaultValue={query}
            id="records-explorer-q"
            name="q"
            placeholder="text across every searchable stream…"
            type="search"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1" htmlFor="records-explorer-since">
          <span className="pdpp-eyebrow text-muted-foreground">Since</span>
          <Input defaultValue={since} id="records-explorer-since" name="since" type="date" />
        </label>
        <label className="flex min-w-0 flex-col gap-1" htmlFor="records-explorer-until">
          <span className="pdpp-eyebrow text-muted-foreground">Until</span>
          <Input defaultValue={until} id="records-explorer-until" name="until" type="date" />
        </label>
        <Button className="mt-5" size="sm" type="submit" variant="default">
          Find
        </Button>
        {hasDateWindow ? (
          <Link
            className={`${buttonVariants({ variant: "ghost", size: "sm" })} mt-5`}
            href={buildExplorerHref(routes, {
              query,
              connectionIds: selectedConnectionIds,
              streams: selectedStreams,
            })}
          >
            Clear dates
          </Link>
        ) : null}
      </div>

      <div className="pdpp-caption mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
        <span className="text-muted-foreground/60">Range:</span>
        {([1, 7, 30, 90] as const).map((d) => {
          const { since: s, until: u } = defaultWindow(d);
          const href = buildExplorerHref(routes, {
            query,
            connectionIds: selectedConnectionIds,
            streams: selectedStreams,
            since: s,
            until: u,
          });
          return (
            <Link className="underline-offset-2 hover:text-foreground hover:underline" href={href} key={d}>
              {d === 1 ? "today" : `${d}d`}
            </Link>
          );
        })}
        <span className="mx-1 text-muted-foreground/30">·</span>
        <Link
          className="text-muted-foreground/70 underline-offset-2 hover:text-foreground hover:underline"
          href={routes.section.search}
        >
          Jump to trace / grant / run id →
        </Link>
      </div>
    </form>
  );
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

function ConnectionFacets({
  connections,
  selectedConnectionIds,
  selectedStreams,
  query,
  routes,
  since,
  until,
}: {
  connections: ExplorerConnectionFacet[];
  selectedConnectionIds: string[];
  selectedStreams: string[];
  query: string;
  routes: Routes;
  since: string;
  until: string;
}) {
  if (connections.length === 0) {
    return null;
  }
  return (
    <div className="pdpp-caption mb-4 flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="pdpp-eyebrow text-muted-foreground">Connections</span>
      {connections.map((c) => {
        const isOn = selectedConnectionIds.includes(c.connectionId);
        const nextIds = isOn
          ? selectedConnectionIds.filter((id) => id !== c.connectionId)
          : [...selectedConnectionIds, c.connectionId];
        const href = buildExplorerHref(routes, {
          query,
          connectionIds: nextIds,
          streams: selectedStreams,
          since,
          until,
        });
        return (
          <Link
            aria-pressed={isOn}
            className={`inline-flex items-baseline gap-1.5 rounded-full border px-2 py-0.5 transition-colors ${
              isOn
                ? "border-foreground/60 bg-muted text-foreground"
                : "border-border/80 bg-background hover:bg-muted/50"
            }`}
            href={href}
            key={c.connectionId}
            title={`${c.displayName} · ${c.connectorId} · ${c.connectionId}`}
          >
            <span className="font-medium">{c.displayName}</span>
            <span className="text-muted-foreground">{c.connectorId}</span>
          </Link>
        );
      })}
    </div>
  );
}

function StreamFacets({
  connections,
  selectedConnectionIds,
  selectedStreams,
  query,
  routes,
  since,
  until,
}: {
  connections: ExplorerConnectionFacet[];
  selectedConnectionIds: string[];
  selectedStreams: string[];
  query: string;
  routes: Routes;
  since: string;
  until: string;
}) {
  // Limit to streams of the currently selected connections; falls back to
  // every visible stream when nothing is filtered.
  const scope = selectedConnectionIds.length
    ? connections.filter((c) => selectedConnectionIds.includes(c.connectionId))
    : connections;
  const streamCounts = new Map<string, number>();
  for (const c of scope) {
    for (const s of c.streams) {
      streamCounts.set(s, (streamCounts.get(s) ?? 0) + 1);
    }
  }
  const streams = [...streamCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (streams.length === 0) {
    return null;
  }
  return (
    <div className="pdpp-caption mb-5 flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="pdpp-eyebrow text-muted-foreground">Streams</span>
      {streams.map(([name, count]) => {
        const isOn = selectedStreams.includes(name);
        const nextStreams = isOn ? selectedStreams.filter((s) => s !== name) : [...selectedStreams, name];
        const href = buildExplorerHref(routes, {
          query,
          connectionIds: selectedConnectionIds,
          streams: nextStreams,
          since,
          until,
        });
        return (
          <Link
            aria-pressed={isOn}
            className={`inline-flex items-baseline gap-1.5 rounded-full border px-2 py-0.5 font-mono transition-colors ${
              isOn
                ? "border-foreground/60 bg-muted text-foreground"
                : "border-border/80 bg-background hover:bg-muted/50"
            }`}
            href={href}
            key={name}
          >
            <span>{name}</span>
            <span className="text-muted-foreground tabular-nums">{count}</span>
          </Link>
        );
      })}
    </div>
  );
}

function ExplorerWarnings({ warnings }: { warnings: ExplorerWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }
  return (
    <Callout
      className="mb-4"
      description="Some sources did not return a complete result for this view. The records below are partial."
      title="Partial results"
    >
      <ul className="pdpp-caption mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
        {warnings.map((w) => (
          <li key={`${w.code}:${w.message}`}>
            <span className="font-mono text-foreground">{w.code}</span>
            <span> — </span>
            <span>{w.message}</span>
          </li>
        ))}
      </ul>
    </Callout>
  );
}

// Server-deterministic day label for the strip tooltip. Locale-pinned, UTC.
const ACTIVITY_CELL_LABEL_FMT = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function ActivityStrip({
  cells,
  query,
  routes,
  selectedConnectionIds,
  selectedStreams,
  totalRecords,
}: {
  cells: ExplorerActivityCell[];
  query: string;
  routes: Routes;
  selectedConnectionIds: string[];
  selectedStreams: string[];
  totalRecords: number;
}) {
  if (cells.length === 0) {
    return null;
  }
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0);
  return (
    <section aria-label={`activity over the last ${cells.length} days`} className="mb-5">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h2 className="pdpp-eyebrow text-muted-foreground">Activity · last {cells.length} days</h2>
        <span className="pdpp-caption text-muted-foreground tabular-nums">
          from the most recent {totalRecords.toLocaleString()} records
        </span>
      </div>
      <div className="flex h-10 items-end gap-[2px]">
        {cells.map((c) => {
          const intensity = max === 0 || c.count === 0 ? 0 : 0.18 + 0.82 * (c.count / max);
          const nextDay = isoDayFromMs(Date.parse(`${c.day}T00:00:00Z`) + MS_PER_DAY);
          const dayLabel = ACTIVITY_CELL_LABEL_FMT.format(new Date(`${c.day}T00:00:00Z`));
          const title = `${dayLabel} · ${c.count.toLocaleString()} record${c.count === 1 ? "" : "s"}`;
          const wrapperClass = `relative flex h-full min-w-[6px] flex-1 flex-col justify-end rounded-sm ${
            c.isToday ? "ring-1 ring-foreground/40" : ""
          }`;
          const fill = (
            <span
              aria-hidden
              className="block w-full rounded-sm bg-foreground"
              style={{
                height: c.count === 0 ? "8%" : `${Math.round(intensity * 100)}%`,
                opacity: c.count === 0 ? 0.12 : 1,
              }}
            />
          );
          if (c.count === 0) {
            return (
              <span className={wrapperClass} key={c.day} title={title}>
                {fill}
              </span>
            );
          }
          const href = buildExplorerHref(routes, {
            query,
            connectionIds: selectedConnectionIds,
            streams: selectedStreams,
            since: c.day,
            until: nextDay,
          });
          return (
            <Link className={`${wrapperClass} hover:opacity-80`} href={href} key={c.day} title={title}>
              {fill}
            </Link>
          );
        })}
      </div>
    </section>
  );
}

// Per-kind left-rail accent. The temperature system from the designer's
// Explorer: message rows read "human" (copper), event rows read "protocol"
// (blue), money rows read "value" (success green). `titled` and `generic`
// stay neutral so visual weight is reserved for the type-distinct kinds.
// These map onto the same brand tokens the rest of the dashboard uses; no new
// color is introduced.
const KIND_RAIL_TONE: Record<RecordKind, string> = {
  message: "before:bg-[color:var(--human)]",
  money: "before:bg-[color:var(--success)]",
  event: "before:bg-primary",
  titled: "before:bg-border",
  generic: "before:bg-border",
};

// Card eyebrow: connector / stream / connection, shared across every kind so a
// row stays attributable to its exact connection no matter how it renders.
function CardEyebrow({ entry }: { entry: ExplorerFeedEntry }) {
  return (
    <div className="pdpp-eyebrow flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted-foreground">
      <span className="font-medium font-mono text-foreground/80">{entry.connectorId}</span>
      <span className="font-mono">{entry.stream}</span>
      {entry.connectionDisplayName ? (
        <span className="truncate normal-case tracking-normal" title={entry.connectionId ?? ""}>
          · {entry.connectionDisplayName}
        </span>
      ) : null}
    </div>
  );
}

function RetrievalBadge({ entry }: { entry: ExplorerFeedEntry }) {
  if (entry.retrievalMode !== "semantic" && entry.retrievalMode !== "hybrid") {
    return null;
  }
  return (
    <span
      className="ml-2 inline-flex items-baseline gap-1 rounded border border-border px-1.5 py-0.5 align-baseline text-[10px] text-muted-foreground uppercase tracking-wide"
      title={
        entry.retrievalMode === "hybrid"
          ? "Found by hybrid retrieval (experimental)."
          : "Found by semantic retrieval (experimental)."
      }
    >
      {entry.retrievalMode}
    </span>
  );
}

function SummaryBody({ entry }: { entry: ExplorerFeedEntry }) {
  return (
    <p className="break-words text-foreground text-sm">
      {entry.summary}
      <RetrievalBadge entry={entry} />
    </p>
  );
}

function MoneyBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.amount || preview.title)) {
    return null;
  }
  return (
    <div className="flex items-baseline justify-between gap-3">
      <div className="min-w-0">
        {preview.title ? <p className="truncate font-medium text-foreground text-sm">{preview.title}</p> : null}
        {preview.body ? <p className="pdpp-caption truncate text-muted-foreground">{preview.body}</p> : null}
      </div>
      {preview.amount ? (
        <span
          className={`shrink-0 font-mono text-base tabular-nums ${
            preview.amountPositive ? "text-[color:var(--success)]" : "text-foreground"
          }`}
        >
          {preview.amount}
        </span>
      ) : null}
    </div>
  );
}

function MessageBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.author || preview.body || preview.title)) {
    return null;
  }
  return (
    <div className="min-w-0">
      {preview.author ? <span className="font-medium text-foreground text-sm">{preview.author}</span> : null}
      {preview.title ? <p className="truncate font-medium text-foreground text-sm">{preview.title}</p> : null}
      {preview.body ? (
        <p className="mt-0.5 line-clamp-2 text-muted-foreground text-sm leading-snug">{preview.body}</p>
      ) : null}
    </div>
  );
}

function EventBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.title || preview.eventTime)) {
    return null;
  }
  return (
    <div className="min-w-0">
      {preview.eventTime ? (
        <span className="font-medium font-mono text-primary text-sm tabular-nums">{preview.eventTime}</span>
      ) : null}
      {preview.title ? <p className="truncate font-medium text-foreground text-sm">{preview.title}</p> : null}
      {preview.body ? <p className="pdpp-caption truncate text-muted-foreground">{preview.body}</p> : null}
    </div>
  );
}

function TitledBody({ preview }: { preview: RecordPreview }) {
  if (!preview.title) {
    return null;
  }
  return (
    <div className="min-w-0">
      <p className="truncate font-medium text-foreground text-sm">{preview.title}</p>
      {preview.body ? (
        <p className="mt-0.5 line-clamp-2 text-muted-foreground text-sm leading-snug">{preview.body}</p>
      ) : null}
    </div>
  );
}

const PREVIEW_BODY_BY_KIND: Record<RecordKind, (preview: RecordPreview) => ReactNode> = {
  event: (preview) => <EventBody preview={preview} />,
  generic: () => null,
  message: (preview) => <MessageBody preview={preview} />,
  money: (preview) => <MoneyBody preview={preview} />,
  titled: (preview) => <TitledBody preview={preview} />,
};

/**
 * Kind-specific card body. Renders the structured preview when present (a
 * money row leads with its amount, a message row with author + body, an event
 * row with its time), and falls back to the one-line summary otherwise. The
 * fallback path is what every search hit and every unclassified record uses,
 * so the feed never over-promises a shape it could not extract.
 */
function CardBody({ entry }: { entry: ExplorerFeedEntry }) {
  const body = entry.preview ? PREVIEW_BODY_BY_KIND[entry.preview.kind](entry.preview) : null;
  return body ?? <SummaryBody entry={entry} />;
}

function ExplorerCard({
  entry,
  peekHref,
  recordHref,
  selected,
}: {
  entry: ExplorerFeedEntry;
  peekHref: string;
  recordHref: string;
  selected: boolean;
}) {
  const kind = entry.kind ?? "generic";
  // A 3px left rail in the kind's temperature. `before:` pseudo-element keeps
  // the rail flush with the rounded card edge without an extra wrapper.
  const rail = `relative overflow-hidden rounded-lg border before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-[''] ${KIND_RAIL_TONE[kind]}`;
  const surface = selected
    ? "border-foreground/30 bg-muted/50"
    : "border-border/70 bg-card hover:border-border hover:bg-muted/20";
  return (
    <div className={`${rail} ${surface} transition-colors`}>
      <Link className="block py-2.5 pr-3 pl-4" href={peekHref}>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <CardEyebrow entry={entry} />
          <span className="pdpp-caption shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
            <Timestamp value={entry.displayAt} />
          </span>
        </div>
        <CardBody entry={entry} />
      </Link>
      <div className="flex justify-end border-border/50 border-t px-4 py-1">
        <Link
          className="pdpp-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          href={recordHref}
        >
          open →
        </Link>
      </div>
    </div>
  );
}

function ExplorerPeek({
  peek,
  routes,
  closeHref,
}: {
  peek: ExplorerPeekData;
  routes: Routes;
  closeHref: string;
}): ReactNode {
  const openHref = routes.record(peek.connectionId ?? peek.connectorId, peek.stream, peek.recordId);
  return (
    <aside
      aria-label="Record peek"
      className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto overscroll-contain rounded-md border border-border/80 bg-background"
    >
      <div className="pdpp-caption sticky top-0 flex items-center justify-between gap-2 border-border/80 border-b bg-muted/40 px-3 py-2 backdrop-blur">
        <span className="truncate font-medium font-mono">
          {peek.connectorId} / {peek.stream}
        </span>
        <div className="flex items-center gap-3 whitespace-nowrap">
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={openHref}
          >
            open full →
          </Link>
          <Link aria-label="close peek" className="text-muted-foreground hover:text-foreground" href={closeHref}>
            ×
          </Link>
        </div>
      </div>
      <div className="pdpp-caption flex flex-col gap-3 p-3">
        <div>
          <div className="pdpp-eyebrow mb-1">Record id</div>
          <code className="break-all font-mono text-foreground">{peek.recordId}</code>
        </div>
        <div>
          <div className="pdpp-eyebrow mb-1">Emitted</div>
          <Timestamp value={peek.emittedAt} />
        </div>
        <div>
          <div className="pdpp-eyebrow mb-1">Read URL</div>
          <pre className="overflow-x-auto rounded bg-muted p-2 font-mono">{peek.readUrl}</pre>
        </div>
        <div>
          <div className="pdpp-eyebrow mb-1">Body</div>
          <PeekBody peek={peek} />
        </div>
      </div>
    </aside>
  );
}

function PeekBody({ peek }: { peek: ExplorerPeekData }) {
  if (peek.error) {
    return <p className="text-destructive">{peek.error}</p>;
  }
  if (peek.bodyJson) {
    return <pre className="max-h-[40vh] overflow-auto rounded bg-muted p-2 font-mono">{peek.bodyJson}</pre>;
  }
  return <p className="text-muted-foreground italic">No body available.</p>;
}
