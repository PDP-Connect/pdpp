import Link from "next/link";
import type { ReactNode } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { getAsInternalUrl, getOwnerLoginPath, getRsInternalUrl } from "../lib/owner-token.ts";
import { CommandPalette, CommandPaletteTrigger } from "./command-palette.tsx";
import { MobileDrawer, MobileDrawerTrigger } from "./mobile-drawer.tsx";

interface NavItem {
  href: string;
  label: string;
  match: (active: DashboardSection) => boolean;
}

export type DashboardSection = "overview" | "search" | "traces" | "grants" | "runs" | "records";

const SCHEME_PREFIX_RE = /^https?:\/\//;

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", match: (a) => a === "overview" },
  { href: "/dashboard/search", label: "Search", match: (a) => a === "search" },
  { href: "/dashboard/traces", label: "Traces", match: (a) => a === "traces" },
  { href: "/dashboard/grants", label: "Grants", match: (a) => a === "grants" },
  { href: "/dashboard/runs", label: "Runs", match: (a) => a === "runs" },
  { href: "/dashboard/records", label: "Records", match: (a) => a === "records" },
];

export function DashboardShell({ active, children }: { active: DashboardSection; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <div className="grid min-h-screen md:grid-cols-[15rem_minmax(0,1fr)]">
        <DesktopSidebar active={active} />
        <div className="min-w-0 border-border/80 border-l bg-background md:border-l">
          <Topbar />
          <main className="mx-auto w-full max-w-[1400px] px-6 py-8 sm:px-8 md:px-10">{children}</main>
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
    <aside className="sticky top-0 hidden h-screen flex-col justify-between py-6 pr-4 pl-6 md:flex">
      <SidebarContent active={active} />
    </aside>
  );
}

function SidebarContent({ active }: { active: DashboardSection }) {
  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <Link href="/dashboard" className="pdpp-body group inline-flex items-center gap-2 font-semibold">
          <PdppLogo className="h-5 w-5" />
          <span className="tracking-tight">pdpp</span>
          <span className="pdpp-caption font-normal text-muted-foreground">control plane</span>
        </Link>

        <nav className="mt-6 flex flex-col gap-0.5" aria-label="Primary">
          {NAV.map((item) => {
            const isActive = item.match(active);
            return (
              <Link
                key={item.href}
                href={item.href}
                data-testid={`nav-${item.label.toLowerCase()}`}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "pdpp-body relative rounded-md px-2.5 py-1.5 transition-colors",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                ].join(" ")}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {active === "grants" ? <GrantsSubnav /> : null}
        {active === "records" ? <RecordsSubnav /> : null}
      </div>

      <EnvFooter />
    </div>
  );
}

function GrantsSubnav() {
  const items = [
    { href: "/dashboard/grants#pending-approvals", label: "Pending approvals" },
    { href: "/dashboard/grants/request", label: "Grant request" },
    { href: "/dashboard/grants/bootstrap", label: "Owner device flow" },
  ];
  return <SidebarSubnav label="Grants workspace" items={items} />;
}

function RecordsSubnav() {
  const items = [
    { href: "/dashboard/records", label: "Connectors" },
    { href: "/dashboard/records/timeline", label: "Timeline" },
  ];
  return <SidebarSubnav label="Records" items={items} />;
}

function SidebarSubnav({ label, items }: { label: string; items: Array<{ href: string; label: string }> }) {
  return (
    <div className="mt-5 border-border/80 border-t pt-4">
      <div className="pdpp-eyebrow mb-2 px-2.5">{label}</div>
      <nav className="flex flex-col gap-0.5" aria-label={label}>
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="pdpp-caption rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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
        <dd className="truncate font-mono text-foreground/80" title={as}>
          {stripScheme(as)}
        </dd>
        <dt className="text-muted-foreground">RS</dt>
        <dd className="truncate font-mono text-foreground/80" title={rs}>
          {stripScheme(rs)}
        </dd>
      </dl>
    </div>
  );
}

function stripScheme(url: string): string {
  return url.replace(SCHEME_PREFIX_RE, "");
}

function Topbar() {
  return (
    <div className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-border/80 border-b bg-background/90 px-6 backdrop-blur sm:px-8 md:px-10">
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
    <div className="rounded-r-md border border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-3">
      <h2 className="pdpp-title text-destructive">Reference server unreachable</h2>
      <p className="pdpp-body mt-1 text-muted-foreground">
        Could not reach the PDPP authorization/resource server at{" "}
        <code className="pdpp-caption font-mono text-foreground">{getRsInternalUrl()}</code>. Start it with:
      </p>
      <pre className="pdpp-caption mt-3 overflow-x-auto rounded bg-muted p-3 font-mono">
        PDPP_DB_PATH=packages/polyfill-connectors/.pdpp-data/polyfill.sqlite{"\n"}
        node reference-implementation/server/index.js
      </pre>
    </div>
  );
}

export function OwnerTokenRequired() {
  return (
    <div data-surface="human" className="rounded-md px-4 py-3">
      <h2 className="pdpp-title text-foreground">Owner token required</h2>
      <p className="pdpp-body mt-1 text-muted-foreground">
        This surface reads the owner self-export record APIs. When placeholder owner auth is enabled, the dashboard
        cannot auto-approve a device flow in the background.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          href="/dashboard/grants/bootstrap"
          className="pdpp-label inline-flex items-center rounded-md border border-border px-3 py-1.5 hover:bg-muted/60"
        >
          Open owner device flow →
        </Link>
        <a
          href={getOwnerLoginPath()}
          className="pdpp-label inline-flex items-center rounded-md border border-border px-3 py-1.5 hover:bg-muted/60"
        >
          Owner access →
        </a>
      </div>
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-border/80 border-dashed px-4 py-10 text-center">
      <p className="pdpp-body font-medium text-foreground">{title}</p>
      {hint ? <p className="pdpp-body mx-auto mt-1 max-w-md text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
