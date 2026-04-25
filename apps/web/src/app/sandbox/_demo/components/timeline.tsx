import type { DemoTimelineEvent } from "../types.ts";

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-[color:var(--success)]",
  issued: "text-[color:var(--success)]",
  approved: "text-[color:var(--success)]",
  declined: "text-destructive",
  refused: "text-destructive",
  revoked: "text-destructive",
  failed: "text-destructive",
  needs_input: "text-[color:var(--warning)]",
  started: "text-[color:var(--warning)]",
  presented: "text-muted-foreground",
  received: "text-muted-foreground",
  running: "text-muted-foreground",
};

export function Timeline({ events }: { events: readonly DemoTimelineEvent[] }) {
  if (events.length === 0) {
    return <p className="pdpp-body text-muted-foreground">No events recorded for this object.</p>;
  }
  return (
    <ol className="space-y-4">
      {events.map((evt) => (
        <li className="flex gap-3" key={evt.event_id}>
          <div className="pt-1">
            <span aria-hidden className="block h-2 w-2 rounded-full bg-foreground/60" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="pdpp-body font-medium text-foreground">{evt.event_type}</span>
              <span className="pdpp-caption text-muted-foreground tabular-nums">{evt.occurred_at}</span>
            </div>
            <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-2">
              {evt.status ? (
                <span className={`pdpp-eyebrow ${STATUS_TONE[evt.status] ?? "text-muted-foreground"}`}>
                  {evt.status}
                </span>
              ) : null}
              <code className="pdpp-caption break-all font-mono text-muted-foreground">{evt.event_id}</code>
            </div>
            {Object.keys(evt.data).length > 0 ? (
              <pre className="pdpp-caption mt-2 overflow-x-auto rounded border border-border/70 bg-muted/30 px-2 py-1.5 font-mono text-foreground">
                {JSON.stringify(evt.data, null, 2)}
              </pre>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
