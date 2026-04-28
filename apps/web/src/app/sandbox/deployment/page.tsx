/**
 * Sandbox deployment page. Renders the same operator-facing diagnostic
 * surfaces the live `/dashboard/deployment` page renders (warnings,
 * lexical/semantic state, manifests, environment, database) bound to
 * the sandbox data source — plus the demo-only AS/RS metadata and
 * capabilities matrix that already exist for sandbox visitors.
 *
 * Visual language matches the live page: PageHeader, Section, Callout.
 */

import { headers } from "next/headers";
import { Callout, PageHeader, Section } from "@/app/dashboard/components/primitives.tsx";
import { DashboardShell, EmptyState } from "@/app/dashboard/components/shell.tsx";
import {
  buildLiveAuthServerMetadata,
  buildLiveProtectedResourceMetadata,
  getDemoCapabilities,
} from "../_demo/builders.ts";
import { CodeBlock } from "../_demo/components/code-block.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-dynamic";

const WARNING_TITLES: Record<string, string> = {
  zero_participation: "Zero semantic participation",
  lexical_building_index: "Lexical index is rebuilding",
  building_index: "Semantic index is rebuilding",
  stale_index: "Semantic index is stale",
  backend_unavailable: "Embedding backend unavailable",
  missing_model_cache: "Embedding model cache missing",
  download_disabled: "Model download disabled",
  vector_index_fallback: "Using blob-flat vector fallback",
};

export default async function SandboxDeploymentPage() {
  const report = await sandboxDashboardDataSource.getDeploymentDiagnostics();
  const capabilities = getDemoCapabilities();
  const issuer = `${await getRequestOrigin()}/sandbox`;
  const auth = buildLiveAuthServerMetadata(issuer);
  const rs = buildLiveProtectedResourceMetadata(issuer);

  return (
    <DashboardShell active="deployment" mode="mock-owner">
      <PageHeader
        description="Reference deployment diagnostics: AS/RS metadata, retrieval state, and manifests."
        title="Deployment"
      />

      <Section title={`Warnings (${report.warnings.length})`}>
        {report.warnings.length === 0 ? (
          <p className="pdpp-body text-muted-foreground">No warnings. Sandbox retrieval is operational.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {report.warnings.map((w) => (
              <Callout description={w.message} key={w.code} surface="human" title={WARNING_TITLES[w.code] ?? w.code} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Lexical index">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Field label="Index state" value={report.lexical.index.state} />
          <Field label="Backfill" value={report.lexical.index.backfill_progress ? "in progress" : "—"} />
        </dl>
      </Section>

      <Section title="Semantic backend">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Field label="Configured" value={yesNo(report.semantic.backend.configured)} />
          <Field label="Available" value={yesNo(report.semantic.backend.available)} />
          <Field label="Vector index kind" value={report.semantic.index.kind ?? "—"} />
          <Field label="Index state" value={report.semantic.index.state ?? "—"} />
        </dl>
      </Section>

      <Section
        description="Fields advertised by manifests for semantic retrieval."
        title={`Participation (${report.semantic.participation.field_count} fields)`}
      >
        {report.semantic.participation.tuples.length === 0 ? (
          <EmptyState hint="No semantic backend configured for this deployment." title="No participating fields" />
        ) : null}
      </Section>

      <Section
        description="Connector manifests loaded by this deployment."
        title={`Manifests (${report.manifests.length})`}
      >
        <table className="w-full border-border/80 border-y text-left text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs uppercase tracking-wide">
              <th className="px-2 py-2 font-medium">Connector</th>
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Provenance</th>
              <th className="px-2 py-2 font-medium">Semantic streams</th>
            </tr>
          </thead>
          <tbody>
            {report.manifests.map((m) => (
              <tr className="border-border/60 border-t" key={m.connector_id}>
                <td className="px-2 py-1.5 font-mono text-xs">{m.connector_id}</td>
                <td className="px-2 py-1.5">{m.display_name ?? "—"}</td>
                <td className="px-2 py-1.5 text-muted-foreground text-xs">{m.provenance}</td>
                <td className="px-2 py-1.5 tabular-nums">{m.semantic_stream_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Database">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
          <Field label="Path" value={report.database.path} />
          <Field label="Vector index kind" value={report.semantic.index.kind ?? "—"} />
        </dl>
      </Section>

      <Section description="Environment-driven configuration markers." title="Environment">
        <table className="w-full border-border/80 border-y text-left text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs uppercase tracking-wide">
              <th className="px-2 py-2 font-medium">Name</th>
              <th className="px-2 py-2 font-medium">Value</th>
              <th className="px-2 py-2 font-medium">Provenance</th>
            </tr>
          </thead>
          <tbody>
            {report.environment.map((entry) => (
              <tr className="border-border/60 border-t" key={entry.name}>
                <td className="px-2 py-1.5 font-mono text-xs">{entry.name}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{entry.value ?? "—"}</td>
                <td className="px-2 py-1.5 text-muted-foreground text-xs">{entry.provenance}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section description="Capabilities advertised by this reference implementation." title="Capabilities matrix">
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {capabilities.map((cap) => (
            <li
              className="grid grid-cols-1 gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_6rem_6rem]"
              key={cap.capability}
            >
              <span className="pdpp-body font-medium text-foreground">{cap.capability}</span>
              <span className="pdpp-caption text-muted-foreground">
                {cap.description}
                <br />
                <span className="text-muted-foreground/70">{cap.notes}</span>
              </span>
              <span
                className={`pdpp-eyebrow ${cap.implemented ? "text-[color:var(--success)]" : "text-muted-foreground"}`}
              >
                {cap.implemented ? "live: ✓" : "live: —"}
              </span>
              <span
                className={`pdpp-eyebrow ${cap.demonstrated_in_demo ? "text-[color:var(--success)]" : "text-muted-foreground"}`}
              >
                {cap.demonstrated_in_demo ? "demo: ✓" : "demo: —"}
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section description="Live response from /sandbox/.well-known/oauth-authorization-server." title="AS metadata">
        <CodeBlock language="json">{JSON.stringify(auth, null, 2)}</CodeBlock>
      </Section>

      <Section description="Live response from /sandbox/.well-known/oauth-protected-resource." title="RS metadata">
        <CodeBlock language="json">{JSON.stringify(rs, null, 2)}</CodeBlock>
      </Section>
    </DashboardShell>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="pdpp-eyebrow text-muted-foreground">{label}</dt>
      <dd className="pdpp-body break-words">{value}</dd>
    </div>
  );
}

function yesNo(v: boolean): string {
  return v ? "yes" : "no";
}

async function getRequestOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3002";
  const protocol =
    headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}
