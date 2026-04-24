import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { isDashboardEnabled, requireDashboardAccess } from "./lib/dashboard-access.ts";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  if (!isDashboardEnabled()) {
    notFound();
  }

  await requireDashboardAccess();

  return children;
}
