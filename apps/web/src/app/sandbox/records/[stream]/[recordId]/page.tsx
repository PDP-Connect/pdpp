import Link from "next/link";
import { notFound } from "next/navigation";
import { buildRecordDetail } from "../../../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../../../_demo/components/code-block.tsx";
import { SandboxShell } from "../../../_demo/components/shell.tsx";

export const dynamic = "force-static";

export default async function SandboxRecordDetailPage(props: {
  params: Promise<{ stream: string; recordId: string }>;
}) {
  const { stream, recordId } = await props.params;
  const maybeDetail = buildRecordDetail(stream, recordId);
  if (!maybeDetail) {
    notFound();
    return null;
  }
  const detail = maybeDetail;

  return (
    <SandboxShell active="records">
      <header className="mb-6 border-border/80 border-b pb-5">
        <nav
          aria-label="Breadcrumb"
          className="pdpp-caption mb-3 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
        >
          <Link className="hover:text-foreground hover:underline" href="/sandbox/records">
            Records
          </Link>
          <span className="text-muted-foreground/60">/</span>
          <Link
            className="hover:text-foreground hover:underline"
            href={`/sandbox/records/${encodeURIComponent(detail.stream)}`}
          >
            {detail.stream}
          </Link>
          <span className="text-muted-foreground/60">/</span>
          <span className="text-foreground">{detail.record_id}</span>
        </nav>
        <h1 className="pdpp-heading break-all text-foreground">{detail.record_id}</h1>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Connector <InlineCode>{detail.connector_id}</InlineCode> · stream <InlineCode>{detail.stream}</InlineCode> ·
          record time {detail.record_time} · ingested {detail.ingested_at}
        </p>
      </header>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Fields</h2>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {Object.entries(detail.fields).map(([k, v]) => (
            <li className="grid grid-cols-1 gap-1 px-3 py-2.5 sm:grid-cols-[10rem_minmax(0,1fr)]" key={k}>
              <code className="pdpp-caption font-mono text-muted-foreground">{k}</code>
              <code className="pdpp-caption break-words font-mono text-foreground">{formatValue(v)}</code>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Raw JSON</h2>
        <CodeBlock language="json">{JSON.stringify(detail, null, 2)}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">API example</h2>
        <CodeBlock language="shell">
          {`curl -s /sandbox/v1/streams/${detail.stream}/records/${detail.record_id}`}
        </CodeBlock>
      </section>
    </SandboxShell>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
