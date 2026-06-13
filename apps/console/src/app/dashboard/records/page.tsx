/**
 * Sources — the Ink Carbon "loading dock" view.
 *
 * Reskinned per docs/design/ink-carbon/project/recordroom/rr-sources.jsx: a
 * master-detail over the owner's configured source instances. The left list is
 * health-flagged; the right "passport" (a Sheet) carries identity + a KV block
 * + foot actions; below it a stream manifest Table links every stream into
 * Explore. Records are never rendered here — Explore is the one reader.
 *
 * Data path is REAL: the page fetches connector summaries through the existing
 * owner-token `liveDashboardDataSource.listConnectorSummaries()` and projects
 * them with the pure `toSourcesView` mapping. The route id is unchanged
 * (`/dashboard/records`); redirects + tests pin it. The Sync and Revoke
 * mutations bind to the same server actions the prior surface used
 * (`runConnectorNowAction`, `revokeConnectionAction`).
 *
 * A DEV-ONLY seeded demo (`?demo=mixed|healthy|attention`, blocked in
 * production) lets a reviewer screenshot every status flag and the revoke
 * ceremony without a live server. The live path never imports the fixtures
 * when `demo` is absent.
 */
import { RecordroomShell } from "@/components/ink-carbon";
import { ServerUnreachable } from "../components/shell.tsx";
import { liveDashboardDataSource } from "../lib/data-source.ts";
import { getReferencePublicOrigin, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { listRecordVersionStats, type RefConnectorSummary } from "../lib/ref-client.ts";
import { revokeConnectionAction } from "./[connector]/actions.ts";
import { RecordsPagePoller } from "./records-page-poller.tsx";
import { SourcesView } from "./sources-view.tsx";
import { buildSourcesChurnAdvisory, type SourcesChurnAdvisory, toSourcesView } from "./sources-view-model.ts";

export const dynamic = "force-dynamic";

/**
 * Defensively fetch the version-churn advisory for the Sources surface. The
 * signal comes from `/_ref/records/version-stats` (metadata only — no record
 * payloads). A failed or older route degrades to no advisory rather than
 * breaking the page, exactly as the prior records-page `VersionChurnSection`
 * did. Mirrors that fetch shape (`limit: 8`); the non-`normal` risk filter and
 * the honest disposition headline live in `buildSourcesChurnAdvisory`.
 */
async function resolveChurnAdvisory(): Promise<SourcesChurnAdvisory | null> {
  try {
    const churn = await listRecordVersionStats({ limit: 8 });
    return buildSourcesChurnAdvisory(churn.data);
  } catch {
    return null;
  }
}

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

export default async function RecordsIndexPage({
  searchParams,
}: {
  searchParams?: Promise<{ demo?: string; error?: string; message?: string }>;
}) {
  const params = searchParams ? await searchParams : {};
  const host = await resolveHost();

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
      <RecordroomShell build="pdpp 0.1.0" host={host}>
        <SourcesHeader notice={`Seeded demo · ${scenario} · fictional data`} />
        {/* interactive=false: the demo never reaches a live server, so the
            mutating Sync/Revoke controls are read-only here. */}
        <SourcesView churnAdvisory={churnAdvisory} instances={instances} interactive={false} />
      </RecordroomShell>
    );
  }

  let summaries: RefConnectorSummary[];
  try {
    const response = await liveDashboardDataSource.listConnectorSummaries();
    summaries = response.data;
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShell build="pdpp 0.1.0" host={host}>
          <SourcesHeader />
          <ServerUnreachable />
        </RecordroomShell>
      );
    }
    throw err;
  }

  const instances = toSourcesView(summaries);
  const churnAdvisory = await resolveChurnAdvisory();
  // The poller is mounted unconditionally; `running` (derived from any active
  // run) only selects the fast vs. idle cadence. Named `runningCount` to match
  // the records-poller mount invariant.
  const runningCount = summaries.filter(
    (s) => s.last_run != null && (s.last_run.status === "started" || s.last_run.status === "in_progress")
  ).length;

  return (
    <RecordroomShell build="pdpp 0.1.0" host={host}>
      <SourcesHeader error={params.error} message={params.message} />
      <SourcesView
        churnAdvisory={churnAdvisory}
        instances={instances}
        interactive={true}
        revokeAction={revokeConnectionAction}
      />
      <RecordsPagePoller running={runningCount > 0} />
    </RecordroomShell>
  );
}

function SourcesHeader({ error, message, notice }: { error?: string; message?: string; notice?: string }) {
  return (
    <header style={{ marginBottom: 24, maxWidth: 760 }}>
      <h1 style={{ fontSize: 21, fontWeight: 800, letterSpacing: "-0.02em", margin: "0 0 4px" }}>Sources</h1>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--muted-foreground)",
          margin: 0,
        }}
      >
        your loading dock · each source pushes into your streams · nothing leaves
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
