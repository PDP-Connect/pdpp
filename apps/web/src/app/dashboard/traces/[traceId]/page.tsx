import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { PageHeader, Section } from '../../components/primitives';
import { ReferenceServerUnreachableError, getAsInternalUrl } from '../../lib/owner-token';
import { getTraceTimeline, type TimelineEnvelope } from '../../lib/ref-client';
import { TimelineView } from '../../components/timeline-view';

export const dynamic = 'force-dynamic';

export default async function TraceDetailPage({
  params,
}: {
  params: Promise<{ traceId: string }>;
}) {
  const { traceId: raw } = await params;
  const traceId = decodeURIComponent(raw);

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getTraceTimeline(traceId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="traces">
          <PageHeader title="Trace" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  if (!envelope) notFound();

  const first = envelope.events[0];
  const grantIds = Array.from(
    new Set(envelope.events.map((e) => e.grant_id).filter(Boolean) as string[]),
  );
  const runIds = Array.from(
    new Set(envelope.events.map((e) => e.run_id).filter(Boolean) as string[]),
  );

  return (
    <DashboardShell active="traces">
      <PageHeader
        title={<code className="font-mono">{traceId}</code>}
        breadcrumbs={[{ label: 'Traces', href: '/dashboard/traces' }, { label: 'Trace' }]}
        description={
          <>
            {envelope.events.length} events
            {first ? (
              <>
                {' · '}actor <span className="text-foreground font-mono">
                  {first.actor_type}/{first.actor_id}
                </span>
              </>
            ) : null}
          </>
        }
      />

      {grantIds.length > 0 || runIds.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {grantIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/grants/${encodeURIComponent(id)}`}
              className="pdpp-caption border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-2.5 py-1"
            >
              grant <code className="ml-1 font-mono">{id}</code> →
            </Link>
          ))}
          {runIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/runs/${encodeURIComponent(id)}`}
              className="pdpp-caption border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-2.5 py-1"
            >
              run <code className="ml-1 font-mono">{id}</code> →
            </Link>
          ))}
        </div>
      ) : null}

      <Section title="Timeline">
        <TimelineView events={envelope.events} />
      </Section>

      <Section title="CLI equivalent">
        <pre className="pdpp-caption border-border/80 bg-muted/30 overflow-x-auto rounded-md border p-3 font-mono">
          pdpp trace show {traceId}
        </pre>
        <p className="pdpp-caption text-muted-foreground mt-1 break-all">
          raw: <code>{`${getAsInternalUrl()}/_ref/traces/${encodeURIComponent(traceId)}`}</code>
        </p>
      </Section>
    </DashboardShell>
  );
}
