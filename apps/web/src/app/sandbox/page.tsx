import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button.tsx";
import { SandboxWalkthrough } from "./sandbox-walkthrough.tsx";

export const metadata: Metadata = {
  title: "PDPP Sandbox - Try a scoped grant end to end",
  description:
    "An interactive, mock-backed PDPP walkthrough: a fictional client requests scoped pay-statement access, the owner approves a bounded grant, the resource server returns only granted fields, and revocation refuses the next read. No credentials, no live data.",
};

const audienceCards = [
  {
    eyebrow: "Reviewer",
    title: "See the surface a real owner approves",
    body: "Grant scope, fields, retention, and refusal evidence are all visible without reading the spec first.",
  },
  {
    eyebrow: "Implementer",
    title: "Inspect the API shapes",
    body: "Each step exposes a representative request/response so you can compare your own draft to the protocol.",
  },
  {
    eyebrow: "Skeptic",
    title: "Confirm scope is enforced, not implied",
    body: "Approve a grant, revoke it, and watch the simulated resource server refuse the next read.",
  },
] as const;

const guarantees = [
  "Everything below is fictional. No real Acme, Northwind, Quill Tax, payroll, or owner exists.",
  "No credential or token entry. The sandbox cannot connect to real platforms.",
  "State lives only in this browser tab. Reset returns you to step 0; closing the tab forgets it.",
  "JSON shapes are representative, not captured from a live reference run.",
] as const;

export default function SandboxPage() {
  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem]"
        style={{
          background:
            "radial-gradient(circle at 16% 18%, oklch(0.72 0.11 45 / 0.16), transparent 34%), radial-gradient(circle at 82% 10%, oklch(0.58 0.172 253.7 / 0.12), transparent 32%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <div className="pdpp-eyebrow text-muted-foreground">Sandbox / Mock educational surface</div>
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
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/reference/coverage">
                See coverage matrix
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
              This is the public sandbox: a single coherent PDPP scenario you can click through. It does not run the
              reference server, host owner accounts, or accept credentials.
            </p>
            <ul className="mt-4 space-y-2">
              {guarantees.map((line) => (
                <li className="grid grid-cols-[0.6rem_minmax(0,1fr)] gap-2.5" key={line}>
                  <span className="mt-2 h-1.5 rounded-full bg-primary" />
                  <span className="pdpp-caption text-muted-foreground">{line}</span>
                </li>
              ))}
            </ul>
          </aside>
        </section>

        <section className="mt-12" id="walkthrough">
          <SandboxWalkthrough />
        </section>

        <section className="mt-14 grid gap-3 md:grid-cols-3">
          {audienceCards.map((card) => (
            <article className="rounded-2xl border bg-card/70 p-5" key={card.title}>
              <div className="pdpp-eyebrow text-muted-foreground">{card.eyebrow}</div>
              <h2 className="pdpp-title mt-2 text-foreground">{card.title}</h2>
              <p className="pdpp-caption mt-2 text-muted-foreground">{card.body}</p>
            </article>
          ))}
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]">
          <div>
            <h2 className="pdpp-heading text-foreground">What this sandbox isn't</h2>
            <p className="pdpp-body mt-2 text-muted-foreground">
              Keeping artifact boundaries crisp is part of the protocol's contract with reviewers.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Boundary
              body="Operator views run against a real local or self-hosted reference instance with owner auth. They are intentionally out of scope here."
              eyebrow="Not the dashboard"
              href="/reference"
              hrefLabel="See the surface map"
              title="/dashboard is for live operation"
            />
            <Boundary
              body="When the sandbox and the docs disagree, trust the docs. The sandbox is pedagogy, not a conformance suite."
              eyebrow="Not the protocol"
              href="/docs"
              hrefLabel="Read the docs"
              title="/docs holds normative semantics"
            />
            <Boundary
              body="Vana does not host a canonical PDPP owner instance. To run one, fork the repo and use the Docker compose stack."
              eyebrow="Not a hosted service"
              href="/reference"
              hrefLabel="Self-host instructions"
              title="No live reference instance"
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function Boundary({
  eyebrow,
  title,
  body,
  href,
  hrefLabel,
}: {
  eyebrow: string;
  title: string;
  body: string;
  href: string;
  hrefLabel: string;
}) {
  return (
    <article className="flex flex-col rounded-2xl border bg-card/70 p-5">
      <div className="pdpp-eyebrow text-muted-foreground">{eyebrow}</div>
      <h3 className="pdpp-title mt-2 text-foreground">{title}</h3>
      <p className="pdpp-caption mt-2 text-muted-foreground">{body}</p>
      <Link
        className="pdpp-caption mt-3 self-start text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground"
        href={href}
      >
        {hrefLabel} -&gt;
      </Link>
    </article>
  );
}
