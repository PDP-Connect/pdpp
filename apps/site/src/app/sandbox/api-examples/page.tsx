// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    description:
      "Discover connectors, streams, and field schemas. Same shape as /v1/schema on a real reference server.",
    endpoint: "/sandbox/v1/schema",
    method: "GET",
    request: "curl -s /sandbox/v1/schema",
    responseHint: "Live `schema` envelope: object='schema', bearer, connectors[].streams[] with stream_metadata.",
    surface: "v1",
    title: "Schema",
  },
  {
    description: "Supports cursor pagination via `limit` and `cursor`. Optional `connector_id` filter.",
    endpoint: "/sandbox/v1/streams",
    method: "GET",
    request: "curl -s '/sandbox/v1/streams?limit=10'",
    responseHint: "Live `list` envelope of `stream` rows: { name, record_count, last_updated, freshness }.",
    surface: "v1",
    title: "List streams",
  },
  {
    description: "Replace the path segment with any stream name from /sandbox/v1/schema.",
    endpoint: "/sandbox/v1/streams/pay_statements",
    method: "GET",
    request: "curl -s /sandbox/v1/streams/pay_statements",
    responseHint: "Live `stream_metadata` envelope with schema, primary_key, cursor_field, freshness.",
    surface: "v1",
    title: "Stream metadata",
  },
  {
    description: "Supports cursor pagination via `limit` and `cursor`.",
    endpoint: "/sandbox/v1/streams/pay_statements/records",
    method: "GET",
    request: "curl -s '/sandbox/v1/streams/pay_statements/records?limit=2'",
    responseHint: "Live `list` envelope of `record` rows: { object:'record', id, stream, data, emitted_at }.",
    surface: "v1",
    title: "List records",
  },
  {
    description: "Use the `id` returned in list responses (record_key in the underlying RS).",
    endpoint: "/sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03",
    method: "GET",
    request: "curl -s /sandbox/v1/streams/pay_statements/records/rec_sb_paystmt_2026_03",
    responseHint: "Single live `record` envelope: { id, stream, data, emitted_at }.",
    surface: "v1",
    title: "Record detail",
  },
  {
    description: "Same shape as the public lexical retrieval extension. Try `payroll`, `Northwind`, `follow-up`.",
    endpoint: "/sandbox/v1/search",
    method: "GET",
    request: "curl -s '/sandbox/v1/search?q=payroll'",
    responseHint:
      "Live `list` of `search_result` rows: { stream, record_key, connector_id, record_url, emitted_at, matched_fields, snippet?, score? } with score.kind='bm25'.",
    surface: "v1",
    title: "Lexical search",
  },
  {
    description: "Filter by `status` (issued, revoked, denied) or `client_id`.",
    endpoint: "/sandbox/_ref/grants",
    method: "GET",
    request: "curl -s '/sandbox/_ref/grants?status=revoked'",
    responseHint: "Live `list` of `grant_summary` rows with kinds[], failure?: { event_type, reason }.",
    surface: "_ref",
    title: "List grants",
  },
  {
    description: "See request → consent → grant → resource read events end-to-end.",
    endpoint: "/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
    method: "GET",
    request: "curl -s /sandbox/_ref/grants/grant_sb_quill_paystmt/timeline",
    responseHint: "Live `grant_timeline` envelope: { object, grant_id, trace_id, event_count, data: events[] }.",
    surface: "_ref",
    title: "Grant timeline",
  },
  {
    description: "Includes `started`, `records.synced`, and `succeeded`/`failed` events.",
    endpoint: "/sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline",
    method: "GET",
    request: "curl -s /sandbox/_ref/runs/run_sb_acme_2026_04_22/timeline",
    responseHint: "Live `run_timeline` envelope: { object, run_id, trace_id, event_count, data: events[] }.",
    surface: "_ref",
    title: "Run timeline",
  },
  {
    description: "Shows the full PDPP interaction across grant + resource read.",
    endpoint: "/sandbox/_ref/traces/trace_sb_quill_paystmt",
    method: "GET",
    request: "curl -s /sandbox/_ref/traces/trace_sb_quill_paystmt",
    responseHint: "Live `trace` envelope: { object, trace_id, event_count, data: events[] sorted by occurred_at }.",
    surface: "_ref",
    title: "Trace timeline",
  },
  {
    description: "Same fields as the live reference deployment summary.",
    endpoint: "/sandbox/_ref/dataset/summary",
    method: "GET",
    request: "curl -s /sandbox/_ref/dataset/summary",
    responseHint: "Live `dataset_summary` envelope with retained-bytes, record-time bounds, top_connectors[].",
    surface: "_ref",
    title: "Dataset summary",
  },
  {
    description: "Inspect the issuer, token/PAR/device endpoints, and provider-connect capabilities.",
    endpoint: "/sandbox/.well-known/oauth-authorization-server",
    method: "GET",
    request: "curl -s /sandbox/.well-known/oauth-authorization-server",
    responseHint: "RFC 8414 + PDPP `pdpp_provider_connect_capabilities`. Same shape as a real AS.",
    surface: "well-known",
    title: "Authorization server metadata",
  },
  {
    description: "Drives discovery: schema_endpoint, query_base, search endpoint, blob indirection.",
    endpoint: "/sandbox/.well-known/oauth-protected-resource",
    method: "GET",
    request: "curl -s /sandbox/.well-known/oauth-protected-resource",
    responseHint:
      "Live RS metadata: resource, authorization_servers, pdpp_discovery_hints, capabilities.lexical_retrieval.",
    surface: "well-known",
    title: "Protected resource metadata",
  },
];

export default function SandboxApiExamplesPage() {
  return (
    <SandboxEducationalShell>
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / API examples</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Reference API examples</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Every endpoint below is callable directly against this deployment and returns the same envelope shape a real
          PDPP reference server would. Route handlers use deterministic mock adapters and preserve live payload shapes.
          All responses are JSON; the sandbox marker is the <InlineCode>x-pdpp-demo</InlineCode> response header so an
          agent can swap origins without touching parsing code.
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
