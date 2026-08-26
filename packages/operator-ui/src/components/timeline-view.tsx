// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { humanizeFieldLabel } from "@pdpp/display";
import Link from "next/link";
// biome-ignore lint/correctness/noUnresolvedImports: React 19 exports Fragment; tsc validates the import and Biome 2.5.5 misreads the package export map.
import { Fragment } from "react";
import type { SpineEvent } from "../lib/ref-client.ts";
import { Timestamp } from "../ui/timestamp.tsx";

const SECRET_KEYS = new Set([
  "interaction_response",
  "INTERACTION_RESPONSE",
  "access_token",
  "refresh_token",
  "device_code",
  "user_code",
]);

// Connectors sometimes emit hundreds or thousands of `run.progress_reported`
// events in a single run (e.g. Claude Code ingest). Rendering them all makes
// the timeline unusable and drowns out the state transitions an operator
// actually needs to see. When we find a run of ≥ this many consecutive
// progress rows, we collapse them into a single summary row that retains
// the final message/count/total and a per-stream breakdown. Individual
// rows are still reachable via the <details> toggle inside the group.
const PROGRESS_GROUP_THRESHOLD = 5;

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

function eventRowClass(ev: SpineEvent): string {
  if (ev.status === "failed" || ev.status === "rejected") {
    return "border-l-destructive";
  }
  if (ev.event_type.startsWith("run.state_advanced")) {
    return "border-l-green-600";
  }
  if (ev.event_type.startsWith("run.state_staged")) {
    return "border-l-amber-500";
  }
  if (ev.event_type.startsWith("run.state_commit_failed")) {
    return "border-l-destructive";
  }
  return "border-l-border";
}

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
        nodes.push({ events: events.slice(i, j), kind: "progress-group", start: i });
        i = j;
        continue;
      }
    }
    nodes.push({ event: current, index: i, kind: "event" });
    i += 1;
  }
  return nodes;
}

export function TimelineView({
  events,
  loadMoreHref,
}: {
  events: SpineEvent[];
  // Forwarded verbatim from TimelineDetailView's own same-shaped optional
  // prop and read only via `loadMoreHref ? ... : null` below, so "absent"
  // and "present but undefined" are already the same "no more pages" one
  // level up.
  loadMoreHref?: string | null | undefined;
}) {
  const nodes = groupTimeline(events);
  return (
    <>
      <ol className="relative space-y-1.5">
        {nodes.map((node) => {
          if (node.kind === "progress-group") {
            return <ProgressGroupRow events={node.events} key={`pg-${node.start}`} startIndex={node.start} />;
          }
          return <EventRow event={node.event} index={node.index} key={node.event.event_id} />;
        })}
      </ol>
      {loadMoreHref ? (
        <div className="pdpp-caption mt-4 flex justify-end">
          <Link
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            href={loadMoreHref}
          >
            load more timeline events →
          </Link>
        </div>
      ) : null}
    </>
  );
}

function EventRow({ event, index }: { event: SpineEvent; index: number }) {
  return (
    <li
      className={`rounded-md border border-border/70 border-l-4 bg-muted/15 px-3 py-2 ${eventRowClass(event)}`}
      id={event.event_id}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="pdpp-caption text-muted-foreground/70 tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </span>
          <code className="pdpp-caption font-medium font-mono" title={event.event_type}>
            {humanizeFieldLabel(event.event_type)}
          </code>
          <span
            className={`pdpp-eyebrow rounded px-1.5 py-0.5 font-medium ${
              event.status === "failed" || event.status === "rejected"
                ? "bg-destructive/10 text-destructive"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {event.status}
          </span>
        </div>
        <span className="pdpp-caption text-muted-foreground">
          <Timestamp value={event.occurred_at} />
        </span>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        <span className="font-mono">
          {event.actor_type}/{event.actor_id}
        </span>
        {event.stream_id ? ` · stream ${humanizeFieldLabel(event.stream_id)}` : ""}
        {event.request_id ? ` · req ${event.request_id}` : ""}
      </div>
      <details className="mt-1">
        <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">data</summary>
        <pre className="pdpp-caption mt-1 overflow-x-auto rounded border border-border/70 bg-background p-2 font-mono">
          {/** biome-ignore lint/suspicious/noUnnecessaryConditions: The declared public input remains defensive at this boundary; removing the guard would reduce runtime tolerance. */}
          {JSON.stringify(redactSecrets(event.data || {}), null, 2)}
        </pre>
      </details>
    </li>
  );
}

interface StreamBreakdown {
  count: number;
  latestCount: number | null;
  latestMessage: string | null;
  latestTotal: number | null;
  stream: string;
}

function formatStreamProgress(s: StreamBreakdown): string {
  if (s.latestCount === null) {
    return "";
  }
  if (s.latestTotal !== null && s.latestTotal > 0) {
    return ` · ${s.latestCount}/${s.latestTotal}`;
  }
  return ` · ${s.latestCount}`;
}

function summarizeStreams(events: SpineEvent[]): StreamBreakdown[] {
  const byStream = new Map<string, StreamBreakdown>();
  for (const event of events) {
    const stream = event.stream_id ?? "—";
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The declared public input remains defensive at this boundary; removing the guard would reduce runtime tolerance.
    const message = typeof event.data?.message === "string" ? event.data.message : null;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The declared public input remains defensive at this boundary; removing the guard would reduce runtime tolerance.
    const count = typeof event.data?.count === "number" ? event.data.count : null;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: The declared public input remains defensive at this boundary; removing the guard would reduce runtime tolerance.
    const total = typeof event.data?.total === "number" ? event.data.total : null;
    const existing = byStream.get(stream);
    if (existing) {
      existing.count += 1;
      existing.latestMessage = message ?? existing.latestMessage;
      existing.latestCount = count ?? existing.latestCount;
      existing.latestTotal = total ?? existing.latestTotal;
    } else {
      byStream.set(stream, {
        count: 1,
        latestCount: count,
        latestMessage: message,
        latestTotal: total,
        stream,
      });
    }
  }
  return Array.from(byStream.values()).sort((a, b) => b.count - a.count);
}

function ProgressGroupRow({ events, startIndex }: { events: SpineEvent[]; startIndex: number }) {
  const [first] = events;
  const last = events.at(-1);
  if (!(first && last)) {
    return null;
  }
  const streams = summarizeStreams(events);
  const endIndex = startIndex + events.length - 1;

  return (
    <li className="rounded-md border border-border/70 border-l-4 border-l-blue-500/70 bg-muted/15 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="pdpp-caption text-muted-foreground/70 tabular-nums">
            {String(startIndex + 1).padStart(2, "0")}–{String(endIndex + 1).padStart(2, "0")}
          </span>
          <code className="pdpp-caption font-medium font-mono" title="run.progress_reported">
            {humanizeFieldLabel("run.progress_reported")}
          </code>
          <span className="pdpp-eyebrow rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            {events.length.toLocaleString()} reports
          </span>
        </div>
        <span className="pdpp-caption text-muted-foreground">
          <Timestamp value={first.occurred_at} />
          {" → "}
          <Timestamp value={last.occurred_at} />
        </span>
      </div>
      <div className="pdpp-caption mt-1 text-muted-foreground">
        {streams[0] && streams.length === 1 ? (
          <span>stream {humanizeFieldLabel(streams[0].stream)}</span>
        ) : (
          <span>{streams.length} streams</span>
        )}
        {" · latest: "}
        <span className="text-foreground">{typeof last.data?.message === "string" ? last.data.message : "—"}</span>
      </div>
      {streams.length > 1 ? (
        <dl className="pdpp-caption mt-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5">
          {streams.map((s) => (
            <Fragment key={s.stream}>
              <dt className="font-mono text-muted-foreground" title={s.stream}>
                {humanizeFieldLabel(s.stream)}
              </dt>
              <dd className="truncate text-muted-foreground">{s.latestMessage ?? "—"}</dd>
              <dd className="text-right text-muted-foreground tabular-nums">
                {s.count.toLocaleString()}
                {formatStreamProgress(s)}
              </dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <details className="mt-2">
        <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">
          show {events.length.toLocaleString()} individual reports
        </summary>
        <ol className="mt-2 space-y-1">
          {events.map((ev, offset) => (
            <EventRow event={ev} index={startIndex + offset} key={ev.event_id} />
          ))}
        </ol>
      </details>
    </li>
  );
}
