/**
 * RecordroomShell — the Ink Carbon owner-console frame.
 *
 * The dependency root of the redesigned console: a left sidebar (brand mark +
 * grouped nav + footer host block) and a main column with a sticky header
 * (crumb, ⌘K jump affordance, theme toggle, mobile menu) wrapping `{children}`.
 * On narrow screens the sidebar folds into a drawer overlay.
 *
 * Ported from `rr-app.jsx` (the design SHELL) and rebound to the REAL app:
 *
 * NAV RECONCILIATION (design groups vs real routes):
 *   The design groups nav as Explore · Collection (Syncs, Sources) · Sharing
 *   (Grants, Traces) · Server (Connect AI apps, Deployment, Device exporters,
 *   Event subscriptions) · Glance (Standing = Overview). We keep that grouped
 *   PRESENTATION but bind every item to the REAL route the dashboard enforces
 *   (those routes are pinned by next.config.mjs redirects + tests), and adopt
 *   the design's labels where they map. Decisions:
 *     - "Standing" (design) → label kept, route is the real Overview `/dashboard`.
 *     - "Sources" → the real route is `/dashboard/records` (the design's Sources
 *       maps onto the real records surface).
 *     - "Syncs" (design-only; the real app has no /dashboard/syncs) → mapped to
 *       the real Runs route `/dashboard/runs`, keeping the warmer "Syncs" label
 *       (is your data arriving). See SYNCS_NOTE below.
 *   `NAV_GROUPS` is a typed array so leaf views / future edits are trivial.
 *
 * THEME: the toggle flips BOTH `data-theme` and the `dark` class on <html> so
 * the Ink Carbon tokens (light `:root`, dark `.dark,[data-theme="dark"]`) and
 * the existing Tailwind/shadcn `dark:` variants react together.
 *
 * OWNER IDENTITY: there is none to show — owner auth is invisible (cookie-gated).
 * The footer is a host line + build crumb, NOT a user menu.
 */
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import "./components.css";
import "./shell.css";

// SYNCS_NOTE: the design's "Syncs" group item has no dedicated real route; we
// point it at the real Runs route. If a future `/dashboard/runs` presentation
// renames itself "Syncs", only this href/label pair changes.

export interface NavItem {
  /** Real route href (pinned by redirects/tests). */
  href: string;
  /** Display label (design vocabulary where it maps). */
  label: string;
}

export interface NavGroup {
  /** Group heading; null for the ungrouped top item (Explore). */
  heading: string | null;
  items: NavItem[];
}

/**
 * The grouped nav. Routes are the REAL dashboard routes; labels follow the
 * design vocabulary. Edit this array to change nav — components derive from it.
 */
export const NAV_GROUPS: NavGroup[] = [
  { heading: null, items: [{ label: "Explore", href: "/dashboard/explore" }] },
  {
    heading: "Collection",
    items: [
      { label: "Syncs", href: "/dashboard/runs" },
      { label: "Sources", href: "/dashboard/records" },
    ],
  },
  {
    heading: "Sharing",
    items: [
      { label: "Grants", href: "/dashboard/grants" },
      { label: "Traces", href: "/dashboard/traces" },
    ],
  },
  {
    heading: "Server",
    items: [
      { label: "Connect AI apps", href: "/dashboard/connect" },
      { label: "Deployment", href: "/dashboard/deployment" },
      { label: "Device exporters", href: "/dashboard/device-exporters" },
      { label: "Event subscriptions", href: "/dashboard/event-subscriptions" },
    ],
  },
  { heading: "Glance", items: [{ label: "Standing", href: "/dashboard" }] },
];

/** Flat list of every nav item, for ⌘K palettes and tests. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// ─── Active-route matching ────────────────────────────────────────
//
// `/dashboard` (Standing) must match ONLY itself — every other route also
// starts with `/dashboard`, so an exact match is required for the root and a
// prefix match (segment-boundary aware) for the rest.
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") {
    return pathname === "/dashboard";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ─── Brand mark — a sheet casting its carbon ──────────────────────

function BrandMark() {
  return <span aria-hidden="true" className="rr-side__mark" />;
}

// ─── Nav list (shared by sidebar + drawer) ────────────────────────

function NavList({ pathname, onNavigate }: { onNavigate?: () => void; pathname: string }) {
  return (
    <>
      {NAV_GROUPS.map((group) => (
        <div className="rr-nav-group" key={group.heading ?? "_top"}>
          {group.heading && <div className="rr-side__group">{group.heading}</div>}
          {group.items.map((item) => {
            const active = isNavItemActive(item.href, pathname);
            return (
              <Link
                aria-current={active ? "page" : undefined}
                className={["rr-nav-item", active ? "is-active" : undefined].filter(Boolean).join(" ")}
                href={item.href}
                key={item.href}
                onClick={onNavigate}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ─── Footer host block ────────────────────────────────────────────

function FootBlock({ host, build }: { build: string; host: string }) {
  // Theme toggle lives here in the sidebar footer — a quiet utility, not a
  // front-and-center header action. The hook flips <html> so any toggle
  // instance stays in sync via the DOM.
  const [theme, toggleTheme] = useThemeToggle();
  const themeLabel = theme === "dark" ? "Dark" : "Light";
  const themeTitle = theme === "dark" ? "Switch to light" : "Switch to dark";
  return (
    <div className="rr-side__foot">
      <span className="rr-side__host">
        {host} · {build}
      </span>
      <span className="rr-side__motto">your data, at home</span>
      <button className="rr-side__theme rr-chrome-btn" onClick={toggleTheme} title={themeTitle} type="button">
        {themeLabel}
      </button>
    </div>
  );
}

// ─── Theme toggle (flips <html> data-theme + dark class) ──────────

type Theme = "dark" | "light";

function readInitialTheme(): Theme {
  if (typeof document === "undefined") {
    return "dark";
  }
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light") {
    return "light";
  }
  if (attr === "dark") {
    return "dark";
  }
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.classList.toggle("dark", theme === "dark");
}

function useThemeToggle(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>("dark");

  // Sync from the SSR-rendered <html> on mount (avoids a hydration flip).
  useEffect(() => {
    setTheme(readInitialTheme());
  }, []);

  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      applyTheme(next);
      return next;
    });
  }, []);

  return [theme, toggle];
}

// ─── RecordroomShell ──────────────────────────────────────────────

interface RecordroomShellProps {
  /** Build crumb, e.g. "pdpp 0.1.0". */
  build?: string;
  children: ReactNode;
  /** Host line for the header crumb + sidebar foot, e.g. "rs.owner.example.net". */
  host?: string;
  /** Called when the ⌘K jump affordance is activated (open a command palette). */
  onJump?: () => void;
}

export function RecordroomShell({
  children,
  host = "this server",
  build = "pdpp 0.1.0",
  onJump,
}: RecordroomShellProps) {
  const pathname = usePathname() ?? "/dashboard";
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // ⌘K / Ctrl+K → jump; Escape closes the drawer.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onJump?.();
      }
      if (e.key === "Escape") {
        setDrawerOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onJump]);

  return (
    <div className="rr-app">
      {/* ─── Desktop sidebar ─── */}
      <aside className="rr-side">
        <div className="rr-side__brand">
          <BrandMark />
          <span className="rr-side__name">Recordroom</span>
        </div>
        <nav aria-label="Primary" className="rr-side__nav">
          <NavList pathname={pathname} />
        </nav>
        <div className="rr-side__spacer" />
        <FootBlock build={build} host={host} />
      </aside>

      {/* ─── Main column ─── */}
      <main className="rr-main">
        <header className="rr-head">
          <span className="rr-head__brand">
            <BrandMark />
            <span>Recordroom</span>
          </span>
          <span className="rr-head__crumb">
            {host} · {build}
          </span>
          <div className="rr-head__actions">
            {/* Jump (⌘K) renders ONLY when a caller wires onJump — no dead
                affordance. The ⌘K keydown below is likewise a no-op without
                a handler. Pages that mount a command palette pass onJump. */}
            {onJump ? (
              <button className="rr-chrome-btn" onClick={() => onJump()} type="button">
                Jump <span className="rr-kbd">⌘K</span>
              </button>
            ) : null}
            <button
              aria-expanded={drawerOpen}
              className="rr-chrome-btn rr-menu-btn"
              onClick={() => setDrawerOpen(true)}
              type="button"
            >
              Menu
            </button>
          </div>
        </header>
        <div className="rr-content">{children}</div>
      </main>

      {/* ─── Mobile drawer ─── */}
      {drawerOpen && (
        <div className="rr-drawer-overlay">
          {/* A real button is the backdrop so keyboard users get a focusable
              close affordance; Escape also closes (wired globally above). */}
          <button aria-label="Close menu" className="rr-drawer-scrim" onClick={closeDrawer} type="button" />
          <nav aria-label="Primary" className="rr-drawer">
            <div className="rr-side__brand">
              <BrandMark />
              <span className="rr-side__name">Recordroom</span>
            </div>
            <div className="rr-drawer__nav">
              <NavList onNavigate={closeDrawer} pathname={pathname} />
            </div>
            <FootBlock build={build} host={host} />
          </nav>
        </div>
      )}
    </div>
  );
}
