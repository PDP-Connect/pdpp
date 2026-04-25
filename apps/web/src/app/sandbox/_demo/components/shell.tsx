import Link from "next/link";
import type { ReactNode } from "react";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { ThemeToggle } from "@/components/theme/theme-toggle.tsx";

export type SandboxSection =
  | "overview"
  | "records"
  | "search"
  | "grants"
  | "runs"
  | "traces"
  | "deployment"
  | "api"
  | "walkthrough";

interface NavItem {
  href: string;
  label: string;
  match: SandboxSection;
}

const NAV: readonly NavItem[] = [
  { href: "/sandbox", label: "Overview", match: "overview" },
  { href: "/sandbox/records", label: "Records", match: "records" },
  { href: "/sandbox/search", label: "Search", match: "search" },
  { href: "/sandbox/grants", label: "Grants", match: "grants" },
  { href: "/sandbox/runs", label: "Runs", match: "runs" },
  { href: "/sandbox/traces", label: "Traces", match: "traces" },
  { href: "/sandbox/deployment", label: "Deployment", match: "deployment" },
  { href: "/sandbox/api-examples", label: "API examples", match: "api" },
  { href: "/sandbox/walkthrough", label: "Walkthrough", match: "walkthrough" },
] as const;

/**
 * Demo-instance shell. Mirrors the live `/dashboard` chrome so visitors see
 * the same operator concepts, but never imports owner-token clients and
 * always carries the "Demo instance / fictional data" label.
 */
export function SandboxShell({ active, children }: { active: SandboxSection; children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <DemoBanner />
      <div className="grid min-h-[calc(100vh-2.25rem)] md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="sticky top-9 hidden h-[calc(100vh-2.25rem)] flex-col justify-between py-6 pr-4 pl-6 md:flex">
          <div>
            <Link className="pdpp-body group inline-flex items-center gap-2 font-semibold" href="/sandbox">
              <PdppLogo className="h-5 w-5" />
              <span className="tracking-tight">pdpp</span>
              <span className="pdpp-caption font-normal text-muted-foreground">demo instance</span>
            </Link>
            <nav aria-label="Sandbox navigation" className="mt-6 flex flex-col gap-0.5">
              {NAV.map((item) => {
                const isActive = item.match === active;
                return (
                  <Link
                    aria-current={isActive ? "page" : undefined}
                    className={[
                      "pdpp-body relative rounded-md px-2.5 py-1.5 transition-colors",
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
            </nav>
            <div className="mt-6 border-border/80 border-t pt-4">
              <div className="pdpp-eyebrow mb-2 px-2.5">Boundaries</div>
              <ul className="pdpp-caption flex flex-col gap-1.5 px-2.5 text-muted-foreground">
                <li>
                  <Link className="hover:text-foreground hover:underline" href="/reference">
                    Reference surface map →
                  </Link>
                </li>
                <li>
                  <Link className="hover:text-foreground hover:underline" href="/docs">
                    Protocol docs →
                  </Link>
                </li>
                <li>
                  <Link className="hover:text-foreground hover:underline" href="/reference/coverage">
                    Coverage matrix →
                  </Link>
                </li>
              </ul>
            </div>
          </div>
        </aside>
        <div className="min-w-0 border-border/80 border-l bg-background md:border-l">
          <div className="sticky top-9 z-30 flex h-12 items-center justify-between gap-3 border-border/80 border-b bg-background/90 px-6 backdrop-blur sm:px-8 md:px-10">
            <Link className="pdpp-body inline-flex items-center gap-2 font-semibold md:hidden" href="/sandbox">
              <PdppLogo className="h-5 w-5" />
              pdpp
            </Link>
            <div className="flex-1" />
            <span className="pdpp-eyebrow hidden items-center gap-2 rounded-full border border-amber-400/40 bg-amber-400/10 px-2.5 py-0.5 text-amber-700 sm:inline-flex dark:text-amber-300">
              Demo · fictional data
            </span>
            <ThemeToggle />
          </div>
          <main className="mx-auto w-full max-w-[1400px] px-6 py-8 sm:px-8 md:px-10">{children}</main>
        </div>
      </div>
    </div>
  );
}

function DemoBanner() {
  return (
    <div
      className="sticky top-0 z-40 flex h-9 items-center justify-center gap-2 border-amber-500/30 border-b bg-amber-500/10 px-4 text-amber-900 text-xs dark:text-amber-200"
      role="note"
    >
      <span className="pdpp-eyebrow">Sandbox demo instance</span>
      <span aria-hidden className="text-amber-700/50 dark:text-amber-300/50">
        ·
      </span>
      <span className="text-[0.7rem] sm:text-xs">
        Deterministic fictional data. Not connected to real services. Reset by reloading.
      </span>
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
