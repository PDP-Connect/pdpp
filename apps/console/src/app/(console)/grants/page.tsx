// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buttonVariants, IcButton, IcTimestamp } from "@pdpp/brand-react";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { GRANT_LIFECYCLE_VOCABULARY } from "@pdpp/operator-ui/components/status-vocabularies";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { formatSourceForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import { grantRowLabel } from "@pdpp/operator-ui/lib/summary-row-label";
import Link from "next/link";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../components/shell.tsx";
import { getOwnerLoginPath, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type GrantSummary,
  getGrantTimeline,
  type ListResponse,
  listGrants,
  listPendingApprovals,
  type PendingApproval,
} from "../lib/ref-client.ts";
import { approvePendingApprovalAction, denyPendingApprovalAction } from "./pending-actions.ts";

export const dynamic = "force-dynamic";

interface Params {
  approval_error?: string;
  client_id?: string;
  cursor?: string;
  demo?: string;
  peek?: string;
  q?: string;
  since?: string;
  source_id?: string;
  source_kind?: "connector" | "provider_native";
  status?: string;
  until?: string;
  /** `all` shows every lifecycle status (incl. revoked/denied/failed/pending
   *  and probe/test residue); any other value (default) shows current,
   *  actionable access only. Never a name-based filter. */
  view?: string;
}

const CURRENT_ACCESS_STATUS = "issued";

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
    .join("&");
  return qs ? `/grants?${qs}` : "/grants";
}

// Authoritative-only: the caption uses the stored `client_name` from
// oauth_clients when present, otherwise the raw client_id. Never derived
// from a URL or client-id shape — a client_id that happens to look like a
// hostname or a `cli_...` token is not evidence of what the client is.
function grantClientCaption(grant: GrantSummary): string | null {
  const name = grant.client?.client_name?.trim();
  if (name) {
    return `client ${name}`;
  }
  const clientId = grant.client_id?.trim();
  return clientId ? `client ${clientId}` : null;
}

interface LoadedGrantData {
  approvals: ListResponse<PendingApproval>;
  peekEnvelope: Awaited<ReturnType<typeof getGrantTimeline>>;
  result: ListResponse<GrantSummary>;
}

async function loadGrantData(params: Params): Promise<LoadedGrantData> {
  const showAll = params.view === "all";
  if (process.env.NODE_ENV !== "production" && params.demo === "atlas") {
    const demo = await import("./grants-demo-data.ts");
    const demoData = demo.buildGrantsDemoData();
    return { approvals: demoData.approvals, peekEnvelope: null, result: demoData.grants };
  }

  const [result, approvals] = await Promise.all([
    listGrants(buildGrantListFilters(params, showAll)),
    listPendingApprovals(),
  ]);
  const peekEnvelope = params.peek ? await getGrantTimeline(params.peek) : null;
  return { approvals, peekEnvelope, result };
}

function buildGrantListFilters(params: Params, showAll: boolean) {
  const effectiveStatus = params.status ?? (showAll ? undefined : CURRENT_ACCESS_STATUS);
  return {
    client_id: params.client_id,
    cursor: params.cursor,
    limit: 50,
    q: params.q,
    source_id: params.source_id,
    source_kind: params.source_kind,
    // `since`/`until` are already applied server-side as HAVING clauses over
    // MIN/MAX(occurred_at); the console simply had no affordance for them.
    // Widen a bare date to cover the whole day so "active before 2026-07-01"
    // does not silently exclude everything that happened on the 1st.
    since: params.since ? `${params.since}T00:00:00.000Z` : undefined,
    status: effectiveStatus,
    until: params.until ? `${params.until}T23:59:59.999Z` : undefined,
  };
}

function buildActiveFilters(params: Params, showAll: boolean) {
  const filters: Array<{ label: string; value: string } | null> = [];
  if (params.status) {
    filters.push({ label: "state", value: params.status });
  } else if (!showAll) {
    filters.push({ label: "view", value: "current access (issued)" });
  }
  if (params.q) {
    filters.push({ label: "query", value: params.q });
  }
  if (params.client_id) {
    filters.push({ label: "client", value: params.client_id });
  }
  if (params.since) {
    filters.push({ label: "since", value: params.since });
  }
  if (params.until) {
    filters.push({ label: "before", value: params.until });
  }
  return filters.filter((item): item is { label: string; value: string } => Boolean(item));
}

function buildGrantFilters(params: Params, showAll: boolean) {
  const carry = [
    params.client_id ? { name: "client_id", value: params.client_id } : null,
    params.source_id ? { name: "source_id", value: params.source_id } : null,
    params.source_kind ? { name: "source_kind", value: params.source_kind } : null,
    // Carries the current/all view mode through the filter form (status
    // select, query, date range) so switching a filter doesn't silently
    // drop back to the default current-access view.
    showAll ? { name: "view", value: "all" } : null,
  ].filter((item): item is { name: string; value: string } => Boolean(item));

  return {
    carry,
    dateRange: {
      sinceName: "since",
      sinceValue: params.since ?? "",
      untilName: "until",
      untilValue: params.until ?? "",
    },
    query: { defaultValue: params.q ?? "", name: "q", placeholder: "id contains…" },
    status: {
      defaultValue: params.status ?? (showAll ? "" : CURRENT_ACCESS_STATUS),
      name: "status",
      options: [
        { label: "issued", value: "issued" },
        { label: "revoked", value: "revoked" },
        { label: "denied", value: "denied" },
        { label: "failed", value: "failed" },
        { label: "pending", value: "pending" },
      ],
    },
  };
}

export default async function GrantsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const showAll = params.view === "all";

  let data: LoadedGrantData;
  try {
    data = await loadGrantData(params);
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader title="Grants" />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }
  const { approvals, peekEnvelope, result } = data;

  const ownerLoginUrl = getOwnerLoginPath();
  const viewParams: ListWithPeekParams<GrantSummary> = {
    active: "grants",
    activeFilterChips: buildActiveFilters(params, showAll),
    buildListHref: (overrides) => listHref(params, overrides),
    description: showAll
      ? "All grant evidence, including current, historical, denied, failed, and pending lifecycle records."
      : "Current issued authorizations for client access to owner data. Historical and non-actionable evidence remains available under All grants.",
    emptyHint: "Grant artifacts appear after client/provider-connect consent flows issue or reject grants.",
    emptyTitle: "No grants yet",
    filters: buildGrantFilters(params, showAll),
    headerActions: <GrantViewActions params={params} showAll={showAll} />,
    peekCliCommand: (id) => `pdpp ref grant timeline ${id}`,
    peekEnvelope,
    peekId: params.peek,
    preHeader: <GrantsPreHeader approvals={approvals} ownerLoginUrl={ownerLoginUrl} params={params} />,
    renderRow: (grant, { peeked, href, detailHref }) => (
      <GrantRow
        clientFilterHref={grant.client_id ? listHref(params, { client_id: grant.client_id, cursor: undefined }) : null}
        detailHref={detailHref}
        grant={grant}
        href={href}
        peeked={peeked}
      />
    ),
    resetHref: "/grants",
    result,
    routes: dashboardRoutes,
    rowKey: (grant) => grant.grant_id,
    subject: "grant",
    title: "Grants",
  };

  return (
    <RecordroomShellWithPalette>
      <ListWithPeekView params={viewParams} />
    </RecordroomShellWithPalette>
  );
}

function GrantsPreHeader({
  approvals,
  ownerLoginUrl,
  params,
}: {
  approvals: ListResponse<PendingApproval>;
  ownerLoginUrl: string;
  params: Params;
}) {
  return (
    <>
      {params.approval_error ? (
        <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 shadow-[inset_3px_0_0_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]">
          <span className="font-medium text-destructive">Approval error:</span> <span>{params.approval_error}</span>
        </div>
      ) : null}

      {/* Zero pending approvals collapses entirely — no dead "Pending approvals
          (0)" section with an empty-state at the top of the grants list every
          render. The section (and its owner-approval affordances) appears only
          when there is something waiting. */}
      {approvals.data.length > 0 ? (
        <Section
          description="Device-flow and consent requests waiting for the owner."
          id="pending-approvals"
          title={`Pending approvals (${approvals.data.length})`}
        >
          <DataList>
            {approvals.data.map((approval) => (
              <li key={approval.approval_id}>
                <PendingApprovalRow approval={approval} />
              </li>
            ))}
          </DataList>
          <p className="pdpp-caption mt-2 text-muted-foreground">
            These dashboard shortcut buttons work in open local-dev mode. If placeholder owner auth is enabled, sign in
            at{" "}
            <a className="underline-offset-2 hover:underline" href={ownerLoginUrl}>
              owner access
            </a>{" "}
            and approve there instead.
          </p>
        </Section>
      ) : null}
    </>
  );
}

function GrantViewActions({ params, showAll }: { params: Params; showAll: boolean }) {
  return (
    <>
      <Link
        className={buttonVariants({ size: "sm", variant: showAll ? "ghost" : "default" })}
        href={listHref(params, { cursor: undefined, view: undefined })}
      >
        Current access
      </Link>
      <Link
        className={buttonVariants({ size: "sm", variant: showAll ? "default" : "ghost" })}
        href={listHref(params, { cursor: undefined, view: "all" })}
        title="Revoked, denied, failed, pending, and any probe/test residue — nothing is hidden by name."
      >
        All grants
      </Link>
      <Link className={buttonVariants({ size: "sm", variant: "ghost" })} href="/grants/request">
        Grant request workspace
      </Link>
    </>
  );
}

function PendingApprovalRow({ approval }: { approval: PendingApproval }) {
  const previewStreams = Array.isArray(approval.grant_preview?.streams)
    ? approval.grant_preview.streams.flatMap((stream) => {
        const name = typeof stream === "string" ? stream : stream?.name || "";
        return name ? [name] : [];
      })
    : [];

  return (
    <div className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <code className="pdpp-caption break-all font-medium font-mono text-foreground">{approval.approval_id}</code>
          <span className="pdpp-caption text-muted-foreground">
            <IcTimestamp value={approval.created_at} />
          </span>
          <StatusBadge status={approval.kind} />
        </div>
        <div className="pdpp-caption mt-1 break-words text-muted-foreground">
          client {approval.client_id ?? "—"}
          {approval.grant_preview?.source ? ` · source ${formatSourceForDisplay(approval.grant_preview.source)}` : ""}
          {previewStreams.length ? ` · streams ${previewStreams.join(", ")}` : ""}
        </div>
      </div>
      <form className="flex flex-wrap gap-2">
        <input name="kind" type="hidden" value={approval.kind} />
        <input name="approval_id" type="hidden" value={approval.approval_id} />
        <IcButton formAction={approvePendingApprovalAction} size="sm" type="submit">
          Approve
        </IcButton>
        <IcButton formAction={denyPendingApprovalAction} size="sm" type="submit" variant="destructive">
          Deny
        </IcButton>
      </form>
    </div>
  );
}

function GrantRow({
  grant,
  href,
  detailHref,
  peeked,
  clientFilterHref,
}: {
  grant: GrantSummary;
  href: string;
  detailHref: string;
  peeked: boolean;
  clientFilterHref: string | null;
}) {
  const packageHref = grant.grant_package_id ? `/grants/packages/${encodeURIComponent(grant.grant_package_id)}` : null;
  const clientCaption = grantClientCaption(grant);

  // Shared row content rendered inside both the mobile and desktop links.
  const rowContent = (
    <>
      {/* Lead with the source/client + decision; the raw grant id is demoted
          to a monospace lookup key on the detail line. */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-medium text-foreground">{grantRowLabel(grant)}</span>
          <StatusBadge status={grant.status} vocabulary={GRANT_LIFECYCLE_VOCABULARY} />
          {clientCaption ? (
            <span
              className="pdpp-caption max-w-[20ch] truncate text-muted-foreground"
              title={grant.client_id ?? undefined}
            >
              {clientCaption}
            </span>
          ) : null}
        </div>
        <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums" title="Last used">
          last used <IcTimestamp value={grant.last_at} />
        </span>
      </div>
      <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
        <code className="max-w-[32ch] truncate font-mono" title={grant.grant_id}>
          {grant.grant_id}
        </code>
        <span className="text-muted-foreground/50">·</span>
        <span title="Issued">
          issued <IcTimestamp value={grant.first_at} />
        </span>
        <span className="text-muted-foreground/50">·</span>
        <span className="tabular-nums">{grant.event_count} events</span>
        {grant.source ? (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span>source {formatSourceForDisplay(grant.source)}</span>
          </>
        ) : null}
      </div>
    </>
  );

  return (
    <div
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
    >
      {/* Mobile (below xl): navigate to full-page detail route. */}
      <Link className="block xl:hidden" href={detailHref}>
        {rowContent}
      </Link>
      {/* Desktop (xl+): open the side-panel peek via ?peek= param. */}
      <Link className="hidden xl:block" href={href} scroll={false}>
        {rowContent}
      </Link>
      {/* Pivots live OUTSIDE the row-wide links above — nesting an anchor
          inside an anchor is invalid and breaks activation on both. */}
      {packageHref || clientFilterHref ? (
        <div className="pdpp-caption mt-1 flex flex-wrap gap-1.5">
          {packageHref ? (
            <Link
              className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:bg-muted/60"
              href={packageHref}
            >
              package {grant.grant_package_id} →
            </Link>
          ) : null}
          {clientFilterHref ? (
            <Link
              className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:bg-muted/60"
              href={clientFilterHref}
              title={`Show only grants for ${grant.client_id}`}
            >
              only this client
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
