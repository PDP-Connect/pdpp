import { Fragment } from "react";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import type { SpineEvent } from "../lib/ref-client.ts";

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

export function TimelineView({ events }: { events: SpineEvent[] }) {
  const nodes = groupTimeline(events);
  return (
    <ol className="relative space-y-1.5">
      {nodes.map((node) => {
        if (node.kind === "progress-group") {
          return <ProgressGroupRow events={node.events} key={`pg-${node.start}`} startIndex={node.start} />;
        }
        return <EventRow event={node.event} index={node.index} key={node.event.event_id} />;
      })}
    </ol>
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
          <code className="pdpp-caption font-medium font-mono">{event.event_type}</code>
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
        {event.stream_id ? ` · stream ${event.stream_id}` : ""}
        {event.request_id ? ` · req ${event.request_id}` : ""}
      </div>
      <details className="mt-1">
        <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">data</summary>
        <pre className="pdpp-caption mt-1 overflow-x-auto rounded border border-border/70 bg-background p-2 font-mono">
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
  if (s.latestCount == null) {
    return "";
  }
  if (s.latestTotal != null && s.latestTotal > 0) {
    return ` · ${s.latestCount}/${s.latestTotal}`;
  }
  return ` · ${s.latestCount}`;
}

function summarizeStreams(events: SpineEvent[]): StreamBreakdown[] {
  const byStream = new Map<string, StreamBreakdown>();
  for (const event of events) {
    const stream = event.stream_id ?? "—";
    const message = typeof event.data?.message === "string" ? event.data.message : null;
    const count = typeof event.data?.count === "number" ? event.data.count : null;
    const total = typeof event.data?.total === "number" ? event.data.total : null;
    const existing = byStream.get(stream);
    if (existing) {
      existing.count += 1;
      existing.latestMessage = message ?? existing.latestMessage;
      existing.latestCount = count ?? existing.latestCount;
      existing.latestTotal = total ?? existing.latestTotal;
    } else {
      byStream.set(stream, {
        stream,
        count: 1,
        latestMessage: message,
        latestCount: count,
        latestTotal: total,
      });
    }
  }
  return Array.from(byStream.values()).sort((a, b) => b.count - a.count);
}

function ProgressGroupRow({ events, startIndex }: { events: SpineEvent[]; startIndex: number }) {
  const first = events[0];
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
          <code className="pdpp-caption font-medium font-mono">run.progress_reported</code>
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
        {streams.length === 1 ? <span>stream {streams[0]?.stream}</span> : <span>{streams.length} streams</span>}
        {" · latest: "}
        <span className="text-foreground">{typeof last.data?.message === "string" ? last.data.message : "—"}</span>
      </div>
      {streams.length > 1 ? (
        <dl className="pdpp-caption mt-2 grid grid-cols-[auto_1fr_auto] gap-x-3 gap-y-0.5">
          {streams.map((s) => (
            <Fragment key={s.stream}>
              <dt className="font-mono text-muted-foreground">{s.stream}</dt>
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
