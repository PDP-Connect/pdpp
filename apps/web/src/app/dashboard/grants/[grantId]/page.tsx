import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { ReferenceServerUnreachableError, getAsUrl } from '../../lib/owner-token';
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
      <nav className="text-muted-foreground mb-3 text-xs">
        <Link href="/dashboard/grants" className="hover:text-foreground">
          grants
        </Link>
        <span className="mx-1">/</span>
        <span className="text-foreground">grant</span>
      </nav>
      <header className="mb-4">
        <h1 className="text-lg font-semibold break-all">grant {grantId}</h1>
        <div className="text-muted-foreground mt-1 text-xs">
          {envelope.events.length} events {revoked ? '· revoked' : ''}
        </div>
      </header>

      {(traceIds.length > 0 || runIds.length > 0) && (
        <section className="mb-4 flex flex-wrap gap-2 text-xs">
          {traceIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/traces/${encodeURIComponent(id)}`}
              className="border-border hover:bg-muted/50 rounded border px-2 py-1"
            >
              trace {id} →
            </Link>
          ))}
          {runIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/runs/${encodeURIComponent(id)}`}
              className="border-border hover:bg-muted/50 rounded border px-2 py-1"
            >
              run {id} →
            </Link>
          ))}
        </section>
      )}

      <TimelineView events={envelope.events} />

      <section className="mt-6">
        <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
          CLI equivalent
        </h2>
        <pre className="bg-muted overflow-x-auto rounded p-3 text-[11px]">
          pdpp grant timeline {grantId}
        </pre>
        <p className="text-muted-foreground mt-1 text-[11px] break-all">
          raw: <code>{`${getAsUrl()}/_ref/grants/${encodeURIComponent(grantId)}/timeline`}</code>
        </p>
      </section>
    </DashboardShell>
  );
}
