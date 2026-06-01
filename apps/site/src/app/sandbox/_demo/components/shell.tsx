/**
 * Standalone shell for sandbox support pages that should not inherit the
 * dashboard sidebar. Primary `/sandbox/**` pages use `DashboardShell`.
 */

import type { ReactNode } from "react";
import { SiteHeader } from "@/components/site-header.tsx";

/**
 * Lightweight shell for support pages. It renders only the site header and
 * page content; page-level CTAs decide where the user should go next.
 */
export function SandboxEducationalShell({ children }: { children: ReactNode }) {
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
