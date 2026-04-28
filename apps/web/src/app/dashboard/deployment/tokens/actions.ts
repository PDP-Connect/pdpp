"use server";

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import {
  approveOwnerBootstrapFlow,
  denyOwnerBootstrapFlow,
  exchangeOwnerBootstrapToken,
  introspectOwnerBootstrapToken,
  setOwnerBootstrapFlowError,
  startOwnerBootstrapFlow,
} from "../../lib/operator-bootstrap.ts";
import { getAsInternalUrl, withOwnerSessionCookie } from "../../lib/owner-token.ts";

const DEFAULT_SUBJECT_ID = process.env.PDPP_OWNER_SUBJECT_ID || "owner_local";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function flowHref(flowId: string): string {
  return `/dashboard/deployment/tokens?flow=${encodeURIComponent(flowId)}`;
}

function errorHref(message: string): string {
  return `/dashboard/deployment/tokens?error=${encodeURIComponent(message)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected operator action failure";
}

export async function startOwnerTokenFlowAction(formData: FormData) {
  await requireDashboardAccess("/dashboard/deployment/tokens");
  const name = asString(formData.get("name"));
  let target: string;
  try {
    const flow = await startOwnerBootstrapFlow(undefined, name);
    target = flowHref(flow.flowId);
  } catch (err) {
    target = errorHref(errorMessage(err));
  }
  redirect(target);
}

/**
 * Operator-shaped composite action: start → approve → exchange in one click,
 * landing the user on a flow page with the bearer issued and visible. The
 * per-step actions below stay exported so the inspector disclosure can replay
 * the device flow step-by-step for an evaluator who wants to see the wire.
 */
export async function issueOwnerTokenAction(formData: FormData) {
  await requireDashboardAccess("/dashboard/deployment/tokens");
  // The form deliberately doesn't expose client_id — per-token DCR registers a
  // fresh public client for every credential. The Name is operator-supplied
  // dashboard metadata; subject is fixed by the operator's session.
  const name = asString(formData.get("name"));
  const subjectId = DEFAULT_SUBJECT_ID;
  if (!name) {
    redirect(errorHref("Token name is required"));
  }
  let target: string;
  try {
    const flow = await startOwnerBootstrapFlow(undefined, name);
    try {
      await approveOwnerBootstrapFlow(flow.flowId, subjectId);
      await exchangeOwnerBootstrapToken(flow.flowId);
    } catch (err) {
      setOwnerBootstrapFlowError(flow.flowId, errorMessage(err));
    }
    target = flowHref(flow.flowId);
  } catch (err) {
    target = errorHref(errorMessage(err));
  }
  redirect(target);
}

export async function approveOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get("flow_id"));
  await requireDashboardAccess(flowHref(flowId));
  const subjectId = asString(formData.get("subject_id")) || "owner_local";
  try {
    await approveOwnerBootstrapFlow(flowId, subjectId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

export async function denyOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get("flow_id"));
  await requireDashboardAccess(flowHref(flowId));
  const subjectId = asString(formData.get("subject_id")) || "owner_local";
  try {
    await denyOwnerBootstrapFlow(flowId, subjectId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

export async function exchangeOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get("flow_id"));
  await requireDashboardAccess(flowHref(flowId));
  try {
    await exchangeOwnerBootstrapToken(flowId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

export async function introspectOwnerTokenFlowAction(formData: FormData) {
  const flowId = asString(formData.get("flow_id"));
  await requireDashboardAccess(flowHref(flowId));
  try {
    await introspectOwnerBootstrapToken(flowId);
  } catch (err) {
    setOwnerBootstrapFlowError(flowId, errorMessage(err));
  }
  redirect(flowHref(flowId));
}

/**
 * RFC 7592 client deletion. Cascade-revokes the bound bearer on the AS side.
 * The dashboard never holds the bearer string in process memory after issuance,
 * so the only thing to clean up here is the AS state.
 */
export async function revokeOwnerTokenAction(formData: FormData) {
  await requireDashboardAccess("/dashboard/deployment/tokens");
  const clientId = asString(formData.get("client_id"));
  if (!clientId) {
    redirect("/dashboard/deployment/tokens?error=client_id+required");
  }
  let target = "/dashboard/deployment/tokens?notice=revoked";
  try {
    const url = `${getAsInternalUrl()}/oauth/register/${encodeURIComponent(clientId)}`;
    const res = await fetch(
      url,
      await withOwnerSessionCookie({
        method: "DELETE",
        cache: "no-store",
      })
    );
    if (res.status !== 204 && res.status !== 404) {
      target = `/dashboard/deployment/tokens?error=${encodeURIComponent(`revoke failed (${res.status})`)}`;
    }
  } catch (err) {
    target = `/dashboard/deployment/tokens?error=${encodeURIComponent(errorMessage(err))}`;
  }
  redirect(target);
}
