import { ConnectAgentCard } from "@pdpp/operator-ui/components/connect-agent-card";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

const GITHUB_REPO = "https://github.com/vana-com/pdpp";
const GITHUB_REFERENCE_README = `${GITHUB_REPO}/blob/main/reference-implementation/README.md`;
const GITHUB_ROOT_README = `${GITHUB_REPO}/blob/main/README.md`;
const GITHUB_DOCKER_README = `${GITHUB_REPO}/blob/main/deploy/docker/README.md`;
const GITHUB_FLY_README = `${GITHUB_REPO}/blob/main/deploy/flyio/README.md`;
const RAILWAY_DEPLOY_URL =
  "https://railway.com/new/template/pdpp-core-template-source?utm_medium=integration&utm_source=button&utm_campaign=pdpp-core";

export const metadata: Metadata = {
  title: "Reference Implementation - PDPP",
  description:
    "A public explainer for the forkable PDPP reference implementation: purpose, architecture, trust boundaries, and local/self-hosted operation.",
};

async function getRequestOrigin(): Promise<string> {
  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3002";
  const protocol =
    headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");
  return `${protocol}://${host}`;
}

const architectureLayers = [
  {
    label: "Protocol authority",
    route: "/docs",
    title: "PDPP docs",
    body: "Normative protocol semantics, extension docs, grant shapes, query behavior, and intentionally deferred scope.",
  },
  {
    label: "Reference authority",
    route: "/reference",
    title: "Forkable implementation",
    body: "Current code, tests, dashboards, example clients, and operator diagnostics for one implementation of PDPP.",
  },
  {
    label: "Live instance",
    route: "/dashboard",
    title: "Operator dashboard",
    body: "A stateful control plane for a running local or self-hosted instance. It is not a public hosted demo.",
  },
  {
    label: "Reference sandbox",
    route: "/sandbox",
    title: "Mock-adapter reference instance",
    body: "A mock-adapter-backed reference instance with deterministic data. Browse connectors, streams, records, grants, runs, traces, and call sandbox-prefixed AS/RS-shaped APIs.",
  },
] as const;

const trustBoundaries = [
  "The protocol docs define PDPP semantics; the reference implementation demonstrates one executable interpretation.",
  "Reference-only headers, traces, timelines, and deployment diagnostics are operator aids, not protocol negotiation.",
  "The dashboard reads live instance state and should be protected with owner auth when exposed beyond local development.",
  "The public website does not imply that Vana operates a canonical live PDPP owner dashboard for real data.",
] as const;

const referenceLinks = [
  {
    label: "Coverage",
    title: "Public coverage matrix",
    href: "/reference/coverage",
    body: "Falsifiable status rows for protocol flows, retrieval extensions, collection profiles, reference diagnostics, sandbox, and deferred scope.",
  },
  {
    label: "Sandbox",
    title: "Mock reference demo instance",
    href: "/sandbox",
    body: "Browse a public PDPP reference surface backed by deterministic mock adapters. Inspect records, grants, runs, and traces, then call sandbox-prefixed AS/RS-shaped APIs (/sandbox/v1/**, /sandbox/_ref/**, /sandbox/.well-known/**).",
  },
  {
    label: "Repository",
    title: "GitHub source",
    href: GITHUB_REPO,
    body: "Browse the monorepo, issues, tests, Docker files, and reference package.",
  },
  {
    label: "Start here",
    title: "Root README",
    href: GITHUB_ROOT_README,
    body: "Repo overview, dev commands, Docker image posture, and top-level project map.",
  },
  {
    label: "Run/deploy",
    title: "Reference README",
    href: GITHUB_REFERENCE_README,
    body: "Local stack, direct AS/RS mode, Docker Compose, owner auth, and generated artifacts.",
  },
  {
    label: "Architecture",
    title: "Architecture docs",
    href: "/docs/spec-architecture",
    body: "Protocol-facing architecture notes. Treat repo package topology as reference behavior unless specified by docs.",
  },
  {
    label: "Planning",
    title: "OpenSpec change history",
    href: "/planning",
    body: "Project planning and active changes. Useful for review context, but not protocol authority.",
  },
] as const;

export default async function ReferencePage() {
  const providerUrl = await getRequestOrigin();

  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[28rem]"
        style={{
          background:
            "radial-gradient(circle at 18% 20%, oklch(0.58 0.172 253.7 / 0.12), transparent 34%), radial-gradient(circle at 82% 8%, oklch(0.72 0.11 45 / 0.12), transparent 32%)",
        }}
      />
      <div className="relative mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
        <section className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            <div className="pdpp-eyebrow text-muted-foreground">Reference implementation</div>
            <h1 className="pdpp-display mt-3 max-w-4xl text-foreground">
              The forkable PDPP implementation, not the protocol authority.
            </h1>
            <p className="pdpp-body-lg mt-5 max-w-3xl text-muted-foreground">
              This surface explains the runnable code in this repository: the authorization server, resource server,
              local composition, dashboard, reference clients, tests, and deployment posture. For normative protocol
              behavior, use the protocol docs.
            </p>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <a className={buttonVariants({ variant: "default", size: "lg" })} href={GITHUB_REFERENCE_README}>
                Clone and run
              </a>
              <Link className={buttonVariants({ variant: "outline", size: "lg" })} href="/docs">
                Read protocol docs
              </Link>
            </div>
          </div>

          <aside className="rounded-2xl border bg-card/80 p-4 shadow-sm backdrop-blur">
            <div className="pdpp-eyebrow text-muted-foreground">Run posture</div>
            <div className="mt-4 space-y-4">
              <CalloutMetric label="Local app" value={providerUrl} />
              <CalloutMetric label="Operator surface" value="/dashboard" />
              <CalloutMetric label="Public sandbox" value="/sandbox" />
            </div>
            <p className="pdpp-caption mt-5 text-muted-foreground">
              The dashboard is an operator surface for a running instance. It is hidden or unavailable on public docs
              deploys unless that deployment intentionally enables a live reference stack.
            </p>
          </aside>
        </section>

        <div className="mt-10">
          <ConnectAgentCard mode="live" providerUrl={providerUrl} />
        </div>

        <section className="mt-14">
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="pdpp-heading text-foreground">Run your own node</h2>
            <p className="pdpp-body text-muted-foreground">
              Start with one click in the cloud or one command on your machine. Production compose and other platforms
              are available when you need them.
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <DeployCard
              action={
                <a className={buttonVariants({ variant: "default" })} href={RAILWAY_DEPLOY_URL}>
                  Deploy on Railway
                </a>
              }
              body="One click provisions the Core node and Postgres. You choose one thing: your owner password."
              eyebrow="Cloud, one click"
              title="Deploy on Railway"
            />
            <DeployCard
              action={
                <a className={buttonVariants({ variant: "outline" })} href={GITHUB_DOCKER_README}>
                  Docker runbook
                </a>
              }
              body="One command starts a full node on your laptop. First boot prints your dashboard URL and a generated owner password - nothing to configure."
              code={`docker run -d --name pdpp -p 3000:3000 -v pdpp_data:/var/lib/pdpp \\
  ghcr.io/vana-com/pdpp/railway-core:main
docker logs -f pdpp`}
              eyebrow="Your machine, one command"
              footer="Open http://localhost:3000/dashboard and sign in with the printed password. Your data persists in the pdpp_data volume across restarts and upgrades."
              title="Run with Docker"
            />
          </div>
          <div className="mt-4 grid gap-3">
            <DeployDisclosure title="Production deployment (Docker Compose)">
              <p className="pdpp-body text-muted-foreground">
                Running a node you intend to keep? Use the minimal Compose stack - reference, console, and Postgres with
                pgvector - with healthchecks and named volumes:
              </p>
              <CodeBlock
                code={`mkdir pdpp && cd pdpp
curl -fsSLO https://raw.githubusercontent.com/vana-com/pdpp/main/deploy/docker/docker-compose.yml
printf 'PDPP_OWNER_PASSWORD=%s\\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\\n' \\
  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env
docker compose up -d`}
              />
              <p className="pdpp-caption text-muted-foreground">
                Put your HTTPS reverse proxy in front and set <code>PDPP_REFERENCE_ORIGIN</code> to your domain. Full
                runbook:{" "}
                <a className="underline underline-offset-2" href={GITHUB_DOCKER_README}>
                  deploy/docker/README.md
                </a>
                .
              </p>
            </DeployDisclosure>
            <DeployDisclosure title="Other platforms (Fly.io)">
              <p className="pdpp-body text-muted-foreground">
                Fly.io has no deploy button. Its honest equivalent is one <code>fly launch</code> command that creates
                the app, provisions Postgres, and deploys the same Core image:
              </p>
              <CodeBlock
                code={`APP="pdpp-core-$(openssl rand -hex 3)"
OWNER_PASSWORD="$(openssl rand -base64 24)"
fly launch --image ghcr.io/vana-com/pdpp/railway-core:main \\
  --name "$APP" --internal-port 3000 --db \\
  --secret "PDPP_OWNER_PASSWORD=$OWNER_PASSWORD" \\
  --env "PDPP_REFERENCE_ORIGIN=https://$APP.fly.dev" \\
  --no-github-workflow --no-object-storage --no-redis --now --yes
printf 'Origin: https://%s.fly.dev\\nOwner password: %s\\n' "$APP" "$OWNER_PASSWORD"`}
              />
              <p className="pdpp-caption text-muted-foreground">
                Requires a payment method on the Fly org. Details and a source-build fallback:{" "}
                <a className="underline underline-offset-2" href={GITHUB_FLY_README}>
                  deploy/flyio/README.md
                </a>
                .
              </p>
            </DeployDisclosure>
          </div>
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <div>
            <h2 className="pdpp-heading text-foreground">Purpose and non-goals</h2>
            <p className="pdpp-body mt-2 text-muted-foreground">
              The reference exists to make PDPP concrete enough to fork, test, and criticize.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <Statement
              body="Prove grant issuance, owner self-export, resource queries, native provider identity, polyfill connector identity, and reference-only diagnostics with runnable code and tests."
              eyebrow="Purpose"
              title="Executable proof"
            />
            <Statement
              body="Do not read this website as a hosted multi-tenant PDPP service or as a promise that every implementation must copy these dashboard, trace, or storage choices."
              eyebrow="Non-goal"
              title="Not canonical SaaS"
            />
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="pdpp-heading text-foreground">Surface map</h2>
            <p className="pdpp-body text-muted-foreground">
              Each route family has a different job, authority, and data posture.
            </p>
          </div>
          <div className="divide-y rounded-2xl border bg-card/70">
            {architectureLayers.map((layer) => (
              <SurfaceRow key={layer.route} layer={layer} />
            ))}
          </div>
        </section>

        <section className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div>
            <h2 className="pdpp-heading text-foreground">Architecture</h2>
            <div className="mt-4 grid gap-3">
              <ArchitectureStep
                body="PAR and protected registration shape the current reference client-connect path."
                label="1"
                title="Clients stage access requests"
              />
              <ArchitectureStep
                body="Consent creates durable grants with streams, fields, retention, and source identity."
                label="2"
                title="Owners approve bounded grants"
              />
              <ArchitectureStep
                body="The resource server projects records to the granted fields and supports owner self-export separately."
                label="3"
                title="Resource reads enforce grants"
              />
              <ArchitectureStep
                body="Dashboard pages and _ref routes expose traces, runs, records, deployment diagnostics, and timelines for this implementation."
                label="4"
                title="Operators inspect the instance"
              />
            </div>
          </div>
          <div className="rounded-2xl border bg-card/70 p-4">
            <h3 className="pdpp-title text-foreground">Trust boundaries</h3>
            <ul className="mt-3 space-y-3">
              {trustBoundaries.map((item) => (
                <li className="grid grid-cols-[0.75rem_minmax(0,1fr)] gap-3" key={item}>
                  <span className="mt-2 h-1.5 rounded-full bg-primary" />
                  <span className="pdpp-caption text-muted-foreground">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="mt-14">
          <div className="mb-4 flex flex-col gap-1">
            <h2 className="pdpp-heading text-foreground">Review paths</h2>
            <p className="pdpp-body text-muted-foreground">
              These links keep artifact boundaries explicit: protocol docs are normative, coverage is public evidence,
              sandbox is mock-only, and live operation remains local or self-hosted.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {referenceLinks.map((item) => (
              <ReferenceLink item={item} key={item.href} />
            ))}
            <ReferenceLink
              item={{
                label: "Implementation notes",
                title: "Reference topology",
                href: "/docs/reference-implementation",
                body: "Existing reference notes remain available, labeled as current implementation behavior rather than protocol truth.",
              }}
            />
            <ReferenceLink
              item={{
                label: "Examples",
                title: "End-to-end flows",
                href: "/docs/reference-implementation-examples",
                body: "Concrete request, consent, owner self-export, and query examples from the current reference.",
              }}
            />
          </div>
        </section>
      </div>
    </main>
  );
}

function CalloutMetric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "warning";
}) {
  return (
    <div className="border-border/70 border-t pt-3">
      <div className="pdpp-caption text-muted-foreground">{label}</div>
      <div className={cn("pdpp-title mt-1 text-foreground", tone === "warning" && "text-[color:var(--warning)]")}>
        {value}
      </div>
    </div>
  );
}

function Statement({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="rounded-2xl border bg-card/70 p-5">
      <div className="pdpp-eyebrow text-muted-foreground">{eyebrow}</div>
      <h3 className="pdpp-title mt-3 text-foreground">{title}</h3>
      <p className="pdpp-body mt-2 text-muted-foreground">{body}</p>
    </div>
  );
}

function DeployCard({
  eyebrow,
  title,
  body,
  code,
  footer,
  action,
}: {
  eyebrow: string;
  title: string;
  body: string;
  code?: string;
  footer?: string;
  action: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 rounded-2xl border bg-card/70 p-5">
      <div>
        <div className="pdpp-eyebrow text-muted-foreground">{eyebrow}</div>
        <h3 className="pdpp-title mt-2 text-foreground">{title}</h3>
        <p className="pdpp-body mt-2 text-muted-foreground">{body}</p>
      </div>
      {code ? <CodeBlock code={code} /> : null}
      {footer ? <p className="pdpp-caption text-muted-foreground">{footer}</p> : null}
      <div className="mt-auto">{action}</div>
    </div>
  );
}

function DeployDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="group rounded-2xl border bg-card/60 p-4">
      <summary className="pdpp-title cursor-pointer list-none text-foreground">
        <span className="inline-flex items-center gap-2">
          <span className="text-muted-foreground transition-transform group-open:rotate-90">-&gt;</span>
          {title}
        </span>
      </summary>
      <div className="mt-4 space-y-3">{children}</div>
    </details>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border bg-muted/45 p-3 text-[0.78rem] text-foreground leading-5">
      <code>{code}</code>
    </pre>
  );
}

function SurfaceRow({ layer }: { layer: (typeof architectureLayers)[number] }) {
  const content = (
    <>
      <div>
        <div className="pdpp-eyebrow text-muted-foreground">{layer.label}</div>
        <h3 className="pdpp-title mt-1 text-foreground">{layer.title}</h3>
      </div>
      <p className="pdpp-body text-muted-foreground">{layer.body}</p>
      <div className="pdpp-caption font-mono text-muted-foreground">{layer.route}</div>
    </>
  );

  return (
    <Link
      className="grid gap-3 p-4 transition-colors hover:bg-muted/35 md:grid-cols-[12rem_minmax(0,1fr)_6rem]"
      href={layer.route}
    >
      {content}
    </Link>
  );
}

function ArchitectureStep({ label, title, body }: { label: string; title: string; body: string }) {
  return (
    <div className="grid gap-4 rounded-xl border bg-card/60 p-4 sm:grid-cols-[2rem_minmax(0,1fr)]">
      <div className="pdpp-caption flex size-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
        {label}
      </div>
      <div>
        <h3 className="pdpp-title text-foreground">{title}</h3>
        <p className="pdpp-caption mt-1 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function ReferenceLink({
  item,
}: {
  item: {
    label: string;
    title: string;
    href: string;
    body: string;
  };
}) {
  const external = item.href.startsWith("http");
  const className = "group rounded-xl border bg-card/70 p-4 transition-colors hover:border-foreground/30";
  const content = (
    <>
      <div className="pdpp-eyebrow text-muted-foreground">{item.label}</div>
      <h3 className="pdpp-title mt-2 text-foreground">
        {item.title}
        <span className="ml-1 text-muted-foreground transition-colors group-hover:text-foreground">-&gt;</span>
      </h3>
      <p className="pdpp-caption mt-2 text-muted-foreground">{item.body}</p>
    </>
  );

  if (external) {
    return (
      <a className={className} href={item.href}>
        {content}
      </a>
    );
  }

  return (
    <Link className={className} href={item.href}>
      {content}
    </Link>
  );
}
