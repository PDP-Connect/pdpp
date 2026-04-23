import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isDashboardEnabled, requireDashboardAccess } from './lib/dashboard-access';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  if (!isDashboardEnabled()) {
    notFound();
  }

  await requireDashboardAccess();

  return children;
}
