import { redirect } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { sandboxRoutes } from "@/app/dashboard/components/views/routes.ts";
import { type SearchData, SearchView } from "@/app/dashboard/components/views/search-view.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-dynamic";

function exactMatchTarget(exact: { kind: "trace" | "grant" | "run"; id: string }): string {
  if (exact.kind === "trace") {
    return sandboxRoutes.trace(exact.id);
  }
  if (exact.kind === "grant") {
    return sandboxRoutes.grant(exact.id);
  }
  return sandboxRoutes.run(exact.id);
}

export default async function SandboxSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; jump?: string }>;
}) {
  const { q: qParam, jump } = await searchParams;
  const query = (qParam ?? "").trim();
  let data: SearchData | null = null;

  if (query) {
    const ds = sandboxDashboardDataSource;
    const spine = await ds.refSearch(query);

    if (spine.exact && jump !== "0") {
      const target = exactMatchTarget(spine.exact);
      redirect(target);
    }

    const lexical = await ds.searchRecordsLexical(query, { limit: 25 });
    data = {
      exact: spine.exact,
      grants: spine.grants,
      runs: spine.runs,
      traces: spine.traces,
      hits: lexical.data.map((h) => ({
        connectorId: h.connector_id,
        stream: h.stream,
        recordId: h.record_key,
        displayAt: h.emitted_at,
        emittedAt: h.emitted_at,
        snippet: h.snippet?.text ?? `${h.stream}/${h.record_key}`,
        timestampLabel: "emitted",
      })),
      hasMore: lexical.has_more,
      nextCursor: lexical.next_cursor ?? null,
      prevStack: [],
    };
  }

  return (
    <DashboardShell active="search" mode="mock-owner">
      <SearchView
        data={data}
        emptyHint="Try a query like 'payroll', 'visit', or 'merchant'. Paste a grant/run/trace id to jump directly."
        query={query}
        routes={sandboxRoutes}
      />
    </DashboardShell>
  );
}
