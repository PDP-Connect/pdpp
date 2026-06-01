"use client";

import { siteNav } from "@pdpp/brand/chrome";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";

// The shared brand `siteNav` is consumed by both the public site (`apps/site`)
// and the legacy combined app (`apps/web`). It still lists the operator
// console's `/dashboard`, which lives on a SEPARATE origin from the public
// site (proposal: "public surfaces SHALL NOT share an origin with a live
// operator dashboard"). The public site has no `/dashboard` route, so linking
// to it would 404 on this origin and would send a mock-owner visitor out of
// the public surface. Filter operator-console links out of the public header.
// The brand package and `apps/web`'s nav (which DOES serve `/dashboard`) are
// intentionally left untouched.
const OPERATOR_CONSOLE_LINK_RE = /^\/dashboard(?:\/|$)/;
const publicSiteNav = siteNav.filter((item) => !OPERATOR_CONSOLE_LINK_RE.test(item.link));

export function SiteHeader({
  currentLabel,
  showThemeToggle = true,
}: {
  currentLabel: string;
  showThemeToggle?: boolean;
}) {
  const pathname = usePathname();
  const isHome = pathname === "/";

  return (
    <div className="flex items-center gap-2">
      <Link aria-label="PDPP home" className="flex shrink-0 items-center gap-2" href="/">
        <PdppLogo size={22} title="" variant="mark" />
        <span className="font-semibold text-sm tracking-tight" style={{ color: "var(--foreground)" }}>
          PDPP
        </span>
      </Link>
      {isHome ? (
        // Reserved spacer keeps the nav anchored at the same x as on subpages
        // (desktop only — on mobile we don't pad to avoid overflow).
        <span aria-hidden="true" className="hidden md:inline-block md:min-w-[9.5rem]" />
      ) : (
        // Breadcrumb label is desktop-only; on mobile the active nav pill
        // already indicates the current page (avoids "Docs / Docs" collision).
        <span className="hidden items-center gap-2 md:flex">
          <span style={{ color: "var(--muted-foreground)", opacity: 0.4 }}>/</span>
          <span className="whitespace-nowrap text-sm md:min-w-[8.5rem]" style={{ color: "var(--muted-foreground)" }}>
            {currentLabel}
          </span>
        </span>
      )}
      <nav className="ml-auto flex items-center gap-1 md:ml-0">
        {publicSiteNav.map((item) => {
          const active = pathname === item.link || pathname.startsWith(`${item.link}/`);

          return (
            <Link
              className="rounded-full px-3 py-1.5 text-xs transition-colors"
              href={item.link}
              key={item.link}
              style={{
                backgroundColor: active ? "var(--foreground)" : "transparent",
                color: active ? "var(--background)" : "var(--muted-foreground)",
              }}
            >
              {item.text}
            </Link>
          );
        })}
        {showThemeToggle ? <ThemeToggle className="ml-1" /> : null}
      </nav>
    </div>
  );
}
