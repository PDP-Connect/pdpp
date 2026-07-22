"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../lib/dashboard-access.ts";
import { approvePendingApproval, denyPendingApproval } from "../lib/operator-approvals.ts";

function asString(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function baseHref(message?: string): string {
  const base = "/grants#pending-approvals";
  if (!message) {
    return base;
  }
  return `/grants?approval_error=${encodeURIComponent(message)}#pending-approvals`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected approval action failure";
}

export async function approvePendingApprovalAction(formData: FormData) {
  await requireDashboardAccess("/grants#pending-approvals");
  const kind = asString(formData.get("kind")) as "consent" | "owner_device";
  const approvalId = asString(formData.get("approval_id"));
  const subjectId = asString(formData.get("subject_id")) || undefined;
  let error: string | undefined;

  try {
    await approvePendingApproval({
      kind,
      approvalId,
      subjectId,
    });
  } catch (err) {
    error = errorMessage(err);
  }

  redirect(baseHref(error));
}

export async function denyPendingApprovalAction(formData: FormData) {
  await requireDashboardAccess("/grants#pending-approvals");
  const kind = asString(formData.get("kind")) as "consent" | "owner_device";
  const approvalId = asString(formData.get("approval_id"));
  const subjectId = asString(formData.get("subject_id")) || undefined;
  let error: string | undefined;

  try {
    await denyPendingApproval({
      kind,
      approvalId,
      subjectId,
    });
  } catch (err) {
    error = errorMessage(err);
  }

  redirect(baseHref(error));
}
