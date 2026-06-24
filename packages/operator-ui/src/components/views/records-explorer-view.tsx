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
import { formatConnectorKeyForDisplay, formatConnectorNameForDisplay } from "../../lib/connector-display.ts";
import { humanizeFieldLabel } from "../../lib/field-label.ts";
import type { RecordKind } from "../../lib/record-kind.ts";
import type { RecordPreview } from "../../lib/record-preview.ts";
import { defaultWindow } from "../../lib/timeline.ts";
import { Button, buttonVariants } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
import { Timestamp } from "../../ui/timestamp.tsx";
import { EmptyState } from "../empty-state.tsx";
import { Callout, FilterSummary, PageHeader, Section, SplitLayout } from "../primitives.tsx";
import type { Routes } from "./routes.ts";

export type {
  ExplorerActivityCell,
  ExplorerActivitySummary,
  ExplorerBlobAffordance,
  ExplorerConnectionFacet,
  ExplorerFeedDayGroup,
  ExplorerFeedEntry,
  ExplorerFieldCapability,
  ExplorerLens,
  ExplorerPeekData,
  ExplorerStreamDoor,
  ExplorerStreamSeeAllLink,
  ExplorerWarning,
  RecordsExplorerData,
  SetDescriptor,
} from "./explorer-utils.ts";
// biome-ignore lint/performance/noBarrelFile: This view preserves the historical import seam while helpers live in a framework-free module.
export {
  buildBlobAffordance,
  buildExplorerHref,
  buildPeekFields,
  computeActivityStripCells,
  emptyFeedMessage,
  exactWindowSummaryText,
  explorerPeekParam,
  feedCountLabel,
  feedDescription,
  feedSectionTitle,
  groupFeedByDay,
  isoDayFromMs,
  parseExplorerPeekParam,
} from "./explorer-utils.ts";

import type {
  ExplorerActivitySummary,
  ExplorerBlobAffordance,
  ExplorerConnectionFacet,
  ExplorerFeedEntry,
  ExplorerLens,
  ExplorerPeekData,
  ExplorerWarning,
  RecordsExplorerData,
} from "./explorer-utils.ts";
import {
  buildExplorerHref,
  emptyFeedMessage,
  explorerPeekParam,
  feedCountLabel,
  feedDescription,
  feedSectionTitle,
  groupFeedByDay,
} from "./explorer-utils.ts";

interface ExplorerFilterItem {
  label: string;
  /** Link to the same view with just this one filter dropped. */
  removeHref: string;
  value: string;
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
    activitySummary,
    peek,
    fromSearch,
    lens,
    truncated,
    warnings,
  } = data;

  const main = (
    <ExplorerMain
      activitySummary={activitySummary}
      connections={connections}
      feed={feed}
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
        description="Search and browse records across every connection. Filter by connection, stream, or date — each account stays distinct."
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

function buildExplorerFilterItems({
  connections,
  query,
  routes,
  selectedConnectionIds,
  selectedStreams,
  since,
  until,
}: {
  connections: ExplorerConnectionFacet[];
  query: string;
  routes: Routes;
  selectedConnectionIds: string[];
  selectedStreams: string[];
  since: string;
  until: string;
}): ExplorerFilterItem[] {
  // In search mode we cannot enforce per-connection scope (public search
  // does not yet accept `connection_id`), so the chip label is honest:
  // it narrows by connector type for the underlying request.
  const connectionLabel = query ? "connector (from connection)" : "connection";
  const filterItems: ExplorerFilterItem[] = [];
  for (const id of selectedConnectionIds) {
    const conn = connections.find((c) => c.connectionId === id);
    filterItems.push({
      label: connectionLabel,
      value: query
        ? formatConnectorKeyForDisplay(conn?.connectorId ?? id)
        : formatConnectorNameForDisplay({
            connectorId: conn?.connectorId ?? id,
            displayName: conn?.displayName,
          }),
      // Drop just this connection, preserving query, the other connections,
      // streams, and the date window.
      removeHref: buildExplorerHref(routes, {
        query,
        connectionIds: selectedConnectionIds.filter((c) => c !== id),
        streams: selectedStreams,
        since,
        until,
      }),
    });
  }
  for (const stream of selectedStreams) {
    filterItems.push({
      label: "stream",
      value: stream,
      removeHref: buildExplorerHref(routes, {
        query,
        connectionIds: selectedConnectionIds,
        streams: selectedStreams.filter((s) => s !== stream),
        since,
        until,
      }),
    });
  }
  if (since) {
    filterItems.push({
      label: "since",
      value: since,
      removeHref: buildExplorerHref(routes, {
        query,
        connectionIds: selectedConnectionIds,
        streams: selectedStreams,
        until,
      }),
    });
  }
  if (until) {
    filterItems.push({
      label: "until",
      value: until,
      removeHref: buildExplorerHref(routes, {
        query,
        connectionIds: selectedConnectionIds,
        streams: selectedStreams,
        since,
      }),
    });
  }
  return filterItems;
}

function ExplorerMain({
  query,
  connections,
  selectedConnectionIds,
  selectedStreams,
  since,
  until,
  feed,
  activitySummary,
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
  activitySummary: ExplorerActivitySummary | null;
  lens: ExplorerLens;
  truncated: boolean;
  peekId: string | null;
  routes: Routes;
  warnings: ExplorerWarning[];
}) {
  const filterItems = buildExplorerFilterItems({
    connections,
    query,
    routes,
    selectedConnectionIds,
    selectedStreams,
    since,
    until,
  });

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

      {activitySummary?.source === "exact_window" ? <CorpusSummary summary={activitySummary} /> : null}

      {/* The legacy loaded-only ActivityStrip ("from the most recent N records")
          was RETIRED (over-time-chart cell §0/§8): a histogram fed by loaded
          entries and labeled "most recent N" is a count-reachability lie. The
          honest, brushable volume band — TRUE per-bucket totals over the filtered
          grant-scoped corpus (server group_by_time aggregate) — renders in the
          live ExploreCanvas (over-time-chart.tsx). Two strips can never both ship. */}

      <Section description={feedDescription(lens)} title={feedSectionTitle(lens)}>
        <ExplorerFeedContent
          connections={connections}
          feed={feed}
          lens={lens}
          peekId={peekId}
          query={query}
          routes={routes}
          selectedConnectionIds={selectedConnectionIds}
          selectedStreams={selectedStreams}
          since={since}
          until={until}
        />
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

function ExplorerFeedContent({
  connections,
  feed,
  lens,
  peekId,
  query,
  routes,
  selectedConnectionIds,
  selectedStreams,
  since,
  until,
}: {
  connections: ExplorerConnectionFacet[];
  feed: ExplorerFeedEntry[];
  lens: ExplorerLens;
  peekId: string | null;
  query: string;
  routes: Routes;
  selectedConnectionIds: string[];
  selectedStreams: string[];
  since: string;
  until: string;
}) {
  if (feed.length === 0) {
    return <ExplorerEmptyFeed connections={connections} lens={lens} routes={routes} />;
  }
  return (
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
                    recordHref={routes.record(entry.connectionId ?? entry.connectorId, entry.stream, entry.recordId)}
                    selected={peekId === key}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ExplorerEmptyFeed({
  connections,
  lens,
  routes,
}: {
  connections: ExplorerConnectionFacet[];
  lens: ExplorerLens;
  routes: Routes;
}) {
  if (connections.length === 0) {
    return (
      <EmptyState
        hint={
          <span>
            No connectors are configured yet.{" "}
            <Link className="underline underline-offset-2 hover:text-foreground" href={routes.section.addSource}>
              Add a source →
            </Link>
          </span>
        }
        title="No sources"
      />
    );
  }
  return <EmptyState hint={emptyFeedMessage(lens)} title="No records" />;
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
      <span className="pdpp-eyebrow text-muted-foreground">Sources</span>
      {connections.map((c) => {
        const isOn = selectedConnectionIds.includes(c.connectionId);
        const displayName = formatConnectorNameForDisplay({
          connectorId: c.connectorId,
          displayName: c.displayName,
        });
        const connectorKey = formatConnectorKeyForDisplay(c.connectorId);
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
            title={`${displayName} · ${connectorKey} · ${c.connectionId}`}
          >
            <span className="font-medium">{displayName}</span>
            <span className="text-muted-foreground">{connectorKey}</span>
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

function CorpusSummary({ summary }: { summary: ExplorerActivitySummary }) {
  return (
    <div className="pdpp-caption mb-4 rounded border border-border/80 bg-muted/30 px-3 py-2 text-muted-foreground">
      <span className="pdpp-eyebrow mr-2 text-foreground">Loaded stream window</span>
      <span>{summary.text}</span>
    </div>
  );
}

function BlobAffordance({ affordance }: { affordance: ExplorerBlobAffordance }) {
  if (affordance.state === "unavailable") {
    return (
      <span className="pdpp-caption inline-flex items-center rounded-full border border-border/80 px-2 py-0.5 text-muted-foreground">
        {affordance.reason ?? "Blob unavailable under active projection."}
      </span>
    );
  }
  if (!affordance.href) {
    return null;
  }
  return (
    <a
      className="pdpp-caption inline-flex items-center rounded-full border border-border/80 px-2 py-0.5 font-mono text-primary underline-offset-2 hover:underline"
      href={affordance.href}
    >
      Open blob →
    </a>
  );
}

// Per-kind hairline rule tone — the brand's temperature duality (`.impeccable`
// §3.3): copper (`--human`) for human/message/person surfaces, cool blue
// (`--primary`) for protocol / money / system surfaces. `titled` and `generic`
// stay neutral so visual weight is reserved for the type-distinct kinds. These
// map onto the same brand tokens the rest of the dashboard uses; no new color
// is introduced. The marker is a true 1px hairline (see ExplorerCard), never a
// decorative side-stripe.
const KIND_RULE_TONE: Record<RecordKind, string> = {
  message: "before:bg-[color:var(--human)]",
  money: "before:bg-primary",
  event: "before:bg-primary",
  // Activity and location are surfaces of the person's lived life, so they take
  // the warm copper rule alongside message; reader is content and stays neutral.
  activity: "before:bg-[color:var(--human)]",
  location: "before:bg-[color:var(--human)]",
  reader: "before:bg-border",
  titled: "before:bg-border",
  generic: "before:bg-border",
};

// Card eyebrow: connector / stream / connection, shared across every kind so a
// row stays attributable to its exact connection no matter how it renders.
function CardEyebrow({ entry }: { entry: ExplorerFeedEntry }) {
  const connectorKey = formatConnectorKeyForDisplay(entry.connectorId);
  const connectionDisplayName = formatConnectorNameForDisplay({
    connectorId: entry.connectorId,
    displayName: entry.connectionDisplayName,
  });
  return (
    <div className="pdpp-eyebrow flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-muted-foreground">
      <span className="font-medium font-mono text-foreground/80">{connectorKey}</span>
      <span className="font-mono">{entry.stream}</span>
      {entry.connectionDisplayName ? (
        <span className="truncate normal-case tracking-normal" title={entry.connectionId ?? ""}>
          · {connectionDisplayName}
        </span>
      ) : null}
    </div>
  );
}

function SummaryBody({ entry }: { entry: ExplorerFeedEntry }) {
  // The old field-name-guessing `entry.summary` is gone. Show honest content: the
  // declared-role preview title/body, else a search hit's matched snippet, else the
  // neutral record id — never a guessed summary. (This view is the non-live explorer
  // path; the live feed renders via explore-canvas's rowPrimary/rowSecondary.)
  const line = entry.preview?.title ?? entry.preview?.body ?? entry.snippet ?? entry.recordId;
  return <p className="break-words text-foreground text-sm">{line}</p>;
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

function ActivityBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.title || preview.stats?.length)) {
    return null;
  }
  return (
    <div className="min-w-0">
      {preview.title ? <p className="truncate font-medium text-foreground text-sm">{preview.title}</p> : null}
      {preview.stats?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
          {preview.stats.map((stat) => (
            <div className="min-w-0" key={stat.label}>
              <span className="font-mono font-semibold text-[color:var(--human)] text-sm tabular-nums">
                {stat.value}
              </span>
              <span className="pdpp-eyebrow ml-1.5 text-muted-foreground">{stat.label}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ReaderBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.title || preview.body)) {
    return null;
  }
  return (
    <div className="min-w-0">
      {preview.title ? (
        <p className="truncate font-medium text-[0.95rem] text-foreground leading-snug">{preview.title}</p>
      ) : null}
      {preview.body ? (
        <p className="mt-1 line-clamp-3 text-muted-foreground text-sm leading-relaxed">{preview.body}</p>
      ) : null}
      {preview.author ? <p className="pdpp-caption mt-1 text-muted-foreground">by {preview.author}</p> : null}
    </div>
  );
}

function LocationBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.title || preview.coordinates)) {
    return null;
  }
  return (
    <div className="min-w-0">
      {preview.title ? <p className="truncate font-medium text-foreground text-sm">{preview.title}</p> : null}
      {preview.coordinates ? (
        <p className="pdpp-caption mt-0.5 font-mono text-muted-foreground tabular-nums">{preview.coordinates}</p>
      ) : null}
    </div>
  );
}

// The HONEST GENERIC card (design.md §5.4). An undeclared record renders the
// manifest-authored stream label (the card eyebrow, shared) + the declared
// event time (the row timestamp, shared) + the record identity (the eyebrow
// carries connection/stream; the peek carries the record id) + a readable
// key/value table of its declared fields with humanized labels. It NEVER
// guesses a message/money/photo shape. Prior art: Datadog's generic log
// attribute table. `title`/`body` appear ONLY when a manifest declared those
// roles (the empty default leaves them absent → pure table).
function GenericBody({ preview }: { preview: RecordPreview }) {
  if (!(preview.title || preview.body || preview.fields?.length)) {
    return null;
  }
  return (
    <div className="min-w-0">
      {preview.title ? <p className="truncate font-medium text-foreground text-sm">{preview.title}</p> : null}
      {preview.body ? (
        <p className="mt-0.5 line-clamp-2 text-muted-foreground text-sm leading-snug">{preview.body}</p>
      ) : null}
      {preview.fields?.length ? (
        <dl className="rr-x-kv mt-1.5">
          {preview.fields.map((field) => (
            <div className="rr-x-kv__row" key={field.name}>
              <dt className="rr-x-kv__label">{field.label}</dt>
              <dd className="rr-x-kv__value">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

const PREVIEW_BODY_BY_KIND: Record<RecordKind, (preview: RecordPreview) => ReactNode> = {
  activity: (preview) => <ActivityBody preview={preview} />,
  event: (preview) => <EventBody preview={preview} />,
  generic: (preview) => <GenericBody preview={preview} />,
  location: (preview) => <LocationBody preview={preview} />,
  message: (preview) => <MessageBody preview={preview} />,
  money: (preview) => <MoneyBody preview={preview} />,
  reader: (preview) => <ReaderBody preview={preview} />,
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
  // A true 1px hairline rule on the leading edge, tinted to the kind's
  // temperature (copper for human/message, cool blue for protocol/money/event).
  // The `before:` pseudo-element keeps the hairline flush with the rounded card
  // edge without an extra wrapper. Intentionally 1px — a restrained kind marker,
  // not a decorative side-stripe.
  const rule = `relative overflow-hidden rounded-lg border before:absolute before:inset-y-0 before:left-0 before:w-px before:content-[''] ${KIND_RULE_TONE[kind]}`;
  const surface = selected
    ? "border-foreground/30 bg-muted/50"
    : "border-border/70 bg-card hover:border-border hover:bg-muted/20";
  // Row body — shared by the desktop and mobile links below.
  const cardBody = (
    <>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <CardEyebrow entry={entry} />
        <span className="pdpp-caption shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
          {/* Day-grouped feed: the section header carries the date ("Today",
              "Monday, June 15"), so the row shows TIME-OF-DAY only (relative when
              recent) — the Slack / iMessage / Outlook timeline pattern. The full
              date+time stays in the hover title. See
              docs/research/explore-timeline-legibility-stability-validation-2026-06-19.md */}
          <Timestamp precision="time" value={entry.displayAt} />
        </span>
      </div>
      <CardBody entry={entry} />
    </>
  );
  return (
    <div className={`${rule} ${surface} transition-colors`}>
      {/* Responsive master-detail dual-link (mirrors SplitLayout's `xl` peek
          breakpoint): on desktop the peek pane is visible, so the row opens it
          via ?peek=; on mobile the peek pane is HIDDEN (SplitLayout), so the row
          must navigate to the full-page record detail route instead — otherwise
          a mobile tap sets ?peek and nothing renders. See
          docs/research/explore-chatgpt-three-bugs-2026-06-20.md (bug 3). */}
      <Link className="hidden py-2.5 pr-3 pl-4 xl:block" href={peekHref}>
        {cardBody}
      </Link>
      <Link className="block py-2.5 pr-3 pl-4 xl:hidden" href={recordHref}>
        {cardBody}
      </Link>
      {entry.blobAffordance ? (
        <div className="border-border/50 border-t px-4 py-1.5">
          <BlobAffordance affordance={entry.blobAffordance} />
        </div>
      ) : null}
      <div className="flex justify-end border-border/50 border-t px-4 py-1">
        <Link
          className="pdpp-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          href={recordHref}
        >
          Open record →
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
  const connectorKey = formatConnectorKeyForDisplay(peek.connectorId);
  const connectionDisplayName = formatConnectorNameForDisplay({
    connectorId: peek.connectorId,
    displayName: peek.connectionDisplayName,
  });
  return (
    <aside
      aria-label="Record peek"
      className="sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto overscroll-contain rounded-md border border-border/80 bg-background"
    >
      <div className="pdpp-caption sticky top-0 flex items-center justify-between gap-2 border-border/80 border-b bg-muted/40 px-3 py-2 backdrop-blur">
        <div className="min-w-0">
          <span className="truncate font-medium font-mono">
            {connectorKey} / {peek.stream}
          </span>
          {peek.connectionDisplayName ? (
            <span className="ml-1.5 text-muted-foreground normal-case tracking-normal">· {connectionDisplayName}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-3 whitespace-nowrap">
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={openHref}
          >
            Open record →
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
        {peek.semanticTimestamp ? (
          <div>
            <div className="pdpp-eyebrow mb-1">{peek.semanticTimestamp.label}</div>
            <Timestamp value={peek.semanticTimestamp.value} />
          </div>
        ) : null}
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
  if (peek.fields.length > 0) {
    return (
      <dl className="divide-y divide-border/70 rounded border border-border/80">
        {peek.fields.map((field) => (
          <div className="grid gap-1 px-2 py-2 sm:grid-cols-[minmax(8rem,12rem)_1fr]" key={field.name}>
            <dt className="min-w-0">
              {/* Humanized label is the primary, readable key (the honest generic
                  card, design.md §5.4); the raw field key stays beneath it in
                  mono so the inspector remains debuggable. The humanization is a
                  LABEL transform only — never a type/role signal. */}
              <span className="break-words font-medium text-foreground">{humanizeFieldLabel(field.name)}</span>
              <code className="block break-all font-mono text-[0.7rem] text-muted-foreground">{field.name}</code>
              {field.type ? (
                <span className="mt-0.5 inline-block rounded bg-muted px-1 py-0.5 text-muted-foreground">
                  {field.type}
                </span>
              ) : null}
            </dt>
            <dd className="min-w-0">
              {field.state === "withheld" ? (
                <span className="text-muted-foreground italic">withheld by active projection</span>
              ) : (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-foreground">
                  {field.valueJson}
                </pre>
              )}
              {field.blobAffordance ? (
                <div className="mt-1.5">
                  <BlobAffordance affordance={field.blobAffordance} />
                </div>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (peek.bodyJson) {
    return <pre className="max-h-[40vh] overflow-auto rounded bg-muted p-2 font-mono">{peek.bodyJson}</pre>;
  }
  return <p className="text-muted-foreground italic">No body available.</p>;
}
