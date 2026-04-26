import Link from "next/link";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxEducationalShell } from "../_demo/components/shell.tsx";

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
    title: "Schema",
    method: "GET",
    endpoint: "/sandbox/v1/schema",
    request: "curl -s /sandbox/v1/schema",
    responseHint: "Live `schema` envelope: object='schema', bearer, connectors[].streams[] with stream_metadata.",
    description:
      "Discover connectors, streams, and field schemas. Same shape as /v1/schema on a real reference server.",
  },
  {
    surface: "v1",
    title: "List streams",
    method: "GET",
    endpoint: "/sandbox/v1/streams",
    request: "curl -s '/sandbox/v1/streams?limit=10'",
    responseHint: "Live `list` envelope of `stream` rows: { name, record_count, last_updated, freshness }.",
    description: "Supports cursor pagination via `limit` and `cursor`. Optional `connector_id` filter.",
  },
  {
    surface: "v1",
    title: "Stream metadata",
    method: "GET",
    endpoint: "/sandbox/v1/streams/pay_statements",
    request: "curl -s /sandbox/v1/streams/pay_statements",
    responseHint: "Live `stream_metadata` envelope with schema, primary_key, cursor_field, freshness.",
    description: "Replace the path segment with any stream name from /sandbox/v1/schema.",
  },
  {
    surface: "v1",
    title: "List records",
    method: "GET",
    endpoint: "/sandbox/v1/streams/pay_statements/records",
    request: "curl -s '/sandbox/v1/streams/pay_statements/records?limit=2'",
    responseHint: "Live `list` envelope of `record` rows: { object:'record', id, stream, data, emitted_at }.",
    description: "Supports cursor pagination via `limit` and `cursor`.",
  },
  {
    surface: "v1",
    title: "Record detail",
    method: "GET",
    endpoint: "/sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03",
    request: "curl -s /sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03",
    responseHint: "Single live `record` envelope: { id, stream, data, emitted_at }.",
    description: "Use the `id` returned in list responses (record_key in the underlying RS).",
  },
  {
    surface: "v1",
    title: "Lexical search",
    method: "GET",
    endpoint: "/sandbox/v1/search",
    request: "curl -s '/sandbox/v1/search?q=payroll'",
    responseHint:
      "Live `list` of `search_result` rows: { stream, record_key, connector_id, record_url, emitted_at, matched_fields, snippet?, score? } with score.kind='bm25'.",
    description: "Same shape as the public lexical retrieval extension. Try `payroll`, `Northwind`, `follow-up`.",
  },
  {
    surface: "_ref",
    title: "List grants",
    method: "GET",
    endpoint: "/sandbox/_ref/grants",
    request: "curl -s '/sandbox/_ref/grants?status=revoked'",
    responseHint: "Live `list` of `grant_summary` rows with kinds[], failure?: { event_type, reason }.",
    description: "Filter by `status` (issued, revoked, denied) or `client_id`.",
  },
  {
    surface: "_ref",
    title: "Grant timeline",
    method: "GET",
    endpoint: "/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
    request: "curl -s /sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
    responseHint: "Live `grant_timeline` envelope: { object, grant_id, trace_id, event_count, data: events[] }.",
    description: "See request → consent → grant → resource read events end-to-end.",
  },
  {
    surface: "_ref",
    title: "Run timeline",
    method: "GET",
    endpoint: "/sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline",
    request: "curl -s /sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline",
    responseHint: "Live `run_timeline` envelope: { object, run_id, trace_id, event_count, data: events[] }.",
    description: "Includes `started`, `records.synced`, and `succeeded`/`failed` events.",
  },
  {
    surface: "_ref",
    title: "Trace timeline",
    method: "GET",
    endpoint: "/sandbox/_ref/traces/trace_sb_quill_paystmt",
    request: "curl -s /sandbox/_ref/traces/trace_sb_quill_paystmt",
    responseHint: "Live `trace` envelope: { object, trace_id, event_count, data: events[] sorted by occurred_at }.",
    description: "Shows the full PDPP interaction across grant + resource read.",
  },
  {
    surface: "_ref",
    title: "Dataset summary",
    method: "GET",
    endpoint: "/sandbox/_ref/dataset/summary",
    request: "curl -s /sandbox/_ref/dataset/summary",
    responseHint: "Live `dataset_summary` envelope with retained-bytes, record-time bounds, top_connectors[].",
    description: "Same fields as the live reference deployment summary.",
  },
  {
    surface: "well-known",
    title: "Authorization server metadata",
    method: "GET",
    endpoint: "/sandbox/.well-known/oauth-authorization-server",
    request: "curl -s /sandbox/.well-known/oauth-authorization-server",
    responseHint: "RFC 8414 + PDPP `pdpp_provider_connect_capabilities`. Same shape as a real AS.",
    description: "Inspect the issuer, token/PAR/device endpoints, and provider-connect capabilities.",
  },
  {
    surface: "well-known",
    title: "Protected resource metadata",
    method: "GET",
    endpoint: "/sandbox/.well-known/oauth-protected-resource",
    request: "curl -s /sandbox/.well-known/oauth-protected-resource",
    responseHint:
      "Live RS metadata: resource, authorization_servers, pdpp_discovery_hints, capabilities.lexical_retrieval.",
    description: "Drives discovery: schema_endpoint, query_base, search endpoint, blob indirection.",
  },
];

export default function SandboxApiExamplesPage() {
  return (
    <SandboxEducationalShell active="api">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / API examples</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Reference API examples</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Every endpoint below is callable directly against this deployment and returns the same envelope shape a real
          PDPP reference server would. All responses are JSON; the sandbox marker is the{" "}
          <InlineCode>x-pdpp-demo</InlineCode> response header — payload shapes are intentionally identical to the live
          reference so an agent can swap origins without touching parsing code.
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
    </SandboxEducationalShell>
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
