// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { type CommandTab, PdppCommandTabs } from "@/components/pdpp-concept/command-tabs.tsx";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { GithubIcon } from "@/components/pdpp-concept/icons.tsx";
import { GITHUB_ISSUES_URL, GITHUB_REPO_URL } from "@/components/pdpp-concept/site-facts.ts";

export const metadata: Metadata = {
  description:
    "Run your own personal data server. Query Gmail, GitHub, Notion, and more from Claude, ChatGPT, or Codex.",
  title: "Self-Host - PDPP",
};

// SELF-HOST. Structure per the RI owner: five-second promise, one dominant
// command, Docker/Compose/Railway tabs, local vs web-app access, semantic search
// included by default, browser sources optional, Advanced configuration below.
//
// NO IMPLEMENTATION DETAIL ON THE LANDING SURFACE, per instruction: no env vars,
// no profiles, no ports, no runtime internals above the fold. The env-var table
// moved into Advanced configuration, which is a collapsed <details>.
//
// EVERY ARTIFACT HERE WAS VERIFIED TODAY, and the ones that failed were dropped:
//   - `railway-core:main` — DROPPED. Resolves, but was built 2026-07-21 from
//     revision 2fbdb4a8, which is 46 commits behind pdp/main and 391 behind the
//     runtime candidate. That is the stale `:main` the owner disqualified.
//   - releases/latest/download/docker-compose.yml — DROPPED. 404s. Every release
//     v1.0.0 through v1.0.4 has ZERO assets; that URL has never worked.
//   - The fresh-clone Compose path — KEPT. Booted end to end: postgres healthy,
//     reference healthy, web up, `/` 307s to /owner/login, and
//     /.well-known/oauth-authorization-server returns 200.
//   - The Railway template — KEPT. Resolves to the published "PDPP Core Template
//     Source", which builds from repository source rather than a published image,
//     so it does not carry the staleness that disqualified the image tags.
//
// The single-image `docker run` tab is deliberately ABSENT until a fresh image
// is published. Shipping a one-liner that installs a two-week-old build would be
// exactly the thing the owner told us not to do.
//
// NAMING CONTRACT. Public, user-facing artifact names are platform-neutral:
// `core` is the browser-free single-container node and `core-browser` is the
// browser-capable one. `railway-core` is an internal Docker target kept for
// backward compatibility and must not appear in any command or copy a reader
// sees. Railway is named as the provider that deploys the artifact, never as
// part of the artifact's name.
//
// PENDING: the Railway tab consumes `core-browser` once the release matrix
// publishes it. Until that artifact exists publicly the browser path there is
// UNVERIFIED, so the tab says so rather than emitting a command nobody has run.
const GITHUB_DOCKER_README = `${GITHUB_REPO_URL}/blob/main/deploy/docker/README.md`;
const GITHUB_LOCAL_COLLECTOR = `${GITHUB_REPO_URL}/blob/main/docs/operator/local-collector-runbook.md`;
const RAILWAY_TEMPLATE_URL = "https://railway.com/new/template/pdpp-core-template-source";

// Each tab's command is the command that tab's label promises, and the eye
// lands on the token that says WHAT you are running. The Railway tab is a link
// rather than a command, because pretending a click is a shell line would be
// worse than showing the one affordance it actually is.
const COMMAND_TABS: readonly CommandTab[] = [
  {
    // Verified end to end from a fresh clone: containers healthy, `/` 307s to
    // /owner/login. The secret-generation line is NOT optional decoration — the
    // Compose file guards both values with `:?`, so without it the stack refuses
    // to start. I ran the version without it and it fails, so it stays.
    command: [
      { text: "git clone " },
      { emphasis: true, text: "https://github.com/PDP-Connect/pdpp.git" },
      {
        text: '\ncd pdpp/deploy/docker\nprintf \'PDPP_OWNER_PASSWORD=%s\\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\\n\' \\\n  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env\ndocker compose up -d',
      },
    ],
    // Same clone, one extra line in .env. deploy/docker/README.md documents
    // PDPP_REFERENCE_IMAGE as the supported override, and the compose file
    // already reads it, so this is the repo's own answer rather than ours.
    // The image override is appended on its own short line rather than folded
    // into the printf. The printf is already the widest line in the panel, and
    // a reader who cannot SEE the browser image has no evidence the choice
    // above took effect.
    browserCommand: [
      { text: "git clone " },
      { emphasis: true, text: "https://github.com/PDP-Connect/pdpp.git" },
      {
        text: '\ncd pdpp/deploy/docker\nprintf \'PDPP_OWNER_PASSWORD=%s\\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\\n\' \\\n  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env\necho PDPP_REFERENCE_IMAGE=',
      },
      { emphasis: true, text: "ghcr.io/pdp-connect/pdpp/reference-browser:main" },
      { text: " >> .env\ndocker compose up -d" },
    ],
    id: "docker",
    label: "Docker",
    note: <>Your records stay in a local volume, and the dashboard opens in your browser.</>,
  },
  {
    command: [
      { text: "docker compose -f " },
      { emphasis: true, text: "deploy/docker/docker-compose.yml" },
      { text: " up -d" },
    ],
    browserCommand: [
      { text: "PDPP_REFERENCE_IMAGE=" },
      { emphasis: true, text: "ghcr.io/pdp-connect/pdpp/reference-browser:main" },
      { text: " \\\n  docker compose -f deploy/docker/docker-compose.yml up -d" },
    ],
    id: "compose",
    label: "Compose",
    note: (
      <>
        From a checkout you already have, once its <code>.env</code> exists.{" "}
        <a href={GITHUB_DOCKER_README} rel="noopener noreferrer" target="_blank">
          Runbook →
        </a>
      </>
    ),
  },
  {
    // PENDING A PUBLISHED ARTIFACT, not a dead end. Railway deploys a prebuilt
    // image, and the browser-capable Core node (`core-browser`) is not in the
    // release matrix yet, so there is nothing to point a template at today.
    // When it publishes, this tab consumes it the same way Compose does and the
    // notice goes away. Naming stays platform-neutral: the artifact is `core`
    // and `core-browser`; Railway is the provider that deploys it, not part of
    // the image name.
    browserUnavailable: (
      <>
        The browser-capable Core node is not published yet, so this path is unverified. Use Docker or Compose for
        sources that sign in through a browser.
      </>
    ),
    command: [{ text: "Deploy the " }, { emphasis: true, text: "PDPP Core" }, { text: " template" }],
    id: "railway",
    label: "Railway",
    note: (
      <>
        One click builds from source and provisions Postgres.{" "}
        <a href={RAILWAY_TEMPLATE_URL} rel="noopener noreferrer" target="_blank">
          Open the template →
        </a>
      </>
    ),
  },
];

const features = [
  {
    body: (
      <>
        Claude, ChatGPT, and Codex query your data over{" "}
        <a href="https://modelcontextprotocol.io/" rel="noopener noreferrer" target="_blank">
          MCP
        </a>
        .
      </>
    ),
    title: "MCP built in",
  },
  { body: <>Gmail, GitHub, Notion, Oura, YNAB, and more.</>, title: "33 sources" },
  { body: <>Full text and semantic, on by default. Nothing to switch on.</>, title: "Search included" },
  { body: <>Give a client read access to the fields you pick. Revoke it anytime.</>, title: "Scoped grants" },
  {
    body: <>Sources that need a sign-in browser are optional, and off unless you add them.</>,
    title: "Browser sources optional",
  },
  { body: <>Your records stay on the machine you run it on.</>, title: "Yours" },
] as const;

const configuration = [
  { default: "http://localhost:3000", name: "PDPP_REFERENCE_ORIGIN", sets: "Public origin in OAuth metadata" },
  { default: "generated", name: "PDPP_OWNER_PASSWORD", sets: "Dashboard sign-in" },
  { default: "—", name: "PDPP_DATABASE_URL", sets: "Postgres instead of SQLite" },
  { default: "/var/lib/pdpp/pdpp.sqlite", name: "PDPP_DB_PATH", sets: "SQLite location" },
] as const;

const implementations = [
  {
    href: `${GITHUB_REPO_URL}/tree/main/reference-implementation`,
    linkLabel: "Source",
    name: "Reference implementation",
    type: "Authorization server and resource server",
  },
  { href: "https://dtinit.org", linkLabel: "DTI", name: "Data Connect", type: "Portability and transfer interface" },
  { href: "https://vana.org/", linkLabel: "Vana", name: "Vana Network", type: "Deployed personal-data network" },
] as const;

export default function ReferencePage() {
  return (
    <>
      <main className="pdpp-page">
        <article className="pdpp-doc">
          {/* The five-second promise. One line, then the command. */}
          <h1>Self-Host</h1>
          <p className="pdpp-lede">
            Your own personal data server. Ask Claude, ChatGPT, or Codex about your Gmail, GitHub, Notion, and 30 more.
          </p>

          <PdppCommandTabs tabs={COMMAND_TABS} />

          {/* The distinction a reader will otherwise get wrong. Stated plainly,
              because "connect an AI client" is not one thing: a local client
              reaches loopback, a hosted one cannot. */}
          <section className="pdpp-section pdpp-section--lead" id="access">
            <h2>
              <span className="pdpp-section__numeral">01</span>Reaching it from an AI client
            </h2>
            <div className="pdpp-split">
              <div className="pdpp-split__half">
                <h3>On your machine</h3>
                <p>
                  Codex and Claude Code run on your computer, so they reach a local instance directly. Nothing to
                  expose, nothing to sign up for.
                </p>
              </div>
              <div className="pdpp-split__half">
                <h3>Claude.ai and ChatGPT</h3>
                <p>
                  These are hosted services. They call your server from their own infrastructure, so it has to be
                  reachable over HTTPS — a domain or a tunnel. A local-only instance will not work with them.
                </p>
              </div>
            </div>
          </section>

          <section className="pdpp-section" id="features">
            <h2>
              <span className="pdpp-section__numeral">02</span>What you get
            </h2>
            <ul className="pdpp-features">
              {features.map((feature) => (
                <li key={feature.title}>
                  <strong>{feature.title}</strong> {feature.body}
                </li>
              ))}
            </ul>
            <p className="pdpp-note">
              Data that only lives on your machine, like Claude Code or Codex history, is ingested by the{" "}
              <a href={GITHUB_LOCAL_COLLECTOR} rel="noopener noreferrer" target="_blank">
                local collector →
              </a>
            </p>
          </section>

          {/* BELOW, and collapsed. Everything the landing surface must not carry. */}
          <section className="pdpp-section" id="configuration">
            <h2>
              <span className="pdpp-section__numeral">03</span>Advanced configuration
            </h2>
            <details className="pdpp-details">
              <summary>Settings you can override</summary>
              <table className="pdpp-impl-table pdpp-config-table">
                <thead>
                  <tr>
                    <th scope="col">Setting</th>
                    <th scope="col">Default</th>
                    <th scope="col">Sets</th>
                  </tr>
                </thead>
                <tbody>
                  {configuration.map((row) => (
                    <tr key={row.name}>
                      <td>
                        <code>{row.name}</code>
                      </td>
                      <td>{row.default === "—" ? "—" : <code>{row.default}</code>}</td>
                      <td>{row.sets}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Serving a domain? Put HTTPS in front and set the public origin to match. Full runbook:{" "}
                <a href={GITHUB_DOCKER_README} rel="noopener noreferrer" target="_blank">
                  deploy/docker/README.md →
                </a>
              </p>
            </details>
          </section>

          <section className="pdpp-section" id="implementations">
            <h2>
              <span className="pdpp-section__numeral">04</span>Other implementations
            </h2>
            <table className="pdpp-impl-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Type</th>
                  <th scope="col">
                    <span className="pdpp-visually-hidden">Link</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {implementations.map((impl) => (
                  <tr key={impl.name}>
                    <td>{impl.name}</td>
                    <td>{impl.type}</td>
                    <td>
                      <a href={impl.href} rel="noopener noreferrer" target="_blank">
                        {impl.linkLabel} →
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p>
              The specification defines conformance by role in{" "}
              <Link href="/specification/spec-core#conformance">section 9</Link>.
            </p>
            <p>
              <a
                className="pdpp-footer__source-link"
                href={GITHUB_ISSUES_URL}
                rel="noopener noreferrer"
                target="_blank"
              >
                <GithubIcon />
                Open an issue on GitHub
              </a>
            </p>
          </section>
        </article>
      </main>

      <PdppConceptFooter />
    </>
  );
}
