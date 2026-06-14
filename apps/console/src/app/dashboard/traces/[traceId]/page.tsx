/**
 * Trace detail — Ink Carbon redesign.
 *
 * Surface: trace identity sheet (KV: trace id, actor, event count, status),
 * a Band stat strip, related-artifact pivot links, and an in-page timeline
 * Table. All data fetching is verbatim; only the presentation layer changed.
 *
 * Temperature discipline:
 *   - ProtocolSurface wraps machine-authored sections (timeline, CLI reference).
 *   - No HumanSurface here — traces have no owner-action surface.
 *   - Endorse is the sole home of state color (status badge).
 *   - No hardcoded hex/rgb; all color via CSS custom properties / data-surface.
 */

import {
  Band,
  BandCell,
  Body,
  Caption,
  CopyMono,
  Endorse,
  Eyebrow,
  KV,
  KVRow,
  ProtocolSurface,
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
  Typed,
  TypedSm,
} from "@pdpp/brand-react";
import { notFound } from "next/navigation";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getTraceTimeline, type SpineEvent, type TimelineEnvelope } from "../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

type TimelineSearchParams = Promise<{ cursor?: string | string[] }>;

function getCursor(searchParams: { cursor?: string | string[] }): string | null {
  return typeof searchParams.cursor === "string" && searchParams.cursor.length > 0 ? searchParams.cursor : null;
}

function traceTimelineHref(traceId: string, cursor: string): string {
  return `/dashboard/traces/${encodeURIComponent(traceId)}?${new URLSearchParams({ cursor }).toString()}`;
}

// ─── Event status → Endorse variant ──────────────────────────────────────────

type EndorseStatus = "active" | "continuous" | "expiring" | "revoked" | "denied";

function eventStatusEndorse(status: string | null): EndorseStatus {
  if (!status) {
    return "continuous";
  }
  if (status === "failed" || status === "rejected") {
    return "denied";
  }
  if (status === "completed" || status === "succeeded") {
    return "active";
  }
  if (status === "cancelled" || status === "revoked") {
    return "revoked";
  }
  if (status === "pending" || status === "started") {
    return "expiring";
  }
  return "continuous";
}

// ─── Secret redaction (mirrors TimelineView) ─────────────────────────────────

const SECRET_KEYS = new Set([
  "interaction_response",
  "INTERACTION_RESPONSE",
  "access_token",
  "refresh_token",
  "device_code",
  "user_code",
]);

function redactSecrets(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = "<redacted>";
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ─── Pivot helpers ────────────────────────────────────────────────────────────

function collectPivotIds(envelope: TimelineEnvelope, key: "grant_id" | "run_id"): string[] {
  return Array.from(new Set(envelope.events.flatMap((e) => (e[key] ? [e[key] as string] : []))));
}

// ─── Surface: server unreachable ──────────────────────────────────────────────

function TraceServerUnreachable({ rsUrl }: { rsUrl: string }) {
  return (
    <Sheet>
      <SheetHead>
        <SheetTitle as="h2">Reference server unreachable</SheetTitle>
      </SheetHead>
      <SheetBody>
        <Body>
          The dashboard could not reach its PDPP authorization server at <Typed as="code">{rsUrl}</Typed>. It recovers
          as soon as the server responds again.
        </Body>
        <ul className="pdpp-caption mt-3 grid gap-1" style={{ color: "var(--color-muted-foreground)" }}>
          <li>Confirm the PDPP service is running in your deployment.</li>
          <li>Check deployment logs for a startup error, then restart the PDPP service.</li>
          <li>
            Open{" "}
            <a
              className="underline underline-offset-2"
              href="/dashboard/deployment"
              style={{ color: "var(--color-foreground)" }}
            >
              Deployment readiness
            </a>{" "}
            once the server is reachable.
          </li>
        </ul>
      </SheetBody>
    </Sheet>
  );
}

// ─── Timeline Table ───────────────────────────────────────────────────────────
//
// Adapts the operator-ui TimelineView into a hairline Table. The PROGRESS
// grouping threshold and logic are identical so the behaviour is unchanged.

const PROGRESS_GROUP_THRESHOLD = 5;

type TimelineNode =
  | { kind: "event"; event: SpineEvent; index: number }
  | { kind: "progress-group"; events: SpineEvent[]; start: number };

function groupTimeline(events: SpineEvent[]): TimelineNode[] {
  const nodes: TimelineNode[] = [];
  let i = 0;
  while (i < events.length) {
    const current = events[i];
    if (!current) {
      i += 1;
      continue;
    }
    if (current.event_type === "run.progress_reported") {
      let j = i;
      while (j < events.length && events[j]?.event_type === "run.progress_reported") {
        j += 1;
      }
      const runLen = j - i;
      if (runLen >= PROGRESS_GROUP_THRESHOLD) {
        nodes.push({ kind: "progress-group", events: events.slice(i, j), start: i });
        i = j;
        continue;
      }
    }
    nodes.push({ kind: "event", event: current, index: i });
    i += 1;
  }
  return nodes;
}

function padIndex(n: number): string {
  return String(n + 1).padStart(3, "0");
}

function EventTableRow({ event, index }: { event: SpineEvent; index: number }) {
  const endorseStatus = eventStatusEndorse(event.status);
  return (
    <TableRow>
      <TableCell>
        <TypedSm style={{ color: "var(--color-muted-foreground)" }}>{padIndex(index)}</TypedSm>
      </TableCell>
      <TableCell>
        <Typed as="code" id={event.event_id}>
          {event.event_type}
        </Typed>
        <br />
        <TypedSm style={{ color: "var(--color-muted-foreground)" }}>
          {event.actor_type}/{event.actor_id}
          {event.stream_id ? ` · ${event.stream_id}` : ""}
        </TypedSm>
      </TableCell>
      <TableCell>
        <Endorse label={event.status ?? "—"} status={endorseStatus} />
      </TableCell>
      <TableCell>
        <TypedSm style={{ color: "var(--color-muted-foreground)" }}>
          {event.occurred_at ? event.occurred_at.replace("T", " ").slice(0, 19) + "Z" : "—"}
        </TypedSm>
      </TableCell>
      <TableCell>
        <details>
          <summary className="pdpp-caption" style={{ color: "var(--color-muted-foreground)", cursor: "pointer" }}>
            data
          </summary>
          <pre
            className="pdpp-caption mt-1 overflow-x-auto"
            style={{
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              fontFamily: "var(--font-mono)",
              padding: "var(--space-2)",
            }}
          >
            {JSON.stringify(redactSecrets(event.data || {}), null, 2)}
          </pre>
        </details>
      </TableCell>
    </TableRow>
  );
}

function ProgressGroupTableRow({ events, startIndex }: { events: SpineEvent[]; startIndex: number }) {
  const first = events[0];
  const last = events.at(-1);
  if (!(first && last)) {
    return null;
  }
  return (
    <TableRow>
      <TableCell>
        <TypedSm style={{ color: "var(--color-muted-foreground)" }}>
          {padIndex(startIndex)}–{padIndex(startIndex + events.length - 1)}
        </TypedSm>
      </TableCell>
      <TableCell>
        <Typed as="code">run.progress_reported</Typed>
        <br />
        <TypedSm style={{ color: "var(--color-muted-foreground)" }}>
          {events.length.toLocaleString()} reports · {typeof last.data?.message === "string" ? last.data.message : "—"}
        </TypedSm>
      </TableCell>
      <TableCell>
        <Endorse label="progress" status="continuous" />
      </TableCell>
      <TableCell>
        <TypedSm style={{ color: "var(--color-muted-foreground)" }}>
          {first.occurred_at ? first.occurred_at.slice(0, 19).replace("T", " ") : "—"} →{" "}
          {last.occurred_at ? last.occurred_at.slice(0, 19).replace("T", " ") : "—"}
        </TypedSm>
      </TableCell>
      <TableCell>
        <details>
          <summary className="pdpp-caption" style={{ color: "var(--color-muted-foreground)", cursor: "pointer" }}>
            {events.length.toLocaleString()} individual reports
          </summary>
          <ol className="mt-2" style={{ listStyle: "none", padding: 0 }}>
            {events.map((ev, offset) => (
              <EventTableRow event={ev} index={startIndex + offset} key={ev.event_id} />
            ))}
          </ol>
        </details>
      </TableCell>
    </TableRow>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function TraceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ traceId: string }>;
  searchParams: TimelineSearchParams;
}) {
  const { traceId: raw } = await params;
  const traceId = decodeURIComponent(raw);
  const cursor = getCursor(await searchParams);
  const rsUrl = `${getAsInternalUrl()}/_ref/traces/${encodeURIComponent(traceId)}`;

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getTraceTimeline(traceId, { cursor });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <TraceServerUnreachable rsUrl={getAsInternalUrl()} />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (!envelope) {
    notFound();
  }

  const events = envelope.events;
  const first = events[0] ?? null;
  const actorLabel = first ? `${first.actor_type}/${first.actor_id}` : null;

  // Unique grant and run pivots from the event set
  const grantIds = collectPivotIds(envelope, "grant_id");
  const runIds = collectPivotIds(envelope, "run_id");

  // Overall status: any failed → denied, else active
  const hasFailed = events.some((e) => e.status === "failed" || e.status === "rejected");
  const overallStatus: EndorseStatus = hasFailed ? "denied" : events.length > 0 ? "active" : "continuous";
  const overallLabel = hasFailed ? "has failures" : events.length > 0 ? "complete" : "empty";

  // Load-more
  const loadMoreHref =
    envelope.truncated && envelope.next_cursor ? traceTimelineHref(traceId, envelope.next_cursor) : null;

  // Timeline nodes
  const nodes = groupTimeline(events);

  // CLI command
  const cliCommand = `pdpp ref trace show ${traceId}`;

  return (
    <RecordroomShellWithPalette>
      {/* ─── Breadcrumb ─── */}
      <nav aria-label="Breadcrumb" className="pdpp-caption mb-6" style={{ color: "var(--color-muted-foreground)" }}>
        <a href="/dashboard/traces" style={{ color: "inherit" }}>
          Traces
        </a>
        <span aria-hidden="true" style={{ margin: "0 var(--space-2)" }}>
          /
        </span>
        <span style={{ color: "var(--color-foreground)" }}>Trace</span>
      </nav>

      {/* ─── Identity sheet ─── */}
      <Sheet className="mb-6">
        <SheetHead>
          <SheetTitle as="h1">Trace</SheetTitle>
          <SheetSerial>
            <CopyMono text={traceId} />
          </SheetSerial>
        </SheetHead>
        <SheetBody>
          <KV>
            <KVRow k="trace id">
              <Typed as="code">{traceId}</Typed>
            </KVRow>
            {actorLabel ? (
              <KVRow k="actor">
                <Typed as="code">{actorLabel}</Typed>
              </KVRow>
            ) : null}
            <KVRow k="status">
              <Endorse label={overallLabel} status={overallStatus} />
            </KVRow>
            {first?.grant_id ? (
              <KVRow k="grant">
                <a
                  className="pdpp-typed"
                  href={`/dashboard/grants/${encodeURIComponent(first.grant_id)}`}
                  style={{ color: "var(--color-foreground)" }}
                >
                  {first.grant_id} →
                </a>
              </KVRow>
            ) : null}
            {first?.run_id ? (
              <KVRow k="run">
                <a
                  className="pdpp-typed"
                  href={`/dashboard/runs/${encodeURIComponent(first.run_id)}`}
                  style={{ color: "var(--color-foreground)" }}
                >
                  {first.run_id} →
                </a>
              </KVRow>
            ) : null}
          </KV>
        </SheetBody>
      </Sheet>

      {/* ─── Stat strip ─── */}
      <Band className="mb-6">
        <BandCell k="events" v={String(envelope.event_count)} />
        <BandCell k="page" v={String(events.length)} />
        {grantIds.length > 0 ? <BandCell k="grants" v={String(grantIds.length)} /> : null}
        {runIds.length > 0 ? <BandCell k="runs" v={String(runIds.length)} /> : null}
        {envelope.truncated ? <BandCell k="truncated" v="yes" /> : null}
      </Band>

      {/* ─── Pivot links ─── */}
      {grantIds.length > 0 || runIds.length > 0 ? (
        <div className="mb-6" style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
          {grantIds.map((id) => (
            <a
              className="pdpp-caption"
              href={`/dashboard/grants/${encodeURIComponent(id)}`}
              key={`grant:${id}`}
              style={{
                border: "1px solid var(--color-border)",
                color: "var(--color-foreground)",
                display: "inline-flex",
                alignItems: "center",
                padding: "var(--space-1) var(--space-2-5)",
              }}
            >
              grant{" "}
              <Typed as="code" className="ml-1">
                {id}
              </Typed>{" "}
              →
            </a>
          ))}
          {runIds.map((id) => (
            <a
              className="pdpp-caption"
              href={`/dashboard/runs/${encodeURIComponent(id)}`}
              key={`run:${id}`}
              style={{
                border: "1px solid var(--color-border)",
                color: "var(--color-foreground)",
                display: "inline-flex",
                alignItems: "center",
                padding: "var(--space-1) var(--space-2-5)",
              }}
            >
              run{" "}
              <Typed as="code" className="ml-1">
                {id}
              </Typed>{" "}
              →
            </a>
          ))}
        </div>
      ) : null}

      {/* ─── Timeline ─── */}
      <ProtocolSurface className="mb-6">
        <header className="mb-3 flex items-baseline justify-between gap-4">
          <Eyebrow as="h2">Timeline</Eyebrow>
          <Caption style={{ color: "var(--color-muted-foreground)" }}>
            {envelope.truncated ? `page · ${events.length} of ${envelope.event_count}` : `${events.length} events`}
          </Caption>
        </header>

        {events.length === 0 ? (
          <Caption style={{ color: "var(--color-muted-foreground)" }}>No events on this page.</Caption>
        ) : (
          <Table cols="3rem 1fr 8rem 13rem 6rem">
            <TableHeaderRow>
              <TableHeader>#</TableHeader>
              <TableHeader>event · actor</TableHeader>
              <TableHeader>status</TableHeader>
              <TableHeader>occurred at</TableHeader>
              <TableHeader>data</TableHeader>
            </TableHeaderRow>
            {nodes.map((node) => {
              if (node.kind === "progress-group") {
                return <ProgressGroupTableRow events={node.events} key={`pg-${node.start}`} startIndex={node.start} />;
              }
              return <EventTableRow event={node.event} index={node.index} key={node.event.event_id} />;
            })}
          </Table>
        )}

        {loadMoreHref ? (
          <div className="pdpp-caption mt-4" style={{ display: "flex", justifyContent: "flex-end" }}>
            <a
              href={loadMoreHref}
              style={{
                color: "var(--color-muted-foreground)",
                textDecoration: "underline",
                textUnderlineOffset: "2px",
              }}
            >
              load more timeline events →
            </a>
          </div>
        ) : null}
      </ProtocolSurface>

      {/* ─── CLI reference ─── */}
      <ProtocolSurface className="mb-6">
        <Eyebrow as="h2" className="mb-3">
          Reference CLI
        </Eyebrow>
        <Sheet>
          <SheetBody>
            <pre className="pdpp-caption overflow-x-auto" style={{ fontFamily: "var(--font-mono)" }}>
              {cliCommand}
            </pre>
          </SheetBody>
        </Sheet>
        <Caption className="mt-2" style={{ color: "var(--color-muted-foreground)" }}>
          Requires{" "}
          <a
            href="https://www.npmjs.com/package/@pdpp/cli"
            rel="noreferrer"
            style={{ textDecoration: "underline", textUnderlineOffset: "2px" }}
            target="_blank"
          >
            @pdpp/cli
          </a>{" "}
          on PATH. Set <Typed as="code">PDPP_OWNER_SESSION_COOKIE</Typed> when owner auth is enabled.
        </Caption>
        <Caption className="mt-1 break-all" style={{ color: "var(--color-muted-foreground)" }}>
          raw: <Typed as="code">{rsUrl}</Typed>
        </Caption>
      </ProtocolSurface>
    </RecordroomShellWithPalette>
  );
}
