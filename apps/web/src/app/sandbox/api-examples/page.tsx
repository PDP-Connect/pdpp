import Link from "next/link";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

export const dynamic = "force-static";

interface Example {
  description: string;
  endpoint: string;
  method: "GET";
  request: string;
  responseHint: string;
  surface: "v1" | "_ref" | "well-known";
  title: string;
}

const EXAMPLES: readonly Example[] = [
  {
    surface: "v1",
    title: "Schema graph",
    method: "GET",
    endpoint: "/sandbox/v1/schema",
    request: "curl -s https://EXAMPLE/sandbox/v1/schema",
    responseHint: "Returns connectors → streams → fields with semantic class.",
    description: "Use when discovering what streams and fields the demo dataset offers.",
  },
  {
    surface: "v1",
    title: "List streams",
    method: "GET",
    endpoint: "/sandbox/v1/streams",
    request: "curl -s 'https://EXAMPLE/sandbox/v1/streams?limit=10'",
    responseHint: "Paginated list of stream summaries.",
    description: "Each summary includes stream key, label, record count, and field count.",
  },
  {
    surface: "v1",
    title: "Stream detail",
    method: "GET",
    endpoint: "/sandbox/v1/streams/pay_statements",
    request: "curl -s https://EXAMPLE/sandbox/v1/streams/pay_statements",
    responseHint: "Full stream descriptor with schema, retention, and counts.",
    description: "Replace the path segment with any stream key from the schema graph.",
  },
  {
    surface: "v1",
    title: "List records",
    method: "GET",
    endpoint: "/sandbox/v1/streams/pay_statements/records",
    request: "curl -s 'https://EXAMPLE/sandbox/v1/streams/pay_statements/records?limit=2'",
    responseHint: "Paginated record summaries newest-first, each with a preview string.",
    description: "Supports cursor pagination via `limit` and `cursor`.",
  },
  {
    surface: "v1",
    title: "Record detail",
    method: "GET",
    endpoint: "/sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03",
    request: "curl -s https://EXAMPLE/sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03",
    responseHint: "Full field projection for one record.",
    description: "Returns the full fictional record including its projection map.",
  },
  {
    surface: "v1",
    title: "Search",
    method: "GET",
    endpoint: "/sandbox/v1/search",
    request: "curl -s 'https://EXAMPLE/sandbox/v1/search?q=payroll'",
    responseHint: "Lexical hits across all seeded records with snippets and matched fields.",
    description: "Try queries like `payroll`, `Northwind`, `follow-up`.",
  },
  {
    surface: "_ref",
    title: "List grants",
    method: "GET",
    endpoint: "/sandbox/_ref/grants",
    request: "curl -s '/sandbox/_ref/grants?status=revoked'",
    responseHint: "Reference-only grant summaries with status and stream.",
    description: "Filter by `status` (issued, revoked, denied) or `client_id`.",
  },
  {
    surface: "_ref",
    title: "Grant timeline",
    method: "GET",
    endpoint: "/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
    request: "curl -s /sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
    responseHint: "Per-event timeline for one grant.",
    description: "See request → consent → grant → resource read events end-to-end.",
  },
  {
    surface: "_ref",
    title: "Run timeline",
    method: "GET",
    endpoint: "/sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline",
    request: "curl -s /sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline",
    responseHint: "Per-event timeline for one connector run.",
    description: "Includes `started`, `records.synced`, and `succeeded`/`failed` events.",
  },
  {
    surface: "_ref",
    title: "Trace timeline",
    method: "GET",
    endpoint: "/sandbox/_ref/traces/trace_sb_quill_paystmt",
    request: "curl -s /sandbox/_ref/traces/trace_sb_quill_paystmt",
    responseHint: "Trace-level timeline merging grant and run events.",
    description: "Shows the full PDPP interaction across grant + resource read.",
  },
  {
    surface: "_ref",
    title: "Dataset summary",
    method: "GET",
    endpoint: "/sandbox/_ref/dataset/summary",
    request: "curl -s /sandbox/_ref/dataset/summary",
    responseHint: "Top-level dataset statistics for the demo instance.",
    description: "Connector count, stream count, record count, retained-bytes approximation.",
  },
  {
    surface: "well-known",
    title: "Authorization server metadata",
    method: "GET",
    endpoint: "/sandbox/.well-known/oauth-authorization-server",
    request: "curl -s /sandbox/.well-known/oauth-authorization-server",
    responseHint: "Demo AS metadata advertising sandbox-prefixed endpoints.",
    description: "Inspect the issuer, authorization endpoint, and supported scopes for the mock AS.",
  },
  {
    surface: "well-known",
    title: "Protected resource metadata",
    method: "GET",
    endpoint: "/sandbox/.well-known/oauth-protected-resource",
    request: "curl -s /sandbox/.well-known/oauth-protected-resource",
    responseHint: "Demo RS metadata advertising sandbox-prefixed endpoints.",
    description: "Use to confirm the RS resource identifier and authorization servers list.",
  },
];

export default function SandboxApiExamplesPage() {
  return (
    <SandboxShell active="api">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / API examples</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Demo API examples</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Every endpoint below is callable directly against this deployment. Replace <InlineCode>EXAMPLE</InlineCode>{" "}
          with the host you reached this page on. All responses are JSON; all carry an{" "}
          <InlineCode>x-pdpp-demo</InlineCode> header so agents can be sure they are looking at sandbox data.
        </p>
        <p className="pdpp-caption mt-2 text-muted-foreground">
          The full surface map lives at{" "}
          <Link className="underline underline-offset-2" href="/reference">
            /reference
          </Link>
          .
        </p>
      </header>

      {(["v1", "_ref", "well-known"] as const).map((surface) => (
        <section className="mb-10" key={surface}>
          <h2 className="pdpp-title mb-3 text-foreground">{surfaceTitle(surface)}</h2>
          <div className="grid gap-5">
            {EXAMPLES.filter((e) => e.surface === surface).map((ex) => (
              <article className="rounded-md border border-border/80 bg-card/60 p-4" key={ex.endpoint}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="pdpp-body font-medium text-foreground">{ex.title}</h3>
                  <code className="pdpp-caption font-mono text-muted-foreground">
                    {ex.method} {ex.endpoint}
                  </code>
                </div>
                <p className="pdpp-caption mt-1 text-muted-foreground">{ex.description}</p>
                <CodeBlock language="shell">{ex.request}</CodeBlock>
                <p className="pdpp-caption mt-1 text-muted-foreground">{ex.responseHint}</p>
              </article>
            ))}
          </div>
        </section>
      ))}
    </SandboxShell>
  );
}

function surfaceTitle(surface: "v1" | "_ref" | "well-known"): string {
  if (surface === "v1") {
    return "Public-shaped APIs (/sandbox/v1)";
  }
  if (surface === "_ref") {
    return "Reference-only inspection APIs (/sandbox/_ref)";
  }
  return "OAuth-shaped metadata (/sandbox/.well-known)";
}
