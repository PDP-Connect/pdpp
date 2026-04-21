import Link from 'next/link';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { ReferenceServerUnreachableError } from '../../lib/owner-token';
import { formatTimestamp } from '../../lib/rs-client';
import {
  defaultWindow,
  loadTimeline,
  shortConnectorName,
  type TimelineEntry,
} from '../../lib/timeline';

export const dynamic = 'force-dynamic';

export default async function RecordsTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string; until?: string }>;
}) {
  const { since: sinceParam, until: untilParam } = await searchParams;
  const fallback = defaultWindow(7);
  const since = sinceParam || fallback.since;
  const until = untilParam || fallback.until;

  let result: Awaited<ReturnType<typeof loadTimeline>>;
  try {
    result = await loadTimeline({ since, until });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="records">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  return (
    <DashboardShell active="records">
      <nav className="text-muted-foreground mb-3 flex flex-wrap items-center gap-x-2 text-xs">
        <Link href="/dashboard/records" className="hover:text-foreground">records</Link>
        <span>/</span>
        <span className="text-foreground">timeline</span>
      </nav>
      <header className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <h1 className="text-lg font-semibold">timeline</h1>
        <span className="text-muted-foreground text-xs">
          {result.entries.length} entries · {result.sources} streams scanned · {result.scanned} records
        </span>
      </header>

      <form method="get" className="text-muted-foreground mb-4 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          since
          <input
            type="date"
            name="since"
            defaultValue={since}
            className="border-border bg-background text-foreground rounded border px-2 py-1"
          />
        </label>
        <label className="flex items-center gap-1">
          until
          <input
            type="date"
            name="until"
            defaultValue={until}
            className="border-border bg-background text-foreground rounded border px-2 py-1"
          />
        </label>
        <button
          type="submit"
          className="border-border hover:bg-muted/50 rounded border px-2 py-1"
        >
          apply
        </button>
        <WindowPresetLinks />
      </form>

      {result.entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No time-anchored records in this window. Try widening the range or loading more data.
        </p>
      ) : (
        <ul className="divide-border divide-y border-y">
          {result.entries.map((e) => (
            <li key={`${e.connectorId}::${e.stream}::${e.recordId}`}>
              <TimelineRow entry={e} />
            </li>
          ))}
        </ul>
      )}
    </DashboardShell>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const href = `/dashboard/records/${encodeURIComponent(entry.connectorId)}/${encodeURIComponent(entry.stream)}/${encodeURIComponent(entry.recordId)}`;
  const connectorShort = shortConnectorName(entry.connectorId);
  return (
    <Link
      href={href}
      className="hover:bg-muted/50 grid gap-1 px-2 py-2 text-xs sm:grid-cols-[10rem_9rem_1fr] sm:items-baseline sm:gap-4"
    >
      <span className="text-muted-foreground whitespace-nowrap tabular-nums">
        {formatTimestamp(entry.timestamp)}
      </span>
      <span className="text-foreground flex items-baseline gap-2 whitespace-nowrap">
        <span className="truncate font-medium">{connectorShort}</span>
        <span className="text-muted-foreground truncate">{entry.stream}</span>
      </span>
      <span className="break-words">{entry.summary}</span>
    </Link>
  );
}

function WindowPresetLinks() {
  return (
    <span className="ml-auto flex flex-wrap gap-2">
      {([1, 7, 30, 90] as const).map((d) => {
        const { since, until } = defaultWindow(d);
        return (
          <Link
            key={d}
            href={`/dashboard/records/timeline?since=${since}&until=${until}`}
            className="hover:text-foreground"
          >
            {d}d
          </Link>
        );
      })}
    </span>
  );
}
