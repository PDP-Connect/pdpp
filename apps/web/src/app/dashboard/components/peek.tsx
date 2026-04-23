import Link from 'next/link';
import type { ReactNode } from 'react';
import type { SpineEvent, TimelineEnvelope } from '../lib/ref-client';
import { TimelineView } from './timeline-view';

export function PeekPane({
  title,
  closeHref,
  openHref,
  cliCommand,
  children,
}: {
  title: string;
  closeHref: string;
  openHref: string;
  cliCommand?: string;
  children: ReactNode;
}) {
  return (
    <aside
      className="border-border/80 bg-background sticky top-16 max-h-[calc(100vh-5rem)] overflow-y-auto overscroll-contain rounded-md border"
      aria-label="peek"
      data-testid="peek-pane"
    >
      <div className="pdpp-caption border-border/80 bg-muted/40 sticky top-0 flex items-center justify-between gap-2 border-b px-3 py-2 backdrop-blur">
        <span className="font-medium truncate">{title}</span>
        <div className="flex items-center gap-3 whitespace-nowrap">
          <Link
            href={openHref}
            className="hover:text-foreground text-muted-foreground underline-offset-2 hover:underline"
          >
            open full →
          </Link>
          <Link
            href={closeHref}
            aria-label="close peek"
            className="hover:text-foreground text-muted-foreground"
          >
            ×
          </Link>
        </div>
      </div>
      <div className="pdpp-caption p-3">
        {children}
        {cliCommand && (
          <div className="mt-3">
            <div className="pdpp-eyebrow mb-1">CLI equivalent</div>
            <pre className="pdpp-caption bg-muted overflow-x-auto rounded p-2 font-mono">{cliCommand}</pre>
          </div>
        )}
      </div>
    </aside>
  );
}

export function PeekEmpty() {
  return (
    <aside
      className="pdpp-caption border-border/80 border-dashed text-muted-foreground hidden items-center justify-center rounded-md border p-6 italic xl:flex"
      aria-label="peek hint"
    >
      Select a row to peek its timeline
    </aside>
  );
}

/**
 * Render a condensed timeline section inside the peek pane.
 */
export function PeekTimeline({ events }: { events: SpineEvent[] }) {
  return <TimelineView events={events} />;
}

/**
 * Derive pivot links from the events inside a timeline envelope.
 */
export function pivotsFromEnvelope(envelope: TimelineEnvelope): Array<{
  kind: 'trace' | 'grant' | 'run';
  id: string;
}> {
  const pivots: Array<{ kind: 'trace' | 'grant' | 'run'; id: string }> = [];
  const seen = new Set<string>();
  for (const ev of envelope.events) {
    for (const [key, kind] of [
      ['trace_id', 'trace'] as const,
      ['grant_id', 'grant'] as const,
      ['run_id', 'run'] as const,
    ]) {
      const id = ev[key];
      if (!id) continue;
      const tag = `${kind}:${id}`;
      if (seen.has(tag)) continue;
      seen.add(tag);
      pivots.push({ kind, id });
    }
  }
  return pivots;
}
