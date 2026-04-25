import Link from "next/link";
import { buildStreamsList, getDemoConnectors } from "../_demo/builders.ts";
import { CodeBlock, InlineCode } from "../_demo/components/code-block.tsx";
import { SandboxShell } from "../_demo/components/shell.tsx";

export const dynamic = "force-static";

export default function SandboxRecordsPage() {
  const streams = buildStreamsList({});
  const connectors = getDemoConnectors();

  return (
    <SandboxShell active="records">
      <header className="mb-6 border-border/80 border-b pb-5">
        <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Records</div>
        <h1 className="pdpp-heading mt-2 text-foreground">Connectors and streams</h1>
        <p className="pdpp-body mt-2 max-w-3xl text-muted-foreground">
          Inspect the seeded fictional dataset. Click any stream to see its records, or any record to see its full field
          projection. Each page is also reachable as JSON under <InlineCode>/sandbox/v1/streams/...</InlineCode>.
        </p>
      </header>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Connectors</h2>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {connectors.map((connector) => (
            <li
              className="grid grid-cols-1 gap-1 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem]"
              key={connector.connector_id}
            >
              <div className="min-w-0">
                <div className="pdpp-body font-medium text-foreground">{connector.display_name}</div>
                <code className="pdpp-caption font-mono text-muted-foreground">{connector.connector_id}</code>
              </div>
              <div className="pdpp-caption text-muted-foreground">{connector.description}</div>
              <div className="pdpp-eyebrow text-muted-foreground">
                {connector.provenance} · {connector.schedule ?? "—"}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">Streams</h2>
        <ul className="divide-y divide-border/70 border-border/70 border-y">
          {streams.data.map((stream) => (
            <li className="px-3 py-3" key={`${stream.connector_id}:${stream.stream}`}>
              <Link className="block" href={`/sandbox/records/${encodeURIComponent(stream.stream)}`}>
                <div className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_6rem]">
                  <div className="min-w-0">
                    <div className="pdpp-body font-medium text-foreground">{stream.label}</div>
                    <code className="pdpp-caption font-mono text-muted-foreground">{stream.stream}</code>
                  </div>
                  <div className="pdpp-caption text-muted-foreground">{stream.description}</div>
                  <div className="pdpp-caption text-muted-foreground tabular-nums">{stream.record_count} records</div>
                  <div className="pdpp-caption text-muted-foreground tabular-nums">{stream.field_count} fields</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mb-10">
        <h2 className="pdpp-title mb-3 text-foreground">API examples</h2>
        <CodeBlock language="shell">{`curl -s /sandbox/v1/schema
curl -s /sandbox/v1/streams
curl -s /sandbox/v1/streams/pay_statements`}</CodeBlock>
      </section>
    </SandboxShell>
  );
}
