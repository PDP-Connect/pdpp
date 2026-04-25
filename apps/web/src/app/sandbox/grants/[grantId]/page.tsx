import Link from "next/link";
import { notFound } from "next/navigation";
import { buildGrantTimeline, getDemoGrants } from "../../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../../_demo/components/code-block.tsx";
import { SandboxShell } from "../../_demo/components/shell.tsx";
import { Timeline } from "../../_demo/components/timeline.tsx";

export const dynamic = "force-static";

export default async function SandboxGrantDetailPage(props: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await props.params;
  const grant = getDemoGrants().find((g) => g.grant_id === grantId);
  const maybeTimeline = buildGrantTimeline(grantId);
  if (!(grant && maybeTimeline)) {
    notFound();
    return null;
  }
  const timeline = maybeTimeline;

  return (
    <SandboxShell active="grants">
      <header className="mb-6 border-border/80 border-b pb-5">
        <nav
          aria-label="Breadcrumb"
          className="pdpp-caption mb-3 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
        >
          <Link className="hover:text-foreground hover:underline" href="/sandbox/grants">
            Grants
          </Link>
          <span className="text-muted-foreground/60">/</span>
          <span className="text-foreground">{grant.grant_id}</span>
        </nav>
        <h1 className="pdpp-heading break-all text-foreground">{grant.grant_id}</h1>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Status <InlineCode>{grant.status}</InlineCode> · client <InlineCode>{grant.client_id}</InlineCode> · stream{" "}
          <InlineCode>{grant.stream}</InlineCode> · trace{" "}
          <Link
            className="hover:text-foreground hover:underline"
            href={`/sandbox/traces/${encodeURIComponent(grant.trace_id)}`}
          >
            <InlineCode>{grant.trace_id}</InlineCode>
          </Link>
        </p>
      </header>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Granted fields</h2>
        <div className="flex flex-wrap gap-2">
          {grant.fields.map((f) => (
            <code
              className="pdpp-caption rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-foreground"
              key={f}
            >
              {f}
            </code>
          ))}
        </div>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Timeline</h2>
        <Timeline events={timeline.events} />
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">API example</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/_ref/grants/${grant.grant_id}/timeline`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
