import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Section } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { TimelineView } from "../../components/timeline-view.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getTraceTimeline, type TimelineEnvelope } from "../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

export default async function TraceDetailPage({ params }: { params: Promise<{ traceId: string }> }) {
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

  if (!envelope) {
    notFound();
  }

  const first = envelope.events[0];
  const grantIds = Array.from(new Set(envelope.events.map((e) => e.grant_id).filter(Boolean) as string[]));
  const runIds = Array.from(new Set(envelope.events.map((e) => e.run_id).filter(Boolean) as string[]));

  return (
    <DashboardShell active="traces">
      <PageHeader
        breadcrumbs={[{ label: "Traces", href: "/dashboard/traces" }, { label: "Trace" }]}
        description={
          <>
            {envelope.events.length} events
            {first ? (
              <>
                {" · "}actor{" "}
                <span className="font-mono text-foreground">
                  {first.actor_type}/{first.actor_id}
                </span>
              </>
            ) : null}
          </>
        }
        title={<code className="font-mono">{traceId}</code>}
      />

      {grantIds.length > 0 || runIds.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {grantIds.map((id) => (
            <Link
              className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
              href={`/dashboard/grants/${encodeURIComponent(id)}`}
              key={id}
            >
              grant <code className="ml-1 font-mono">{id}</code> →
            </Link>
          ))}
          {runIds.map((id) => (
            <Link
              className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
              href={`/dashboard/runs/${encodeURIComponent(id)}`}
              key={id}
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
        <pre className="pdpp-caption overflow-x-auto rounded-md border border-border/80 bg-muted/30 p-3 font-mono">
          pdpp trace show {traceId}
        </pre>
        <p className="pdpp-caption mt-1 break-all text-muted-foreground">
          raw: <code>{`${getAsInternalUrl()}/_ref/traces/${encodeURIComponent(traceId)}`}</code>
        </p>
      </Section>
    </DashboardShell>
  );
}
