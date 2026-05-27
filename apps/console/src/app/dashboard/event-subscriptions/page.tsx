/**
 * Operator oversight surface for client event subscriptions.
 *
 * List + peek view backed by the `_ref/event-subscriptions*` routes. The
 * page renders the operator projection only — never the subscription
 * secret. The peek pane includes a single confirmed Disable affordance
 * that posts to a server action; there is no operator-create, re-enable,
 * rotate, or replay surface on purpose. The bound grant retains all
 * lifecycle authority.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Select } from "@/components/ui/select.tsx";
import { Timestamp } from "@/components/ui/timestamp.tsx";
import {
  DataList,
  FilterSummary,
  PageHeader,
  Section,
  SplitLayout,
  StatusBadge,
  Toolbar,
  ToolbarField,
} from "../components/primitives.tsx";
import { DashboardShell, EmptyState, ServerUnreachable } from "../components/shell.tsx";
import { dashboardRoutes } from "../components/views/routes.ts";
import { ReferenceServerUnreachableError } from "../lib/owner-token.ts";
import {
  type ClientEventSubscriptionAttempt,
  type ClientEventSubscriptionDetail,
  type ClientEventSubscriptionStatus,
  type ClientEventSubscriptionSummary,
  getClientEventSubscription,
  listClientEventSubscriptions,
} from "../lib/ref-client.ts";
import { disableSubscriptionAction } from "./disable-action.ts";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Client event subscriptions",
};

// Mirrors the SubscriptionStatus union on the server. Kept in one place so
// the row badge tone and the status filter options stay in lockstep.
const SUBSCRIPTION_STATUS_VOCABULARY = {
  active: { label: "active", tone: "success" },
  pending_verification: { label: "pending verification", tone: "warning" },
  disabled: { label: "disabled", tone: "danger" },
  disabled_failure: { label: "disabled · failure", tone: "danger" },
  disabled_revoked: { label: "disabled · revoked", tone: "danger" },
  deleted: { label: "deleted", tone: "neutral" },
} as const;

const STATUS_FILTER_OPTIONS: { label: string; value: ClientEventSubscriptionStatus }[] = [
  { label: "active", value: "active" },
  { label: "pending verification", value: "pending_verification" },
  { label: "disabled", value: "disabled" },
  { label: "disabled · failure", value: "disabled_failure" },
  { label: "disabled · revoked", value: "disabled_revoked" },
];

// Statuses for which the operator-disable form is hidden because the
// subscription is already not delivering. The set is a UI condition, not
// a lifecycle concept — three of these four statuses are recoverable by
// the bound client, and `DisabledNoticeCopy` below splits the copy per
// status to reflect the real state machine:
//
//   - `disabled`         — client may re-enable via PATCH { enabled: true }
//   - `disabled_failure` — same client re-enable path; cause was delivery
//                          failure rather than a client/operator disable
//   - `disabled_revoked` — grant was revoked; the client's re-enable PATCH
//                          is rejected with 409 grant_revoked; the only
//                          recovery is a new grant
//   - `deleted`          — soft-deleted; not recoverable
//
// Source of truth for those transitions lives in
// `reference-implementation/operations/as-client-event-subscriptions/`.
const HIDE_DISABLE_FORM_STATUSES = new Set<ClientEventSubscriptionStatus>([
  "disabled",
  "disabled_failure",
  "disabled_revoked",
  "deleted",
]);

interface PageParams {
  client_id?: string;
  disable_error?: string;
  grant_id?: string;
  peek?: string;
  status?: string;
}

interface ResolvedParams {
  clientId: string;
  disableError: string;
  grantId: string;
  peekId: string;
  status: string;
}

function resolveParams(params: PageParams): ResolvedParams {
  return {
    clientId: (params.client_id ?? "").trim(),
    disableError: (params.disable_error ?? "").trim(),
    grantId: (params.grant_id ?? "").trim(),
    peekId: (params.peek ?? "").trim(),
    status: (params.status ?? "").trim(),
  };
}

function buildListHref(params: ResolvedParams, overrides: Record<string, string | undefined> = {}): string {
  const search = new URLSearchParams();
  const setOrInherit = (key: string, inherited: string) => {
    if (key in overrides) {
      const v = overrides[key];
      if (v && v.length > 0) {
        search.set(key, v);
      }
    } else if (inherited) {
      search.set(key, inherited);
    }
  };
  setOrInherit("client_id", params.clientId);
  setOrInherit("grant_id", params.grantId);
  setOrInherit("status", params.status);
  setOrInherit("peek", params.peekId);
  const qs = search.toString();
  return qs ? `/dashboard/event-subscriptions?${qs}` : "/dashboard/event-subscriptions";
}

function activeFilterChips(params: ResolvedParams): { label: string; value: string }[] {
  const chips: { label: string; value: string }[] = [];
  if (params.clientId) {
    chips.push({ label: "client", value: params.clientId });
  }
  if (params.grantId) {
    chips.push({ label: "grant", value: params.grantId });
  }
  if (params.status) {
    chips.push({ label: "status", value: params.status });
  }
  return chips;
}

function renderPeek({
  disableError,
  peek,
  peekId,
}: {
  disableError: string;
  peek: ClientEventSubscriptionDetail | null;
  peekId: string;
}): ReactNode {
  if (!peekId) {
    return (
      <Section title="Peek a subscription">
        <p className="pdpp-body text-muted-foreground">
          Select a row to inspect callback host, recent delivery attempts, and the operator disable affordance.
        </p>
      </Section>
    );
  }
  if (!peek) {
    return (
      <Section title="Subscription not found">
        <p className="pdpp-body text-muted-foreground">
          Subscription <code className="pdpp-caption font-mono">{peekId}</code> was deleted or never existed.
        </p>
        <p className="pdpp-body mt-3">
          <Link className="underline-offset-2 hover:underline" href="/dashboard/event-subscriptions">
            ← back to list
          </Link>
        </p>
      </Section>
    );
  }
  return <PeekPane disableError={disableError} subscription={peek} />;
}

export default async function EventSubscriptionsPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = resolveParams(await searchParams);

  try {
    const list = await listClientEventSubscriptions({
      client_id: params.clientId || undefined,
      grant_id: params.grantId || undefined,
      status: params.status || undefined,
    });

    const peek = params.peekId
      ? await getClientEventSubscription(params.peekId).catch((err) => {
          // Don't fail the whole page if the peek target is gone — render the
          // list with a PeekMissing state instead.
          if (err instanceof ReferenceServerUnreachableError) {
            throw err;
          }
          return null;
        })
      : null;

    return (
      <DashboardShell active="event-subscriptions">
        <PageHeader
          count={`${list.data.length}`}
          description="Webhook-style event subscriptions registered by clients against owner-issued grants. Operator surface is read-only with one safety-valve disable; rotate and replay remain client-owned."
          title="Client event subscriptions"
        />

        <FiltersForm params={params} />
        <FilterSummary items={activeFilterChips(params)} resetHref="/dashboard/event-subscriptions" />

        <SplitLayout
          main={
            list.data.length === 0 ? (
              <EmptyState
                hint="A subscription appears once a client posts to /v1/event-subscriptions against an owner-issued grant."
                title="No subscriptions match these filters"
              />
            ) : (
              <DataList ariaLabel="Client event subscriptions">
                {list.data.map((sub) => (
                  <SubscriptionRow
                    href={buildListHref(params, { peek: sub.subscription_id })}
                    key={sub.subscription_id}
                    peeked={sub.subscription_id === params.peekId}
                    subscription={sub}
                  />
                ))}
              </DataList>
            )
          }
          peek={renderPeek({ disableError: params.disableError, peek, peekId: params.peekId })}
        />
      </DashboardShell>
    );
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <DashboardShell active="event-subscriptions">
          <ServerUnreachable />
        </DashboardShell>
      );
    }
    throw err;
  }
}

function FiltersForm({ params }: { params: ResolvedParams }) {
  return (
    <form action="/dashboard/event-subscriptions" className="mb-3" method="get">
      {/* Preserve the active peek across filter submits so the operator
          can keep a row open while narrowing the surrounding list. */}
      {params.peekId ? <input name="peek" type="hidden" value={params.peekId} /> : null}
      <Toolbar>
        <ToolbarField label="client_id" width="min-w-[12rem]">
          <Input defaultValue={params.clientId} name="client_id" placeholder="cli_…" />
        </ToolbarField>
        <ToolbarField label="grant_id" width="min-w-[12rem]">
          <Input defaultValue={params.grantId} name="grant_id" placeholder="grt_…" />
        </ToolbarField>
        <ToolbarField label="status" width="min-w-[10rem]">
          <Select defaultValue={params.status} name="status">
            <option value="">any</option>
            {STATUS_FILTER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <Button className="mt-5" size="sm" type="submit">
          Filter
        </Button>
      </Toolbar>
    </form>
  );
}

function SubscriptionRow({
  subscription,
  href,
  peeked,
}: {
  subscription: ClientEventSubscriptionSummary;
  href: string;
  peeked: boolean;
}) {
  return (
    <li>
      <Link
        aria-current={peeked ? "true" : undefined}
        className={`block px-3 py-2.5 transition-colors ${peeked ? "bg-muted" : "hover:bg-muted/40"}`}
        href={href}
        scroll={false}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <code className="pdpp-caption break-all font-medium font-mono text-foreground">
            {subscription.subscription_id}
          </code>
          <div className="flex items-center gap-2">
            <StatusBadge status={subscription.status} vocabulary={SUBSCRIPTION_STATUS_VOCABULARY} />
            <span className="pdpp-caption text-muted-foreground">
              <Timestamp value={subscription.updated_at} />
            </span>
          </div>
        </div>
        <div className="pdpp-caption mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
          <span>
            client <code className="font-mono">{subscription.client_id}</code>
          </span>
          <span>
            grant <code className="font-mono">{subscription.grant_id}</code>
          </span>
          <span>callback {subscription.callback_host}</span>
          <span>pending {subscription.pending_queue_count}</span>
          <span>failed {subscription.final_failure_count}</span>
          <LastAttemptCell subscription={subscription} />
        </div>
      </Link>
    </li>
  );
}

function LastAttemptCell({ subscription }: { subscription: ClientEventSubscriptionSummary }) {
  if (!subscription.last_attempted_at) {
    return <span>no attempts yet</span>;
  }
  const okLabel = subscription.last_attempt_ok ? "ok" : "fail";
  const code = subscription.last_attempt_status_code ?? "—";
  return (
    <span>
      last attempt {okLabel} {code} · <Timestamp value={subscription.last_attempted_at} />
    </span>
  );
}

function PeekPane({
  subscription,
  disableError,
}: {
  subscription: ClientEventSubscriptionDetail;
  disableError: string;
}) {
  const hideDisableForm = HIDE_DISABLE_FORM_STATUSES.has(subscription.status);
  return (
    <Section
      description={
        <span>
          grant{" "}
          <Link className="underline-offset-2 hover:underline" href={dashboardRoutes.grant(subscription.grant_id)}>
            <code className="font-mono">{subscription.grant_id}</code>
          </Link>{" "}
          · client <code className="font-mono">{subscription.client_id}</code>
        </span>
      }
      title={
        <span className="flex flex-wrap items-baseline gap-2">
          <code className="pdpp-body break-all font-mono text-foreground">{subscription.subscription_id}</code>
          <StatusBadge status={subscription.status} vocabulary={SUBSCRIPTION_STATUS_VOCABULARY} />
        </span>
      }
    >
      <dl className="pdpp-caption grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-muted-foreground">
        <DefRow label="callback">
          <code className="break-all font-mono text-foreground">{subscription.callback_url}</code>
        </DefRow>
        <DefRow label="created">
          <Timestamp value={subscription.created_at} />
        </DefRow>
        <DefRow label="updated">
          <Timestamp value={subscription.updated_at} />
        </DefRow>
        {subscription.disabled_at ? (
          <DefRow label="disabled">
            <Timestamp value={subscription.disabled_at} />
            {subscription.disabled_reason ? (
              <>
                {" "}
                <span>· reason {subscription.disabled_reason}</span>
              </>
            ) : null}
          </DefRow>
        ) : null}
        <DefRow label="pending">{subscription.pending_queue_count}</DefRow>
        <DefRow label="final fail">{subscription.final_failure_count}</DefRow>
        <DefRow label="scope">{describeScope(subscription.scope)}</DefRow>
      </dl>

      {hideDisableForm ? (
        <DisabledNoticeCopy status={subscription.status} subscriptionId={subscription.subscription_id} />
      ) : (
        <DisableForm disableError={disableError} subscriptionId={subscription.subscription_id} />
      )}

      <RecentAttempts attempts={subscription.recent_attempts} />
    </Section>
  );
}

// Per-status copy for the "Disable form is hidden because the row is
// already not delivering" notice. Three of the four statuses are
// recoverable by the bound client; one (`disabled_revoked`) is not, and
// `deleted` is not recoverable at all. See the operations layer in
// `reference-implementation/operations/as-client-event-subscriptions/`
// for the real transitions.
function DisabledNoticeCopy({
  status,
  subscriptionId,
}: {
  status: ClientEventSubscriptionStatus;
  subscriptionId: string;
}) {
  const clientReenablePatch = (
    <code className="font-mono">
      PATCH /v1/event-subscriptions/{subscriptionId} {"{ enabled: true }"}
    </code>
  );
  if (status === "disabled") {
    return (
      <p className="pdpp-caption mt-4 text-muted-foreground">
        This subscription is already disabled. The bound client can re-enable it by sending {clientReenablePatch} from
        its own credentials.
      </p>
    );
  }
  if (status === "disabled_failure") {
    return (
      <p className="pdpp-caption mt-4 text-muted-foreground">
        This subscription was disabled by the delivery worker after repeated failures. The bound client can re-enable it
        once the callback is healthy by sending {clientReenablePatch} from its own credentials.
      </p>
    );
  }
  if (status === "disabled_revoked") {
    return (
      <p className="pdpp-caption mt-4 text-muted-foreground">
        The bound grant has been revoked, so this subscription is not recoverable in place. The client's re-enable PATCH
        is rejected with <code className="font-mono">409 grant_revoked</code>; the client would need to obtain a new
        grant and create a new subscription.
      </p>
    );
  }
  // status === "deleted"
  return (
    <p className="pdpp-caption mt-4 text-muted-foreground">
      This subscription has been deleted and cannot be re-enabled. The client would need to create a new subscription
      against an active grant.
    </p>
  );
}

function DefRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="pdpp-eyebrow self-start">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function DisableForm({ subscriptionId, disableError }: { subscriptionId: string; disableError: string }) {
  // The Disable affordance is intentionally a server-rendered two-input
  // form: a `confirm_disable` checkbox the operator must tick and the
  // submit button. The server action rejects submits that are missing
  // the checkbox, so the confirmation is enforced server-side rather than
  // through a client-only `confirm()` dialog (per spec scenario "An
  // operator opens the peek pane and disables a subscription").
  return (
    <form action={disableSubscriptionAction} className="mt-4 flex flex-col gap-2">
      <input name="subscription_id" type="hidden" value={subscriptionId} />
      <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground" htmlFor={`reason-${subscriptionId}`}>
        <span>reason (optional, max 256 bytes UTF-8)</span>
        <Input defaultValue="" id={`reason-${subscriptionId}`} name="reason" placeholder="loop_suspected" />
      </label>
      <label
        className="pdpp-caption mt-1 flex items-center gap-2 text-muted-foreground"
        htmlFor={`confirm-${subscriptionId}`}
      >
        <input id={`confirm-${subscriptionId}`} name="confirm_disable" required type="checkbox" value="yes" />
        <span>
          I understand this stops deliveries for the subscription. The bound grant stays active and the client may
          re-enable.
        </span>
      </label>
      {disableError ? (
        <p className="pdpp-caption text-destructive" role="alert">
          {disableError}
        </p>
      ) : null}
      <Button size="sm" type="submit" variant="destructive">
        Disable subscription
      </Button>
    </form>
  );
}

function RecentAttempts({ attempts }: { attempts: ClientEventSubscriptionAttempt[] }) {
  if (attempts.length === 0) {
    return <p className="pdpp-caption mt-4 text-muted-foreground">No delivery attempts recorded yet.</p>;
  }
  return (
    <div className="mt-5">
      <h3 className="pdpp-eyebrow mb-2">Recent attempts</h3>
      <ol className="pdpp-caption divide-y divide-border/70 border-border/70 border-y">
        {attempts.map((attempt) => (
          <li className="flex flex-wrap items-baseline justify-between gap-2 px-1 py-1.5" key={attempt.attempt_id}>
            <span className="font-mono">
              {attempt.ok ? "ok" : "fail"} {attempt.status_code ?? "—"}
            </span>
            <span className="text-muted-foreground">{attempt.event_type}</span>
            <span className="text-muted-foreground tabular-nums">
              {attempt.latency_ms == null ? "—" : `${attempt.latency_ms}ms`}
            </span>
            <span className="text-muted-foreground">
              <Timestamp value={attempt.attempted_at} />
            </span>
            {attempt.error ? <span className="text-destructive">err: {attempt.error}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function describeScope(scope: ClientEventSubscriptionDetail["scope"]): ReactNode {
  if (!scope) {
    return "—";
  }
  const streams = Array.isArray(scope.streams)
    ? scope.streams.map((s) => s?.name).filter((n): n is string => typeof n === "string" && n.length > 0)
    : [];
  if (streams.length === 0) {
    return "—";
  }
  return <span>streams {streams.join(", ")}</span>;
}
