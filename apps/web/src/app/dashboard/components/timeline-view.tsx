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

export function TimelineView({ events }: { events: SpineEvent[] }) {
  return (
    <ol className="relative space-y-1.5">
      {events.map((ev, i) => (
        <li
          key={ev.event_id}
          className={`rounded-md border border-border/70 border-l-4 bg-muted/15 px-3 py-2 ${eventRowClass(ev)}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="pdpp-caption text-muted-foreground/70 tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              <code className="pdpp-caption font-medium font-mono">{ev.event_type}</code>
              <span
                className={`pdpp-eyebrow rounded px-1.5 py-0.5 font-medium ${
                  ev.status === "failed" || ev.status === "rejected"
                    ? "bg-destructive/10 text-destructive"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {ev.status}
              </span>
            </div>
            <span className="pdpp-caption text-muted-foreground">
              <Timestamp value={ev.occurred_at} />
            </span>
          </div>
          <div className="pdpp-caption mt-1 text-muted-foreground">
            <span className="font-mono">
              {ev.actor_type}/{ev.actor_id}
            </span>
            {ev.stream_id ? ` · stream ${ev.stream_id}` : ""}
            {ev.request_id ? ` · req ${ev.request_id}` : ""}
          </div>
          <details className="mt-1">
            <summary className="pdpp-caption cursor-pointer text-muted-foreground hover:text-foreground">data</summary>
            <pre className="pdpp-caption mt-1 overflow-x-auto rounded border border-border/70 bg-background p-2 font-mono">
              {JSON.stringify(redactSecrets(ev.data || {}), null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
