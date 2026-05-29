import Link from "next/link";
import { redirect } from "next/navigation";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
import { dashboardRoutes } from "../components/views/routes.ts";
import { type SearchData, SearchView } from "../components/views/search-view.tsx";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import { type GrantSummary, type RunSummary, refSearch, type TraceSummary } from "../lib/ref-client.ts";
import { verifyDashboardSession } from "../lib/verify-session.ts";

export const dynamic = "force-dynamic";

interface SearchResult {
  exact: { kind: "trace" | "grant" | "run"; id: string } | null;
  grants: GrantSummary[];
  runs: RunSummary[];
  traces: TraceSummary[];
}

function exactMatchRedirectTarget(exact: { id: string; kind: "trace" | "grant" | "run" }): string {
  const { kind, id } = exact;
  if (kind === "trace") {
    return `/dashboard/traces/${encodeURIComponent(id)}`;
  }
  if (kind === "grant") {
    return `/dashboard/grants/${encodeURIComponent(id)}`;
  }
  return `/dashboard/runs/${encodeURIComponent(id)}`;
}

interface LoadSearchOutput {
  result: SearchResult | null;
  unreachable: boolean;
}

async function loadSearchResult(query: string, jump: string | undefined): Promise<LoadSearchOutput> {
  try {
    const spineResult = await refSearch(query);

    // Deep-link on exact id match. jump=0 opts out so operators can inspect
    // what matched without auto-following the redirect.
    if (spineResult.exact && jump !== "0") {
      redirect(exactMatchRedirectTarget(spineResult.exact));
    }

    // Free-text submit: hand off record-content search to Explore, which is
    // the sole owner-token record search surface after
    // `narrow-search-to-spine-jump`. `jump=0` opts out and renders the
    // spine-only results.
    if (jump !== "0") {
      redirect(`${dashboardRoutes.section.explore}?q=${encodeURIComponent(query)}`);
    }

    return {
      result: {
        exact: spineResult.exact,
        traces: spineResult.traces,
        grants: spineResult.grants,
        runs: spineResult.runs,
      },
      unreachable: false,
    };
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return { result: null, unreachable: true };
    }
    throw err;
  }
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string; jump?: string }> }) {
  const { q: qParam, jump } = await searchParams;
  const query = (qParam ?? "").trim();

  // Empty-query loads bypass `loadSearchResult`, so they would otherwise miss
  // the DAL gate. Verify the session here so the empty-shell render redirects
  // unauthenticated callers consistently with sibling dashboard routes.
  if (!query) {
    await verifyDashboardSession();
  }

  const { result, unreachable } = query ? await loadSearchResult(query, jump) : { result: null, unreachable: false };

  if (unreachable) {
    return (
      <DashboardShell active="search">
        <ServerUnreachable />
      </DashboardShell>
    );
  }

  const data: SearchData | null = result
    ? {
        exact: result.exact,
        grants: result.grants,
        runs: result.runs,
        traces: result.traces,
      }
    : null;

  return (
    <DashboardShell active="search">
      <SearchView
        data={data}
        emptyHint={
          <>
            Paste a trace, grant, or run id.{" "}
            <Link className="underline underline-offset-2 hover:text-foreground" href={dashboardRoutes.section.explore}>
              Search records by text in Explore →
            </Link>
          </>
        }
        query={query}
        routes={dashboardRoutes}
      />
    </DashboardShell>
  );
}
