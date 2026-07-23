// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import type { RunSummary } from "@pdpp/operator-ui/lib/ref-client";
import Link from "next/link";
import { DashboardShell } from "@/app/dashboard/components/shell.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { sandboxDashboardDataSource } from "../_demo/data-source.ts";

export const dynamic = "force-dynamic";

interface Params {
  connector_id?: string;
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
  return qs ? `/sandbox/runs?${qs}` : "/sandbox/runs";
}

export default async function SandboxRunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const ds = sandboxDashboardDataSource;
  const result = await ds.listRuns({
    connector_id: params.connector_id,
    cursor: params.cursor,
    limit: 50,
    q: params.q,
    status: params.status,
  });
  const peekEnvelope = params.peek ? await ds.getRunTimeline(params.peek) : null;

  const viewParams: ListWithPeekParams<RunSummary> = {
    active: "runs",
    activeFilterChips: [
      params.status ? { label: "status", value: params.status } : null,
      params.connector_id ? { label: "connector", value: params.connector_id } : null,
      params.q ? { label: "query", value: params.q } : null,
    ].filter((c): c is { label: string; value: string } => Boolean(c)),
    buildListHref: (overrides) => listHref(params, overrides),
    description: "Connector runs and their outcomes.",
    emptyHint: "No runs match this filter.",
    emptyTitle: "No runs",
    filters: {
      connector: { defaultValue: params.connector_id ?? "", name: "connector_id" },
      query: { defaultValue: params.q ?? "", name: "q", placeholder: "id contains…" },
      status: {
        defaultValue: params.status ?? "",
        name: "status",
        options: [
          { label: "succeeded", value: "succeeded" },
          { label: "failed", value: "failed" },
          { label: "needs input", value: "needs_input" },
          { label: "started", value: "started" },
        ],
      },
    },
    peekCliCommand: (id) => `pdpp ref run timeline ${id}`,
    peekEnvelope,
    peekId: params.peek,
    renderRow: (run, { peeked, href, detailHref }) => {
      const rowContent = (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <code className="pdpp-caption break-all font-medium font-mono text-foreground">{run.run_id}</code>
            <div className="flex items-center gap-2">
              {run.needs_input ? (
                <span className="pdpp-eyebrow rounded-[3px] bg-[color:var(--warning-wash)] px-1.5 py-0.5 font-medium text-[color:var(--warning)]">
                  needs input
                </span>
              ) : null}
              <StatusBadge status={run.status} />
              <span className="pdpp-caption text-muted-foreground">
                <Timestamp value={run.last_at} />
              </span>
            </div>
          </div>
          <div className="pdpp-caption mt-1 text-muted-foreground">
            {run.event_count} events · {run.connector_id ?? "—"}
            {run.failure_reason ? ` · ${run.failure_reason}` : ""}
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
    resetHref: "/sandbox/runs",
    result,
    routes: sandboxRoutes,
    rowKey: (r) => r.run_id,
    subject: "run",
    title: "Runs",
  };

  return (
    <DashboardShell active="runs" mode="mock-owner">
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
  );
}
