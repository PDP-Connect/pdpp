"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import {
  type AcknowledgeConnectionLossInput,
  acknowledgeConnectionLoss,
  type ConfirmCoverageHorizonInput,
  confirmCoverageHorizon,
} from "../../lib/operator-runs.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected connection confirmation action failure";
}

function confirmationHref(routeId: string, message?: string, error?: string): string {
  const base = `/sources/${encodeURIComponent(routeId)}`;
  const params = new URLSearchParams();
  if (message) {
    params.set("message", message);
  }
  if (error) {
    params.set("error", error);
  }
  const query = params.toString();
  return `${base}${query ? `?${query}` : ""}#coverage-confirmation`;
}

/**
 * Owner-confirm a coverage horizon from the connection detail page. Collects
 * owner-entered evidence (basis, reason, earliest_available) and calls the
 * canonical route. This does not pause, revoke, or change the connection's
 * status, never rewrites or deletes retained records, and does not narrow the
 * coverage denominator. The form supplies only the evidence fields the
 * route's closed vocabularies accept; the actor is the authenticated owner
 * session, never a form field.
 */
export async function confirmCoverageHorizonAction(formData: FormData): Promise<void> {
  const connectionId = asString(formData.get("connection_id"));
  await requireDashboardAccess(confirmationHref(connectionId));
  if (!connectionId) {
    redirect(confirmationHref(connectionId, undefined, "This connection has no addressable id to confirm."));
  }

  const basis = asString(formData.get("basis")) as ConfirmCoverageHorizonInput["basis"];
  const reason = asString(formData.get("reason")) as ConfirmCoverageHorizonInput["reason"];
  const stream = asString(formData.get("stream"));
  const earliestAvailable = asString(formData.get("earliest_available"));
  const note = asString(formData.get("note"));

  let message: string | undefined;
  let error: string | undefined;
  try {
    await confirmCoverageHorizon(connectionId, {
      basis,
      earliest_available: earliestAvailable || null,
      ...(note ? { note } : {}),
      reason,
      stream: stream || null,
    });
    message = "Coverage boundary confirmed. This records disclosure only — nothing retained changes.";
  } catch (err) {
    error = errorMessage(err);
  }

  revalidatePath(`/sources/${encodeURIComponent(connectionId)}`);
  redirect(confirmationHref(connectionId, message, error));
}

/**
 * Owner-acknowledge a permanent, externally-caused data loss from the
 * connection detail page. Collects owner-entered confirmation (cause, scope,
 * name) and calls the canonical route. Does not pause, revoke, delete, or
 * retry anything: the source keeps collecting anything still reachable.
 */
export async function acknowledgeConnectionLossAction(formData: FormData): Promise<void> {
  const connectionId = asString(formData.get("connection_id"));
  await requireDashboardAccess(confirmationHref(connectionId));
  if (!connectionId) {
    redirect(confirmationHref(connectionId, undefined, "This connection has no addressable id to acknowledge."));
  }

  const cause = asString(formData.get("cause")) as AcknowledgeConnectionLossInput["cause"];
  const scope = asString(formData.get("scope")) as AcknowledgeConnectionLossInput["scope"];
  const acknowledgedBy = asString(formData.get("acknowledged_by"));
  const stream = asString(formData.get("stream"));
  const note = asString(formData.get("note"));

  if (!acknowledgedBy) {
    redirect(confirmationHref(connectionId, undefined, "Enter your name to confirm this acknowledgement."));
  }

  let message: string | undefined;
  let error: string | undefined;
  try {
    await acknowledgeConnectionLoss(connectionId, acknowledgedBy, {
      cause,
      ...(note ? { note } : {}),
      scope,
      ...(stream ? { streams: [stream] } : {}),
    });
    message = "Loss acknowledged. This does not recover the data — it records that you've seen and accepted it.";
  } catch (err) {
    error = errorMessage(err);
  }

  revalidatePath(`/sources/${encodeURIComponent(connectionId)}`);
  redirect(confirmationHref(connectionId, message, error));
}
