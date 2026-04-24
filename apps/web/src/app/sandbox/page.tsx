import type { Metadata } from "next";
import Link from "next/link";
import type React from "react";
import { buttonVariants } from "@/components/ui/button.tsx";

export const metadata: Metadata = {
  title: "Mock Sandbox - PDPP",
  description:
    "A clearly labeled placeholder for a future mock-backed PDPP sandbox with seeded data, resettable state, and no real credentials.",
};

const sandboxContract = [
  {
    title: "Mock-backed only",
    body: "The sandbox will use seeded records, mock connector manifests, and simulated authorization events. It will not connect to real platform accounts.",
  },
  {
    title: "No real credentials",
    body: "Visitors will not be asked for Gmail, GitHub, bank, payroll, or other platform credentials. Any login-like UI must be specimen copy.",
  },
  {
    title: "Resettable state",
    body: "Walkthrough state should be disposable and reset between sessions so a visitor cannot mistake it for a durable owner account.",
  },
  {
    title: "Protocol-flow walkthroughs",
    body: "The goal is to teach request, consent, grant, query, revocation, collection, and retrieval extension shapes with inspectable examples.",
  },
  {
    title: "Distinct from dashboard",
    body: "The sandbox may reuse display primitives, but its chrome and copy must stay visibly simulated, unlike the live operator dashboard.",
  },
] as const;

const plannedWalkthroughs = [
  "Client requests scoped pay-statement access",
  "Owner approves a bounded grant",
  "App reads only granted fields",
  "Owner revokes access and sees refusal evidence",
  "Mock connector emits RECORD and STATE messages",
  "Lexical and semantic search explain candidate references",
] as const;

export default function SandboxPage() {
  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[30rem]"
        style={{
          background:
            "radial-gradient(circle at 16% 18%, oklch(0.72 0.11 45 / 0.16), transparent 34%), radial-gradient(circle at 82% 10%, oklch(0.58 0.172 253.7 / 0.12), transparent 32%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_23rem]">
          <div>
            <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Mock educational surface</div>
            <h1 className="pdpp-display mt-3 max-w-4xl text-foreground">
              A pedagogical PDPP sandbox, not a live owner dashboard.
            </h1>
            <p className="pdpp-body-lg mt-5 max-w-3xl text-muted-foreground">
              This placeholder defines the sandbox contract before the full runtime exists. The future sandbox should
              teach protocol flows with seeded data, resettable state, and no real credentials or owner records.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Link className={buttonVariants({ variant: "default", size: "lg" })} href="/reference/coverage">
                View coverage matrix
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/reference">
                Reference explainer
              </Link>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/docs">
                Protocol docs
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border border-dashed bg-card/80 p-5 shadow-sm backdrop-blur">
            <div className="pdpp-eyebrow text-muted-foreground">Current state</div>
            <div className="pdpp-heading mt-3 text-foreground">Placeholder only</div>
            <p className="pdpp-caption mt-3 text-muted-foreground">
              There is no credential entry, no live connector connection, no hosted owner account, and no operational
              dashboard state on this surface.
            </p>
          </aside>
        </section>

        <section className="mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sandboxContract.map((item) => (
            <article className="rounded-2xl border bg-card/70 p-5" key={item.title}>
              <h2 className="pdpp-title text-foreground">{item.title}</h2>
              <p className="pdpp-caption mt-2 text-muted-foreground">{item.body}</p>
            </article>
          ))}
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <div>
            <h2 className="pdpp-heading text-foreground">Planned walkthroughs</h2>
            <p className="pdpp-body mt-2 text-muted-foreground">
              These are education targets, not claims that the public sandbox runtime exists today.
            </p>
          </div>
          <div className="rounded-2xl border bg-card/70 p-4">
            <ol className="grid gap-3 md:grid-cols-2">
              {plannedWalkthroughs.map((item, index) => (
                <li className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-xl bg-background/60 p-3" key={item}>
                  <span className="pdpp-caption flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    {index + 1}
                  </span>
                  <span className="pdpp-caption self-center text-foreground">{item}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="mt-14 rounded-2xl border bg-card/70 p-5">
          <div className="pdpp-eyebrow text-muted-foreground">Artifact boundary</div>
          <p className="pdpp-body mt-3 max-w-4xl text-muted-foreground">
            Protocol docs at <LinkLabel href="/docs">/docs</LinkLabel> remain normative. The reference explainer at{" "}
            <LinkLabel href="/reference">/reference</LinkLabel> describes forkable implementation behavior. The live
            dashboard at <span className="font-mono text-foreground">/dashboard</span> is for authenticated operation of
            a running instance. This sandbox is for simulated learning only.
          </p>
        </section>
      </div>
    </main>
  );
}

function LinkLabel({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      className="text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
      href={href}
    >
      {children}
    </Link>
  );
}
