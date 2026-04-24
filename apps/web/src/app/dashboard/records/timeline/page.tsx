import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DataList, PageHeader, Section, Toolbar } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { defaultWindow, loadTimeline, shortConnectorName, type TimelineEntry } from "../../lib/timeline.ts";

export const dynamic = "force-dynamic";

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
        breadcrumbs={[{ label: "Records", href: "/dashboard/records" }, { label: "Timeline" }]}
        count={`${result.entries.length} entries · ${result.sources} streams scanned · ${result.scanned} records`}
        description="Time-anchored records across all connectors, sorted by the owner's data time."
        title="Timeline"
      />

      <form method="get">
        <Toolbar
          trailing={
            <div className="pdpp-caption flex flex-wrap gap-3">
              {([1, 7, 30, 90] as const).map((d) => {
                const { since: s, until: u } = defaultWindow(d);
                return (
                  <Link
                    className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                    href={`/dashboard/records/timeline?since=${s}&until=${u}`}
                    key={d}
                  >
                    {d}d
                  </Link>
                );
              })}
            </div>
          }
        >
          <label className="flex min-w-0 flex-col gap-1" htmlFor="records-timeline-since">
            <span className="pdpp-eyebrow">Since</span>
            <Input defaultValue={since} id="records-timeline-since" name="since" type="date" />
          </label>
          <label className="flex min-w-0 flex-col gap-1" htmlFor="records-timeline-until">
            <span className="pdpp-eyebrow">Until</span>
            <Input defaultValue={until} id="records-timeline-until" name="until" type="date" />
          </label>
          <Button className="mt-5" size="sm" type="submit">
            Apply
          </Button>
          <Link
            className={`${buttonVariants({ variant: "ghost", size: "sm" })} mt-5`}
            href="/dashboard/records/timeline"
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
      className="pdpp-caption grid gap-1 px-3 py-2.5 transition-colors hover:bg-muted/40 sm:grid-cols-[11rem_11rem_1fr] sm:items-baseline sm:gap-4"
      href={href}
    >
      <span className="whitespace-nowrap text-muted-foreground">
        <Timestamp value={entry.timestamp} />
      </span>
      <span className="flex items-baseline gap-2 whitespace-nowrap text-foreground">
        <span className="truncate font-medium font-mono">{connectorShort}</span>
        <span className="pdpp-caption truncate font-mono text-muted-foreground">{entry.stream}</span>
      </span>
      <span className="break-words">{entry.summary}</span>
    </Link>
  );
}
