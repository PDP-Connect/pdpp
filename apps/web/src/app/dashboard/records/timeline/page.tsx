import Link from 'next/link';
import { DashboardShell, OwnerTokenRequired, ServerUnreachable } from '../../components/shell';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DataList,
  PageHeader,
  Section,
  Toolbar,
} from '../../components/primitives';
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
          <PageHeader title="Timeline" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  return (
    <DashboardShell active="records">
      <PageHeader
        title="Timeline"
        description="Time-anchored records across all connectors, sorted by the owner's data time."
        breadcrumbs={[{ label: 'Records', href: '/dashboard/records' }, { label: 'Timeline' }]}
        count={`${result.entries.length} entries · ${result.sources} streams scanned · ${result.scanned} records`}
      />

      <form method="get">
        <Toolbar
          trailing={
            <div className="pdpp-caption flex flex-wrap gap-3">
              {([1, 7, 30, 90] as const).map((d) => {
                const { since: s, until: u } = defaultWindow(d);
                return (
                  <Link
                    key={d}
                    href={`/dashboard/records/timeline?since=${s}&until=${u}`}
                    className="text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  >
                    {d}d
                  </Link>
                );
              })}
            </div>
          }
        >
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Since</span>
            <Input type="date" name="since" defaultValue={since} />
          </label>
          <label className="flex min-w-0 flex-col gap-1">
            <span className="pdpp-eyebrow">Until</span>
            <Input type="date" name="until" defaultValue={until} />
          </label>
          <Button type="submit" size="sm" className="mt-5">
            Apply
          </Button>
          <Link
            href="/dashboard/records/timeline"
            className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} mt-5`}
          >
            Reset
          </Link>
        </Toolbar>
      </form>

      <Section>
        {result.entries.length === 0 ? (
          <p className="pdpp-caption text-muted-foreground italic">
            No time-anchored records in this window. Try widening the range or loading more data.
          </p>
        ) : (
          <DataList>
            {result.entries.map((e) => (
              <li key={`${e.connectorId}::${e.stream}::${e.recordId}`}>
                <TimelineRow entry={e} />
              </li>
            ))}
          </DataList>
        )}
      </Section>
    </DashboardShell>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const href = `/dashboard/records/${encodeURIComponent(entry.connectorId)}/${encodeURIComponent(entry.stream)}/${encodeURIComponent(entry.recordId)}`;
  const connectorShort = shortConnectorName(entry.connectorId);
  return (
    <Link
      href={href}
      className="pdpp-caption hover:bg-muted/40 grid gap-1 px-3 py-2.5 transition-colors sm:grid-cols-[11rem_11rem_1fr] sm:items-baseline sm:gap-4"
    >
      <span className="text-muted-foreground whitespace-nowrap tabular-nums">
        {formatTimestamp(entry.timestamp)}
      </span>
      <span className="text-foreground flex items-baseline gap-2 whitespace-nowrap">
        <span className="truncate font-mono font-medium">{connectorShort}</span>
        <span className="pdpp-caption text-muted-foreground truncate font-mono">{entry.stream}</span>
      </span>
      <span className="break-words">{entry.summary}</span>
    </Link>
  );
}
