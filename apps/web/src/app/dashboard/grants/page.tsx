import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import { PeekEmpty, PeekPane, PeekTimeline, pivotsFromEnvelope } from "../components/peek.tsx";
import {
  DataList,
  FilterSummary,
  PageHeader,
  Pager,
  Section,
  SplitLayout,
  StatusBadge,
  Toolbar,
} from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { getOwnerLoginPath, ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type GrantSummary,
  getGrantTimeline,
  type ListResponse,
  listGrants,
  listPendingApprovals,
  type PendingApproval,
  type TimelineEnvelope,
} from "../lib/ref-client.ts";
import { approvePendingApprovalAction, denyPendingApprovalAction } from "./pending-actions.ts";

export const dynamic = "force-dynamic";

interface Params {
  approval_error?: string;
  client_id?: string;
  cursor?: string;
  peek?: string;
  source_id?: string;
  source_kind?: "connector" | "provider_native";
  q?: string;
  status?: string;
}

function renderGrantsPeek({
  peekId,
  peekEnvelope,
  closePeekHref,
  openPeekFullHref,
}: {
  peekId: string | undefined;
  peekEnvelope: TimelineEnvelope | null;
  closePeekHref: string;
  openPeekFullHref: string;
}) {
  if (!peekId) {
    return <PeekEmpty />;
  }
  if (!peekEnvelope) {
    return (
      <PeekPane closeHref={closePeekHref} openHref={openPeekFullHref} title={`grant ${peekId}`}>
        <p className="text-muted-foreground">Grant not found.</p>
      </PeekPane>
    );
  }
  return (
    <PeekPane
      cliCommand={`pdpp grant timeline ${peekId}`}
      closeHref={closePeekHref}
      openHref={openPeekFullHref}
      title={`grant ${peekId}`}
    >
      <Pivots currentKind="grant" envelope={peekEnvelope} />
      <div className="pdpp-caption mb-2 text-muted-foreground">{peekEnvelope.events.length} events</div>
      <PeekTimeline events={peekEnvelope.events} />
    </PeekPane>
  );
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
  let peekEnvelope: TimelineEnvelope | null = null;
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

  const closePeekHref = listHref(params, { peek: undefined });
  const openPeekFullHref = params.peek ? `/dashboard/grants/${encodeURIComponent(params.peek)}` : "";
  const ownerLoginUrl = getOwnerLoginPath();
  const activeFilters = [
    params.status ? { label: "state", value: params.status } : null,
    params.q ? { label: "query", value: params.q } : null,
  ].filter((item): item is { label: string; value: string } => Boolean(item));

  return (
    <DashboardShell active="grants">
      <PageHeader
        actions={
          <Link className={buttonVariants({ variant: "outline", size: "sm" })} href="/dashboard/grants/request">
            Grant request workspace
          </Link>
        }
        count={`${result.data.length}${result.has_more ? "+" : ""}`}
        description="Issued authorizations and lifecycle decisions for client access to owner data."
        title="Grants"
      />

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

      <Section title="All grants">
        <form method="get">
          <Toolbar>
            <label className="flex min-w-0 flex-col gap-1" htmlFor="grants-query">
              <span className="pdpp-eyebrow">Query</span>
              <Input
                className="w-64 font-mono"
                defaultValue={params.q ?? ""}
                id="grants-query"
                name="q"
                placeholder="id contains…"
                type="search"
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1" htmlFor="grants-status">
              <span className="pdpp-eyebrow">State</span>
              <Select defaultValue={params.status ?? ""} id="grants-status" name="status">
                <option value="">Any state</option>
                <option value="issued">issued</option>
                <option value="revoked">revoked</option>
                <option value="denied">denied</option>
                <option value="failed">failed</option>
                <option value="pending">pending</option>
              </Select>
            </label>
            <Button className="mt-5" size="sm" type="submit">
              Filter
            </Button>
          </Toolbar>
        </form>

        <FilterSummary items={activeFilters} resetHref="/dashboard/grants" />

        <SplitLayout
          main={
            <>
              {result.data.length === 0 ? (
                <EmptyState
                  hint="Grant artifacts appear after client/provider-connect consent flows issue or reject grants."
                  title="No grants yet"
                />
              ) : (
                <DataList>
                  {result.data.map((g) => (
                    <li key={g.grant_id}>
                      <GrantRow grant={g} params={params} />
                    </li>
                  ))}
                </DataList>
              )}
              {result.has_more && result.next_cursor && (
                <Pager next={listHref(params, { cursor: result.next_cursor })} />
              )}
            </>
          }
          peek={renderGrantsPeek({ peekId: params.peek, peekEnvelope, closePeekHref, openPeekFullHref })}
        />
      </Section>
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
            ? ` · source ${approval.grant_preview.source.kind}:${approval.grant_preview.source.id}`
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

function GrantRow({ grant, params }: { grant: GrantSummary; params: Params }) {
  const peeked = params.peek === grant.grant_id;
  return (
    <Link
      aria-current={peeked ? "true" : undefined}
      className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
      href={listHref(params, { peek: grant.grant_id })}
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
        {grant.source ? ` · source ${grant.source.kind}:${grant.source.id}` : ""}
      </div>
    </Link>
  );
}

function Pivots({ envelope, currentKind }: { envelope: TimelineEnvelope; currentKind: "trace" | "grant" | "run" }) {
  const pivots = pivotsFromEnvelope(envelope).filter((p) => p.kind !== currentKind);
  if (pivots.length === 0) {
    return null;
  }
  return (
    <div className="mb-3 flex flex-wrap gap-1">
      {pivots.map((p) => (
        <Link
          className="pdpp-eyebrow rounded border border-border px-2 py-0.5 hover:bg-muted/60"
          href={`/dashboard/${p.kind}s?peek=${encodeURIComponent(p.id)}`}
          key={`${p.kind}:${p.id}`}
        >
          {p.kind} {p.id} →
        </Link>
      ))}
    </div>
  );
}
