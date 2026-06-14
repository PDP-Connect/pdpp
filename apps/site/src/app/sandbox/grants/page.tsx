import { StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import type { GrantSummary } from "@pdpp/operator-ui/lib/ref-client";
import Link from "next/link";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-dynamic";

interface Params {
  cursor?: string;
  peek?: string;
  q?: string;
  status?: string;
}

function listHref(params: Params, overrides: Record<string, string | undefined>): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return qs ? `/sandbox/grants?${qs}` : "/sandbox/grants";
}

export default async function SandboxGrantsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const ds = sandboxDashboardDataSource;
  const result = await ds.listGrants({ cursor: params.cursor, status: params.status, q: params.q, limit: 50 });
  const peekEnvelope = params.peek ? await ds.getGrantTimeline(params.peek) : null;

  const viewParams: ListWithPeekParams<GrantSummary> = {
    active: "grants",
    routes: sandboxRoutes,
    subject: "grant",
    title: "Grants",
    description: "Issued, revoked, and denied grant decisions.",
    result,
    rowKey: (g) => g.grant_id,
    renderRow: (grant, { peeked, href, detailHref }) => {
      const rowContent = (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <code className="pdpp-caption break-all font-medium font-mono text-foreground">{grant.grant_id}</code>
            <div className="flex items-center gap-2">
              <StatusBadge status={grant.status} />
              <span className="pdpp-caption text-muted-foreground">
                <Timestamp value={grant.last_at} />
              </span>
            </div>
          </div>
          <div className="pdpp-caption mt-1 text-muted-foreground">
            {grant.event_count} events
            {grant.client_id ? ` · client ${grant.client_id}` : ""}
            {grant.connector_id ? ` · ${grant.connector_id}` : ""}
          </div>
        </>
      );
      return (
        <div
          aria-current={peeked ? "true" : undefined}
          className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
        >
          {/* Mobile (below xl): full-page detail route. */}
          <Link className="block xl:hidden" href={detailHref}>
            {rowContent}
          </Link>
          {/* Desktop (xl+): side-panel peek via ?peek= param. */}
          <Link className="hidden xl:block" href={href} scroll={false}>
            {rowContent}
          </Link>
        </div>
      );
    },
    filters: {
      query: { name: "q", placeholder: "id contains…", defaultValue: params.q ?? "" },
      status: {
        name: "status",
        defaultValue: params.status ?? "",
        options: [
          { value: "issued", label: "issued" },
          { value: "revoked", label: "revoked" },
          { value: "denied", label: "denied" },
        ],
      },
    },
    activeFilterChips: [
      params.status ? { label: "state", value: params.status } : null,
      params.q ? { label: "query", value: params.q } : null,
    ].filter((c): c is { label: string; value: string } => Boolean(c)),
    resetHref: "/sandbox/grants",
    buildListHref: (overrides) => listHref(params, overrides),
    peekId: params.peek,
    peekEnvelope,
    peekCliCommand: (id) => `pdpp ref grant timeline ${id}`,
    emptyTitle: "No grants",
    emptyHint: "No grants match this filter.",
  };

  return (
    <DashboardShell active="grants" mode="mock-owner">
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
  );
}
