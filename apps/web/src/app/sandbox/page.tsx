/**
 * Sandbox launcher.
 *
 * `/sandbox` is the mock-owner entrypoint into the reference dashboard.
 * It is intentionally thin: a short framing paragraph, a primary CTA
 * into the dashboard at `/sandbox/overview`, and secondary links to
 * the supporting educational surfaces (API examples, walkthrough).
 *
 * The substantive demo experience is the dashboard itself, rendered in
 * mock-owner mode. The launcher is the only place that frames the
 * environment as simulated; once the visitor enters the dashboard,
 * affordances live in the persistent sidebar footer.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { PdppLogo } from "@/components/pdpp-logo.tsx";
import { SiteHeader } from "@/components/site-header.tsx";

export const metadata: Metadata = {
  title: "PDPP reference instance · Sandbox",
  description:
    "Enter the PDPP reference dashboard as a mock owner. Deterministic fictional data, no credentials, no live calls.",
};

export const dynamic = "force-static";

const HIGHLIGHTS = [
  {
    title: "Records, search, grants, runs, traces",
    body: "The same operator views the live owner sees, bound to deterministic mock AS/RS data.",
  },
  {
    title: "Callable APIs",
    body: "/sandbox/v1/** and /sandbox/_ref/** mirror the reference envelopes. Curl them directly.",
  },
  {
    title: "Reset by reload",
    body: "All state lives in seeded fixtures. There's nothing real here, no cleanup needed.",
  },
] as const;

export default function SandboxLauncherPage() {
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
      <main className="mx-auto w-full max-w-3xl px-6 py-16 sm:px-8 md:px-10">
        <div className="mb-2 inline-flex items-center gap-2 text-muted-foreground">
          <PdppLogo className="h-5 w-5" />
          <span className="pdpp-eyebrow">Reference instance · sandbox</span>
        </div>
        <h1 className="pdpp-display mt-4 text-foreground">Inspect PDPP as a mock owner</h1>
        <p className="pdpp-body mt-4 max-w-2xl text-muted-foreground">
          The sandbox runs the PDPP reference dashboard against deterministic fictional data. Browse records, watch
          grants get issued and revoked, replay run timelines, and call the same APIs an integrator would call — all
          without credentials, Docker, or a local SQLite file. Everything you see is invented; the protocol behavior is
          real.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <Link
            className="pdpp-body inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 font-medium text-background transition-colors hover:bg-foreground/90"
            href="/sandbox/overview"
          >
            Enter mock-owner dashboard →
          </Link>
          <Link
            className="pdpp-body inline-flex items-center rounded-md border border-border px-4 py-2 text-foreground hover:bg-muted/60"
            href="/sandbox/api-examples"
          >
            API examples
          </Link>
          <Link
            className="pdpp-body inline-flex items-center rounded-md border border-border px-4 py-2 text-foreground hover:bg-muted/60"
            href="/sandbox/walkthrough"
          >
            Guided walkthrough
          </Link>
        </div>

        <ul className="mt-12 grid gap-4 sm:grid-cols-3">
          {HIGHLIGHTS.map((h) => (
            <li className="rounded-md border border-border/80 p-4" key={h.title}>
              <h2 className="pdpp-title text-foreground">{h.title}</h2>
              <p className="pdpp-caption mt-1 text-muted-foreground">{h.body}</p>
            </li>
          ))}
        </ul>

        <div className="mt-12 border-border/80 border-t pt-6">
          <h2 className="pdpp-title text-foreground">Boundaries</h2>
          <ul className="pdpp-caption mt-3 grid gap-1.5 text-muted-foreground sm:grid-cols-2">
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
            <li>
              <span className="font-mono text-foreground/70">/sandbox/v1/schema</span> ·{" "}
              <span className="font-mono text-foreground/70">/sandbox/v1/search</span>
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}
