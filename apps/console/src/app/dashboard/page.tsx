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
import {
  advisoryOwnerActionsFromConnectors,
  attentionConnectionsFromConnectors,
  buildStandingData,
  type StandingHrefs,
  type StandingInputs,
  sourceIssueConnectionsFromConnectors,
} from "./components/views/standing-view-model.ts";
import { rethrowControlFlow } from "./lib/control-flow.ts";
import { liveDashboardDataSource } from "./lib/data-source.ts";
import { getReferencePublicOrigin } from "./lib/owner-token.ts";
import {
  type GrantSummary,
  listConnectorSummaries,
  listOwnerIssuedClients,
  type OwnerIssuedClient,
  type PendingApproval,
  type TraceSummary,
} from "./lib/ref-client.ts";

export const dynamic = "force-dynamic";

const SCHEME_RE = /^https?:\/\//;

const HREFS: StandingHrefs = {
  grants: dashboardRoutes.section.grants,
  runs: dashboardRoutes.section.runs,
  sources: dashboardRoutes.section.records,
  traces: dashboardRoutes.section.traces,
  deployment: dashboardRoutes.section.deployment,
  deploymentTokens: dashboardRoutes.section.deploymentTokens,
  connection: (connectorKey) => dashboardRoutes.connector(connectorKey),
  grant: (id) => dashboardRoutes.grant(id),
  run: (id) => dashboardRoutes.run(id),
  trace: (id) => dashboardRoutes.trace(id),
};

interface SafeRead<T> {
  issue: string | null;
  value: T;
}

/** Run a read, re-throwing control flow (redirects) but recording data errors. */
async function safeRead<T>(issue: string, fn: () => Promise<T>, fallback: T): Promise<SafeRead<T>> {
  try {
    return { issue: null, value: await fn() };
  } catch (err) {
    rethrowControlFlow(err);
    return { issue, value: fallback };
  }
}

/** Run a non-critical read where the caller already has a better fallback. */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  return (await safeRead("read_failed", fn, fallback)).value;
}

async function loadStandingInputs(): Promise<StandingInputs> {
  const ds = liveDashboardDataSource;
  const [summary, grantsRes, tracesRes, pendingRes, clientsRes, connectorsRes] = await Promise.all([
    safeRead("dataset_summary", () => ds.getDatasetSummary(), null),
    safeRead("grants", () => ds.listGrants({ limit: 12 }), {
      data: [] as GrantSummary[],
      has_more: false,
      object: "list" as const,
    }),
    safeRead("traces", () => ds.listTraces({ limit: 6 }), {
      data: [] as TraceSummary[],
      has_more: false,
      object: "list" as const,
    }),
    safeRead("pending_approvals", () => ds.listPendingApprovals(), {
      data: [] as PendingApproval[],
      has_more: false,
      object: "list" as const,
    }),
    safeRead("owner_tokens", () => listOwnerIssuedClients(), {
      data: [] as OwnerIssuedClient[],
      has_more: false,
      object: "list" as const,
    }),
    // The SINGLE source of attention truth — same `_ref/connectors` family `/runs` uses.
    safeRead("source_status", () => listConnectorSummaries(), { data: [], has_more: false, object: "list" as const }),
  ]);
  const overviewLoadIssues = [summary, grantsRes, tracesRes, pendingRes, clientsRes, connectorsRes]
    .map((result) => result.issue)
    .filter((issue): issue is string => issue !== null);

  return {
    now: new Date(),
    hrefs: HREFS,
    summary: summary.value,
    grants: grantsRes.value.data,
    traces: tracesRes.value.data,
    failedTraces: [],
    failedRuns: [],
    overviewLoadIssues,
    pendingApprovals: pendingRes.value.data,
    bearerClients: clientsRes.value.data,
    advisoryOwnerActions: advisoryOwnerActionsFromConnectors(connectorsRes.value.data),
    attentionConnections: attentionConnectionsFromConnectors(connectorsRes.value.data),
    sourceIssues: sourceIssueConnectionsFromConnectors(connectorsRes.value.data),
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
