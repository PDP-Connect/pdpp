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
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  getTraceTimeline,
  type ListResponse,
  listTraces,
  type TimelineEnvelope,
  type TraceSummary,
} from "../lib/ref-client.ts";

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
  return qs ? `/dashboard/traces?${qs}` : "/dashboard/traces";
}

/** Map trace status to the Endorse variant vocabulary. */
function traceEndorseStatus(status: string): "active" | "continuous" | "expiring" | "revoked" | "denied" {
  switch (status) {
    case "succeeded":
      return "active";
    case "started":
    case "in_progress":
      return "continuous";
    case "failed":
    case "rejected":
      return "denied";
    default:
      return "revoked"; // unknown / terminal-muted
  }
}

export default async function TracesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = {
    cursor: params.cursor,
    status: params.status,
    client_id: params.client_id,
    provider_id: params.provider_id,
    q: params.q,
    limit: 50,
  };

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

  const hasFilters = Boolean(params.status || params.q || params.client_id || params.provider_id);
  const isPeeking = Boolean(params.peek && peekEnvelope);

  return (
    <RecordroomShellWithPalette>
      <TracesHeader />

      {/* ── Filter band ─────────────────────────────────────────────── */}
      <form
        action="/dashboard/traces"
        method="get"
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}
      >
        <IcInput
          aria-label="Search traces"
          defaultValue={params.q ?? ""}
          name="q"
          placeholder="id contains…"
          style={{ flex: "1 1 200px", maxWidth: 320 }}
          type="search"
        />
        {/* Status filter — Ink Carbon select (base-ui listbox, fully styled). */}
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
          <a className={buttonVariants({ variant: "ghost", size: "sm" })} href="/dashboard/traces">
            Reset
          </a>
        ) : null}
      </form>

      {/* ── Active filter chips ──────────────────────────────────────── */}
      {hasFilters ? (
        <div
          aria-label="Active filters"
          role="list"
          style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}
        >
          {params.status ? (
            <span role="listitem">
              <Tag>status: {params.status}</Tag>
            </span>
          ) : null}
          {params.q ? (
            <span role="listitem">
              <Tag>query: {params.q}</Tag>
            </span>
          ) : null}
          {params.client_id ? (
            <span role="listitem">
              <Tag>client: {params.client_id}</Tag>
            </span>
          ) : null}
          {params.provider_id ? (
            <span role="listitem">
              <Tag>provider: {params.provider_id}</Tag>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ── Split layout: list + optional peek panel ─────────────────── */}
      {/* On desktop (xl+): 2-column grid when peeking; 1-column otherwise.
          On mobile (below xl): always 1-column; the peek pane is hidden via
          `hidden xl:block` on the panel element — mobile rows navigate to
          the full detail page instead. */}
      <div
        className="rr-traces-split xl:grid xl:gap-6 xl:items-start"
        style={{
          gridTemplateColumns: isPeeking ? "minmax(0, 1.4fr) minmax(0, 1fr)" : "1fr",
        }}
      >
        {/* ── Traces table ──────────────────────────────────────────── */}
        <div>
          {result.data.length === 0 ? (
            <TracesEmptyState hasFilters={hasFilters} />
          ) : (
            <>
              {/* Desktop table — hidden on mobile via CSS */}
              <div className="rr-traces-table-wrap hidden sm:block">
                <Table cols="80px minmax(0,1.4fr) minmax(0,1fr) 64px 128px">
                  <TableHeaderRow>
                    <TableHeader>Status</TableHeader>
                    <TableHeader>Subject</TableHeader>
                    <TableHeader>Kinds</TableHeader>
                    <TableHeader numeric>Events</TableHeader>
                    <TableHeader numeric>Time</TableHeader>
                  </TableHeaderRow>
                  {result.data.map((trace) => {
                    const peeked = params.peek === trace.trace_id;
                    const peekHref = listHref(params, { peek: peeked ? undefined : trace.trace_id, cursor: undefined });
                    const label = traceRowLabel(trace);
                    const kinds = trace.kinds.slice(0, 3).join(", ");
                    return (
                      <TableRow className={peeked ? "pdpp-table__row--active" : undefined} key={trace.trace_id}>
                        <TableCell>
                          <Endorse label={trace.status} status={traceEndorseStatus(trace.status)} />
                        </TableCell>
                        <TableCell>
                          <Link href={peekHref} scroll={false} style={{ display: "block", textDecoration: "none" }}>
                            <span
                              style={{
                                display: "block",
                                fontFamily: "var(--font-sans)",
                                fontSize: "0.875rem",
                                fontWeight: 600,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                color: "var(--foreground)",
                              }}
                            >
                              {label}
                            </span>
                            <TypedSm
                              style={{
                                display: "block",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                                marginTop: 1,
                              }}
                            >
                              {trace.trace_id}
                            </TypedSm>
                          </Link>
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

              {/* Mobile card list — shown only at <640px */}
              <ul className="rr-traces-cards sm:hidden" style={{ listStyle: "none", margin: 0, padding: 0 }}>
                {result.data.map((trace) => {
                  const detailHref = `/dashboard/traces/${encodeURIComponent(trace.trace_id)}`;
                  const label = traceRowLabel(trace);
                  const kinds = trace.kinds.slice(0, 3).join(", ");
                  return (
                    <li
                      key={trace.trace_id}
                      style={{
                        borderBottom: "1px solid var(--border)",
                        padding: "10px 0",
                      }}
                    >
                      {/* Mobile card: tap anywhere navigates to full-page detail. */}
                      <Link href={detailHref} style={{ display: "block", textDecoration: "none" }}>
                        <span
                          style={{
                            display: "block",
                            fontFamily: "var(--font-sans)",
                            fontSize: "0.875rem",
                            fontWeight: 600,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            color: "var(--foreground)",
                          }}
                        >
                          {label}
                        </span>
                        <TypedSm
                          style={{
                            display: "block",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            marginTop: 1,
                            color: "var(--muted-foreground)",
                          }}
                        >
                          {trace.trace_id}
                        </TypedSm>
                        {/* Meta line: status · kinds · events · time */}
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            alignItems: "center",
                            gap: "5px 10px",
                            marginTop: 6,
                          }}
                        >
                          <Endorse label={trace.status} status={traceEndorseStatus(trace.status)} />
                          {kinds ? (
                            <TypedSm style={{ color: "var(--muted-foreground)" }}>{kinds}</TypedSm>
                          ) : null}
                          <TypedSm style={{ color: "var(--muted-foreground)" }}>
                            {trace.event_count} events
                          </TypedSm>
                          <TypedSm style={{ color: "var(--muted-foreground)" }}>
                            <IcTimestamp value={trace.last_at} />
                          </TypedSm>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {/* ── Pagination ────────────────────────────────────────── */}
          {result.has_more || params.cursor ? (
            <div
              style={{
                display: "flex",
                gap: 8,
                justifyContent: "flex-end",
                marginTop: 16,
                paddingTop: 12,
                borderTop: "1px solid var(--border)",
              }}
            >
              {params.cursor ? (
                <a
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={listHref(params, { cursor: undefined })}
                >
                  ← First page
                </a>
              ) : null}
              {result.has_more && result.next_cursor ? (
                <a
                  className={buttonVariants({ variant: "ghost", size: "sm" })}
                  href={listHref(params, { cursor: result.next_cursor })}
                >
                  Next →
                </a>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* ── Peek panel — desktop only (xl+) ────────────────────────── */}
        {isPeeking && peekEnvelope ? (
          <div className="hidden xl:block">
            <TracesPeekPanel
              cliCommand={`pdpp ref trace show ${params.peek}`}
              envelope={peekEnvelope}
              listParams={params}
              traceId={params.peek!}
            />
          </div>
        ) : null}
      </div>
    </RecordroomShellWithPalette>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TracesHeader() {
  return (
    <header style={{ marginBottom: 24, maxWidth: 640 }}>
      <Eyebrow as="p" style={{ marginBottom: 6 }}>
        Audit surface
      </Eyebrow>
      <h1
        style={{
          fontSize: 21,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          margin: "0 0 4px",
          fontFamily: "var(--font-sans)",
        }}
      >
        Traces
      </h1>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted-foreground)",
          margin: 0,
        }}
      >
        provider-connect · owner device · /v1 reads · every protocol interaction recorded
      </p>
    </header>
  );
}

function TracesEmptyState({ hasFilters }: { hasFilters: boolean }) {
  return (
    <div
      style={{
        padding: "40px 0",
        textAlign: "center",
        borderTop: "1px solid var(--border-strong)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: "0.875rem",
          fontWeight: 600,
          color: "var(--foreground)",
          margin: "0 0 6px",
        }}
      >
        {hasFilters ? "No matching traces" : "No traces yet"}
      </p>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted-foreground)",
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
  const detailHref = `/dashboard/traces/${encodeURIComponent(traceId)}`;

  return (
    <Sheet>
      <SheetHead>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ minWidth: 0 }}>
            <SheetTitle as="h2">Trace</SheetTitle>
            <SheetSerial>{traceId}</SheetSerial>
          </div>
          <Link className={buttonVariants({ variant: "ghost", size: "sm" })} href={closeHref} scroll={false}>
            ✕
          </Link>
        </div>
      </SheetHead>
      <SheetBody>
        {/* Summary meta */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px 16px",
            marginBottom: 16,
            paddingBottom: 12,
            borderBottom: "1px solid var(--border)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted-foreground)" }}>
            {envelope.events.length} events
          </span>
          {firstEvent ? (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--muted-foreground)" }}>
              actor{" "}
              <span style={{ color: "var(--foreground)" }}>
                {firstEvent.actor_type}/{firstEvent.actor_id}
              </span>
            </span>
          ) : null}
        </div>

        {/* Event timeline — first 8 events to keep the panel compact */}
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {envelope.events.slice(0, 8).map((event, i) => (
            <div
              key={i}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid var(--border)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <Typed
                  style={{
                    fontSize: "0.7rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    flex: 1,
                    minWidth: 0,
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
                    marginTop: 2,
                    display: "block",
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
            marginTop: 16,
            paddingTop: 12,
            borderTop: "1px solid var(--border)",
          }}
        >
          <p
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.625rem",
              fontWeight: 500,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: "var(--muted-foreground)",
              margin: "0 0 4px",
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
