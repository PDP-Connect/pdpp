import Link from "next/link";
import { buildGrantsList } from "../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

export const dynamic = "force-static";

const STATUS_TONE: Record<string, string> = {
  issued: "text-[color:var(--success)]",
  revoked: "text-destructive",
  denied: "text-destructive",
};

export default async function SandboxGrantsPage(props: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await props.searchParams;
  const grants = buildGrantsList({ status });

  return (
    <SandboxShell active="grants">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Grants</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Grants</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Issued, revoked, or denied decisions across the seeded demo. Reachable as JSON at{" "}
          <InlineCode>/sandbox/_ref/grants</InlineCode>.
        </p>
      </header>

      <nav aria-label="Grant status filters" className="mb-4 flex flex-wrap gap-2">
        {[undefined, "issued", "revoked", "denied"].map((s) => {
          const href = s ? `/sandbox/grants?status=${s}` : "/sandbox/grants";
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
        {grants.data.map((g) => (
          <li className="px-3 py-3" key={g.grant_id}>
            <Link className="block" href={`/sandbox/grants/${encodeURIComponent(g.grant_id)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <code className="pdpp-caption break-all font-medium font-mono text-foreground">{g.grant_id}</code>
                <span className={`pdpp-eyebrow ${STATUS_TONE[g.status] ?? "text-muted-foreground"}`}>{g.status}</span>
              </div>
              <div className="pdpp-caption mt-1 text-muted-foreground">
                client {g.client_id ?? "—"} · stream {g.stream} · last {g.last_at}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <section className="mt-10">
        <h2 className="pdpp-title mb-3 text-foreground">API examples</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/_ref/grants
curl -s '/sandbox/_ref/grants?status=revoked'`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
