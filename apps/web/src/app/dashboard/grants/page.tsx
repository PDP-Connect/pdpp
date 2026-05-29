import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { DataList, PageHeader, Section, StatusBadge } from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { type ListWithPeekParams, ListWithPeekView } from "../components/views/list-with-peek.tsx";
import { dashboardRoutes } from "../components/views/routes.ts";
import { formatSourceForDisplay } from "../lib/connector-display.ts";
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
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
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
        <div className="pdpp-caption mb-6 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5">
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
    ? approval.grant_preview.streams
        .map((stream) => (typeof stream === "string" ? stream : stream?.name || ""))
        .filter(Boolean)
    : [];

  return (
    <div className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
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
          {approval.grant_preview?.source
            ? ` · source ${formatSourceForDisplay(approval.grant_preview.source)}`
            : ""}
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
  return (
    <Link
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      href={href}
      scroll={false}
    >
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
        {grant.source ? ` · source ${formatSourceForDisplay(grant.source)}` : ""}
      </div>
    </Link>
  );
}
