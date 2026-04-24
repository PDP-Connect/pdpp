import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isDashboardEnabled, requireDashboardAccess } from "./lib/dashboard-access.ts";

// Live operator state for a single reference instance — never index.
// The primary defense is the X-Robots-Tag response header set in proxy.ts,
// which applies regardless of which layout actually renders (owner-login
// redirect, server-unreachable shell, or the dashboard itself). This
// metadata export is defense in depth for the case where the dashboard
// layout does render to completion.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  if (!isDashboardEnabled()) {
    notFound();
  }

  await requireDashboardAccess();

  return children;
}
