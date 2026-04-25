import Link from "next/link";
import { buildRunsList } from "../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

export const dynamic = "force-static";

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-[color:var(--success)]",
  failed: "text-destructive",
  needs_input: "text-[color:var(--warning)]",
  started: "text-[color:var(--warning)]",
};

export default async function SandboxRunsPage(props: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await props.searchParams;
  const runs = buildRunsList({ status });

  return (
    <SandboxShell active="runs">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Runs</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Connector runs</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Demo runs for the seeded connectors. Includes a successful run, a failure, and a needs-input case. Backed by{" "}
          <InlineCode>/sandbox/_ref/runs</InlineCode>.
        </p>
      </header>

      <nav aria-label="Run status filters" className="mb-4 flex flex-wrap gap-2">
        {[undefined, "succeeded", "failed", "needs_input"].map((s) => {
          const href = s ? `/sandbox/runs?status=${s}` : "/sandbox/runs";
          const label = s ?? "all";
          const active = (status ?? undefined) === s;
          return (
            <Link
              className={`pdpp-eyebrow rounded-full border px-2.5 py-0.5 ${active ? "border-foreground text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`}
              href={href}
              key={label}
            >
              {label}
            </Link>
          );
        })}
      </nav>

      <ul className="divide-y divide-border/70 border-border/70 border-y">
        {runs.data.map((r) => (
          <li className="px-3 py-3" key={r.run_id}>
            <Link className="block" href={`/sandbox/runs/${encodeURIComponent(r.run_id)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="pdpp-caption break-all font-medium font-mono text-foreground">{r.run_id}</code>
                <span className={`pdpp-eyebrow ${STATUS_TONE[r.status] ?? "text-muted-foreground"}`}>{r.status}</span>
              </div>
              <div className="pdpp-caption mt-1 text-muted-foreground">
                {r.connector_id} · started {r.started_at} · {r.failure_reason ?? "no failure"}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mt-10">
        <h2 className="pdpp-title mb-3 text-foreground">API examples</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/_ref/runs
curl -s '/sandbox/_ref/runs?status=failed'`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
