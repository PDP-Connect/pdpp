import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DashboardShell, ServerUnreachable } from '../../components/shell';
import { ReferenceServerUnreachableError } from '../../lib/owner-token';
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
      <nav className="text-muted-foreground mb-3 text-xs">
        <Link href="/dashboard/traces" className="hover:text-foreground">
          traces
        </Link>
        <span className="mx-1">/</span>
        <span className="text-foreground">trace</span>
      </nav>
      <header className="mb-4">
        <h1 className="text-lg font-semibold break-all">trace {traceId}</h1>
        <div className="text-muted-foreground mt-1 text-xs">
          {envelope.events.length} events · actor {first?.actor_type}/{first?.actor_id}
        </div>
      </header>

      {(grantIds.length > 0 || runIds.length > 0) && (
        <section className="mb-4 flex flex-wrap gap-2 text-xs">
          {grantIds.map((id) => (
            <Link
              key={id}
              href={`/dashboard/grants/${encodeURIComponent(id)}`}
              className="border-border hover:bg-muted/50 rounded border px-2 py-1"
            >
              grant {id} →
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

      <CliEquivalent traceId={traceId} />
    </DashboardShell>
  );
}

function CliEquivalent({ traceId }: { traceId: string }) {
  return (
    <section className="mt-6">
      <h2 className="text-muted-foreground mb-2 text-xs uppercase tracking-wide">
        CLI equivalent
      </h2>
      <pre className="bg-muted overflow-x-auto rounded p-3 text-[11px]">
        pdpp trace show {traceId}
      </pre>
      <p className="text-muted-foreground mt-1 text-[11px] break-all">
        raw: <code>{`/_ref/traces/${encodeURIComponent(traceId)}`}</code>
      </p>
    </section>
  );
}
