import Link from "next/link";
import { notFound } from "next/navigation";
import { buildRecordsList, buildStreamDetail } from "../../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../../_demo/components/code-block.tsx";
import { SandboxShell } from "../../_demo/components/shell.tsx";

export const dynamic = "force-static";

export default async function SandboxStreamDetailPage(props: { params: Promise<{ stream: string }> }) {
  const { stream } = await props.params;
  const maybeDetail = buildStreamDetail(stream);
  const maybeRecords = buildRecordsList({ stream });
  if (!(maybeDetail && maybeRecords)) {
    notFound();
    return null;
  }
  const detail = maybeDetail;
  const records = maybeRecords;

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
          <span className="text-foreground">{detail.label}</span>
        </nav>
        <h1 className="pdpp-heading text-foreground">{detail.label}</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">{detail.description}</p>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          Connector <InlineCode>{detail.connector_id}</InlineCode> · stream <InlineCode>{detail.stream}</InlineCode> ·{" "}
          {detail.record_count} records · retention: {detail.retention_label}
        </p>
      </header>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Schema</h2>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {detail.fields.map((field) => (
            <li
              className="grid grid-cols-1 gap-1 px-3 py-2.5 sm:grid-cols-[10rem_8rem_8rem_minmax(0,1fr)]"
              key={field.name}
            >
              <code className="pdpp-caption font-mono text-foreground">{field.name}</code>
              <span className="pdpp-caption text-muted-foreground">{field.type}</span>
              <span className="pdpp-eyebrow text-muted-foreground">{field.semantic_class}</span>
              <span className="pdpp-caption text-muted-foreground">{field.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Records</h2>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {records.data.map((record) => (
            <li className="px-3 py-2.5" key={record.record_id}>
              <Link
                className="block"
                href={`/sandbox/records/${encodeURIComponent(detail.stream)}/${encodeURIComponent(record.record_id)}`}
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <code className="pdpp-caption break-all font-medium font-mono text-foreground">
                    {record.record_id}
                  </code>
                  <span className="pdpp-caption text-muted-foreground tabular-nums">{record.record_time}</span>
                </div>
                <div className="pdpp-caption mt-1 truncate text-muted-foreground">{record.preview}</div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">API examples</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/v1/streams/${detail.stream}
curl -s '/sandbox/v1/streams/${detail.stream}/records?limit=5'`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
