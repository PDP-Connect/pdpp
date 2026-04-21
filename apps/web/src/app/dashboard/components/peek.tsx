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
      className="border-border bg-background sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto rounded border"
      aria-label="peek"
      data-testid="peek-pane"
    >
      <div className="border-border bg-muted/30 sticky top-0 flex items-center justify-between gap-2 border-b px-3 py-2 text-xs">
        <span className="font-medium truncate">{title}</span>
        <div className="flex items-center gap-2 whitespace-nowrap">
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
      <div className="p-3 text-xs">
        {children}
        {cliCommand && (
          <div className="mt-3">
            <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
              CLI equivalent
            </div>
            <pre className="bg-muted overflow-x-auto rounded p-2 text-[11px]">{cliCommand}</pre>
          </div>
        )}
      </div>
    </aside>
  );
}

export function PeekEmpty() {
  return (
    <aside
      className="border-border text-muted-foreground hidden items-center justify-center rounded border p-6 text-xs md:flex"
      aria-label="peek hint"
    >
      select an item to peek
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
