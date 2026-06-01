import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button.tsx";
import { SandboxEducationalShell } from "../_demo/components/shell.tsx";
import { SandboxWalkthrough } from "./sandbox-walkthrough.tsx";

export const metadata: Metadata = {
  title: "PDPP Sandbox walkthrough - scoped grant end to end",
  description:
    "An interactive PDPP reference scenario: a client requests scoped pay-statement access, the owner approves a bounded grant, the resource server returns only granted fields, and revocation refuses the next read.",
};

export default function WalkthroughPage() {
  return (
    <SandboxEducationalShell>
      <div className="relative mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Guided walkthrough</div>
            <h1 className="pdpp-display mt-3 max-w-4xl text-foreground">Inspect a scoped PDPP grant lifecycle.</h1>
            <p className="pdpp-body-lg mt-5 max-w-3xl text-muted-foreground">
              Advance through request staging, owner consent, bounded resource reads, revocation, and refused replay.
              The transcript shows the API-shaped artifact for each step.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link className={buttonVariants({ variant: "default", size: "lg" })} href="#walkthrough">
                Start the walkthrough
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/sandbox">
                Open sandbox dashboard
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/docs">
                Protocol docs
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border bg-card/80 p-5 shadow-sm backdrop-blur">
            <div className="pdpp-eyebrow text-muted-foreground">Scenario posture</div>
            <div className="pdpp-heading mt-2 text-foreground">Compact lifecycle view</div>
            <p className="pdpp-caption mt-3 text-muted-foreground">
              This page isolates one grant lifecycle for quick review. For the full reference instance, use the{" "}
              <Link className="underline underline-offset-2" href="/sandbox">
                sandbox dashboard
              </Link>
              .
            </p>
          </aside>
        </section>

        <section className="mt-12" id="walkthrough">
          <SandboxWalkthrough />
        </section>
      </div>
    </SandboxEducationalShell>
  );
}
