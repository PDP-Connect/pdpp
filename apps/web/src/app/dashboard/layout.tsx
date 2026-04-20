import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { isDashboardEnabled } from './lib/dashboard-access';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  if (!isDashboardEnabled()) {
    notFound();
  }

  return children;
}
