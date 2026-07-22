"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import {
  deleteConnection,
  deleteConnectionSchedule,
  deleteConnectorSchedule,
  pauseConnectionSchedule,
  pauseConnectorSchedule,
  reactivateConnection,
  resumeConnectionSchedule,
  resumeConnectorSchedule,
  revokeConnection,
  runConnectionNow,
  runConnectorNow,
  saveConnectionSchedule,
  saveConnectorSchedule,
  setConnectionDisplayName,
} from "../../lib/operator-runs.ts";

// The store caps `display_name` at 200 chars; mirror that here so the
// operator gets a clear message instead of a backend 400.
const MAX_DISPLAY_NAME_LENGTH = 200;

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function connectorHref(connectorId: string, message?: string, error?: string) {
  const base = `/sources/${encodeURIComponent(connectorId)}`;
  const params = new URLSearchParams();
  if (message) {
    params.set("message", message);
  }
  if (error) {
    params.set("error", error);
  }
  const query = params.toString();
  return `${base}${query ? `?${query}` : ""}#operator-controls`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected connector operator action failure";
}

export async function runConnectorNowAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const connectionId = asString(formData.get("connection_id"));
  const force = asString(formData.get("force")) === "true";
  const routeId = connectionId || connectorId;
  await requireDashboardAccess(connectorHref(routeId));
  let message: string | undefined;
  let error: string | undefined;
  try {
    const runOptions = { force };
    const result = (await (connectionId
      ? runConnectionNow(connectionId, runOptions)
      : runConnectorNow(connectorId, runOptions))) as {
      run_id?: string;
      trace_id?: string;
    };
    message = result.run_id ? `Run started (${result.run_id})` : "Run started";
  } catch (err) {
    error = errorMessage(err);
  }
  redirect(connectorHref(routeId, message, error));
}

export type RenameConnectionResult = { ok: true; display_name: string } | { ok: false; message: string };

/**
 * Owner-rename a connection's `display_name`. Rename always targets a
 * concrete connection instance (`connection_id`), never a connector type —
 * a type-scoped rename is meaningless when multiple connections share a
 * connector. Returns a discriminated result so the client island can render
 * an inline toast and refresh in place (matching `runConnectorNowAction`),
 * rather than redirecting and losing the message.
 */
export async function renameConnectionAction(
  connectionId: string | null,
  displayName: string
): Promise<RenameConnectionResult> {
  await requireDashboardAccess(connectorHref(connectionId ?? ""));
  const trimmed = displayName.trim();
  if (!connectionId) {
    return { message: "This connector has no addressable connection to rename yet.", ok: false };
  }
  if (!trimmed) {
    return { message: "Enter a label before saving.", ok: false };
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    return { message: `Label is too long (max ${MAX_DISPLAY_NAME_LENGTH} characters).`, ok: false };
  }
  try {
    await setConnectionDisplayName(connectionId, trimmed);
    revalidatePath("/sources");
    revalidatePath(`/sources/${encodeURIComponent(connectionId)}`);
    return { display_name: trimmed, ok: true };
  } catch (err) {
    return { message: errorMessage(err), ok: false };
  }
}

export async function saveConnectorScheduleAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId || connectorId;
  await requireDashboardAccess(connectorHref(routeId));
  const every = asString(formData.get("every"));
  const jitter = asString(formData.get("jitter"));
  const enabled = formData.get("enabled") === "on";

  let message: string | undefined;
  let error: string | undefined;
  try {
    await (connectionId
      ? saveConnectionSchedule(connectionId, { enabled, every, jitter })
      : saveConnectorSchedule(connectorId, { enabled, every, jitter }));
    message = enabled ? "Schedule saved and enabled" : "Schedule saved as paused";
  } catch (err) {
    error = errorMessage(err);
  }
  redirect(connectorHref(routeId, message, error));
}

export async function pauseConnectorScheduleAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId || connectorId;
  await requireDashboardAccess(connectorHref(routeId));
  let message: string | undefined;
  let error: string | undefined;
  try {
    await (connectionId ? pauseConnectionSchedule(connectionId) : pauseConnectorSchedule(connectorId));
    message = "Schedule paused";
  } catch (err) {
    error = errorMessage(err);
  }
  redirect(connectorHref(routeId, message, error));
}

export async function resumeConnectorScheduleAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId || connectorId;
  await requireDashboardAccess(connectorHref(routeId));
  let message: string | undefined;
  let error: string | undefined;
  try {
    await (connectionId ? resumeConnectionSchedule(connectionId) : resumeConnectorSchedule(connectorId));
    message = "Schedule resumed";
  } catch (err) {
    error = errorMessage(err);
  }
  redirect(connectorHref(routeId, message, error));
}

export async function deleteConnectorScheduleAction(formData: FormData) {
  const connectorId = asString(formData.get("connector_id"));
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId || connectorId;
  await requireDashboardAccess(connectorHref(routeId));
  let message: string | undefined;
  let error: string | undefined;
  try {
    await (connectionId ? deleteConnectionSchedule(connectionId) : deleteConnectorSchedule(connectorId));
    message = "Schedule deleted";
  } catch (err) {
    error = errorMessage(err);
  }
  redirect(connectorHref(routeId, message, error));
}

// Danger-zone anchor on the connection detail page. The revoke/delete forms
// scroll here after a redirect so the operator lands on the result banner.
function dangerZoneHref(routeId: string, message?: string, error?: string): string {
  const base = `/sources/${encodeURIComponent(routeId)}`;
  const params = new URLSearchParams();
  if (message) {
    params.set("message", message);
  }
  if (error) {
    params.set("error", error);
  }
  const query = params.toString();
  return `${base}${query ? `?${query}` : ""}#danger-zone`;
}

function recordsListHref(message?: string, error?: string): string {
  const params = new URLSearchParams();
  if (message) {
    params.set("message", message);
  }
  if (error) {
    params.set("error", error);
  }
  const query = params.toString();
  return `/sources${query ? `?${query}` : ""}`;
}

/**
 * Owner-revoke a connection from the console. Re-verifies the owner session
 * (every Server Action must re-check its own gate), enforces the confirm
 * checkbox server-side (`confirm_revoke=yes`), then calls the shared
 * owner-session `/_ref` revoke route. Revoke is non-destructive of records: it
 * stops future collection while retaining records, grants, and audit. The
 * typed `already_revoked` outcome is messaged in place rather than thrown.
 * Revoke always targets a concrete `connection_id`; a type-only revoke is
 * meaningless when multiple connections share a connector.
 */
export async function revokeConnectionAction(formData: FormData) {
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId;
  await requireDashboardAccess(dangerZoneHref(routeId));
  if (!connectionId) {
    redirect(dangerZoneHref(routeId, undefined, "This connector has no addressable connection to revoke yet."));
  }
  const confirm = formData.get("confirm_revoke");
  if (typeof confirm !== "string" || confirm !== "yes") {
    redirect(dangerZoneHref(routeId, undefined, "Confirmation required: tick the box before revoking."));
  }

  let message: string | undefined;
  let error: string | undefined;
  try {
    const result = await revokeConnection(connectionId);
    message =
      result.status === "already_revoked"
        ? "This connection was already revoked. Future collection is stopped; its records are retained."
        : "Connection revoked. Future collection is stopped; already-collected records and grants are retained.";
  } catch (err) {
    error = errorMessage(err);
  }
  revalidatePath("/sources");
  revalidatePath(`/sources/${encodeURIComponent(routeId)}`);
  redirect(error ? dangerZoneHref(routeId, message, error) : recordsListHref(message));
}

/**
 * Owner-reactivate a revoked connection from the console. The clean inverse of
 * `revokeConnectionAction`: re-verifies the owner session, then calls the
 * shared owner-session `POST /_ref/connections/:id/reactivate` route. Flips
 * the connection back to active, clears `revoked_at`, resumes future
 * collection — all already-collected records, grants, schedule, and history
 * are preserved. Credential freshness is handled on the next collection run.
 *
 * The `not_revoked` typed outcome (connection was already active) is messaged
 * in place rather than thrown. On success, redirects to the connections list
 * with a data-preserving confirmation message.
 */
export async function reactivateConnectionAction(formData: FormData) {
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId;
  await requireDashboardAccess(recordsListHref());
  if (!connectionId) {
    redirect(recordsListHref(undefined, "This connection has no addressable id to reactivate."));
  }

  let message: string | undefined;
  let error: string | undefined;
  try {
    const result = await reactivateConnection(connectionId);
    if (result.status === "reactivated") {
      message = "Connection reactivated. Collection will resume on the next scheduled run.";
    } else if (result.status === "not_revoked") {
      message = "This connection was already active — no change was made.";
    } else {
      error = "Connection not found. It may have been deleted.";
    }
  } catch (err) {
    error = errorMessage(err);
  }

  revalidatePath("/sources");
  revalidatePath(`/sources/${encodeURIComponent(routeId)}`);
  redirect(error ? recordsListHref(message, error) : recordsListHref(message));
}

/**
 * Owner-delete a connection from the console. Re-verifies the owner session,
 * enforces the typed-confirmation ceremony server-side — the operator must
 * reproduce the connection id (`confirm_delete` must equal `connection_id`) —
 * then calls the shared owner-session `/_ref` delete route. Delete erases
 * exactly that connection's records/state per the shipped contract and refuses
 * an active run (`run_active`) or a default-account binding (`default_account`)
 * exactly as the shared primitive does; those typed refusals are messaged in
 * place. A scripted POST without the matching confirmation never erases data.
 */
export async function deleteConnectionAction(formData: FormData) {
  const connectionId = asString(formData.get("connection_id"));
  const routeId = connectionId;
  await requireDashboardAccess(dangerZoneHref(routeId));
  if (!connectionId) {
    redirect(dangerZoneHref(routeId, undefined, "This connector has no addressable connection to delete yet."));
  }
  // Server-enforced confirmation ceremony: the typed value must match the
  // connection id. A client-only check is not enough — a scripted request
  // without the matching field round-trips back with a banner and erases
  // nothing.
  const confirm = asString(formData.get("confirm_delete"));
  if (confirm !== connectionId) {
    redirect(
      dangerZoneHref(
        routeId,
        undefined,
        "Confirmation required: type the connection id exactly to confirm deletion. Nothing was erased."
      )
    );
  }

  let message: string | undefined;
  let error: string | undefined;
  let deleted = false;
  try {
    const result = await deleteConnection(connectionId);
    if (result.status === "deleted") {
      deleted = true;
      const count = result.deletedRecordCount;
      message =
        typeof count === "number"
          ? `Connection deleted. ${count.toLocaleString()} record${count === 1 ? "" : "s"} for this connection were erased.`
          : "Connection deleted. Its records for this connection were erased.";
    } else if (result.status === "run_active") {
      error = "A run is in flight for this connection. Cancel the run, then delete.";
    } else if (result.status === "default_account") {
      error = "This default-account connection can't be deleted from here. Revoke it to stop future collection.";
    } else {
      error = "Connection not found. It may have already been deleted.";
    }
  } catch (err) {
    error = errorMessage(err);
  }

  revalidatePath("/sources");
  // A successful delete removes the connection: send the operator back to the
  // connections list, where the deleted row is now absent. A refusal stays on
  // the detail page with the typed banner.
  if (deleted) {
    redirect(recordsListHref(message ?? "Connection deleted."));
  }
  redirect(dangerZoneHref(routeId, message, error));
}
