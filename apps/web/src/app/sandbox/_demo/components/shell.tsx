/**
 * Educational-pages shell for `/sandbox/api-examples` and
 * `/sandbox/walkthrough`. These are supporting docs surfaces — they
 * frame and supplement the mock-owner dashboard without dragging
 * dashboard chrome into a docs context.
 *
 * Primary `/sandbox/**` dashboard pages use the live `DashboardShell`
 * in mock-owner mode. `/sandbox` itself is the mock-owner overview.
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { SiteHeader } from "@/components/site-header.tsx";

export type SandboxEducationalSection = "api" | "walkthrough";

interface NavItem {
  href: string;
  label: string;
  match: SandboxEducationalSection;
}

const NAV: readonly NavItem[] = [
  { href: "/sandbox/api-examples", label: "API examples", match: "api" },
  { href: "/sandbox/walkthrough", label: "Guided walkthrough", match: "walkthrough" },
] as const;

/**
 * Lightweight shell for the supporting educational pages. Renders the
 * site header plus a small navigation row pointing back to the
 * mock-owner dashboard and across the educational pages. No
 * dashboard sidebar; the educational pages are docs, not operator views.
 */
export function SandboxEducationalShell({
  active,
  children,
}: {
  active: SandboxEducationalSection;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header
        className="sticky top-0 z-40 flex h-12 items-center px-5 md:px-6"
        style={{
          backgroundColor: "var(--background)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <SiteHeader currentLabel="Sandbox" />
      </header>
      <div className="border-border/80 border-b">
        <div className="mx-auto flex w-full max-w-[1100px] items-center justify-between gap-3 px-6 py-3 sm:px-8 md:px-10">
          <Link className="pdpp-body inline-flex items-center gap-2 font-semibold text-foreground" href="/sandbox">
            <PdppLogo className="h-5 w-5" />
            <span className="tracking-tight">pdpp</span>
            <span className="pdpp-caption font-normal text-muted-foreground">reference instance</span>
          </Link>
          <nav aria-label="Sandbox educational" className="flex items-center gap-1">
            {NAV.map((item) => {
              const isActive = item.match === active;
              return (
                <Link
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "pdpp-caption rounded-md px-2.5 py-1 transition-colors",
                    isActive
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  ].join(" ")}
                  href={item.href}
                  key={item.href}
                >
                  {item.label}
                </Link>
              );
            })}
            <Link
              className="pdpp-caption rounded-md px-2.5 py-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              href="/sandbox"
            >
              Open dashboard →
            </Link>
          </nav>
        </div>
      </div>
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-6 py-8 sm:px-8 md:px-10">{children}</main>
    </div>
  );
}

export function SandboxEmpty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="rounded-md border border-border/80 border-dashed px-4 py-10 text-center">
      <p className="pdpp-body font-medium text-foreground">{title}</p>
      {hint ? <p className="pdpp-body mx-auto mt-1 max-w-md text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
