/**
 * Shared dashboard-to-owner-login redirect helper.
 *
 * The optimistic proxy redirect only runs when the web process can tell owner
 * auth is enabled. In split/composed deployments the AS may be the only
 * process with `PDPP_OWNER_PASSWORD`, so dashboard fetchers also convert an
 * authoritative AS `owner_session_required` response into the same login flow.
 */
import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { normalizeDashboardReturnTo } from "./return-to.ts";

async function resolveReturnTo(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    return normalizeDashboardReturnTo(explicit);
  }
  const headerList = await headers();
  return normalizeDashboardReturnTo(headerList.get("x-pdpp-return-to") ?? "/");
}

export async function redirectToOwnerLogin(returnTo?: string): Promise<never> {
  const safe = await resolveReturnTo(returnTo);
  redirect(`/owner/login?return_to=${encodeURIComponent(safe)}`);
}
