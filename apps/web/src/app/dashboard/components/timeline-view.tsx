import type { SpineEvent } from '../lib/ref-client';

const SECRET_KEYS = new Set([
  'interaction_response',
  'INTERACTION_RESPONSE',
  'access_token',
  'refresh_token',
  'device_code',
  'user_code',
]);

function redactSecrets(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = '<redacted>';
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function eventRowClass(ev: SpineEvent): string {
  if (ev.status === 'failed' || ev.status === 'rejected') {
    return 'border-l-destructive';
  }
  if (ev.event_type.startsWith('run.state_advanced')) return 'border-l-green-600';
  if (ev.event_type.startsWith('run.state_staged')) return 'border-l-amber-500';
  if (ev.event_type.startsWith('run.state_commit_failed')) return 'border-l-destructive';
  return 'border-l-border';
}

export function TimelineView({ events }: { events: SpineEvent[] }) {
  return (
    <ol className="relative space-y-2">
      {events.map((ev, i) => (
        <li
          key={ev.event_id}
          className={`border-border bg-muted/10 rounded border border-l-4 px-3 py-2 ${eventRowClass(ev)}`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-muted-foreground tabular-nums text-[10px]">
                {String(i + 1).padStart(2, '0')}
              </span>
              <code className="text-xs font-medium">{ev.event_type}</code>
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  ev.status === 'failed' || ev.status === 'rejected'
                    ? 'bg-destructive/10 text-destructive'
                    : ev.status === 'succeeded'
                    ? 'bg-muted text-muted-foreground'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {ev.status}
              </span>
            </div>
            <span className="text-muted-foreground tabular-nums text-[10px]">
              {ev.occurred_at}
            </span>
          </div>
          <div className="text-muted-foreground mt-1 text-[11px]">
            {ev.actor_type}/{ev.actor_id}
            {ev.stream_id ? ` · stream ${ev.stream_id}` : ''}
            {ev.request_id ? ` · req ${ev.request_id}` : ''}
          </div>
          <details className="mt-1">
            <summary className="text-muted-foreground cursor-pointer text-[11px]">
              data
            </summary>
            <pre className="bg-background mt-1 overflow-x-auto rounded border border-border p-2 text-[10px]">
              {JSON.stringify(redactSecrets(ev.data || {}), null, 2)}
            </pre>
          </details>
        </li>
      ))}
    </ol>
  );
}
