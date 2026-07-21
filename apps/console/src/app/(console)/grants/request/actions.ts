// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

"use server";

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../lib/dashboard-access.ts";
import {
  approveGrantRequestWorkspace,
  denyGrantRequestWorkspace,
  registerGrantRequestClient,
  setGrantRequestWorkspaceError,
  stageGrantRequest,
  updateGrantRequestWorkspaceDraft,
} from "../../lib/operator-grant-request.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function asSourceKind(value: FormDataEntryValue | null): "connector" | "provider_native" {
  return asString(value) === "provider_native" ? "provider_native" : "connector";
}

function readDraft(formData: FormData) {
  return {
    initialAccessToken: asString(formData.get("initial_access_token")),
    clientId: asString(formData.get("client_id")),
    clientName: asString(formData.get("client_name")),
    clientUri: asString(formData.get("client_uri")),
    redirectUri: asString(formData.get("redirect_uri")),
    sourceKind: asSourceKind(formData.get("source_kind")),
    sourceId: asString(formData.get("source_id")),
    purposeCode: asString(formData.get("purpose_code")),
    purposeDescription: asString(formData.get("purpose_description")),
    accessMode: asString(formData.get("access_mode")),
    retention: asString(formData.get("retention")),
    streamName: asString(formData.get("stream_name")),
    connectionId: asString(formData.get("connection_id")),
    fields: asString(formData.get("fields")),
    view: asString(formData.get("view")),
    subjectId: asString(formData.get("subject_id")),
  };
}

function workspaceHref(workspaceId: string): string {
  return `/grants/request?workspace=${encodeURIComponent(workspaceId)}`;
}

function workspaceReturnTo(workspaceId: string | undefined): string {
  return workspaceId ? workspaceHref(workspaceId) : "/grants/request";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected grant-request action failure";
}

export async function saveGrantRequestDraftAction(formData: FormData) {
  const workspaceId = asString(formData.get("workspace_id")) || undefined;
  await requireDashboardAccess(workspaceReturnTo(workspaceId));
  const workspace = updateGrantRequestWorkspaceDraft(workspaceId, readDraft(formData));
  redirect(workspaceHref(workspace.workspaceId));
}

export async function registerGrantRequestClientAction(formData: FormData) {
  const workspaceId = asString(formData.get("workspace_id")) || undefined;
  await requireDashboardAccess(workspaceReturnTo(workspaceId));
  const draft = readDraft(formData);
  let target: string;
  try {
    const workspace = await registerGrantRequestClient(workspaceId, draft);
    target = workspaceHref(workspace.workspaceId);
  } catch (err) {
    const workspace = updateGrantRequestWorkspaceDraft(workspaceId, draft);
    setGrantRequestWorkspaceError(workspace.workspaceId, errorMessage(err));
    target = workspaceHref(workspace.workspaceId);
  }
  redirect(target);
}

export async function stageGrantRequestAction(formData: FormData) {
  const workspaceId = asString(formData.get("workspace_id")) || undefined;
  await requireDashboardAccess(workspaceReturnTo(workspaceId));
  const draft = readDraft(formData);
  let target: string;
  try {
    const workspace = await stageGrantRequest(workspaceId, draft);
    target = workspaceHref(workspace.workspaceId);
  } catch (err) {
    const workspace = updateGrantRequestWorkspaceDraft(workspaceId, draft);
    setGrantRequestWorkspaceError(workspace.workspaceId, errorMessage(err));
    target = workspaceHref(workspace.workspaceId);
  }
  redirect(target);
}

export async function approveGrantRequestAction(formData: FormData) {
  const workspaceId = asString(formData.get("workspace_id"));
  await requireDashboardAccess(workspaceReturnTo(workspaceId));
  try {
    await approveGrantRequestWorkspace(workspaceId);
  } catch (err) {
    setGrantRequestWorkspaceError(workspaceId, errorMessage(err));
  }
  redirect(workspaceHref(workspaceId));
}

export async function denyGrantRequestAction(formData: FormData) {
  const workspaceId = asString(formData.get("workspace_id"));
  await requireDashboardAccess(workspaceReturnTo(workspaceId));
  try {
    await denyGrantRequestWorkspace(workspaceId);
  } catch (err) {
    setGrantRequestWorkspaceError(workspaceId, errorMessage(err));
  }
  redirect(workspaceHref(workspaceId));
}
