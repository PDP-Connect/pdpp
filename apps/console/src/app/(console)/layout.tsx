import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { DashboardPaletteProvider } from "./components/dashboard-palette-provider.tsx";
import { isDashboardEnabled } from "./lib/dashboard-flag.ts";

// Live operator state for a single reference instance — never index.
// The primary defense is the X-Robots-Tag response header set in proxy.ts,
// which applies regardless of which layout actually renders (owner-login
// redirect, server-unreachable shell, or the dashboard itself). This
// metadata export is defense in depth for the case where the dashboard
// layout does render to completion.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

// Auth gating intentionally lives in two layers, not here:
//   - proxy.ts redirects unauthenticated browser navigations
//   - dashboard/lib/verify-session.ts (DAL) gates every data fetch
// Layout-level checks are explicitly cautioned against by the Next.js docs
// (https://nextjs.org/docs/app/guides/authentication) due to App Router's
// partial-rendering model: layouts and child pages render concurrently,
// so a layout `redirect()` can race against a child's data-fetch error.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  if (!isDashboardEnabled()) {
    notFound();
  }
  return <DashboardPaletteProvider>{children}</DashboardPaletteProvider>;
}
