/**
 * RecordroomShell — the Ink Carbon owner-console frame.
 *
 * (Component/CSS identifiers keep the internal `Recordroom`/`rr-*` names; the
 * owner-visible wordmark is `PDPP` with the PDPP split-P mark.)
 *
 * The dependency root of the redesigned console: a left sidebar (brand mark +
 * grouped nav + footer host block) and a main column with a sticky header
 * (⌘K jump affordance, theme toggle, mobile menu) wrapping `{children}`. The
 * `{host} · {build}` crumb lives in the sidebar/drawer footer only — not the
 * header — so it renders exactly once. On narrow screens the sidebar folds into
 * a drawer overlay.
 *
 * Ported from `rr-app.jsx` (the design SHELL) and rebound to the REAL app:
 *
 * NAV RECONCILIATION (design groups vs real routes):
 *   The shell uses owner-facing labels for the real routes the dashboard
 *   enforces (those routes are pinned by next.config.mjs redirects + tests).
 *   The labels answer the owner's core questions:
 *     - "Overview" -> where the instance stands and what needs attention.
 *     - "Explore" -> the reader for records already in this instance.
 *     - "Sources" -> configured data sources and their streams.
 *     - "Syncs" -> the clean Syncs route `/syncs`, using the warmer
 *       owner-facing label from the page title. See SYNCS_NOTE below.
 *     - "Schedules" -> the real schedule management route.
 *     - "Notifications" -> device-level owner-action alert setup.
 *     - "Connect AI apps" -> reader/client access, grouped with sharing, not
 *       source collection.
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

// SYNCS_NOTE: the owner-facing "Syncs" group item has no dedicated real route;
// it points at the real Runs route, whose page title is also Syncs.

export interface NavItem {
  /** Real route href (pinned by redirects/tests). */
  href: string;
  /** Display label (design vocabulary where it maps). */
  label: string;
}

export interface NavGroup {
  /** Group heading; null for the ungrouped orientation items. */
  heading: string | null;
  items: NavItem[];
}

/**
 * The grouped nav. Routes are the REAL clean console routes (top-level nouns
 * off root, per `redesign-owner-console-product-experience` §10.B); labels
 * follow the design vocabulary. Edit this array to change nav — components
 * derive from it.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: null,
    items: [
      { label: "Overview", href: "/" },
      { label: "Explore", href: "/explore" },
    ],
  },
  {
    heading: "Collection",
    items: [
      { label: "Sources", href: "/sources" },
      { label: "Syncs", href: "/syncs" },
      { label: "Schedules", href: "/schedules" },
    ],
  },
  {
    heading: "Sharing",
    items: [
      { label: "Connect AI apps", href: "/connect" },
      { label: "Grants", href: "/grants" },
      { label: "Audit", href: "/audit" },
    ],
  },
  {
    heading: "Server",
    items: [
      { label: "Notifications", href: "/notifications" },
      { label: "Deployment", href: "/deployment" },
      { label: "Device exporters", href: "/device-exporters" },
      { label: "Event subscriptions", href: "/event-subscriptions" },
    ],
  },
];

/** Flat list of every nav item, for ⌘K palettes and tests. */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

// ─── Active-route matching ────────────────────────────────────────
//
// `/` (Overview) must match ONLY itself — every other route is a top-level
// noun off root, so an exact match is required for the root and a prefix match
// (segment-boundary aware) for the rest.
export function isNavItemActive(href: string, pathname: string): boolean {
  if (href === "/") {
    return pathname === "/";
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ─── Brand mark — the PDPP split-P ────────────────────────────────
//
// The owner-visible mark is the actual PDPP logo (the split-P): a warm
// human/holder left half and a cool protocol/issuer right half, seamed on the
// optical vertical with a counter in the upper bowl. The geometry is the
// canonical mark from the identity handoff (identity/logo_study.html), the same
// construction operator-ui's `PdppLogo` renders.
//
// It is inlined here rather than imported so `@pdpp/brand-react` stays a leaf
// brand package with no dependency on `@pdpp/operator-ui` (the console → shared
// dependency direction is one-way). This keeps the package-boundary contract
// intact while still shipping the real logo, not a placeholder shape. The hues
// are CSS custom properties so the mark tracks the active Ink Carbon surface.
function BrandMark() {
  return (
    <svg aria-hidden="true" className="rr-side__mark" height="18" role="presentation" viewBox="0 0 200 200" width="18">
      {/* Left half — warm (human/holder) */}
      <path
        d="M 40 30 L 40 170 L 60 170 L 60 116 L 100 116 Q 105 116 105 110 L 105 30 Z"
        fill="var(--pdpp-mark-warm)"
      />
      {/* Right half — cool (protocol/issuer) */}
      <path
        d="M 105 30 L 105 110 Q 105 116 100 116 L 60 116 L 60 170 L 80 170 L 80 136 L 125 136 Q 155 136 155 103 Q 155 30 105 30 Z"
        fill="var(--pdpp-mark-cool)"
      />
      {/* Counter — optically centered in the upper bowl */}
      <circle cx="105" cy="73" fill="var(--pdpp-mark-counter)" r="18" />
    </svg>
  );
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
  const pathname = usePathname() ?? "/";
  const [drawerOpen, setDrawerOpen] = useState(false);

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // Escape closes the mobile drawer. The ⌘K / Ctrl+K palette shortcut is owned
  // by EXACTLY ONE listener — the command-palette provider that wraps the
  // dashboard — so this shell no longer registers its own ⌘K keydown. When both
  // this shell and the provider listened, a single ⌘K flipped the palette state
  // twice (net no-op: the palette appeared not to open and never took focus).
  // The header Jump button still calls `onJump` directly; keyboard toggling is
  // the provider's job.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setDrawerOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="rr-app">
      {/* ─── Desktop sidebar ─── */}
      <aside className="rr-side">
        <div className="rr-side__brand">
          <BrandMark />
          <span className="rr-side__name">PDPP</span>
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
            <span>PDPP</span>
          </span>
          {/* The `{host} · {build}` crumb renders in exactly ONE owner-facing
              place: the sidebar/drawer FootBlock. It used to also render here in
              the header, so the owner saw it twice (top and bottom). Keeping it
              only in the nav footer removes the duplication. */}
          <div className="rr-head__actions">
            {/* Jump (⌘K) renders ONLY when a caller wires onJump — no dead
                affordance. The ⌘K shortcut itself is owned by the palette
                provider, not this shell. Pages that mount a command palette
                pass onJump so the button and the shortcut open the same one. */}
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
              <span className="rr-side__name">PDPP</span>
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
