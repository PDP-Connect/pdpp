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
import { Input } from "@/components/ui/input.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DataList, FilterSummary, PageHeader, Section, SplitLayout, Toolbar } from "../primitives.tsx";
import type { Routes } from "./routes.ts";

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

export interface RecordsExplorerData {
  /** Always present, sorted by display name. */
  connections: ExplorerConnectionFacet[];
  feed: ExplorerFeedEntry[];
  /** Whether feed came from a search call (true) or the recency fan-out (false). */
  fromSearch: boolean;
  /** Whether the hybrid retrieval endpoint was used for this load. */
  hybridUsed: boolean;
  peek: ExplorerPeekData | null;
  query: string;
  /** Connection ids currently selected. */
  selectedConnectionIds: string[];
  /** Stream names currently selected. */
  selectedStreams: string[];
  /** True when the feed was truncated to the explorer's fan-out cap. */
  truncated: boolean;
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

export function buildExplorerHref(
  routes: Routes,
  opts: {
    query?: string;
    connectionIds?: string[];
    streams?: string[];
    peek?: string;
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
  if (opts.peek) {
    params.set("peek", opts.peek);
  }
  const qs = params.toString();
  return qs ? `${routes.section.recordsExplorer}?${qs}` : routes.section.recordsExplorer;
}

export function RecordsExplorerView({ data, routes }: { data: RecordsExplorerData; routes: Routes }) {
  const { query, connections, selectedConnectionIds, selectedStreams, feed, peek, fromSearch, hybridUsed, truncated } =
    data;

  const main = (
    <ExplorerMain
      connections={connections}
      feed={feed}
      fromSearch={fromSearch}
      hybridUsed={hybridUsed}
      peekId={peek ? explorerPeekParam(peek) : null}
      query={query}
      routes={routes}
      selectedConnectionIds={selectedConnectionIds}
      selectedStreams={selectedStreams}
      truncated={truncated}
    />
  );

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: "Records", href: routes.section.records }, { label: "Explorer" }]}
        count={feedCountLabel(feed.length, fromSearch, truncated)}
        description="Query across every owner-visible connection. Connection identity is preserved — two accounts of the same connector type stay distinct."
        title="Explorer"
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

function feedDescription(fromSearch: boolean, hybridUsed: boolean): string {
  if (!fromSearch) {
    return "Recent across every visible connection. Submit a query to search.";
  }
  if (hybridUsed) {
    return "Hybrid retrieval (lexical + semantic), deduplicated by record key. Public search results do not yet carry connection identity, so rows are scoped to the connector unless exactly one connection of that type is configured.";
  }
  return "Lexical retrieval. Results match record text under the owner token. Public search results do not yet carry connection identity, so rows are scoped to the connector unless exactly one connection of that type is configured.";
}

function ExplorerMain({
  query,
  connections,
  selectedConnectionIds,
  selectedStreams,
  feed,
  fromSearch,
  hybridUsed,
  truncated,
  peekId,
  routes,
}: {
  query: string;
  connections: ExplorerConnectionFacet[];
  selectedConnectionIds: string[];
  selectedStreams: string[];
  feed: ExplorerFeedEntry[];
  fromSearch: boolean;
  hybridUsed: boolean;
  truncated: boolean;
  peekId: string | null;
  routes: Routes;
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

  const resetHref = filterItems.length > 0 || query ? buildExplorerHref(routes, {}) : undefined;

  return (
    <>
      <form action={routes.section.recordsExplorer} method="get">
        <Toolbar>
          <label className="flex min-w-0 flex-1 flex-col gap-1" htmlFor="records-explorer-q">
            <span className="pdpp-eyebrow">Query</span>
            <Input
              defaultValue={query}
              id="records-explorer-q"
              name="q"
              placeholder="text across every searchable stream…"
              type="search"
            />
          </label>
          {/* Preserve chip state on form submit. */}
          {selectedConnectionIds.map((id) => (
            <input key={`c:${id}`} name="connection" type="hidden" value={id} />
          ))}
          {selectedStreams.map((s) => (
            <input key={`s:${s}`} name="stream" type="hidden" value={s} />
          ))}
          <button
            className="pdpp-label mt-5 self-start rounded-md border border-border bg-background px-3 py-1.5 hover:bg-muted/60"
            type="submit"
          >
            Search
          </button>
        </Toolbar>
      </form>

      <FilterSummary items={filterItems} resetHref={resetHref} />

      <ConnectionFacets
        connections={connections}
        query={query}
        routes={routes}
        selectedConnectionIds={selectedConnectionIds}
        selectedStreams={selectedStreams}
      />

      <StreamFacets
        connections={connections}
        query={query}
        routes={routes}
        selectedConnectionIds={selectedConnectionIds}
        selectedStreams={selectedStreams}
      />

      <Section description={feedDescription(fromSearch, hybridUsed)} title="Records">
        {feed.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">
            {fromSearch ? "No records match this query." : "No retained records yet on any visible connection."}
          </p>
        ) : (
          <DataList>
            {feed.map((entry) => {
              const key = explorerPeekParam(entry);
              return (
                <li key={key}>
                  <ExplorerRow
                    entry={entry}
                    peekHref={buildExplorerHref(routes, {
                      query,
                      connectionIds: selectedConnectionIds,
                      streams: selectedStreams,
                      peek: key,
                    })}
                    recordHref={routes.record(entry.connectionId ?? entry.connectorId, entry.stream, entry.recordId)}
                    selected={peekId === key}
                  />
                </li>
              );
            })}
          </DataList>
        )}
        {truncated ? (
          <p className="pdpp-caption mt-3 text-muted-foreground italic">
            Showing the most recent {feed.length.toLocaleString()} records across visible connections. Submit a query to
            narrow further.
          </p>
        ) : null}
      </Section>
    </>
  );
}

function ConnectionFacets({
  connections,
  selectedConnectionIds,
  selectedStreams,
  query,
  routes,
}: {
  connections: ExplorerConnectionFacet[];
  selectedConnectionIds: string[];
  selectedStreams: string[];
  query: string;
  routes: Routes;
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
}: {
  connections: ExplorerConnectionFacet[];
  selectedConnectionIds: string[];
  selectedStreams: string[];
  query: string;
  routes: Routes;
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

function ExplorerRow({
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
  return (
    <div
      className={`grid gap-1 px-3 py-2.5 transition-colors sm:grid-cols-[11rem_minmax(0,14rem)_1fr_auto] sm:items-baseline sm:gap-4 ${
        selected ? "bg-muted/50" : "hover:bg-muted/30"
      }`}
    >
      <Link className="pdpp-caption whitespace-nowrap text-muted-foreground" href={peekHref}>
        <Timestamp value={entry.displayAt} />
      </Link>
      <Link className="pdpp-caption flex items-baseline gap-2 whitespace-nowrap" href={peekHref}>
        <span className="truncate font-medium font-mono text-foreground">{entry.connectorId}</span>
        <span className="truncate font-mono text-muted-foreground">{entry.stream}</span>
      </Link>
      <Link className="pdpp-caption break-words" href={peekHref}>
        {entry.summary}
        {entry.retrievalMode === "semantic" || entry.retrievalMode === "hybrid" ? (
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
        ) : null}
      </Link>
      <span className="pdpp-caption flex shrink-0 items-baseline gap-3 whitespace-nowrap text-muted-foreground">
        {entry.connectionDisplayName ? (
          <span className="truncate" title={entry.connectionId ?? ""}>
            {entry.connectionDisplayName}
          </span>
        ) : null}
        <Link className="underline-offset-2 hover:text-foreground hover:underline" href={recordHref}>
          open →
        </Link>
      </span>
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
