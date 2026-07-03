/**
 * Full-page detail route for a single client event subscription.
 *
 * Mobile entry point: on screens narrower than `xl` (1280 px) the list
 * page rows navigate here instead of opening the side-panel peek. Desktop
 * still uses the `?peek=` SplitLayout; this page is also deep-linkable
 * and a browser-back target for mobile users.
 *
 * Content mirrors the peek pane in the list page — same KV metadata, same
 * disable form, same recent-attempts list — but rendered full-width with a
 * back link to the list. The `disableSubscriptionDetailAction` server action
 * (defined in `./disable-action.ts`) redirects back to this page (not to
 * the list) so the operator sees the updated state after disabling.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import {
  Endorse,
  Eyebrow,
  IcButton,
  IcField,
  IcInput,
  IcTimestamp,
  KV,
  KVRow,
  Sheet,
  SheetBody,
  SheetHead,
  SheetSerial,
  SheetTitle,
  Typed,
  TypedSm,
} from "@pdpp/brand-react";
import { PageHeader } from "@pdpp/operator-ui/components/primitives";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { RecordroomShellWithPalette } from "@/app/(console)/components/recordroom-shell-with-palette.tsx";
import { ServerUnreachable } from "../../components/shell.tsx";
import { ReferenceServerUnreachableError } from "../../lib/owner-token.ts";
import {
  type ClientEventSubscriptionAttempt,
  type ClientEventSubscriptionDetail,
  type ClientEventSubscriptionStatus,
  getClientEventSubscription,
} from "../../lib/ref-client.ts";
import { disableSubscriptionDetailAction } from "./disable-action.ts";

export const dynamic = "force-dynamic";

// ─── Status helpers (mirrors list page) ──────────────────────────────────────

function subscriptionEndorseStatus(
  status: ClientEventSubscriptionStatus
): "active" | "expiring" | "denied" | "revoked" {
  switch (status) {
    case "active":
      return "active";
    case "pending_verification":
      return "expiring";
    case "disabled":
    case "disabled_failure":
    case "disabled_revoked":
      return "denied";
    case "deleted":
      return "revoked";
    default:
      return "revoked";
  }
}

function subscriptionEndorseLabel(status: ClientEventSubscriptionStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "pending_verification":
      return "pending verification";
    case "disabled":
      return "disabled";
    case "disabled_failure":
      return "disabled (failure)";
    case "disabled_revoked":
      return "disabled (revoked)";
    case "deleted":
      return "deleted";
    default:
      return status;
  }
}

// Statuses for which the operator-disable form is hidden because the
// subscription is already not delivering. Three of these four are
// recoverable by the bound client via PATCH { enabled: true }.
const HIDE_DISABLE_FORM_STATUSES = new Set<ClientEventSubscriptionStatus>([
  "disabled",
  "disabled_failure",
  "disabled_revoked",
  "deleted",
]);

// ─── Scope description ────────────────────────────────────────────────────────

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

// ─── Per-status copy for disabled subscriptions ───────────────────────────────

function DisabledNoticeCopy({
  status,
  subscriptionId,
}: {
  status: ClientEventSubscriptionStatus;
  subscriptionId: string;
}) {
  const clientReenablePatch = (
    <Typed as="code">
      PATCH /v1/event-subscriptions/{subscriptionId} {"{ enabled: true }"}
    </Typed>
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
        The bound grant has been revoked, so this subscription is not recoverable in place. The client&apos;s re-enable
        PATCH is rejected with <Typed as="code">409 grant_revoked</Typed>; the client would need to obtain a new grant
        and create a new subscription.
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

// ─── Disable form ─────────────────────────────────────────────────────────────

function DisableForm({ subscriptionId, disableError }: { subscriptionId: string; disableError: string }) {
  return (
    <form action={disableSubscriptionDetailAction} className="mt-4 flex flex-col gap-2">
      <input name="subscription_id" type="hidden" value={subscriptionId} />
      <IcField htmlFor={`reason-${subscriptionId}`} label="Reason (optional, max 256 bytes UTF-8)">
        <IcInput defaultValue="" id={`reason-${subscriptionId}`} name="reason" placeholder="loop_suspected" />
      </IcField>
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
      <IcButton size="sm" type="submit" variant="destructive">
        Disable subscription
      </IcButton>
    </form>
  );
}

// ─── Recent attempts ──────────────────────────────────────────────────────────

function RecentAttempts({ attempts }: { attempts: ClientEventSubscriptionAttempt[] }) {
  if (attempts.length === 0) {
    return <p className="pdpp-caption mt-4 text-muted-foreground">No delivery attempts recorded yet.</p>;
  }
  return (
    <div className="mt-5">
      <Eyebrow as="h3" className="mb-2">
        Recent attempts
      </Eyebrow>
      <ol className="pdpp-caption divide-y divide-border/70 border-border/70 border-y">
        {attempts.map((attempt) => (
          <li className="flex flex-wrap items-baseline justify-between gap-2 px-1 py-1.5" key={attempt.attempt_id}>
            <Typed as="span">
              {attempt.ok ? "ok" : "fail"} {attempt.status_code ?? "—"}
            </Typed>
            <span className="text-muted-foreground">{attempt.event_type}</span>
            <span className="text-muted-foreground tabular-nums">
              {attempt.latency_ms == null ? "—" : `${attempt.latency_ms}ms`}
            </span>
            <TypedSm className="text-muted-foreground">
              <IcTimestamp value={attempt.attempted_at} />
            </TypedSm>
            {attempt.error ? <span className="text-destructive">err: {attempt.error}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type PageSearchParams = Promise<{ disable_error?: string }>;

export default async function SubscriptionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ subscriptionId: string }>;
  searchParams: PageSearchParams;
}) {
  const { subscriptionId: raw } = await params;
  const subscriptionId = decodeURIComponent(raw);
  const { disable_error: disableError = "" } = await searchParams;

  let subscription: ClientEventSubscriptionDetail | null;
  try {
    subscription = await getClientEventSubscription(subscriptionId).catch((err) => {
      if (err instanceof ReferenceServerUnreachableError) {
        throw err;
      }
      return null;
    });
  } catch (err) {
    if (err instanceof ReferenceServerUnreachableError) {
      return (
        <RecordroomShellWithPalette>
          <PageHeader
            actions={
              <Link
                className="pdpp-caption text-muted-foreground underline-offset-2 hover:underline"
                href="/event-subscriptions"
              >
                ← Event subscriptions
              </Link>
            }
            title="Subscription"
          />
          <ServerUnreachable />
        </RecordroomShellWithPalette>
      );
    }
    throw err;
  }

  if (!subscription) {
    notFound();
  }

  const hideDisableForm = HIDE_DISABLE_FORM_STATUSES.has(subscription.status);

  return (
    <RecordroomShellWithPalette>
      <PageHeader
        actions={
          <Link
            className="pdpp-caption text-muted-foreground underline-offset-2 hover:underline"
            href="/event-subscriptions"
          >
            ← Event subscriptions
          </Link>
        }
        title="Subscription"
      />

      <Sheet>
        <SheetHead>
          <div className="flex flex-wrap items-baseline gap-2">
            <SheetTitle>
              <Typed as="code" className="break-all">
                {subscription.subscription_id}
              </Typed>
            </SheetTitle>
            <Endorse
              label={subscriptionEndorseLabel(subscription.status)}
              status={subscriptionEndorseStatus(subscription.status)}
            />
          </div>
          <p className="pdpp-caption mt-2 text-muted-foreground">
            grant{" "}
            <Link className="underline-offset-2 hover:underline" href={dashboardRoutes.grant(subscription.grant_id)}>
              <SheetSerial>{subscription.grant_id}</SheetSerial>
            </Link>{" "}
            · client <SheetSerial>{subscription.client_id}</SheetSerial>
          </p>
        </SheetHead>
        <SheetBody>
          <KV className="mb-4">
            <KVRow k="callback">
              <Typed as="code" className="break-all">
                {subscription.callback_url}
              </Typed>
            </KVRow>
            <KVRow k="created">
              <IcTimestamp value={subscription.created_at} />
            </KVRow>
            <KVRow k="updated">
              <IcTimestamp value={subscription.updated_at} />
            </KVRow>
            {subscription.disabled_at ? (
              <KVRow k="disabled">
                <IcTimestamp value={subscription.disabled_at} />
                {subscription.disabled_reason ? (
                  <>
                    {" "}
                    · <Typed as="code">{subscription.disabled_reason}</Typed>
                  </>
                ) : null}
              </KVRow>
            ) : null}
            <KVRow k="pending">{subscription.pending_queue_count}</KVRow>
            <KVRow k="final fail">{subscription.final_failure_count}</KVRow>
            <KVRow k="scope">{describeScope(subscription.scope)}</KVRow>
          </KV>

          {hideDisableForm ? (
            <DisabledNoticeCopy status={subscription.status} subscriptionId={subscription.subscription_id} />
          ) : (
            <DisableForm disableError={disableError} subscriptionId={subscription.subscription_id} />
          )}

          <RecentAttempts attempts={subscription.recent_attempts} />
        </SheetBody>
      </Sheet>
    </RecordroomShellWithPalette>
  );
}
