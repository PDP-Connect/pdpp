import Link from "next/link";
import { notFound } from "next/navigation";
import { buildTraceTimeline, getDemoTraces } from "../../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../../_demo/components/code-block.tsx";
import { SandboxShell } from "../../_demo/components/shell.tsx";
import { Timeline } from "../../_demo/components/timeline.tsx";

export const dynamic = "force-static";

export default async function SandboxTraceDetailPage(props: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await props.params;
  const trace = getDemoTraces().find((t) => t.trace_id === traceId);
  const maybeTimeline = buildTraceTimeline(traceId);
  if (!(trace && maybeTimeline)) {
    notFound();
    return null;
  }
  const timeline = maybeTimeline;

  return (
    <SandboxShell active="traces">
      <header className="mb-6 border-border/80 border-b pb-5">
        <nav
          aria-label="Breadcrumb"
          className="pdpp-caption mb-3 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
        >
          <Link className="hover:text-foreground hover:underline" href="/sandbox/traces">
            Traces
          </Link>
          <span className="text-muted-foreground/60">/</span>
          <span className="text-foreground">{trace.trace_id}</span>
        </nav>
        <h1 className="pdpp-heading break-all text-foreground">{trace.trace_id}</h1>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Status <InlineCode>{trace.status}</InlineCode> · client <InlineCode>{trace.client_id ?? "—"}</InlineCode> ·{" "}
          {trace.grant_id ? (
            <>
              grant{" "}
              <Link
                className="hover:text-foreground hover:underline"
                href={`/sandbox/grants/${encodeURIComponent(trace.grant_id)}`}
              >
                <InlineCode>{trace.grant_id}</InlineCode>
              </Link>
            </>
          ) : null}
          {trace.run_id ? (
            <>
              run{" "}
              <Link
                className="hover:text-foreground hover:underline"
                href={`/sandbox/runs/${encodeURIComponent(trace.run_id)}`}
              >
                <InlineCode>{trace.run_id}</InlineCode>
              </Link>
            </>
          ) : null}
        </p>
      </header>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Timeline</h2>
        <Timeline events={timeline.events} />
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">API example</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/_ref/traces/${trace.trace_id}`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
