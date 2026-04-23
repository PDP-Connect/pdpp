import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { PageHeader, Section } from '../../components/primitives';
import { ReferenceServerUnreachableError, getAsInternalUrl } from '../../lib/owner-token';
import { getGrantTimeline, type TimelineEnvelope } from '../../lib/ref-client';
import { TimelineView } from '../../components/timeline-view';

export const dynamic = 'force-dynamic';

export default async function GrantDetailPage({
  params,
}: {
  params: Promise<{ grantId: string }>;
}) {
  const { grantId: raw } = await params;
  const grantId = decodeURIComponent(raw);

  let envelope: TimelineEnvelope | null;
  try {
    envelope = await getGrantTimeline(grantId);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="grants">
          <PageHeader title="Grant" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  if (!envelope) notFound();

  const traceIds = Array.from(
    new Set(envelope.events.map((e) => e.trace_id).filter(Boolean) as string[]),
  );
  const runIds = Array.from(
    new Set(envelope.events.map((e) => e.run_id).filter(Boolean) as string[]),
  );
  const revoked = envelope.events.some(
    (e) => e.event_type === 'grant.revoked' || e.status === 'revoked',
  );

  return (
    <DashboardShell active="grants">
      <PageHeader
        title={<code className="font-mono">{grantId}</code>}
        breadcrumbs={[{ label: 'Grants', href: '/dashboard/grants' }, { label: 'Grant' }]}
        count={`${envelope.events.length} events${revoked ? ' · revoked' : ''}`}
      />

      {traceIds.length > 0 || runIds.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {traceIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/traces/${encodeURIComponent(id)}`}
              className="pdpp-caption border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-2.5 py-1"
            >
              trace <code className="ml-1 font-mono">{id}</code> →
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
          pdpp grant timeline {grantId}
        </pre>
        <p className="pdpp-caption text-muted-foreground mt-1 break-all">
          raw: <code>{`${getAsInternalUrl()}/_ref/grants/${encodeURIComponent(grantId)}/timeline`}</code>
        </p>
      </Section>
    </DashboardShell>
  );
}
