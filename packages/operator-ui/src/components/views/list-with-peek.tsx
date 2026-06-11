/**
 * Shared list-with-peek view used by:
 *   - /dashboard/grants and /sandbox/grants
 *   - /dashboard/runs and /sandbox/runs
 *   - /dashboard/traces and /sandbox/traces
 *
 * The page passes:
 *   - the list response from the data source
 *   - the peek envelope (or null) for the row currently being peeked
 *   - the filter form fields (keyed search, status select, optional connector)
 *   - the row renderer
 *   - the route helpers (so /sandbox uses /sandbox links)
 *   - any extra "preheader" content (e.g. pending approvals on grants)
 *
 * The body owns: PageHeader, filter form, FilterSummary, SplitLayout,
 * Pager, peek pane, and pivot links inside the peek.
 */

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import type { ListResponse, TimelineEnvelope } from "../../lib/ref-client.ts";
import { Button } from "../../ui/button.tsx";
import { Input } from "../../ui/input.tsx";
import { Select } from "../../ui/select.tsx";
import { EmptyState } from "../empty-state.tsx";
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from "../peek.tsx";
import { DataList, FilterSummary, PageHeader, Pager, Section, SplitLayout, Toolbar } from "../primitives.tsx";
import type { Routes } from "./routes.ts";
import type { TimelineSubject } from "./timeline-detail-view.tsx";

export interface FilterFormConfig {
  connector?: { name: string; defaultValue?: string };
  /** URL query param this form reads/writes. */
  query?: { name: string; placeholder: string; defaultValue?: string };
  status?: { name: string; options: { value: string; label: string }[]; defaultValue?: string };
}

interface StatusOption {
  label: string;
  value: string;
}

export interface ListWithPeekParams<T> {
  active: "grants" | "runs" | "traces";
  activeFilterChips: { label: string; value: string }[];
  /** Build a list href that preserves filters but applies overrides. */
  buildListHref: (overrides: Record<string, string | undefined>) => string;
  /**
   * Optional: derive a date-group key from an item (e.g. "Today", "Yesterday",
   * or an ISO date string). When provided, the list inserts a sticky separator
   * row whenever the key changes between consecutive items. Omit to render the
   * list as a flat sequence (the default for grants and traces).
   */
  dateGroupKey?: (item: T) => string;
  description?: ReactNode;
  emptyHint: ReactNode;
  emptyTitle: string;
  filters: FilterFormConfig;
  headerActions?: ReactNode;
  peekCliCommand: (id: string) => string;
  peekEnvelope: TimelineEnvelope | null;
  peekId: string | undefined;
  preHeader?: ReactNode;
  preList?: ReactNode;
  /** Render a single row anchor; called inside <li>. */
  renderRow: (item: T, opts: { peeked: boolean; href: string }) => ReactNode;
  resetHref: string;
  result: ListResponse<T>;
  routes: Routes;
  rowKey: (item: T) => string;
  subject: TimelineSubject;
  title: string;
}

function subjectHref(subject: TimelineSubject, id: string, routes: Routes): string {
  if (subject === "grant") {
    return routes.grant(id);
  }
  if (subject === "run") {
    return routes.run(id);
  }
  return routes.trace(id);
}

function PeekContent<T>({ params }: { params: ListWithPeekParams<T> }) {
  const { peekId, peekEnvelope, routes, subject, peekCliCommand, buildListHref } = params;
  if (!peekId) {
    return <PeekEmpty />;
  }
  const closeHref = buildListHref({ peek: undefined });
  const openHref = subjectHref(subject, peekId, routes);
  if (!peekEnvelope) {
    return (
      <PeekPane closeHref={closeHref} openHref={openHref} title={`${subject} ${peekId}`}>
        <p className="text-muted-foreground">{titleCase(subject)} not found.</p>
      </PeekPane>
    );
  }
  return (
    <PeekPane
      cliCommand={peekCliCommand(peekId)}
      closeHref={closeHref}
      openHref={openHref}
      title={`${subject} ${peekId}`}
    >
      <PeekPivots envelope={peekEnvelope} routes={routes} subject={subject} />
      <div className="pdpp-caption mb-2 text-muted-foreground">{peekEnvelope.events.length} events</div>
      <PeekTimeline events={peekEnvelope.events} />
    </PeekPane>
  );
}

function PeekPivots({
  envelope,
  subject,
  routes,
}: {
  envelope: TimelineEnvelope;
  subject: TimelineSubject;
  routes: Routes;
}) {
  const pivots = pivotsFromEnvelope(envelope).filter((p) => p.kind !== subject);
  if (pivots.length === 0) {
    return null;
  }
  const pivotHref = (kind: TimelineSubject, id: string) => {
    if (kind === "grant") {
      return routes.grant(id);
    }
    if (kind === "run") {
      return routes.run(id);
    }
    return routes.trace(id);
  };
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {pivots.map((p) => (
        <Link
          className="pdpp-eyebrow rounded border border-border px-2 py-0.5 hover:bg-muted/60"
          href={pivotHref(p.kind, p.id)}
          key={`${p.kind}:${p.id}`}
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function ListFilterForm({ filters, active }: { filters: FilterFormConfig; active: "grants" | "runs" | "traces" }) {
  return (
    <form method="get">
      <Toolbar>
        {filters.query ? (
          <label className="flex min-w-0 flex-col gap-1" htmlFor={`${active}-query`}>
            <span className="pdpp-eyebrow">Query</span>
            <Input
              className="w-64 font-mono"
              defaultValue={filters.query.defaultValue ?? ""}
              id={`${active}-query`}
              name={filters.query.name}
              placeholder={filters.query.placeholder}
              type="search"
            />
          </label>
        ) : null}
        {filters.connector ? (
          <label className="flex min-w-0 flex-col gap-1" htmlFor={`${active}-connector`}>
            <span className="pdpp-eyebrow">Connector</span>
            <Input
              className="w-48 font-mono"
              defaultValue={filters.connector.defaultValue ?? ""}
              id={`${active}-connector`}
              name={filters.connector.name}
              placeholder="connector_id"
              type="text"
            />
          </label>
        ) : null}
        {filters.status ? (
          <label className="flex min-w-0 flex-col gap-1" htmlFor={`${active}-status`}>
            <span className="pdpp-eyebrow">{active === "grants" ? "State" : "Status"}</span>
            <Select defaultValue={filters.status.defaultValue ?? ""} id={`${active}-status`} name={filters.status.name}>
              <option value="">Any</option>
              {filters.status.options.map((opt: StatusOption) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        <Button className="mt-5" size="sm" type="submit">
          Filter
        </Button>
      </Toolbar>
    </form>
  );
}

export function ListWithPeekView<T>({ params }: { params: ListWithPeekParams<T> }) {
  const {
    active,
    title,
    description,
    headerActions,
    preHeader,
    preList,
    result,
    rowKey,
    renderRow,
    dateGroupKey,
    filters,
    activeFilterChips,
    resetHref,
    buildListHref,
    peekId,
    emptyTitle,
    emptyHint,
  } = params;

  const inner = (
    <>
      {result.data.length === 0 ? (
        <EmptyState hint={emptyHint} title={emptyTitle} />
      ) : (
        <DataList>
          {result.data.map((item, index) => {
            const id = rowKey(item);
            const peeked = peekId === id;
            const href = buildListHref({ peek: id });
            const groupKey = dateGroupKey ? dateGroupKey(item) : null;
            const prevGroupKey = dateGroupKey && index > 0 ? dateGroupKey(result.data[index - 1]) : null;
            const showSeparator = groupKey !== null && groupKey !== prevGroupKey;
            return (
              <Fragment key={id}>
                {showSeparator ? (
                  <li className="pdpp-eyebrow sticky top-0 z-10 border-border/60 border-y bg-muted/80 px-3 py-1.5 text-muted-foreground backdrop-blur-sm">
                    {groupKey}
                  </li>
                ) : null}
                <li>{renderRow(item, { peeked, href })}</li>
              </Fragment>
            );
          })}
        </DataList>
      )}
      {result.has_more && result.next_cursor ? <Pager next={buildListHref({ cursor: result.next_cursor })} /> : null}
    </>
  );

  return (
    <>
      <PageHeader
        actions={headerActions}
        count={`${result.data.length}${result.has_more ? "+" : ""}`}
        description={description}
        title={title}
      />
      {preHeader}
      {preList ? <Section title={titleCase(active)}>{preList}</Section> : null}
      {!preList && active === "grants" ? null : null}
      <ListFilterForm active={active} filters={filters} />
      <FilterSummary items={activeFilterChips} resetHref={resetHref} />
      <SplitLayout main={inner} peek={<PeekContent params={params} />} />
    </>
  );
}
