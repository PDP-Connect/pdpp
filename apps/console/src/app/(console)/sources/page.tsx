// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Sources — the Ink Carbon "loading dock" view.
 *
 * Reskinned per docs/design-system/ink-carbon/project/recordroom/rr-sources.jsx: a
 * master-detail over the owner's configured source instances. The left list is
 * health-flagged; the right "passport" (a Sheet) carries identity + a KV block
 * + foot actions; below it a stream manifest Table links every stream into
 * Explore. Records are never rendered here — Explore is the one reader.
 *
 * Data path is REAL: the page fetches exactly ONE bounded page of connector
 * summaries (`listConnectorSummaries({ cursor, limit: 100 })` — never the
 * exhaustive fold) through the existing owner-token `liveDashboardDataSource`,
 * and projects it with the pure `toSourcesView` mapping. A fleet larger than
 * one page is reachable via the shared `ConnectorSummaryPager` (a bounded
 * `page_cursor` Next link + explicit Restart; Previous is the browser's own
 * back button, never URL-side history), not by prefetching every page
 * before first paint. The route id is unchanged
 * (`/sources`); redirects + tests pin it. The Sync and Revoke
 * mutations bind to the same server actions the prior surface used
 * (`runConnectorNowAction`, `revokeConnectionAction`, `reactivateConnectionAction`).
 *
 * A DEV-ONLY seeded demo (`?demo=mixed|healthy|attention`, blocked in
 * production) lets a reviewer screenshot every status flag and the revoke
 * ceremony without a live server. The live path never imports the fixtures
 * when `demo` is absent.
 */
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import {
  ConnectorSummaryPageError,
  ConnectorSummaryPager,
  loadConnectorSummaryPage,
} from "../components/connector-summary-page.tsx";
import { isPagedRequest, parseConnectorSummaryPageState } from "../components/connector-summary-pager.ts";
import { ServerUnreachable } from "../components/server-unreachable.tsx";
import { isActiveConnectorRunSummaryStatus } from "../lib/connector-run-summary-status.ts";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { listConnectorManifests } from "../lib/rs-client.ts";
import { reactivateConnectionAction, revokeConnectionAction } from "./[connector]/actions.ts";
import { RecordsPagePoller } from "./records-page-poller.tsx";
import { SOURCE_ACCESS_NOTE } from "./sources-copy.ts";
import { SourcesView } from "./sources-view.tsx";
import {
  buildSourcesChurnAdvisory,
  buildSourcesRuntimeAdvisory,
  type SourcesRuntimeAdvisory,
  toSourcesView,
} from "./sources-view-model.ts";

const SOURCES_PATH = "/sources";
const REFERENCE_REVISION = process.env.PDPP_REFERENCE_REVISION?.trim() || undefined;

export const dynamic = "force-dynamic";

const SCHEME_RE = /^https?:\/\//;

function stripScheme(url: string): string {
  return url.replace(SCHEME_RE, "");
}

async function resolveHost(): Promise<string> {
  try {
    return stripScheme(await getReferencePublicOrigin());
  } catch {
    return "this server";
  }
}

function fetchSourcesPage(pageState: ReturnType<typeof parseConnectorSummaryPageState>) {
  // `sourcesVisibility: true` asks the reference to exclude a pure recovered
  // historical fragment BEFORE its own LIMIT, so `hasMore`/the next cursor
  // stay correct for the rows this page actually renders — never a
  // post-LIMIT filter. Explore and every other surface omit this flag.
  return loadConnectorSummaryPage(pageState, (opts) =>
    liveDashboardDataSource.listConnectorSummaries({ ...opts, sourcesVisibility: true })
  );
}

export default async function RecordsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{
    demo?: string;
    error?: string;
    message?: string;
    page_cursor?: string;
  }>;
}) {
  const params = searchParams ? await searchParams : {};
  const host = await resolveHost();
  const pageState = parseConnectorSummaryPageState(params);

  // DEV-ONLY seeded demo. Gated by NODE_ENV so production never reads fixtures.
  const demoParam = typeof params.demo === "string" ? params.demo : undefined;
  if (process.env.NODE_ENV !== "production" && demoParam) {
    const { buildSourcesDemoSummaries, buildSourcesDemoChurnRows, isSourcesDemoScenario } = await import(
      "./sources-demo-data.ts"
    );
    const scenario = isSourcesDemoScenario(demoParam) ? demoParam : "mixed";
    const instances = toSourcesView(buildSourcesDemoSummaries(scenario));
    // Seed a churn advisory for the demo so the protocol-toned notice is
    // screenshot-able without a live version-stats route.
    const churnAdvisory = buildSourcesChurnAdvisory(buildSourcesDemoChurnRows(scenario));
    return (
      <RecordroomShellWithPalette build="pdpp 0.1.0" host={host}>
        <SourcesHeader notice={`Seeded demo · ${scenario} · fictional data`} />
        {/* interactive=false: the demo never reaches a live server, so the
            mutating Sync/Revoke controls are read-only here. */}
        <SourcesView churnAdvisory={churnAdvisory} instances={instances} interactive={false} />
      </RecordroomShellWithPalette>
    );
  }

  let manifests: Awaited<ReturnType<typeof listConnectorManifests>>;
  let page: Awaited<ReturnType<typeof fetchSourcesPage>>;
  try {
    const [pageResult, connectorManifests] = await Promise.all([fetchSourcesPage(pageState), listConnectorManifests()]);
    page = pageResult;
    manifests = connectorManifests;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette build="pdpp 0.1.0" host={host}>
          <SourcesHeader />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (page.kind === "error") {
    return (
      <RecordroomShellWithPalette build="pdpp 0.1.0" host={host}>
        <SourcesHeader error={params.error} message={params.message} />
        <ConnectorSummaryPageError basePath={SOURCES_PATH} currentParams={params} message={page.message} />
      </RecordroomShellWithPalette>
    );
  }

  const summaries = [...page.items];
  const runtimeAdvisory: SourcesRuntimeAdvisory | null = buildSourcesRuntimeAdvisory(page.runtime);
  const instances = toSourcesView(summaries, { manifests });
  // The poller is mounted unconditionally; `running` (derived from any active
  // run) only selects the fast vs. idle cadence. Named `runningCount` to match
  // the records-poller mount invariant.
  const runningCount = summaries.filter(
    (s) => s.last_run !== null && isActiveConnectorRunSummaryStatus(s.last_run.status)
  ).length;

  return (
    <RecordroomShellWithPalette build="pdpp 0.1.0" host={host}>
      <SourcesHeader error={params.error} message={params.message} />
      <SourcesView
        instances={instances}
        interactive={true}
        reactivateAction={reactivateConnectionAction}
        revokeAction={revokeConnectionAction}
        runtimeAdvisory={runtimeAdvisory}
      />
      <ConnectorSummaryPager
        basePath={SOURCES_PATH}
        currentParams={params}
        hasMore={page.hasMore}
        isPaged={isPagedRequest(pageState)}
        nextCursor={page.nextCursor}
      />
      <RecordsPagePoller running={runningCount > 0} />
    </RecordroomShellWithPalette>
  );
}

function SourcesHeader({ error, message, notice }: { error?: string; message?: string; notice?: string }) {
  return (
    <header data-pdpp-reference-revision={REFERENCE_REVISION} style={{ marginBottom: 24, maxWidth: 760 }}>
      <h1 className="pdpp-heading text-foreground" style={{ margin: "0 0 4px" }}>
        Sources
      </h1>
      <p
        style={{
          color: "var(--muted-foreground)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          margin: 0,
        }}
      >
        {SOURCE_ACCESS_NOTE}
      </p>
      {notice ? (
        <div className="rr-s-toast" data-tone="ok" role="status" style={{ marginTop: 12 }}>
          {notice}
        </div>
      ) : null}
      {error ? (
        <div className="rr-s-toast" data-tone="error" role="status" style={{ marginTop: 12 }}>
          {error}
        </div>
      ) : null}
      {message && !error ? (
        <div className="rr-s-toast" data-tone="ok" role="status" style={{ marginTop: 12 }}>
          {message}
        </div>
      ) : null}
    </header>
  );
}
