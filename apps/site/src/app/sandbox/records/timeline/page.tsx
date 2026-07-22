// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { redirect } from "next/navigation";

/**
 * Sandbox time-range browsing moved to /sandbox/explore.
 *
 * The standalone Timeline view was absorbed into the Explore canvas by
 * `absorb-timeline-into-explore-ia`; next.config.mjs provides a route-level
 * redirect. This module-level redirect handles direct server-component
 * navigations so SSR also lands on the correct surface.
 *
 * Query params (since / until) are forwarded to preserve any deep links.
 */
export const dynamic = "force-dynamic";

export default async function SandboxRecordsTimelinePage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string; until?: string }>;
}) {
  const { since, until } = await searchParams;
  const params = new URLSearchParams();
  if (since) {
    params.set("since", since);
  }
  if (until) {
    params.set("until", until);
  }
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  redirect(`/sandbox/explore${qs}`);
}
