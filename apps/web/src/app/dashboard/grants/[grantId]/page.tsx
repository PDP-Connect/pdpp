import Link from "next/link";
import { notFound } from "next/navigation";
import { PageHeader, Section } from "../../components/primitives.tsx";
import { DashboardShell, ServerUnreachable } from "../../components/shell.tsx";
import { TimelineView } from "../../components/timeline-view.tsx";
import { getAsInternalUrl, ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import { getGrantTimeline, type TimelineEnvelope } from "../../lib/ref-client.ts";

export const dynamic = "force-dynamic";

export default async function GrantDetailPage({ params }: { params: Promise<{ grantId: string }> }) {
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

  if (!envelope) {
    notFound();
  }

  const traceIds = Array.from(new Set(envelope.events.map((e) => e.trace_id).filter(Boolean) as string[]));
  const runIds = Array.from(new Set(envelope.events.map((e) => e.run_id).filter(Boolean) as string[]));
  const revoked = envelope.events.some((e) => e.event_type === "grant.revoked" || e.status === "revoked");

  return (
    <DashboardShell active="grants">
      <PageHeader
        breadcrumbs={[{ label: "Grants", href: "/dashboard/grants" }, { label: "Grant" }]}
        count={`${envelope.events.length} events${revoked ? " · revoked" : ""}`}
        title={<code className="font-mono">{grantId}</code>}
      />

      {traceIds.length > 0 || runIds.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {traceIds.map((id) => (
            <Link
              className="pdpp-caption inline-flex items-center rounded-md border border-border px-2.5 py-1 hover:bg-muted/60"
              href={`/dashboard/traces/${encodeURIComponent(id)}`}
              key={id}
            >
              trace <code className="ml-1 font-mono">{id}</code> →
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
          pdpp grant timeline {grantId}
        </pre>
        <p className="pdpp-caption mt-1 break-all text-muted-foreground">
          raw: <code>{`${getAsInternalUrl()}/_ref/grants/${encodeURIComponent(grantId)}/timeline`}</code>
        </p>
      </Section>
    </DashboardShell>
  );
}
