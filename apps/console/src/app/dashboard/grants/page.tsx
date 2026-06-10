import { EmptyState } from "@pdpp/operator-ui/components/empty-state";
import { DataList, PageHeader, Section, StatusBadge } from "@pdpp/operator-ui/components/primitives";
import { type ListWithPeekParams, ListWithPeekView } from "@pdpp/operator-ui/components/views/list-with-peek";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import { formatSourceForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import { grantRowLabel } from "@pdpp/operator-ui/lib/summary-row-label";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DashboardShell, ServerUnreachable } from "../components/shell.tsx";
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
  peek?: string;
  q?: string;
  source_id?: string;
  source_kind?: "connector" | "provider_native";
  status?: string;
}

function listHref(params: Params, overrides: Partial<Params> = {}): string {
  const merged = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) =>
      v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`]
    )
    .join("&");
  return qs ? `/dashboard/grants?${qs}` : "/dashboard/grants";
}

export default async function GrantsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const filters = {
    cursor: params.cursor,
    status: params.status,
    client_id: params.client_id,
    source_id: params.source_id,
    source_kind: params.source_kind,
    q: params.q,
    limit: 50,
  };

  let result: ListResponse<GrantSummary>;
  let approvals: ListResponse<PendingApproval>;
  let peekEnvelope: Awaited<ReturnType<typeof getGrantTimeline>> = null;
  try {
    [result, approvals] = await Promise.all([listGrants(filters), listPendingApprovals()]);
    if (params.peek) {
      peekEnvelope = await getGrantTimeline(params.peek);
    }
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="grants">
          <PageHeader title="Grants" />
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }

  const ownerLoginUrl = getOwnerLoginPath();
  const activeFilters = [
    params.status ? { label: "state", value: params.status } : null,
    params.q ? { label: "query", value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));
  const preHeader = (
    <>
      {params.approval_error ? (
        <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-2.5 shadow-[inset_3px_0_0_0_color-mix(in_oklab,var(--destructive)_60%,transparent)]">
          <span className="font-medium text-destructive">Approval error:</span> <span>{params.approval_error}</span>
        </div>
      ) : null}

      <Section
        description={approvals.data.length > 0 ? "Device-flow and consent requests waiting for the owner." : undefined}
        id="pending-approvals"
        title={`Pending approvals (${approvals.data.length})`}
      >
        {approvals.data.length === 0 ? (
          <EmptyState
            hint="Device-flow and consent requests appear here while waiting for owner approval."
            title="No pending approvals"
          />
        ) : (
          <>
            <DataList>
              {approvals.data.map((approval) => (
                <li key={approval.approval_id}>
                  <PendingApprovalRow approval={approval} />
                </li>
              ))}
            </DataList>
            <p className="pdpp-caption mt-2 text-muted-foreground">
              These dashboard shortcut buttons work in open local-dev mode. If placeholder owner auth is enabled, sign
              in at{" "}
              <a className="underline-offset-2 hover:underline" href={ownerLoginUrl}>
                owner access
              </a>{" "}
              and approve there instead.
            </p>
          </>
        )}
      </Section>
    </>
  );
  const viewParams: ListWithPeekParams<GrantSummary> = {
    active: "grants",
    activeFilterChips: activeFilters,
    buildListHref: (overrides) => listHref(params, overrides),
    description: "Issued authorizations and lifecycle decisions for client access to owner data.",
    emptyHint: "Grant artifacts appear after client/provider-connect consent flows issue or reject grants.",
    emptyTitle: "No grants yet",
    filters: {
      query: { name: "q", placeholder: "id contains…", defaultValue: params.q ?? "" },
      status: {
        name: "status",
        defaultValue: params.status ?? "",
        options: [
          { value: "issued", label: "issued" },
          { value: "revoked", label: "revoked" },
          { value: "denied", label: "denied" },
          { value: "failed", label: "failed" },
          { value: "pending", label: "pending" },
        ],
      },
    },
    headerActions: (
      <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/grants/request">
        Grant request workspace
      </Link>
    ),
    peekCliCommand: (id) => `pdpp ref grant timeline ${id}`,
    peekEnvelope,
    peekId: params.peek,
    preHeader,
    renderRow: (grant, { peeked, href }) => <GrantRow grant={grant} href={href} peeked={peeked} />,
    resetHref: "/dashboard/grants",
    result,
    routes: dashboardRoutes,
    rowKey: (grant) => grant.grant_id,
    subject: "grant",
    title: "Grants",
  };

  return (
    <DashboardShell active="grants">
      <ListWithPeekView params={viewParams} />
    </DashboardShell>
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
            <Timestamp value={approval.created_at} />
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
        <Button formAction={approvePendingApprovalAction} size="sm" type="submit">
          Approve
        </Button>
        <Button formAction={denyPendingApprovalAction} size="sm" type="submit" variant="destructive">
          Deny
        </Button>
      </form>
    </div>
  );
}

function GrantRow({ grant, href, peeked }: { grant: GrantSummary; href: string; peeked: boolean }) {
  const packageHref = grant.grant_package_id
    ? `/dashboard/grants/packages/${encodeURIComponent(grant.grant_package_id)}`
    : null;
  return (
    <div
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
    >
      <Link className="block" href={href} scroll={false}>
        {/* Lead with the source/client + decision; the raw grant id is demoted
            to a monospace lookup key on the detail line. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium text-foreground">{grantRowLabel(grant)}</span>
            <StatusBadge status={grant.status} />
            {grant.client_id ? (
              <span className="pdpp-caption truncate text-muted-foreground">client {grant.client_id}</span>
            ) : null}
          </div>
          <span className="pdpp-caption shrink-0 text-muted-foreground tabular-nums">
            <Timestamp value={grant.last_at} />
          </span>
        </div>
        <div className="pdpp-caption mt-0.5 flex flex-wrap items-center gap-x-2 text-muted-foreground">
          <code className="break-all font-mono">{grant.grant_id}</code>
          <span className="text-muted-foreground/50">·</span>
          <span className="tabular-nums">{grant.event_count} events</span>
          {grant.source ? (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span>source {formatSourceForDisplay(grant.source)}</span>
            </>
          ) : null}
        </div>
      </Link>
      {packageHref ? (
        <div className="pdpp-caption mt-1">
          <Link
            className="rounded border border-border px-2 py-0.5 text-muted-foreground hover:bg-muted/60"
            href={packageHref}
          >
            package {grant.grant_package_id} →
          </Link>
        </div>
      ) : null}
    </div>
  );
}
