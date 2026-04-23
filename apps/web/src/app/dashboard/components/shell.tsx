import Link from 'next/link';
import type { ReactNode } from 'react';
import { CommandPalette } from './command-palette';

type NavItem = {
  href: string;
  label: string;
  prefix: string;
};

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', prefix: '/dashboard' },
  { href: '/dashboard/traces', label: 'Traces', prefix: '/dashboard/traces' },
  { href: '/dashboard/grants', label: 'Grants', prefix: '/dashboard/grants' },
  { href: '/dashboard/runs', label: 'Runs', prefix: '/dashboard/runs' },
  { href: '/dashboard/records', label: 'Records', prefix: '/dashboard/records' },
  { href: '/dashboard/search', label: 'Search', prefix: '/dashboard/search' },
];

export function DashboardShell({
  active,
  children,
}: {
  active: 'overview' | 'traces' | 'grants' | 'runs' | 'records' | 'search';
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen font-mono text-sm">
      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 md:grid-cols-[12rem_1fr]">
        <aside className="md:sticky md:top-6 md:self-start">
          <div className="mb-4">
            <div className="text-xs font-semibold uppercase tracking-wide">pdpp</div>
            <div className="text-muted-foreground text-[10px] break-all">
              same-origin /v1/*
            </div>
          </div>
          <nav className="flex flex-row flex-wrap gap-1 md:flex-col md:gap-0">
            {NAV.map((item) => {
              const isActive =
                (item.prefix === '/dashboard' && active === 'overview') ||
                (item.prefix !== '/dashboard' &&
                  item.prefix.endsWith(active));
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded px-2 py-1 text-xs ${
                    isActive
                      ? 'bg-muted text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  }`}
                  data-testid={`nav-${item.label.toLowerCase()}`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
      <CommandPalette />
    </div>
  );
}

export function ServerUnreachable() {
  return (
    <div className="border-destructive/40 bg-destructive/5 rounded border p-4 break-words">
      <h2 className="text-destructive font-semibold">Reference server unreachable</h2>
      <p className="mt-2 break-words">
        Could not reach the internal PDPP authorization/resource servers that back the same-origin{' '}
        <code className="break-all">/v1/*</code> and <code className="break-all">/_ref/*</code>{' '}
        surfaces. Start them with:
      </p>
      <pre className="bg-muted mt-3 overflow-x-auto rounded p-3 text-xs">
        pnpm dev
      </pre>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: string;
  hint?: ReactNode;
}) {
  return (
    <div className="border-border bg-muted/30 rounded border px-4 py-6 text-xs">
      <p className="text-foreground font-medium">{title}</p>
      {hint && <p className="text-muted-foreground mt-1">{hint}</p>}
    </div>
  );
}
