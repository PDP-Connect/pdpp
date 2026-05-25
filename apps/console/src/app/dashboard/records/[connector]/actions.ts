"use server";

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import {
  deleteConnectionSchedule,
  deleteConnectorSchedule,
  pauseConnectionSchedule,
  pauseConnectorSchedule,
  resumeConnectionSchedule,
  resumeConnectorSchedule,
  runConnectionNow,
  runConnectorNow,
  saveConnectionSchedule,
  saveConnectorSchedule,
} from "../../lib/operator-runs.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function connectorHref(connectorId: string, message?: string, error?: string) {
  const base = `/dashboard/records/${encodeURIComponent(connectorId)}`;
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
  const routeId = connectionId || connectorId;
  await requireDashboardAccess(connectorHref(routeId));
  let message: string | undefined;
  let error: string | undefined;
  try {
    const result = (await (connectionId ? runConnectionNow(connectionId) : runConnectorNow(connectorId))) as {
      run_id?: string;
      trace_id?: string;
    };
    message = result.run_id ? `Run started (${result.run_id})` : "Run started";
  } catch (err) {
    error = errorMessage(err);
  }
  redirect(connectorHref(routeId, message, error));
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
      ? saveConnectionSchedule(connectionId, { every, jitter, enabled })
      : saveConnectorSchedule(connectorId, { every, jitter, enabled }));
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
