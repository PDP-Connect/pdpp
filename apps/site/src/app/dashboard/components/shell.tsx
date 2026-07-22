// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  CommandPalette,
  CommandPaletteProvider,
  CommandPaletteTrigger,
} from "@pdpp/operator-ui/components/command-palette";
import { LEGACY_SEGMENTS } from "@pdpp/operator-ui/components/command-registry";
import { MobileDrawer, MobileDrawerProvider, MobileDrawerTrigger } from "@pdpp/operator-ui/components/mobile-drawer";
import { type Routes, sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import type { ReactNode } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";

interface NavItem {
  href: string;
  label: string;
  match: (active: DashboardSection) => boolean;
}

export type DashboardSection =
  | "overview"
  | "search"
  | "explore"
  | "traces"
  | "grants"
  | "runs"
  | "records"
  | "schedules"
  | "deployment"
  | "device-exporters";

/**
 * Shell binding mode.
 *
 * On the public site (`apps/site`) the shell only ever renders the public
 * mock sandbox, so `mock-owner` is the only supported binding. The prop is
 * retained for source compatibility with the shared dashboard feature
 * components, but the live operator binding (`live`) has moved to the
 * operator console (`apps/console`). The public bundle therefore carries no
 * owner-token/session import and no live AS/RS reachability.
 */
export type ShellMode = "live" | "mock-owner";

function buildNav(routes: Routes): NavItem[] {
  return [
    { href: routes.section.overview, label: "Overview", match: (a) => a === "overview" },
    {
      href: routes.section.explore,
      label: "Explore",
      match: (a) => a === "explore" || a === "search" || a === "records",
    },
    { href: routes.section.traces, label: "Audit", match: (a) => a === "traces" },
    { href: routes.section.grants, label: "Grants", match: (a) => a === "grants" },
    { href: routes.section.runs, label: "Syncs", match: (a) => a === "runs" },
    { href: routes.section.schedules, label: "Schedules", match: (a) => a === "schedules" },
    { href: routes.section.deployment, label: "Deployment", match: (a) => a === "deployment" },
  ];
}

export function DashboardShell({
  active,
  children,
}: {
  active: DashboardSection;
  children: ReactNode;
  // Accepted for source compatibility; the public site only renders the
  // mock-owner sandbox, so the value is not branched on.
  mode?: ShellMode;
}) {
  const routes = sandboxRoutes;
  return (
    <div className="min-h-screen">
      <CommandPaletteProvider>
        <MobileDrawerProvider>
          <div className="grid min-h-screen md:grid-cols-[15rem_minmax(0,1fr)]">
            <DesktopSidebar active={active} routes={routes} />
            <div className="min-w-0 border-border/80 border-l bg-background md:border-l">
              <Topbar overviewHref={routes.section.overview} />
              <main className="mx-auto w-full max-w-[1400px] px-6 py-8 sm:px-8 md:px-10">
                <SandboxModeBanner />
                {children}
              </main>
            </div>
          </div>
          <MobileDrawer>
            <SidebarContent active={active} routes={routes} />
          </MobileDrawer>
        </MobileDrawerProvider>
        {/* Sandbox keeps its legacy `records`/`runs`/`traces` folder segments;
            pass them explicitly so the shared registry does not default to the
            clean console segments. */}
        <CommandPalette basePath={routes.basePath} mode="mock-owner" segments={LEGACY_SEGMENTS} />
      </CommandPaletteProvider>
    </div>
  );
}

function DesktopSidebar({ active, routes }: { active: DashboardSection; routes: Routes }) {
  return (
    <aside className="sticky top-0 hidden h-screen flex-col justify-between py-6 pr-4 pl-6 md:flex">
      <SidebarContent active={active} routes={routes} />
    </aside>
  );
}

function SidebarContent({ active, routes }: { active: DashboardSection; routes: Routes }) {
  const nav = buildNav(routes);
  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <Link className="pdpp-body group inline-flex items-center gap-2 font-semibold" href={routes.section.overview}>
          <PdppLogo className="h-5 w-5" />
          <span className="tracking-tight">pdpp</span>
          <span className="pdpp-caption font-normal text-muted-foreground">reference instance</span>
        </Link>

        <nav aria-label="Primary" className="mt-6 flex flex-col gap-0.5">
          {nav.map((item) => {
            const isActive = item.match(active);
            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={[
                  "pdpp-body relative rounded-md px-2.5 py-1.5 transition-colors",
                  isActive
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                ].join(" ")}
                data-testid={`nav-${item.label.toLowerCase()}`}
                href={item.href}
                key={item.href}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {active === "explore" || active === "search" || active === "records" ? (
          <ExploreSubnav active={active} routes={routes} />
        ) : null}
      </div>

      <SandboxFooter />
    </div>
  );
}

function ExploreSubnav({ routes, active }: { routes: Routes; active: DashboardSection }) {
  const items: Array<{ href: string; label: string; section: DashboardSection }> = [
    { href: routes.section.explore, label: "Records feed", section: "explore" },
    { href: routes.section.search, label: "Jump to artifact", section: "search" },
  ];
  return <SidebarSubnav activeSection={active} items={items} label="Explore" />;
}

function SidebarSubnav({
  label,
  items,
  activeSection,
}: {
  label: string;
  items: Array<{ href: string; label: string; section?: DashboardSection }>;
  activeSection?: DashboardSection;
}) {
  return (
    <div className="mt-5 border-border/80 border-t pt-4">
      <div className="pdpp-eyebrow mb-2 px-2.5">{label}</div>
      <nav aria-label={label} className="flex flex-col gap-0.5">
        {items.map((item) => {
          const isActive = activeSection !== undefined && item.section !== undefined && item.section === activeSection;
          return (
            <Link
              aria-current={isActive ? "page" : undefined}
              className={[
                "pdpp-caption rounded-md px-2.5 py-1 transition-colors",
                isActive
                  ? "bg-muted/60 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              ].join(" ")}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Persistent top-of-content banner on every sandbox page.
 *
 * Demo data must never read as production data. This banner sits above each
 * page's own content — inside `<main>` — and is purely informational. The
 * sandbox only ever renders in mock-owner mode, so there is no mode branch.
 */
function SandboxModeBanner() {
  return (
    <div
      className="mb-6 flex items-center gap-2.5 rounded-md border border-amber-500/30 bg-amber-500/8 px-4 py-2.5"
      data-testid="sandbox-mode-banner"
      role="note"
    >
      <span aria-hidden className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500/80" />
      <p className="pdpp-caption text-amber-700 dark:text-amber-400">
        <span className="font-semibold">Sandbox demo — </span>
        all data is fictional and deterministic. No owner credentials, no live AS/RS, no real records.
      </p>
    </div>
  );
}

/**
 * Sandbox footer. The public sandbox never reaches out to a configured
 * reference server, so there is no live AS/RS endpoint probe here.
 */
function SandboxFooter() {
  return (
    <div className="pt-6">
      <div className="pdpp-eyebrow mb-2 flex items-center gap-2">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500/80" />
        Sandbox
      </div>
      <p className="pdpp-caption text-muted-foreground">
        A reference profile for exploring PDPP grants, runs, traces, and records.
      </p>
      <ul className="pdpp-caption mt-3 flex flex-col gap-1 text-muted-foreground">
        <li>
          <Link className="hover:text-foreground hover:underline" href="/reference">
            Reference overview →
          </Link>
        </li>
      </ul>
    </div>
  );
}

function Topbar({ overviewHref }: { overviewHref: string }) {
  return (
    <div className="sticky top-0 z-30 flex h-12 items-center justify-between gap-3 border-border/80 border-b bg-background/90 px-6 backdrop-blur sm:px-8 md:px-10">
      <div className="flex items-center gap-3 md:hidden">
        <MobileDrawerTrigger />
        <Link className="pdpp-body inline-flex items-center gap-2 font-semibold" href={overviewHref}>
          <PdppLogo className="h-5 w-5" />
          pdpp
        </Link>
      </div>
      <div className="flex-1" />
      <ThemeToggle />
      <CommandPaletteTrigger />
    </div>
  );
}
