import { CopyButton } from "@pdpp/operator-ui/components/copy-button";
import { MobileDrawer, MobileDrawerProvider, MobileDrawerTrigger } from "@pdpp/operator-ui/components/mobile-drawer";
import { dashboardRoutes, type Routes, sandboxRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { cache, type ReactNode } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";
import { getAsInternalUrl, getOwnerLoginPath, getReferencePublicOrigin, getRsInternalUrl } from "../lib/owner-token.ts";
import { CommandPalette, CommandPaletteProvider, CommandPaletteTrigger } from "./command-palette.tsx";

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
  | "connect"
  | "deployment"
  | "device-exporters"
  | "event-subscriptions";

/**
 * Shell binding mode.
 *
 * `live` is the default and renders the operator dashboard against the
 * configured AS/RS — keep owner-auth behavior and live probes intact.
 *
 * `mock-owner` is the public sandbox binding: same shell, same nav,
 * same chrome, but URLs prefix `/sandbox/...` and the env footer is
 * replaced with a non-probing sandbox summary so the sandbox never
 * reaches out to a live AS/RS.
 */
export type ShellMode = "live" | "mock-owner";

const SCHEME_PREFIX_RE = /^https?:\/\//;

function buildNav(routes: Routes, mode: ShellMode): NavItem[] {
  const nav: NavItem[] = [
    { href: routes.section.overview, label: "Overview", match: (a) => a === "overview" },
    {
      href: routes.section.explore,
      label: "Explore",
      match: (a) => a === "explore" || a === "search",
    },
    { href: routes.section.records, label: "Connections", match: (a) => a === "records" },
    { href: routes.section.traces, label: "Traces", match: (a) => a === "traces" },
    { href: routes.section.grants, label: "Grants", match: (a) => a === "grants" },
    { href: routes.section.runs, label: "Runs", match: (a) => a === "runs" },
    { href: routes.section.schedules, label: "Schedules", match: (a) => a === "schedules" },
  ];
  if (mode === "live") {
    nav.push({ href: routes.section.connect, label: "Connect AI apps", match: (a) => a === "connect" });
    nav.push({ href: routes.section.deployment, label: "Deployment", match: (a) => a === "deployment" });
    nav.push({
      href: routes.section.deviceExporters,
      label: "Device exporters",
      match: (a) => a === "device-exporters",
    });
    nav.push({
      href: routes.section.eventSubscriptions,
      label: "Event subscriptions",
      match: (a) => a === "event-subscriptions",
    });
  }
  return nav;
}

function resolveRoutes(mode: ShellMode): Routes {
  return mode === "mock-owner" ? sandboxRoutes : dashboardRoutes;
}

export function DashboardShell({
  active,
  children,
  mode = "live",
}: {
  active: DashboardSection;
  children: ReactNode;
  mode?: ShellMode;
}) {
  const routes = resolveRoutes(mode);
  return (
    <div className="min-h-screen">
      <CommandPaletteProvider>
        <MobileDrawerProvider>
          <div className="grid min-h-screen md:grid-cols-[15rem_minmax(0,1fr)]">
            <DesktopSidebar active={active} mode={mode} routes={routes} />
            <div className="min-w-0 border-border/80 border-l bg-background md:border-l">
              <Topbar overviewHref={routes.section.overview} />
              <main className="mx-auto w-full max-w-[1400px] px-6 py-8 sm:px-8 md:px-10">
                {mode === "mock-owner" ? <SandboxModeBanner /> : null}
                {children}
              </main>
            </div>
          </div>
          <MobileDrawer>
            <SidebarContent active={active} mode={mode} routes={routes} />
          </MobileDrawer>
        </MobileDrawerProvider>
        <CommandPalette basePath={routes.basePath} mode={mode} />
      </CommandPaletteProvider>
    </div>
  );
}

function DesktopSidebar({ active, mode, routes }: { active: DashboardSection; mode: ShellMode; routes: Routes }) {
  return (
    <aside className="sticky top-0 hidden h-screen flex-col justify-between py-6 pr-4 pl-6 md:flex">
      <SidebarContent active={active} mode={mode} routes={routes} />
    </aside>
  );
}

function SidebarContent({ active, mode, routes }: { active: DashboardSection; mode: ShellMode; routes: Routes }) {
  const nav = buildNav(routes, mode);
  const tagline = mode === "mock-owner" ? "reference instance" : "control plane";
  return (
    <div className="flex h-full flex-col justify-between">
      <div>
        <Link className="pdpp-body group inline-flex items-center gap-2 font-semibold" href={routes.section.overview}>
          <PdppLogo className="h-5 w-5" />
          <span className="tracking-tight">pdpp</span>
          <span className="pdpp-caption font-normal text-muted-foreground">{tagline}</span>
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

        {active === "explore" || active === "search" ? <ExploreSubnav active={active} routes={routes} /> : null}
        {active === "grants" && mode === "live" ? <GrantsSubnav /> : null}
        {active === "deployment" && mode === "live" ? <DeploymentSubnav routes={routes} /> : null}
      </div>

      {mode === "mock-owner" ? <SandboxFooter /> : <EnvFooter />}
    </div>
  );
}

function ExploreSubnav({ active, routes }: { active: DashboardSection; routes: Routes }) {
  const items: Array<{ href: string; label: string; section: DashboardSection }> = [
    { href: routes.section.explore, label: "Records feed", section: "explore" },
    { href: routes.section.search, label: "Jump to artifact", section: "search" },
  ];
  return <SidebarSubnav activeSection={active} items={items} label="Explore workspace" />;
}

function GrantsSubnav() {
  // Owner-only flows; never rendered in mock-owner mode.
  // Note: owner-token issuance lives under /dashboard/deployment/tokens, not
  // here — tokens are an operator/developer concern, not a grants concern.
  const items = [
    { href: "/dashboard/grants#pending-approvals", label: "Pending approvals" },
    { href: "/dashboard/grants/packages", label: "Packages" },
    { href: "/dashboard/grants/request", label: "Grant request" },
  ];
  return <SidebarSubnav items={items} label="Grants workspace" />;
}

function DeploymentSubnav({ routes }: { routes: Routes }) {
  // Owner tokens are for the operator and trusted local agents only — not
  // ordinary MCP clients. Never render this subnav in mock-owner mode.
  const items = [
    { href: routes.section.deployment, label: "Deployment overview" },
    { href: routes.section.connect, label: "Connect AI apps" },
    { href: routes.section.deploymentTokens, label: "Owner tokens" },
  ];
  return <SidebarSubnav items={items} label="Deployment" />;
}

function SidebarSubnav({
  activeSection,
  label,
  items,
}: {
  activeSection?: DashboardSection;
  label: string;
  items: Array<{ href: string; label: string; section?: DashboardSection }>;
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

async function EnvFooter() {
  const asInternal = getAsInternalUrl();
  const rsInternal = getRsInternalUrl();
  const [asOnline, rsOnline, publicOrigin] = await Promise.all([
    probeAs(asInternal),
    probeRs(rsInternal),
    getReferencePublicOrigin(),
  ]);
  return (
    <div className="pt-6">
      <div className="pdpp-eyebrow mb-2">Endpoints</div>
      <ul className="pdpp-caption flex flex-col gap-1">
        <EndpointRow label="AS" online={asOnline} url={publicOrigin} />
        <EndpointRow label="RS" online={rsOnline} url={publicOrigin} />
      </ul>
    </div>
  );
}

/**
 * Persistent top-of-content banner rendered on every sandbox page.
 *
 * Keeps demo data from ever reading as production data. The banner appears
 * above each page's own content — inside `<main>` so it scrolls with the
 * content rather than overlaying it — and is purely informational: no actions,
 * no destructive affordances. Reset and filter-clear links in individual list
 * views are scoped to those views and styled as lightweight navigation, not
 * here as a global reset.
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
 * Sandbox footer. Replaces the live AS/RS probe so the public sandbox
 * never reaches out to a configured reference server.
 */
function SandboxFooter() {
  return (
    <div className="pt-6">
      <div className="pdpp-eyebrow mb-2 flex items-center gap-2">
        <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500/80" />
        Sandbox
      </div>
      <p className="pdpp-caption text-muted-foreground">
        A reference profile for exploring PDPP grants, runs, traces, records, and discovery.
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

function EndpointRow({ label, url, online }: { label: string; url: string; online: boolean }) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex w-8 shrink-0 items-center gap-1.5 text-muted-foreground">
        <StatusDot label={label} online={online} />
        {label}
      </span>
      <span className="inline-flex min-w-0 items-center gap-1">
        <span className="min-w-0 truncate font-mono text-foreground/80" title={url}>
          {stripScheme(url)}
        </span>
        <CopyButton ariaLabel={`Copy ${label} URL`} value={url} />
      </span>
    </li>
  );
}

function StatusDot({ online, label }: { online: boolean; label: string }) {
  const state = online ? "online" : "offline";
  return (
    <span
      aria-label={`${label} ${state}`}
      className={`inline-block h-2 w-2 rounded-full ${online ? "bg-success" : "bg-destructive"}`}
      role="img"
      title={`${label} ${state}`}
    />
  );
}

const PROBE_TIMEOUT_MS = 900;
const PROBE_REVALIDATE_S = 15;

const probeJson = cache(async (url: string): Promise<Record<string, unknown> | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate: PROBE_REVALIDATE_S },
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
});

async function probeAs(baseUrl: string): Promise<boolean> {
  const body = await probeJson(`${baseUrl}/.well-known/oauth-authorization-server`);
  return typeof body?.issuer === "string" && body.issuer.length > 0;
}

async function probeRs(baseUrl: string): Promise<boolean> {
  const body = await probeJson(`${baseUrl}/.well-known/oauth-protected-resource`);
  if (!body) {
    return false;
  }
  const hasResource = typeof body.resource === "string" && body.resource.length > 0;
  const hasAuthServers = Array.isArray(body.authorization_servers) && body.authorization_servers.length > 0;
  return hasResource || hasAuthServers;
}

function stripScheme(url: string): string {
  return url.replace(SCHEME_PREFIX_RE, "");
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

// ──────────────────────────────────────────────────────────────────────────
// Selective callouts — the few places where a real boundary deserves a box.
// ──────────────────────────────────────────────────────────────────────────

export function ServerUnreachable() {
  return (
    <div className="rounded-r-md border border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-3">
      <h2 className="pdpp-title text-destructive">Reference server unreachable</h2>
      <p className="pdpp-body mt-1 text-muted-foreground">
        This dashboard could not reach its PDPP authorization/resource server at{" "}
        <code className="pdpp-caption font-mono text-foreground">{getRsInternalUrl()}</code>. The reference server runs
        alongside this console in your deployment; the dashboard recovers as soon as it responds again.
      </p>
      <ul className="pdpp-caption mt-3 grid gap-1 text-muted-foreground">
        <li>Confirm the PDPP service is running in your deployment (Docker, Railway, Fly, or your VPS).</li>
        <li>Check the deployment logs for a startup error, then restart the PDPP service.</li>
        <li>
          Open{" "}
          <Link className="underline underline-offset-2 hover:text-foreground" href="/dashboard/deployment">
            Deployment readiness
          </Link>{" "}
          once the server is reachable to confirm configuration.
        </li>
      </ul>
    </div>
  );
}

export function OwnerTokenRequired() {
  return (
    <div className="rounded-md px-4 py-3" data-surface="human">
      <h2 className="pdpp-title text-foreground">Owner token required</h2>
      <p className="pdpp-body mt-1 text-muted-foreground">
        This surface reads the owner self-export record APIs. When placeholder owner auth is enabled, the dashboard
        cannot auto-approve a device flow in the background.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Link
          className="pdpp-label inline-flex items-center rounded-md border border-border px-3 py-1.5 hover:bg-muted/60"
          href="/dashboard/deployment/tokens"
        >
          Issue owner token →
        </Link>
        <a
          className="pdpp-label inline-flex items-center rounded-md border border-border px-3 py-1.5 hover:bg-muted/60"
          href={getOwnerLoginPath()}
        >
          Owner access →
        </a>
      </div>
    </div>
  );
}
