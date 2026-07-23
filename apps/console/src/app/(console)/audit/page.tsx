// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Traces — the Ink Carbon audit surface.
 *
 * Traces record who read what under which grant: provider-connect flows,
 * owner-device exchanges, and /v1 data reads all land here as protocol
 * artifacts. This is an honest audit log — every row is immutable record.
 *
 * Layout: filter band → Table (status | subject | kinds | events | time)
 * with an optional Sheet peek panel on the right when ?peek= is set.
 *
 * Data path is unchanged: listTraces + getTraceTimeline via the owner-token
 * ref-client. All filter params and cursor pagination are preserved verbatim.
 */

import {
  buttonVariants,
  Endorse,
  Eyebrow,
  IcButton,
  IcInput,
  IcSelect,
  IcTimestamp,
  Sheet,
  SheetBody,
  SheetHead,
  SheetSerial,
  SheetTitle,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
  TableRow,
  Tag,
  Typed,
  TypedSm,
} from "@pdpp/brand-react";
import { traceRowLabel } from "@pdpp/operator-ui/lib/summary-row-label";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  getTraceTimeline,
  type ListResponse,
  listTraces,
  type TimelineEnvelope,
  type TraceSummary,
} from "../lib/ref-client.ts";
import { traceEndorseStatus } from "./trace-endorse-status.ts";

export const dynamic = "force-dynamic";

interface Params {
  client_id?: string;
  cursor?: string;
  peek?: string;
  provider_id?: string;
  q?: string;
  status?: string;
}

function listHref(params: Params, overrides: Record<string, string | undefined> = {}): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
    .join("&");
  return qs ? `/audit?${qs}` : "/audit";
}

function traceListFilters(params: Params) {
  return {
    client_id: params.client_id,
    cursor: params.cursor,
    limit: 50,
    provider_id: params.provider_id,
    q: params.q,
    status: params.status,
  };
}

function hasActiveFilters(params: Params): boolean {
  return Boolean(params.status || params.q || params.client_id || params.provider_id);
}

export default async function TracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = traceListFilters(params);

  let result: ListResponse<TraceSummary>;
  let peekEnvelope: TimelineEnvelope | null = null;
  try {
    result = await listTraces(filters);
    if (params.peek) {
      peekEnvelope = await getTraceTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <TracesHeader />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  const hasFilters = hasActiveFilters(params);
  const peekTraceId = params.peek && peekEnvelope ? params.peek : null;
  const isPeeking = Boolean(peekTraceId);

  return (
    <RecordroomShellWithPalette>
      <TracesHeader />

      <TraceFilterBand hasFilters={hasFilters} params={params} />
      {hasFilters ? <ActiveFilterChips params={params} /> : null}

      <div
        className="rr-traces-split xl:grid xl:items-start xl:gap-6"
        style={{
          gridTemplateColumns: isPeeking ? "minmax(0, 1.4fr) minmax(0, 1fr)" : "1fr",
        }}
      >
        <div>
          <TracesResults hasFilters={hasFilters} params={params} traces={result.data} />
          <TracePagination params={params} result={result} />
        </div>

        <TracePeekSlot envelope={peekEnvelope} isPeeking={isPeeking} params={params} traceId={peekTraceId} />
      </div>
    </RecordroomShellWithPalette>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TracesHeader() {
  return (
    <header style={{ marginBottom: 24, maxWidth: 640 }}>
      <Eyebrow as="p" style={{ marginBottom: 6 }}>
        Sharing
      </Eyebrow>
      <h1 className="pdpp-heading text-foreground" style={{ margin: "0 0 4px" }}>
        Audit
      </h1>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          margin: 0,
        }}
      >
        provider-connect · owner device · /v1 reads · every protocol interaction recorded
      </p>
    </header>
  );
}

function ActiveFilterChips({ params }: { params: Params }) {
  return (
    <ul
      aria-label="Active filters"
      style={{ display: "flex", flexWrap: "wrap", gap: 6, listStyle: "none", margin: "0 0 16px", padding: 0 }}
    >
      {params.status ? (
        <li>
          <Tag>status: {params.status}</Tag>
        </li>
      ) : null}
      {params.q ? (
        <li>
          <Tag>query: {params.q}</Tag>
        </li>
      ) : null}
      {params.client_id ? (
        <li>
          <Tag>client: {params.client_id}</Tag>
        </li>
      ) : null}
      {params.provider_id ? (
        <li>
          <Tag>provider: {params.provider_id}</Tag>
        </li>
      ) : null}
    </ul>
  );
}

function TraceFilterBand({ params, hasFilters }: { params: Params; hasFilters: boolean }) {
  return (
    <form action="/audit" method="get" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
      <IcInput
        aria-label="Search traces"
        defaultValue={params.q ?? ""}
        name="q"
        placeholder="id contains…"
        style={{ flex: "1 1 200px", maxWidth: 320 }}
        type="search"
      />
      <IcSelect
        aria-label="Filter by status"
        defaultValue={params.status ?? ""}
        name="status"
        options={[
          { label: "all statuses", value: "" },
          { label: "succeeded", value: "succeeded" },
          { label: "failed", value: "failed" },
          { label: "rejected", value: "rejected" },
          { label: "started", value: "started" },
        ]}
        style={{ flex: "0 0 auto", minWidth: 140 }}
      />
      <IcButton size="sm" type="submit" variant="ghost">
        Apply
      </IcButton>
      {hasFilters ? (
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href="/audit">
          Reset
        </a>
      ) : null}
    </form>
  );
}

function TracesResults({
  traces,
  params,
  hasFilters,
}: {
  traces: TraceSummary[];
  params: Params;
  hasFilters: boolean;
}) {
  if (traces.length === 0) {
    return <TracesEmptyState hasFilters={hasFilters} />;
  }

  return (
    <>
      <TracesDesktopTable params={params} traces={traces} />
      <TracesMobileCards traces={traces} />
    </>
  );
}

function TracesDesktopTable({ traces, params }: { traces: TraceSummary[]; params: Params }) {
  return (
    <div className="rr-traces-table-wrap hidden sm:block">
      <Table cols="80px minmax(0,1.4fr) minmax(0,1fr) 64px 128px">
        <TableHeaderRow>
          <TableHeader>Status</TableHeader>
          <TableHeader>Subject</TableHeader>
          <TableHeader>Kinds</TableHeader>
          <TableHeader numeric>Events</TableHeader>
          <TableHeader numeric>Time</TableHeader>
        </TableHeaderRow>
        {traces.map((trace) => {
          const peeked = params.peek === trace.trace_id;
          const peekHref = listHref(params, { cursor: undefined, peek: peeked ? undefined : trace.trace_id });
          const label = traceRowLabel(trace);
          const kinds = trace.kinds.slice(0, 3).join(", ");
          return (
            <TableRow className={peeked ? "pdpp-table__row--active" : undefined} key={trace.trace_id}>
              <TableCell>
                <Endorse label={trace.status} status={traceEndorseStatus(trace.status)} />
              </TableCell>
              <TableCell>
                <TraceSubjectLink href={peekHref} label={label} traceId={trace.trace_id} />
              </TableCell>
              <TableCell>
                {kinds ? <TypedSm style={{ color: "var(--muted-foreground)" }}>{kinds}</TypedSm> : null}
              </TableCell>
              <TableCell numeric>
                <TypedSm>{trace.event_count}</TypedSm>
              </TableCell>
              <TableCell numeric>
                <TypedSm>
                  <IcTimestamp value={trace.last_at} />
                </TypedSm>
              </TableCell>
            </TableRow>
          );
        })}
      </Table>
    </div>
  );
}

function TraceSubjectLink({ href, label, traceId }: { href: string; label: string; traceId: string }) {
  return (
    <Link href={href} scroll={false} style={{ display: "block", textDecoration: "none" }}>
      <span
        style={{
          color: "var(--foreground)",
          display: "block",
          fontFamily: "var(--font-sans)",
          fontSize: "0.875rem",
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
      <TypedSm
        style={{
          display: "block",
          marginTop: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {traceId}
      </TypedSm>
    </Link>
  );
}

function TracesMobileCards({ traces }: { traces: TraceSummary[] }) {
  return (
    <ul className="rr-traces-cards sm:hidden" style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {traces.map((trace) => {
        const detailHref = `/audit/${encodeURIComponent(trace.trace_id)}`;
        const label = traceRowLabel(trace);
        const kinds = trace.kinds.slice(0, 3).join(", ");
        return (
          <TraceMobileCard detailHref={detailHref} key={trace.trace_id} kinds={kinds} label={label} trace={trace} />
        );
      })}
    </ul>
  );
}

function TraceMobileCard({
  detailHref,
  kinds,
  label,
  trace,
}: {
  detailHref: string;
  kinds: string;
  label: string;
  trace: TraceSummary;
}) {
  return (
    <li
      style={{
        borderBottom: "1px solid var(--border)",
        padding: "10px 0",
      }}
    >
      <Link href={detailHref} style={{ display: "block", textDecoration: "none" }}>
        <span
          style={{
            color: "var(--foreground)",
            display: "block",
            fontFamily: "var(--font-sans)",
            fontSize: "0.875rem",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
        <TypedSm
          style={{
            color: "var(--muted-foreground)",
            display: "block",
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {trace.trace_id}
        </TypedSm>
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flexWrap: "wrap",
            gap: "5px 10px",
            marginTop: 6,
          }}
        >
          <Endorse label={trace.status} status={traceEndorseStatus(trace.status)} />
          {kinds ? <TypedSm style={{ color: "var(--muted-foreground)" }}>{kinds}</TypedSm> : null}
          <TypedSm style={{ color: "var(--muted-foreground)" }}>{trace.event_count} events</TypedSm>
          <TypedSm style={{ color: "var(--muted-foreground)" }}>
            <IcTimestamp value={trace.last_at} />
          </TypedSm>
        </div>
      </Link>
    </li>
  );
}

function TracePagination({ result, params }: { result: ListResponse<TraceSummary>; params: Params }) {
  if (!(result.has_more || params.cursor)) {
    return null;
  }

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
        marginTop: 16,
        paddingTop: 12,
      }}
    >
      {params.cursor ? (
        <a className={buttonVariants({ size: "sm", variant: "ghost" })} href={listHref(params, { cursor: undefined })}>
          ← First page
        </a>
      ) : null}
      {result.has_more && result.next_cursor ? (
        <a
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={listHref(params, { cursor: result.next_cursor })}
        >
          Next →
        </a>
      ) : null}
    </div>
  );
}

function TracePeekSlot({
  envelope,
  isPeeking,
  params,
  traceId,
}: {
  envelope: TimelineEnvelope | null;
  isPeeking: boolean;
  params: Params;
  traceId: string | null;
}) {
  if (!(isPeeking && envelope && traceId)) {
    return null;
  }

  return (
    <div className="hidden xl:block">
      <TracesPeekPanel
        cliCommand={`pdpp ref trace show ${traceId}`}
        envelope={envelope}
        listParams={params}
        traceId={traceId}
      />
    </div>
  );
}

function TracesEmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div
      style={{
        borderBottom: "1px solid var(--border)",
        borderTop: "1px solid var(--border-strong)",
        padding: "40px 0",
        textAlign: "center",
      }}
    >
      <p
        style={{
          color: "var(--foreground)",
          fontFamily: "var(--font-sans)",
          fontSize: "0.875rem",
          fontWeight: 600,
          margin: "0 0 6px",
        }}
      >
        {hasFilters ? "No matching traces" : "No traces yet"}
      </p>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          margin: 0,
        }}
      >
        {hasFilters
          ? "Try widening the filters or clearing the query."
          : "Trace artifacts appear as provider-connect, owner-device, or /v1 read flows run."}
      </p>
    </div>
  );
}

interface PeekPanelProps {
  cliCommand: string;
  envelope: TimelineEnvelope;
  listParams: Params;
  traceId: string;
}

function TracesPeekPanel({ traceId, envelope, cliCommand, listParams }: PeekPanelProps) {
  const firstEvent = envelope.events[0];
  const closeHref = listHref(listParams, { peek: undefined });
  const detailHref = `/audit/${encodeURIComponent(traceId)}`;

  return (
    <Sheet>
      <SheetHead>
        <div style={{ alignItems: "flex-start", display: "flex", gap: 8, justifyContent: "space-between" }}>
          <div style={{ minWidth: 0 }}>
            <SheetTitle as="h2">Trace</SheetTitle>
            <SheetSerial>{traceId}</SheetSerial>
          </div>
          <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href={closeHref} scroll={false}>
            ✕
          </Link>
        </div>
      </SheetHead>
      <SheetBody>
        {/* Summary meta */}
        <div
          style={{
            borderBottom: "1px solid var(--border)",
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 16px",
            marginBottom: 16,
            paddingBottom: 12,
          }}
        >
          <span style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
            {envelope.events.length} events
          </span>
          {firstEvent ? (
            <span style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              actor{" "}
              <span style={{ color: "var(--foreground)" }}>
                {firstEvent.actor_type}/{firstEvent.actor_id}
              </span>
            </span>
          ) : null}
        </div>

        {/* Event timeline — first 8 events to keep the panel compact */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {envelope.events.slice(0, 8).map((event) => (
            <div
              key={event.event_id}
              style={{
                borderBottom: "1px solid var(--border)",
                padding: "6px 0",
              }}
            >
              <div style={{ alignItems: "baseline", display: "flex", gap: 8, justifyContent: "space-between" }}>
                <Typed
                  style={{
                    flex: 1,
                    fontSize: "0.7rem",
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {event.event_type}
                </Typed>
                <TypedSm style={{ color: "var(--muted-foreground)", flexShrink: 0 }}>
                  <IcTimestamp value={event.occurred_at} />
                </TypedSm>
              </div>
              {event.status ? (
                <TypedSm
                  style={{
                    color: "var(--muted-foreground)",
                    display: "block",
                    marginTop: 2,
                  }}
                >
                  {event.status}
                </TypedSm>
              ) : null}
            </div>
          ))}
          {envelope.events.length > 8 ? (
            <TypedSm style={{ color: "var(--muted-foreground)", paddingTop: 4 }}>
              +{envelope.events.length - 8} more events
            </TypedSm>
          ) : null}
        </div>

        {/* CLI command */}
        <div
          style={{
            borderTop: "1px solid var(--border)",
            marginTop: 16,
            paddingTop: 12,
          }}
        >
          <p
            style={{
              color: "var(--muted-foreground)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.625rem",
              fontWeight: 500,
              letterSpacing: "0.1em",
              margin: "0 0 4px",
              textTransform: "uppercase",
            }}
          >
            CLI
          </p>
          <Typed
            as="code"
            style={{
              display: "block",
              fontSize: "0.72rem",
              wordBreak: "break-all",
            }}
          >
            {cliCommand}
          </Typed>
        </div>

        {/* Full detail link */}
        <div style={{ marginTop: 14 }}>
          <Link className={buttonVariants({ size: "sm" })} href={detailHref}>
            Full timeline →
          </Link>
        </div>
      </SheetBody>
    </Sheet>
  );
}
