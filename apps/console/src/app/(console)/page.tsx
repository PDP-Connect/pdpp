// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Dashboard home — the Ink Carbon "Standing" (Overview) view.
 *
 * Reskinned per docs/design-system/ink-carbon: a computed hero (one truth, calm |
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
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "./components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "./components/connector-summary-pager.ts";
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
  getFleetHealthVerdict,
  getGrantPackageCount,
  type ListResponse,
  listOwnerIssuedClients,
  listWebPushSubscriptions,
  type OwnerIssuedClient,
  type PendingApproval,
  type RefConnectorSummary,
  type TraceSummary,
  type WebPushSubscriptionSummary,
} from "./lib/ref-client.ts";
import { sourceWorkFromConnectors } from "./lib/source-actionability.ts";

export const dynamic = "force-dynamic";

const SCHEME_RE = /^https?:\/\//;

const HREFS: StandingHrefs = {
  connection: (connectorKey) => dashboardRoutes.connector(connectorKey),
  deployment: dashboardRoutes.section.deployment,
  deploymentTokens: dashboardRoutes.section.deploymentTokens,
  grant: (id) => dashboardRoutes.grant(id),
  grantPackages: `${dashboardRoutes.section.grants}/packages`,
  grants: dashboardRoutes.section.grants,
  notifications: dashboardRoutes.section.notifications,
  run: (id) => dashboardRoutes.run(id),
  runs: dashboardRoutes.section.runs,
  sources: dashboardRoutes.section.records,
  trace: (id) => dashboardRoutes.trace(id),
  traces: dashboardRoutes.section.traces,
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

/**
 * ONE bounded connector-summary page (never the exhaustive fold). The caller
 * renders the shared pager whenever the server returns a continuation, so a
 * larger fleet is reachable without a silent first-page omission.
 */
async function loadOverviewConnectors(state: ReturnType<typeof parseConnectorSummaryPageState>): Promise<{
  complete: boolean;
  connectors: RefConnectorSummary[];
  fleetHealth: Awaited<ReturnType<typeof getFleetHealthVerdict>> | null;
  sourcePage: NonNullable<StandingInputs["sourcePage"]>;
}> {
  const page = await loadConnectorSummaryPage(state, (opts) =>
    liveDashboardDataSource.listConnectorSummaries({ ...opts, includeFleetHealth: true })
  );
  if (page.kind === "error") {
    return {
      complete: false,
      connectors: [],
      fleetHealth: null,
      sourcePage: { isPaged: isPagedRequest(state), kind: "error", message: page.message, hasMore: false },
    };
  }
  // The reference sends fleet_health only for a page it explicitly marked
  // terminal.  Do not turn a short/partial page into a fleet verdict.
  return {
    complete: !page.hasMore,
    connectors: [...page.items],
    fleetHealth: page.hasMore ? null : (page.fleetHealth ?? null),
    sourcePage: {
      hasMore: page.hasMore,
      isPaged: isPagedRequest(state),
      kind: "ok",
      nextCursor: page.nextCursor,
    },
  };
}

async function loadStandingInputs(params: Record<string, string | string[] | undefined>): Promise<StandingInputs> {
  const ds = liveDashboardDataSource;
  const sourcePageState = parseConnectorSummaryPageState(params);
  const [summary, grantsRes, tracesRes, pendingRes, clientsRes, connectorsResult, packageCountRes, webPushRes] =
    await Promise.all([
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
      // ONE bounded page; see loadOverviewConnectors for the `complete` signal.
      safeRead("source_status", () => loadOverviewConnectors(sourcePageState), {
        complete: true,
        connectors: [] as RefConnectorSummary[],
        fleetHealth: null,
        sourcePage: { kind: "error" as const, hasMore: false, isPaged: isPagedRequest(sourcePageState) },
      }),
      // Authoritative grant-package count so the overview badge need not page the
      // full grants/packages list. Fails soft to a null count, which makes the
      // view-model fall back to the loaded-grants floor.
      safeRead<{ count: number | null }>("grant_package_count", () => getGrantPackageCount(), { count: null }),
      // Deployment-wide "is any device enrolled" signal for the Notifications
      // overview block. Per-browser enablement is client-only state (see
      // web-push-settings.tsx); this is the coarser server-derivable proxy.
      safeRead("web_push_subscriptions", () => listWebPushSubscriptions(), {
        data: [] as WebPushSubscriptionSummary[],
        has_more: false,
        object: "list" as const,
      }),
    ]);
  // The complete page is the exact inventory used to project its optional
  // verdict. If it is paged, use the server's full-fleet verdict instead.
  const fleetHealthRes =
    connectorsResult.issue === null && connectorsResult.value.complete && connectorsResult.value.fleetHealth !== null
      ? { issue: null, value: connectorsResult.value.fleetHealth }
      : await safeRead("fleet_health", () => getFleetHealthVerdict(), null);
  const overviewLoadIssues = [summary, grantsRes, tracesRes, pendingRes, clientsRes, connectorsResult, fleetHealthRes]
    .map((result) => result.issue)
    .filter((issue): issue is string => issue !== null);
  if (connectorsResult.issue !== null || connectorsResult.value.sourcePage.kind === "error") {
    overviewLoadIssues.push("source_status_page_unavailable");
  }

  const { connectors } = connectorsResult.value;
  const notificationsSetup: StandingInputs["notificationsSetup"] = webPushSetupState(webPushRes);
  return {
    advisoryOwnerActions: advisoryOwnerActionsFromConnectors(connectors),
    attentionConnections: attentionConnectionsFromConnectors(connectors),
    bearerClients: clientsRes.value.data,
    failedRuns: [],
    failedTraces: [],
    fleetHealth: fleetHealthRes.value,
    grantPackageCount: packageCountRes.value.count,
    grants: grantsRes.value.data,
    hrefs: HREFS,
    notificationsSetup,
    now: new Date(),
    overviewLoadIssues,
    pendingApprovals: pendingRes.value.data,
    sourceIssues: sourceIssueConnectionsFromConnectors(connectors),
    sourceCount:
      connectorsResult.value.complete && !sourcePageState.cursor
        ? (fleetHealthRes.value?.scope.assessed.length ??
          connectors.filter((connector) => connector.revoked_at === null).length)
        : undefined,
    sourcePage: connectorsResult.value.sourcePage,
    sourceWork: sourceWorkFromConnectors(connectors),
    summary: summary.value,
    traces: tracesRes.value.data,
  };
}

/** See StandingData.notificationsSetup — a failed read must stay "unknown", never default to "not_configured". */
function webPushSetupState(
  webPushRes: SafeRead<ListResponse<WebPushSubscriptionSummary>>
): "configured" | "not_configured" | "unknown" {
  if (webPushRes.issue !== null) {
    return "unknown";
  }
  return webPushRes.value.data.length > 0 ? "configured" : "not_configured";
}

function stripScheme(url: string): string {
  return url.replace(SCHEME_RE, "");
}

function DashboardSourcePageControls({
  currentParams,
  page,
}: {
  currentParams: Record<string, string | string[] | undefined>;
  page: StandingInputs["sourcePage"];
}) {
  if (!page) {
    return null;
  }
  if (page.kind === "error") {
    return (
      <ConnectorSummaryPageError
        basePath="/"
        currentParams={currentParams}
        message={page.message ?? "The dashboard source page could not be loaded."}
      />
    );
  }
  return (
    <ConnectorSummaryPager
      basePath="/"
      currentParams={currentParams}
      hasMore={page.hasMore}
      isPaged={page.isPaged}
      nextCursor={page.nextCursor}
    />
  );
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
    inputs = await loadStandingInputs(params);
  }

  const data = buildStandingData(inputs);
  const host = stripScheme(await safe(() => getReferencePublicOrigin(), "this server"));

  return (
    <RecordroomShellWithPalette build="pdpp 0.1.0" host={host}>
      <StandingOverview
        data={data}
        grantsHref={HREFS.grants}
        notice={notice}
        notificationsHref={HREFS.notifications}
        syncsHref={HREFS.runs}
        tokensHref={HREFS.deploymentTokens}
        tracesHref={HREFS.traces}
      />
      <DashboardSourcePageControls currentParams={params} page={inputs.sourcePage} />
    </RecordroomShellWithPalette>
  );
}
