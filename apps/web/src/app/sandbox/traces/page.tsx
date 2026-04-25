import Link from "next/link";
import { buildTracesList } from "../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

export const dynamic = "force-static";

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-[color:var(--success)]",
  revoked: "text-destructive",
  denied: "text-destructive",
  failed: "text-destructive",
};

export default async function SandboxTracesPage(props: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await props.searchParams;
  const traces = buildTracesList({ status });

  return (
    <SandboxShell active="traces">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Traces</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Traces</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          End-to-end interaction summaries across the seeded demo data. Backed by{" "}
          <InlineCode>/sandbox/_ref/traces</InlineCode>.
        </p>
      </header>

      <ul className="divide-y divide-border/70 border-border/70 border-y">
        {traces.data.map((t) => (
          <li className="px-3 py-3" key={t.trace_id}>
            <Link className="block" href={`/sandbox/traces/${encodeURIComponent(t.trace_id)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="pdpp-caption break-all font-medium font-mono text-foreground">{t.trace_id}</code>
                <span className={`pdpp-eyebrow ${STATUS_TONE[t.status] ?? "text-muted-foreground"}`}>{t.status}</span>
              </div>
              <div className="pdpp-caption mt-1 text-muted-foreground">{t.kinds.join(" · ")}</div>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mt-10">
        <h2 className="pdpp-title mb-3 text-foreground">API examples</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/_ref/traces
curl -s '/sandbox/_ref/traces?status=failed'`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
