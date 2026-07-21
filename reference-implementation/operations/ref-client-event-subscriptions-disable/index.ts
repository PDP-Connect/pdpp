/**
 * Canonical `ref.client-event-subscriptions.disable` operation.
 *
 * Operator safety-valve disable for client event subscriptions. Mirrors
 * the client-initiated `PATCH /v1/event-subscriptions/:id { enabled:
 * false }` path but records `disabled_reason: "operator_disabled"` (or an
 * operator-supplied reason) so the audit trail distinguishes the two.
 *
 * Idempotent: invocations on subscriptions already in `disabled`,
 * `disabled_failure`, `disabled_revoked`, or `deleted` return the current
 * row without modification. This matches the spec scenario "Operator
 * disable on an already-disabled subscription".
 *
 * The reference does not add an operator re-enable path — the client must
 * affirm the recovery via `PATCH { enabled: true }`. See the design note
 * in openspec/changes/add-client-event-subscription-management/design.md
 * for the asymmetric-incentive rationale.
 *
 * Boundary rules: see the sibling
 * `ref-client-event-subscriptions-list/index.ts` header.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import type {
  ClientEventSubscriptionStore,
  SubscriptionRow,
} from "../as-client-event-subscriptions/index.ts";

const DEFAULT_DISABLED_REASON = "operator_disabled";
const MAX_DISABLED_REASON_BYTES = 256;

export class RefClientEventSubscriptionsDisableNotFoundError extends Error {
  readonly code = "not_found" as const;
  readonly status = 404 as const;
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} not found`);
    this.name = "RefClientEventSubscriptionsDisableNotFoundError";
  }
}

export class RefClientEventSubscriptionsDisableInvalidRequestError extends Error {
  readonly code = "invalid_request" as const;
  readonly status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "RefClientEventSubscriptionsDisableInvalidRequestError";
  }
}

export interface RefClientEventSubscriptionsDisableInput {
  readonly subscriptionId: string;
  readonly reason?: string | null;
}

export interface RefClientEventSubscriptionsDisableDependencies {
  readonly store: ClientEventSubscriptionStore;
  readonly nowIso: () => string;
}

export interface RefClientEventSubscriptionsDisableOutput {
  readonly subscriptionId: string;
  readonly status: SubscriptionRow["status"];
  readonly disabledReason: string | null;
  readonly disabledAt: string | null;
  readonly wasAlreadyDisabled: boolean;
}

function validateReason(reason: string | null | undefined): string | null {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== "string") {
    throw new RefClientEventSubscriptionsDisableInvalidRequestError("reason must be a string");
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_DISABLED_REASON_BYTES) {
    throw new RefClientEventSubscriptionsDisableInvalidRequestError(
      `reason exceeds ${MAX_DISABLED_REASON_BYTES} bytes`,
    );
  }
  return trimmed;
}

export async function executeRefClientEventSubscriptionsDisable(
  input: RefClientEventSubscriptionsDisableInput,
  dependencies: RefClientEventSubscriptionsDisableDependencies,
): Promise<RefClientEventSubscriptionsDisableOutput> {
  const row = await dependencies.store.getSubscriptionById(input.subscriptionId);
  if (!row || row.status === "deleted") {
    throw new RefClientEventSubscriptionsDisableNotFoundError(input.subscriptionId);
  }
  if (
    row.status === "disabled" ||
    row.status === "disabled_failure" ||
    row.status === "disabled_revoked"
  ) {
    return {
      subscriptionId: row.subscription_id,
      status: row.status,
      disabledReason: row.disabled_reason,
      disabledAt: row.disabled_at,
      wasAlreadyDisabled: true,
    };
  }
  const reason = validateReason(input.reason) ?? DEFAULT_DISABLED_REASON;
  const now = dependencies.nowIso();
  await dependencies.store.updateStatus(row.subscription_id, "disabled", now, now, reason);
  await dependencies.store.dropQueuedForSubscription(row.subscription_id);
  return {
    subscriptionId: row.subscription_id,
    status: "disabled",
    disabledReason: reason,
    disabledAt: now,
    wasAlreadyDisabled: false,
  };
}
