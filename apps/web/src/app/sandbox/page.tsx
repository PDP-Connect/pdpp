import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  buildDatasetSummary,
  buildGrantsList,
  buildRunsList,
  buildTracesList,
  getDemoCapabilities,
  getDemoConnectors,
} from "./_demo/builders.ts";
import { CodeBlock, InlineCode } from "./_demo/components/code-block.tsx";
import { SandboxShell } from "./_demo/components/shell.tsx";

export const metadata: Metadata = {
  title: "PDPP sandbox · mock reference demo instance",
  description:
    "A public, credential-free PDPP reference instance backed by fictional data. Inspect connectors, streams, records, grants, runs, traces, and call sandbox-prefixed AS/RS APIs.",
};

export const dynamic = "force-static";

const STATUS_TONE: Record<string, string> = {
  succeeded: "text-[color:var(--success)]",
  issued: "text-[color:var(--success)]",
  revoked: "text-destructive",
  denied: "text-destructive",
  failed: "text-destructive",
  needs_input: "text-[color:var(--warning)]",
};

export default function SandboxOverviewPage() {
  const summary = buildDatasetSummary();
  const grants = buildGrantsList({ limit: 5 });
  const runs = buildRunsList({ limit: 5 });
  const traces = buildTracesList({ limit: 5 });
  const connectors = getDemoConnectors();
  const capabilities = getDemoCapabilities();

  return (
    <SandboxShell active="overview">
      <header className="mb-8 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Demo overview</div>
        <h1 className="pdpp-display mt-2 text-foreground">Mock reference demo instance</h1>
        <p className="pdpp-body mt-3 max-w-3xl text-muted-foreground">
          A working PDPP reference surface backed by deterministic fictional data. The pages below mirror the live{" "}
          <Link className="underline underline-offset-2" href="/reference">
            reference dashboard
          </Link>{" "}
          but never call a live AS/RS, never request credentials, and never expose private records. Every page here is
          also reachable as a JSON API under <InlineCode>/sandbox/v1/**</InlineCode> or{" "}
          <InlineCode>/sandbox/_ref/**</InlineCode>.
        </p>
      </header>

      <section className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label="Connectors" value={summary.connector_count} />
        <KpiCard label="Streams" value={summary.stream_count} />
        <KpiCard label="Records" value={summary.record_count} />
        <KpiCard label="Approx. retained bytes" value={summary.total_retained_bytes.toLocaleString()} />
      </section>

      <section className="mb-10 grid gap-8 lg:grid-cols-2">
        <Panel
          action={
            <Link className="hover:text-foreground hover:underline" href="/sandbox/grants">
              view all →
            </Link>
          }
          description="Recent decisions across the seeded demo grants."
          title="Grants"
        >
          <ul className="divide-y divide-border/70 border-border/70 border-y">
            {grants.data.map((grant) => (
              <li className="px-3 py-2.5" key={grant.grant_id}>
                <Link className="block" href={`/sandbox/grants/${encodeURIComponent(grant.grant_id)}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="pdpp-caption break-all font-medium font-mono text-foreground">
                      {grant.grant_id}
                    </code>
                    <span className={`pdpp-eyebrow ${STATUS_TONE[grant.status] ?? "text-muted-foreground"}`}>
                      {grant.status}
                    </span>
                  </div>
                  <div className="pdpp-caption mt-1 text-muted-foreground">
                    client {grant.client_id ?? "—"} · stream {grant.stream}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel
          action={
            <Link className="hover:text-foreground hover:underline" href="/sandbox/runs">
              view all →
            </Link>
          }
          description="Connector runs across the seeded demo dataset."
          title="Runs"
        >
          <ul className="divide-y divide-border/70 border-border/70 border-y">
            {runs.data.map((run) => (
              <li className="px-3 py-2.5" key={run.run_id}>
                <Link className="block" href={`/sandbox/runs/${encodeURIComponent(run.run_id)}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="pdpp-caption break-all font-medium font-mono text-foreground">{run.run_id}</code>
                    <span className={`pdpp-eyebrow ${STATUS_TONE[run.status] ?? "text-muted-foreground"}`}>
                      {run.status}
                    </span>
                  </div>
                  <div className="pdpp-caption mt-1 text-muted-foreground">
                    {run.connector_id} · {run.failure_reason ?? "no failure"}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section className="mb-10">
        <Panel
          action={
            <Link className="hover:text-foreground hover:underline" href="/sandbox/traces">
              view all →
            </Link>
          }
          description="End-to-end interaction summaries across the seeded grants and runs."
          title="Traces"
        >
          <ul className="divide-y divide-border/70 border-border/70 border-y">
            {traces.data.map((trace) => (
              <li className="px-3 py-2.5" key={trace.trace_id}>
                <Link className="block" href={`/sandbox/traces/${encodeURIComponent(trace.trace_id)}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <code className="pdpp-caption break-all font-medium font-mono text-foreground">
                      {trace.trace_id}
                    </code>
                    <span className={`pdpp-eyebrow ${STATUS_TONE[trace.status] ?? "text-muted-foreground"}`}>
                      {trace.status}
                    </span>
                  </div>
                  <div className="pdpp-caption mt-1 text-muted-foreground">{trace.kinds.slice(0, 4).join(" · ")}</div>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section className="mb-10">
        <Panel description="Seeded demo connectors, drawn from common operator scenarios." title="Connectors">
          <ul className="divide-y divide-border/70 border-border/70 border-y">
            {connectors.map((connector) => (
              <li
                className="grid grid-cols-1 gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]"
                key={connector.connector_id}
              >
                <span className="pdpp-body font-medium text-foreground">{connector.display_name}</span>
                <span className="pdpp-caption text-muted-foreground">{connector.description}</span>
                <span className="pdpp-eyebrow text-muted-foreground">{connector.provenance}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section className="mb-10">
        <Panel
          description="What this demo demonstrates today vs. what the live reference implements."
          title="Capabilities"
        >
          <ul className="divide-y divide-border/70 border-border/70 border-y">
            {capabilities.map((cap) => (
              <li
                className="grid grid-cols-1 gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_6rem]"
                key={cap.capability}
              >
                <span className="pdpp-body font-medium text-foreground">{cap.capability}</span>
                <span className="pdpp-caption text-muted-foreground">{cap.description}</span>
                <span
                  className={`pdpp-eyebrow ${cap.implemented ? "text-[color:var(--success)]" : "text-muted-foreground"}`}
                >
                  {cap.implemented ? "implemented" : "—"}
                </span>
                <span
                  className={`pdpp-eyebrow ${cap.demonstrated_in_demo ? "text-[color:var(--success)]" : "text-muted-foreground"}`}
                >
                  {cap.demonstrated_in_demo ? "in demo" : "not in demo"}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>

      <section className="mb-12">
        <Panel
          description="Try the demo APIs from your terminal. All endpoints return JSON."
          title="Quick API examples"
        >
          <div className="grid gap-4">
            <ApiExample
              command="curl -s /sandbox/v1/schema"
              description="Schema graph: connectors, streams, fields, semantic classes."
              endpoint="GET /sandbox/v1/schema"
            />
            <ApiExample
              command="curl -s '/sandbox/v1/streams/pay_statements/records?limit=2'"
              description="Paginated record list for a single stream."
              endpoint="GET /sandbox/v1/streams/pay_statements/records"
            />
            <ApiExample
              command="curl -s '/sandbox/v1/search?q=payroll'"
              description="Lexical search across all seeded records."
              endpoint="GET /sandbox/v1/search?q=payroll"
            />
            <ApiExample
              command="curl -s /sandbox/_ref/grants/grant_sb_quill_paystmt/timeline"
              description="Reference-only timeline for one grant."
              endpoint="GET /sandbox/_ref/grants/grant_sb_quill_paystmt/timeline"
            />
            <ApiExample
              command="curl -s /sandbox/.well-known/oauth-authorization-server"
              description="Demo AS metadata advertising sandbox-prefixed endpoints."
              endpoint="GET /sandbox/.well-known/oauth-authorization-server"
            />
          </div>
        </Panel>
      </section>
    </SandboxShell>
  );
}

function KpiCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/80 bg-card/60 px-4 py-3">
      <div className="pdpp-eyebrow text-muted-foreground">{label}</div>
      <div className="pdpp-heading mt-1 font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="pdpp-title text-foreground">{title}</h2>
          {description ? <p className="pdpp-caption mt-0.5 text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="pdpp-caption text-muted-foreground">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

function ApiExample({ endpoint, command, description }: { endpoint: string; command: string; description: string }) {
  return (
    <div>
      <div className="pdpp-caption text-muted-foreground">
        <InlineCode>{endpoint}</InlineCode> — {description}
      </div>
      <CodeBlock language="shell">{command}</CodeBlock>
    </div>
  );
}
