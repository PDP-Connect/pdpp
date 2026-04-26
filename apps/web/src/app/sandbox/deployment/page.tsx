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
import { EmptyState } from "@/app/dashboard/components/shell.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { buildAuthServerMetadata, buildProtectedResourceMetadata, getDemoCapabilities } from "../_demo/builders.ts";
import { CodeBlock } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";
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
  const auth = buildAuthServerMetadata(issuer);
  const rs = buildProtectedResourceMetadata(issuer);

  return (
    <SandboxShell active="deployment">
      <PageHeader
        breadcrumbs={[{ href: sandboxRoutes.section.overview, label: "Sandbox" }, { label: "Deployment" }]}
        description="Operator diagnostics for the sandbox reference instance. Mirrors the live deployment page; values reflect the deterministic mock backend (no real semantic backend, no real DB)."
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
        description="Sandbox uses lexical search only; participating fields are reported by the live deployment."
        title={`Participation (${report.semantic.participation.field_count} fields)`}
      >
        {report.semantic.participation.tuples.length === 0 ? (
          <EmptyState
            hint="The sandbox semantic backend is not configured. Run the live reference and declare semantic_fields on a manifest to populate this list."
            title="No participating fields"
          />
        ) : null}
      </Section>

      <Section
        description="Manifests bound to the sandbox demo dataset."
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

      <Section
        description="Demo environment markers. The sandbox does not read real environment variables."
        title="Environment"
      >
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

      <Section
        description="What this demo demonstrates today vs. what the live reference implements."
        title="Capabilities matrix"
      >
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

      <Section description="Reachable at /sandbox/.well-known/oauth-authorization-server" title="AS metadata (demo)">
        <CodeBlock language="json">{JSON.stringify(auth, null, 2)}</CodeBlock>
      </Section>

      <Section description="Reachable at /sandbox/.well-known/oauth-protected-resource" title="RS metadata (demo)">
        <CodeBlock language="json">{JSON.stringify(rs, null, 2)}</CodeBlock>
      </Section>
    </SandboxShell>
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
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol =
    headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}
