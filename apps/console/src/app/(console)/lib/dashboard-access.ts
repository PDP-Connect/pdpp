// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server Action auth gate.
 *
 * Server Actions are POSTs to the page URL with a special header — they bypass
 * `proxy.ts` matching by route shape but still ride the same edge. The 2026
 * Next.js team guidance and CVE-2025-29927 both make explicit: every Server
 * Action MUST re-verify the session, never trusting that a layout or
 * middleware ran. See https://nextjs.org/docs/app/guides/authentication.
 *
 * Thin alias over `verifyDashboardSession` from `./verify-session.ts`. Two
 * names exist only to make call-site intent obvious: data fetchers call
 * `verifyDashboardSession()`, mutations call `requireDashboardAccess()`. Both
 * verify the cookie and redirect to `/owner/login` on miss; mutations may pass
 * an explicit `returnTo` so the user lands back on the action's home page.
 */
import { verifyDashboardSession } from "./verify-session.ts";

export async function requireDashboardAccess(returnTo?: string): Promise<void> {
  await verifyDashboardSession(returnTo);
}
