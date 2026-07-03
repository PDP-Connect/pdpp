"use server";

/**
 * Server action for the operator-disable affordance on
 * `/event-subscriptions`.
 *
 * The action re-verifies the owner session (per CVE-2025-29927 / Next.js
 * 2026 guidance, every Server Action must re-check its own gate), POSTs to
 * `/_ref/event-subscriptions/:id/disable` via the typed dashboard client,
 * and redirects back to the peek pane so the operator sees the now-disabled
 * status. The redirect target stays inside `/event-subscriptions`
 * regardless of outcome.
 *
 * Spec: openspec/changes/add-client-event-subscription-management/specs/
 *       reference-implementation-architecture/spec.md
 */

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { disableClientEventSubscription } from "../lib/ref-client.ts";

const PAGE_PATH = "/event-subscriptions";
const MAX_REASON_BYTES = 256;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function reasonOverflowMessage(): string {
  return `Reason exceeds ${MAX_REASON_BYTES} bytes UTF-8. Shorten and retry.`;
}

function validateReason(raw: string): { ok: true; value: string | null } | { ok: false; message: string } {
  if (!raw) {
    return { ok: true, value: null };
  }
  // The operation layer rejects reasons over 256 bytes UTF-8. Mirror that
  // here so the operator sees the same gate and the `_ref` call is not
  // wasted. Never truncate — silent truncation corrupts operator intent
  // (an `email-loop_suspected_…` reason that becomes `email-l…` is worse
  // than no reason at all).
  if (Buffer.byteLength(raw, "utf8") > MAX_REASON_BYTES) {
    return { ok: false, message: reasonOverflowMessage() };
  }
  return { ok: true, value: raw };
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

  // Confirmation is enforced server-side rather than via a client-only
  // confirm() dialog (which a scripted client or curl could bypass). The
  // form must POST `confirm_disable=yes`; anything else round-trips back
  // to the peek pane with a clear message and no `_ref` call.
  const confirm = asString(formData.get("confirm_disable"));
  if (confirm !== "yes") {
    redirect(buildPeekHref(subscriptionId, "Confirmation required: tick the box before submitting."));
  }

  const reasonResult = validateReason(asString(formData.get("reason")));
  if (!reasonResult.ok) {
    redirect(buildPeekHref(subscriptionId, reasonResult.message));
  }

  let error: string | undefined;
  try {
    await disableClientEventSubscription(subscriptionId, reasonResult.value);
  } catch (err) {
    error = errorMessage(err);
  }

  redirect(buildPeekHref(subscriptionId, error));
}
