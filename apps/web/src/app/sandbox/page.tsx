import type { Metadata } from "next";
import Link from "next/link";
import { OverviewView, type OverviewViewData } from "@/app/dashboard/components/views/overview-view.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { CodeBlock, InlineCode } from "./_demo/components/code-block.tsx";
import { SandboxShell } from "./_demo/components/shell.tsx";
import { sandboxDashboardDataSource } from "./_demo/data-source.ts";

export const metadata: Metadata = {
  title: "PDPP sandbox · mock reference demo instance",
  description:
    "A public, credential-free PDPP reference instance backed by fictional data. The sandbox renders the same dashboard the real owner sees, bound to deterministic mock AS/RS data.",
};

export const dynamic = "force-static";

async function loadOverview(): Promise<OverviewViewData> {
  const ds = sandboxDashboardDataSource;
  const [summary, failedTraces, failedRuns, revoked, denied, issued, recentRuns] = await Promise.all([
    ds.getDatasetSummary(),
    ds.listTraces({ status: "failed", limit: 5 }),
    ds.listRuns({ status: "failed", limit: 5 }),
    ds.listGrants({ status: "revoked", limit: 5 }),
    ds.listGrants({ status: "denied", limit: 5 }),
    ds.listGrants({ status: "issued", limit: 5 }),
    ds.listRuns({ limit: 8 }),
  ]);
  const recentDecisions = [...revoked.data, ...denied.data, ...issued.data]
    .sort((a, b) => (a.last_at < b.last_at ? 1 : -1))
    .slice(0, 6);
  return {
    summary,
    failedTraces: failedTraces.data,
    failedRuns: failedRuns.data,
    recentDecisions,
    recentRuns: recentRuns.data,
    actionNeeded: failedTraces.data.length + failedRuns.data.length,
  };
}

export default async function SandboxOverviewPage() {
  const data = await loadOverview();
  return (
    <SandboxShell active="overview">
      <OverviewView
        data={data}
        description="Mock reference demo instance. The same dashboard the real owner sees, backed by deterministic fictional AS/RS data — no credentials, no live calls."
        routes={sandboxRoutes}
      />
      <section className="mt-10 rounded-md border border-amber-400/40 bg-amber-400/5 px-4 py-4">
        <h2 className="pdpp-title text-foreground">About this demo</h2>
        <p className="pdpp-caption mt-1 text-muted-foreground">
          Every page here is also reachable as a JSON API under <InlineCode>/sandbox/v1/**</InlineCode> or{" "}
          <InlineCode>/sandbox/_ref/**</InlineCode>. See{" "}
          <Link className="underline underline-offset-2" href="/sandbox/api-examples">
            API examples
          </Link>{" "}
          or follow the guided{" "}
          <Link className="underline underline-offset-2" href="/sandbox/walkthrough">
            walkthrough
          </Link>
          .
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <CodeBlock language="shell">curl -s /sandbox/v1/schema</CodeBlock>
          <CodeBlock language="shell">curl -s /sandbox/v1/search?q=payroll</CodeBlock>
        </div>
      </section>
    </SandboxShell>
  );
}
