import Link from 'next/link';
import type { ReactNode } from 'react';
import { getOwnerLoginPath, getAsInternalUrl, getRsInternalUrl } from '../lib/owner-token';
import { PdppLogo } from '@/components/PdppLogo';
import { CommandPalette, CommandPaletteTrigger } from './command-palette';
import { MobileDrawer, MobileDrawerTrigger } from './mobile-drawer';

type NavItem = {
  href: string;
  label: string;
  match: (active: DashboardSection) => boolean;
};

export type DashboardSection =
  | 'overview'
  | 'search'
  | 'traces'
  | 'grants'
  | 'runs'
  | 'records';

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Overview', match: (a) => a === 'overview' },
  { href: '/dashboard/search', label: 'Search', match: (a) => a === 'search' },
  { href: '/dashboard/traces', label: 'Traces', match: (a) => a === 'traces' },
  { href: '/dashboard/grants', label: 'Grants', match: (a) => a === 'grants' },
  { href: '/dashboard/runs', label: 'Runs', match: (a) => a === 'runs' },
  { href: '/dashboard/records', label: 'Records', match: (a) => a === 'records' },
];

export function DashboardShell({
  active,
  children,
}: {
  active: DashboardSection;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <div className="grid min-h-screen md:grid-cols-[15rem_minmax(0,1fr)]">
        <DesktopSidebar active={active} />
        <div className="min-w-0 border-l border-border/80 bg-background md:border-l">
          <Topbar />
          <main className="mx-auto w-full max-w-[1400px] px-6 py-8 sm:px-8 md:px-10">
            {children}
          </main>
        </div>
      </div>
      <MobileDrawer>
        <SidebarContent active={active} />
      </MobileDrawer>
      <CommandPalette />
    </div>
  );
}

function DesktopSidebar({ active }: { active: DashboardSection }) {
  return (
    <aside className="sticky top-0 hidden h-screen flex-col justify-between py-6 pl-6 pr-4 md:flex">
      <SidebarContent active={active} />
    </aside>
  );
}

function SidebarContent({ active }: { active: DashboardSection }) {
  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <Link
          href="/dashboard"
          className="pdpp-body group inline-flex items-center gap-2 font-semibold"
        >
          <PdppLogo className="h-5 w-5" />
          <span className="tracking-tight">pdpp</span>
          <span className="pdpp-caption text-muted-foreground font-normal">control plane</span>
        </Link>

        <nav className="mt-6 flex flex-col gap-0.5" aria-label="Primary">
          {NAV.map((item) => {
            const isActive = item.match(active);
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.label.toLowerCase()}`}
                aria-current={isActive ? 'page' : undefined}
                className={[
                  'pdpp-body relative rounded-md px-2.5 py-1.5 transition-colors',
                  isActive
                    ? 'bg-muted text-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {active === 'grants' ? <GrantsSubnav /> : null}
        {active === 'records' ? <RecordsSubnav /> : null}
      </div>

      <EnvFooter />
    </div>
  );
}

function GrantsSubnav() {
  const items = [
    { href: '/dashboard/grants#pending-approvals', label: 'Pending approvals' },
    { href: '/dashboard/grants/request', label: 'Grant request' },
    { href: '/dashboard/grants/bootstrap', label: 'Owner device flow' },
  ];
  return <SidebarSubnav label="Grants workspace" items={items} />;
}

function RecordsSubnav() {
  const items = [
    { href: '/dashboard/records', label: 'Connectors' },
    { href: '/dashboard/records/timeline', label: 'Timeline' },
  ];
  return <SidebarSubnav label="Records" items={items} />;
}

function SidebarSubnav({
  label,
  items,
}: {
  label: string;
  items: Array<{ href: string; label: string }>;
}) {
  return (
    <div className="mt-5 border-t border-border/80 pt-4">
      <div className="pdpp-eyebrow px-2.5 mb-2">{label}</div>
      <nav className="flex flex-col gap-0.5" aria-label={label}>
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="pdpp-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground rounded-md px-2.5 py-1"
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

function EnvFooter() {
  const as = getAsInternalUrl();
  const rs = getRsInternalUrl();
  return (
    <div className="pt-6">
      <div className="pdpp-eyebrow mb-2">Endpoints</div>
      <dl className="pdpp-caption grid grid-cols-[2.5rem_minmax(0,1fr)] gap-y-1">
        <dt className="text-muted-foreground">AS</dt>
        <dd className="truncate font-mono text-foreground/80" title={as}>{stripScheme(as)}</dd>
        <dt className="text-muted-foreground">RS</dt>
        <dd className="truncate font-mono text-foreground/80" title={rs}>{stripScheme(rs)}</dd>
      </dl>
    </div>
  );
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//, '');
}

function Topbar() {
  return (
    <div className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-b border-border/80 bg-background/90 px-6 backdrop-blur sm:px-8 md:px-10">
      <div className="flex items-center gap-3 md:hidden">
        <MobileDrawerTrigger />
        <Link href="/dashboard" className="pdpp-body inline-flex items-center gap-2 font-semibold">
          <PdppLogo className="h-5 w-5" />
          pdpp
        </Link>
      </div>
      <div className="flex-1" />
      <CommandPaletteTrigger />
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Selective callouts — the few places where a real boundary deserves a box.
// ──────────────────────────────────────────────────────────────────────────

export function ServerUnreachable() {
  return (
    <div className="border-l-destructive/60 bg-destructive/5 rounded-r-md border border-l-4 px-4 py-3">
      <h2 className="pdpp-title text-destructive">Reference server unreachable</h2>
      <p className="pdpp-body text-muted-foreground mt-1">
        Could not reach the PDPP authorization/resource server at{' '}
        <code className="text-foreground pdpp-caption font-mono">{getRsInternalUrl()}</code>. Start it with:
      </p>
      <pre className="pdpp-caption bg-muted mt-3 overflow-x-auto rounded p-3 font-mono">
        PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/polyfill.sqlite{'\n'}
        node reference-implementation/server/index.js
      </pre>
    </div>
  );
}

export function OwnerTokenRequired() {
  return (
    <div data-surface="human" className="rounded-md px-4 py-3">
      <h2 className="pdpp-title text-foreground">Owner token required</h2>
      <p className="pdpp-body text-muted-foreground mt-1">
        This surface reads the owner self-export record APIs. When placeholder owner auth is
        enabled, the dashboard cannot auto-approve a device flow in the background.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href="/dashboard/grants/bootstrap"
          className="pdpp-label border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-3 py-1.5"
        >
          Open owner device flow →
        </Link>
        <a
          href={getOwnerLoginPath()}
          className="pdpp-label border-border hover:bg-muted/60 inline-flex items-center rounded-md border px-3 py-1.5"
        >
          Owner access →
        </a>
      </div>
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
    <div className="border-border/80 text-center rounded-md border border-dashed px-4 py-10">
      <p className="pdpp-body text-foreground font-medium">{title}</p>
      {hint ? <p className="pdpp-body text-muted-foreground mx-auto mt-1 max-w-md">{hint}</p> : null}
    </div>
  );
}
