// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import { type SearchData, SearchView } from "@pdpp/operator-ui/components/views/search-view";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
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
      redirect(exactMatchTarget(spine.exact));
    }

    // Free-text submit: hand off to Explore, mirroring the live dashboard
    // surface. `jump=0` opts out and renders the spine-only buckets.
    if (jump !== "0") {
      redirect(`${sandboxRoutes.section.explore}?q=${encodeURIComponent(query)}`);
    }

    data = {
      exact: spine.exact,
      grants: spine.grants,
      runs: spine.runs,
      traces: spine.traces,
    };
  }

  return (
    <DashboardShell active="search" mode="mock-owner">
      <SearchView
        data={data}
        emptyHint="Paste a trace, grant, or run id. To search record text, use Explore."
        query={query}
        routes={sandboxRoutes}
      />
    </DashboardShell>
  );
}
