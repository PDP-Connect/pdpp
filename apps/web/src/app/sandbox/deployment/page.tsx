import { headers } from "next/headers";
import {
  buildAuthServerMetadata,
  buildDatasetSummary,
  buildProtectedResourceMetadata,
  getDemoCapabilities,
  getDemoConnectors,
  getDemoStreams,
} from "../_demo/builders.ts";
import { CodeBlock } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

export const dynamic = "force-dynamic";

export default async function SandboxDeploymentPage() {
  const summary = buildDatasetSummary();
  const connectors = getDemoConnectors();
  const streams = getDemoStreams();
  const capabilities = getDemoCapabilities();
  const issuer = `${await getRequestOrigin()}/sandbox`;
  const auth = buildAuthServerMetadata(issuer);
  const rs = buildProtectedResourceMetadata(issuer);

  return (
    <SandboxShell active="deployment">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Deployment</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Deployment and capabilities</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Demo metadata describing what this sandbox demonstrates and what the live reference exposes. The mock AS/RS
          metadata advertises sandbox-prefixed endpoints; agents and engineers can discover the surface from these
          documents.
        </p>
      </header>

      <section className="mb-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Connectors" value={summary.connector_count} />
        <Stat label="Streams" value={summary.stream_count} />
        <Stat label="Records" value={summary.record_count} />
        <Stat label="Capabilities tracked" value={capabilities.length} />
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Connector manifests (simulated)</h2>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {connectors.map((c) => {
            const connectorStreams = streams.filter((s) => s.connector_id === c.connector_id);
            return (
              <li className="px-3 py-3" key={c.connector_id}>
                <div className="pdpp-body font-medium text-foreground">{c.display_name}</div>
                <div className="pdpp-caption text-muted-foreground">
                  <code className="font-mono">{c.connector_id}</code> · {c.provenance} · schedule {c.schedule ?? "—"}
                </div>
                <div className="pdpp-caption mt-1 text-muted-foreground">
                  Streams: {connectorStreams.map((s) => s.key).join(", ")}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Capabilities matrix</h2>
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
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">AS metadata</h2>
        <p className="pdpp-caption mb-2 text-muted-foreground">
          Reachable at <code className="font-mono">/sandbox/.well-known/oauth-authorization-server</code>.
        </p>
        <CodeBlock language="json">{JSON.stringify(auth, null, 2)}</CodeBlock>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">RS metadata</h2>
        <p className="pdpp-caption mb-2 text-muted-foreground">
          Reachable at <code className="font-mono">/sandbox/.well-known/oauth-protected-resource</code>.
        </p>
        <CodeBlock language="json">{JSON.stringify(rs, null, 2)}</CodeBlock>
      </section>
    </SandboxShell>
  );
}

async function getRequestOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol =
    headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/80 bg-card/60 px-4 py-3">
      <div className="pdpp-eyebrow text-muted-foreground">{label}</div>
      <div className="pdpp-heading mt-1 font-semibold text-foreground tabular-nums">{value}</div>
    </div>
  );
}
