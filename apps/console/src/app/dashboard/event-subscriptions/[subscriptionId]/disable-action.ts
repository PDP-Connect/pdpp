"use server";

/**
 * Server action for the operator-disable affordance on the full-page
 * detail route `/dashboard/event-subscriptions/[subscriptionId]`.
 *
 * Identical gate and validation logic to the list-page action; the only
 * difference is the redirect target — this action returns to the detail
 * page rather than the `?peek=` list URL so mobile users land back on
 * the detail page they came from.
 *
 * Spec: openspec/changes/add-client-event-subscription-management
 */

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import { disableClientEventSubscription } from "../../lib/ref-client.ts";

const MAX_REASON_BYTES = 256;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildDetailHref(subscriptionId: string, error?: string): string {
  const base = `/dashboard/event-subscriptions/${encodeURIComponent(subscriptionId)}`;
  if (error) {
    return `${base}?${new URLSearchParams({ disable_error: error }).toString()}`;
  }
  return base;
}

export async function disableSubscriptionDetailAction(formData: FormData): Promise<void> {
  const subscriptionId = asString(formData.get("subscription_id"));
  if (!subscriptionId) {
    redirect("/dashboard/event-subscriptions");
  }

  await requireDashboardAccess(buildDetailHref(subscriptionId));

  const confirm = asString(formData.get("confirm_disable"));
  if (confirm !== "yes") {
    redirect(buildDetailHref(subscriptionId, "Confirmation required: tick the box before submitting."));
  }

  const raw = asString(formData.get("reason"));
  if (raw && Buffer.byteLength(raw, "utf8") > MAX_REASON_BYTES) {
    redirect(buildDetailHref(subscriptionId, `Reason exceeds ${MAX_REASON_BYTES} bytes UTF-8. Shorten and retry.`));
  }

  const reason = raw || null;
  let error: string | undefined;
  try {
    await disableClientEventSubscription(subscriptionId, reason);
  } catch (err) {
    error = err instanceof Error && err.message ? err.message : "Unexpected disable action failure";
  }

  redirect(buildDetailHref(subscriptionId, error));
}
