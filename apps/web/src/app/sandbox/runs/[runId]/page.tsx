import Link from "next/link";
import { notFound } from "next/navigation";
import { buildRunTimeline, getDemoRuns } from "../../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../../_demo/components/code-block.tsx";
import { SandboxShell } from "../../_demo/components/shell.tsx";
import { Timeline } from "../../_demo/components/timeline.tsx";

export const dynamic = "force-static";

export default async function SandboxRunDetailPage(props: { params: Promise<{ runId: string }> }) {
  const { runId } = await props.params;
  const run = getDemoRuns().find((r) => r.run_id === runId);
  const maybeTimeline = buildRunTimeline(runId);
  if (!(run && maybeTimeline)) {
    notFound();
    return null;
  }
  const timeline = maybeTimeline;

  return (
    <SandboxShell active="runs">
      <header className="mb-6 border-border/80 border-b pb-5">
        <nav
          aria-label="Breadcrumb"
          className="pdpp-caption mb-3 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
        >
          <Link className="hover:text-foreground hover:underline" href="/sandbox/runs">
            Runs
          </Link>
          <span className="text-muted-foreground/60">/</span>
          <span className="text-foreground">{run.run_id}</span>
        </nav>
        <h1 className="pdpp-heading break-all text-foreground">{run.run_id}</h1>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Status <InlineCode>{run.status}</InlineCode> · connector <InlineCode>{run.connector_id}</InlineCode> · started{" "}
          {run.started_at}
          {run.failure_reason ? (
            <>
              {" "}
              · failure <InlineCode>{run.failure_reason}</InlineCode>
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
        <CodeBlock language="shell">{`curl -s /sandbox/_ref/runs/${run.run_id}/timeline`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
