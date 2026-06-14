/**
 * Dashboard home — the Ink Carbon "Standing" (Overview) view.
 *
 * Reskinned per docs/design/ink-carbon: a computed hero (one truth, calm |
 * alarm | decide) over the owner's three questions — what can act as you, who
 * can read parts of you, what's been read — plus "anything wrong".
 *
 * Data path is REAL: every section binds to the live owner-token data source
 * (`liveDashboardDataSource`) plus `listOwnerIssuedClients` for the bearer tier.
 * Each sub-fetch is fault-isolated so one failing surface degrades to empty
 * rather than blanking the whole page; the hero still computes from what loaded.
 *
 * A DEV-ONLY seeded demo (`?demo=calm|alarm|decide`, blocked in production)
 * lets a reviewer screenshot every hero tone without mutating real data. The
 * live path never imports the fixtures when `demo` is absent.
 */

import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { RecordroomShellWithPalette } from "@/app/dashboard/components/recordroom-shell-with-palette.tsx";
import { StandingOverview } from "./components/views/standing-overview.tsx";
import { buildStandingData, type StandingHrefs, type StandingInputs } from "./components/views/standing-view-model.ts";
import { rethrowControlFlow } from "./lib/control-flow.ts";
import { liveDashboardDataSource } from "./lib/data-source.ts";
import { getReferencePublicOrigin } from "./lib/owner-token.ts";
import {
  type GrantSummary,
  listOwnerIssuedClients,
  type OwnerIssuedClient,
  type PendingApproval,
  type RunSummary,
  type TraceSummary,
} from "./lib/ref-client.ts";

export const dynamic = "force-dynamic";

const SCHEME_RE = /^https?:\/\//;

const HREFS: StandingHrefs = {
  grants: dashboardRoutes.section.grants,
  traces: dashboardRoutes.section.traces,
  deployment: dashboardRoutes.section.deployment,
  deploymentTokens: dashboardRoutes.section.deploymentTokens,
  grant: (id) => dashboardRoutes.grant(id),
  run: (id) => dashboardRoutes.run(id),
  trace: (id) => dashboardRoutes.trace(id),
};

/** Run a read, re-throwing control flow (redirects) but swallowing data errors. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowControlFlow(err);
    return fallback;
  }
}

async function loadStandingInputs(): Promise<StandingInputs> {
  const ds = liveDashboardDataSource;
  const [summary, grantsRes, tracesRes, failedTracesRes, failedRunsRes, pendingRes, clientsRes] = await Promise.all([
    safe(() => ds.getDatasetSummary(), null),
    safe(() => ds.listGrants({ limit: 12 }), { data: [] as GrantSummary[], has_more: false, object: "list" as const }),
    safe(() => ds.listTraces({ limit: 6 }), { data: [] as TraceSummary[], has_more: false, object: "list" as const }),
    safe(() => ds.listTraces({ status: "failed", limit: 5 }), {
      data: [] as TraceSummary[],
      has_more: false,
      object: "list" as const,
    }),
    safe(() => ds.listRuns({ status: "failed", limit: 5 }), {
      data: [] as RunSummary[],
      has_more: false,
      object: "list" as const,
    }),
    safe(() => ds.listPendingApprovals(), {
      data: [] as PendingApproval[],
      has_more: false,
      object: "list" as const,
    }),
    safe(() => listOwnerIssuedClients(), {
      data: [] as OwnerIssuedClient[],
      has_more: false,
      object: "list" as const,
    }),
  ]);

  return {
    now: new Date(),
    hrefs: HREFS,
    summary,
    grants: grantsRes.data,
    traces: tracesRes.data,
    failedTraces: failedTracesRes.data,
    failedRuns: failedRunsRes.data,
    pendingApprovals: pendingRes.data,
    bearerClients: clientsRes.data,
    attentionCount: failedTracesRes.data.length + failedRunsRes.data.length,
  };
}

function stripScheme(url: string): string {
  return url.replace(SCHEME_RE, "");
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const demoParam = typeof params.demo === "string" ? params.demo : undefined;
  const demoAllowed = process.env.NODE_ENV !== "production";

  let inputs: StandingInputs;
  let notice: string | undefined;
  if (demoAllowed && demoParam) {
    const { buildDemoInputs, isDemoScenario } = await import("./components/views/standing-demo-data.ts");
    const scenario = isDemoScenario(demoParam) ? demoParam : "calm";
    inputs = buildDemoInputs(scenario, HREFS);
    notice = `Seeded demo · ${scenario} state · fictional data`;
  } else {
    inputs = await loadStandingInputs();
  }

  const data = buildStandingData(inputs);
  const host = stripScheme(await safe(() => getReferencePublicOrigin(), "this server"));

  return (
    <RecordroomShellWithPalette build="pdpp 0.1.0" host={host}>
      <StandingOverview
        data={data}
        grantsHref={HREFS.grants}
        notice={notice}
        tokensHref={HREFS.deploymentTokens}
        tracesHref={HREFS.traces}
      />
    </RecordroomShellWithPalette>
  );
}
