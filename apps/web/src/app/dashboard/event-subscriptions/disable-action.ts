"use server";

/**
 * Server action for the operator-disable affordance on
 * `/dashboard/event-subscriptions`.
 *
 * The action re-verifies the owner session (per CVE-2025-29927 / Next.js
 * 2026 guidance, every Server Action must re-check its own gate), POSTs to
 * `/_ref/event-subscriptions/:id/disable` via the typed dashboard client,
 * and redirects back to the peek pane so the operator sees the now-disabled
 * status. The redirect target stays inside `/dashboard/event-subscriptions`
 * regardless of outcome.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { disableClientEventSubscription } from "../lib/ref-client.ts";

const PAGE_PATH = "/dashboard/event-subscriptions";
const MAX_REASON_BYTES = 256;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function clampReason(raw: string): string | null {
  if (!raw) {
    return null;
  }
  // Match the server-side cap so the operator sees the same error the
  // operation layer would have raised; truncation is intentional rather
  // than silent so the operator can shorten and retry.
  if (Buffer.byteLength(raw, "utf8") > MAX_REASON_BYTES) {
    return raw.slice(0, MAX_REASON_BYTES);
  }
  return raw;
}

function buildPeekHref(subscriptionId: string, error?: string): string {
  const params = new URLSearchParams({ peek: subscriptionId });
  if (error) {
    params.set("disable_error", error);
  }
  return `${PAGE_PATH}?${params.toString()}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Unexpected disable action failure";
}

export async function disableSubscriptionAction(formData: FormData): Promise<void> {
  const subscriptionId = asString(formData.get("subscription_id"));
  if (!subscriptionId) {
    redirect(PAGE_PATH);
  }

  await requireDashboardAccess(buildPeekHref(subscriptionId));

  const reason = clampReason(asString(formData.get("reason")));

  let error: string | undefined;
  try {
    await disableClientEventSubscription(subscriptionId, reason);
  } catch (err) {
    error = errorMessage(err);
  }

  redirect(buildPeekHref(subscriptionId, error));
}
