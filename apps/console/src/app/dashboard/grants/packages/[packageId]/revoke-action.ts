"use server";

/**
 * Server action for the operator-revoke affordance on
 * `/dashboard/grants/packages/[packageId]`.
 *
 * The action re-verifies the owner session (per CVE-2025-29927 / Next.js
 * 2026 guidance, every Server Action MUST re-check its own gate), POSTs
 * to `/_ref/grant-packages/:id/revoke` via the typed dashboard client,
 * and redirects back to the same detail page so the operator sees the
 * cascaded child grants flip to `revoked`. Confirmation is enforced
 * server-side (`confirm_revoke=yes` in the form body); a scripted client
 * or curl request without the field round-trips back with a banner.
 *
 * Spec: openspec/changes/add-grant-package-operator-visibility/
 *       specs/reference-implementation-architecture/spec.md
 */

import { redirect } from "next/navigation";
import { requireDashboardAccess } from "../../../lib/dashboard-access.ts";
import { GrantPackageRevokePartialFailureError, revokeGrantPackage } from "../../../lib/ref-client.ts";

function detailHref(packageId: string, params: Record<string, string> = {}): string {
  const sp = new URLSearchParams(params);
  const qs = sp.toString();
  const base = `/dashboard/grants/packages/${encodeURIComponent(packageId)}`;
  return qs ? `${base}?${qs}` : base;
}

function errorMessage(err: unknown): string {
  if (err instanceof GrantPackageRevokePartialFailureError) {
    return err.message;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return "Unexpected revoke action failure";
}

export async function revokePackageAction(formData: FormData): Promise<void> {
  const packageIdRaw = formData.get("package_id");
  const packageId = typeof packageIdRaw === "string" ? packageIdRaw.trim() : "";
  if (!packageId) {
    redirect("/dashboard/grants/packages");
  }

  await requireDashboardAccess(detailHref(packageId));

  const confirm = formData.get("confirm_revoke");
  if (typeof confirm !== "string" || confirm !== "yes") {
    redirect(detailHref(packageId, { revoke_error: "Confirmation required: tick the box before submitting." }));
  }

  try {
    await revokeGrantPackage(packageId);
  } catch (err) {
    redirect(detailHref(packageId, { revoke_error: errorMessage(err) }));
  }

  redirect(detailHref(packageId, { revoked: "yes" }));
}
