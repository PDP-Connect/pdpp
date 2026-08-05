// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppCommandBuilder } from "@/components/pdpp-concept/command-tabs.tsx";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { GithubIcon } from "@/components/pdpp-concept/icons.tsx";
import { GITHUB_ISSUES_URL, GITHUB_REPO_URL } from "@/components/pdpp-concept/site-facts.ts";

export const metadata: Metadata = {
  description:
    "Run your own personal data server. Query Gmail, GitHub, Notion, and more from Claude, ChatGPT, or Codex.",
  title: "Self-Host - PDPP",
};

// SELF-HOST. One dominant command, built from outcome-level choices, then the
// things a reader needs after it is running. No env var, port, profile, service
// or image name appears above Advanced.
//
// THE BUILDER ITSELF lives in `command-tabs.tsx` and its commands come from
// `@/lib/self-host-command.ts`, which is a pure module so the capability test
// can assert against the exact command a reader copies rather than regexing
// this file's JSX.
//
// WHAT WAS VERIFIED BY EXECUTION 2026-08-05, and what that ruled out:
//   KEPT   the Compose path. Fetched by URL into an empty directory and booted
//          end to end: postgres healthy, reference healthy, web serving, `/`
//          307 -> /owner/login, AS metadata 200, and chromium-1217 present
//          inside the RUNNING reference container. The public-origin and
//          keyword-only variants were booted too.
//   DROPPED the single-container `docker run` tab. No published image is both
//          console-bearing and browser-capable: reference-browser has Chromium
//          but serves no console (only 7662/7663), and railway-core has the
//          console but no /opt/patchright-browsers. A one-container command
//          would have to lie about one of them.
//   DROPPED releases/latest/download/docker-compose.yml. 404s — every release
//          v1.0.0 to v1.0.4 shipped zero assets.
//   DROPPED core:main and core-browser:main. Neither exists; manifest 404s.
//
// RAILWAY IS LAST because a template link cannot carry variable values (its
// documented deploy-URL params are attribution only), so it cannot honour the
// choices above and says so instead of discarding them silently.
const GITHUB_DOCKER_README = `${GITHUB_REPO_URL}/blob/main/deploy/docker/README.md`;
const GITHUB_LOCAL_COLLECTOR = `${GITHUB_REPO_URL}/blob/main/docs/operator/local-collector-runbook.md`;

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
    // Browser support is included, not optional: 14 of the 33 connectors
    // cannot sign in without it. When a sign-in needs a human — a code, a
    // confirmation — the browser is streamed to your dashboard so you can
    // take over. Verified in the code: the runtime registers a page-target
    // CDP stream per run and the controller mints its token on every run.
    body: <>Amazon, ChatGPT and USAA sign in through a browser you can watch and take over.</>,
    title: "Browser sources included",
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
  { href: "https://vana.org/", linkLabel: "Vana", name: "Vana network", type: "Deployed personal-data network" },
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

          <PdppCommandBuilder />

          {/* WAS A WHOLE SECTION, now one sentence. The distinction is real —
              Codex and Claude Code reach loopback, Claude.ai and ChatGPT call
              from their own infrastructure and cannot — but the Access choice
              in the builder above is where a reader acts on it, so restating it
              as a two-column section was furniture. */}
          <p className="pdpp-note pdpp-note--access">
            Codex and Claude Code reach a local node directly; Claude.ai and ChatGPT call from their own servers, so
            they need the public address above.
          </p>

          <section className="pdpp-section pdpp-section--lead" id="features">
            <h2>
              <span className="pdpp-section__numeral">01</span>What you get
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
              <span className="pdpp-section__numeral">02</span>Advanced configuration
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
              <span className="pdpp-section__numeral">03</span>Other implementations
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
