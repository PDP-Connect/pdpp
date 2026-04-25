import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button.tsx";
import { SandboxWalkthrough } from "./sandbox-walkthrough.tsx";

export const metadata: Metadata = {
  title: "PDPP Sandbox walkthrough - scoped grant end to end",
  description:
    "An interactive, mock-backed PDPP walkthrough: a fictional client requests scoped pay-statement access, the owner approves a bounded grant, the resource server returns only granted fields, and revocation refuses the next read.",
};

export default function WalkthroughPage() {
  return (
    <main className="relative overflow-hidden">
      <div className="relative mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Guided walkthrough</div>
            <h1 className="pdpp-display mt-3 max-w-4xl text-foreground">
              A scoped PDPP grant, end to end, in your browser.
            </h1>
            <p className="pdpp-body-lg mt-5 max-w-3xl text-muted-foreground">
              Click through a fictional tax-prep app asking a fictional owner for three pay statements. Approve the
              grant, see only the granted fields come back, then revoke and watch the next read get refused. The
              transcript on the right shows the API-shaped JSON for each step.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link className={buttonVariants({ variant: "default", size: "lg" })} href="#walkthrough">
                Start the walkthrough
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/sandbox">
                Back to demo overview
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/docs">
                Protocol docs
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border bg-card/80 p-5 shadow-sm backdrop-blur">
            <div className="pdpp-eyebrow text-muted-foreground">What this is</div>
            <div className="pdpp-heading mt-2 text-foreground">Simulated, not hosted</div>
            <p className="pdpp-caption mt-3 text-muted-foreground">
              A single coherent PDPP scenario you can click through. State lives only in this browser tab. It does not
              run the reference server, host owner accounts, or accept credentials. For a broader demo with callable
              APIs, see the{" "}
              <Link className="underline underline-offset-2" href="/sandbox">
                sandbox demo instance
              </Link>
              .
            </p>
          </aside>
        </section>

        <section className="mt-12" id="walkthrough">
          <SandboxWalkthrough />
        </section>
      </div>
    </main>
  );
}
