// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppCommandBuilder } from "@/components/pdpp-concept/command-tabs.tsx";
import { PdppConceptDocHeader } from "@/components/pdpp-concept/concept-doc-header.tsx";
import { PdppConceptDoc, PdppConceptPage } from "@/components/pdpp-concept/concept-page.tsx";
import { GithubIcon } from "@/components/pdpp-concept/icons.tsx";
import { PdppRail } from "@/components/pdpp-concept/rail.tsx";
import { GITHUB_ISSUES_URL, GITHUB_REPO_URL } from "@/components/pdpp-concept/site-facts.ts";
import { Text } from "@/components/pdpp-concept/text.tsx";

const SELF_HOST_TOC = [
  { href: "#run", label: "Run it" },
  { href: "#features", label: "What you get" },
  { href: "#configuration", label: "Advanced configuration" },
  { href: "#implementations", label: "Other implementations" },
] as const;

export const metadata: Metadata = {
  alternates: { canonical: "/self-host" },
  description:
    "Run your own personal data server. Query Gmail, GitHub, Notion, and more from Claude, ChatGPT, or Codex.",
  openGraph: { url: "/self-host" },
  title: "Self-Host - PDPP",
};

// Command builder: command-tabs.tsx → self-host-command.ts (see module doc + capability test).
// `/self-host/coverage` exists (coverage/page.tsx + data.ts) but has no inbound site links yet —
// reachable only by direct URL or `/reference/coverage` redirect. Orphan on purpose for now; delete
// this note once wired into the page.
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
  { body: <>Full text and semantic, on by default.</>, title: "Search included" },
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
  {
    // The default is durable SQLite on a volume, which is the whole point of
    // running a data SERVER rather than a cache — but the page never said so
    // in those terms until now. One line, same discipline as every other row
    // here: state the fact, not the mechanism.
    body: <>Your records stay on the machine you run it on, and survive a restart.</>,
    title: "Yours",
  },
] as const;

const configuration = [
  // NEVER a concrete localhost value here. This column's job is "the default
  // an unmodified deployment actually has," and PDPP_REFERENCE_ORIGIN's only
  // job is to be a real public HTTPS origin — `http://localhost:3000` reads
  // as a plausible copy-pasteable default but can never satisfy that job, so
  // showing it risks a reader shipping a broken OAuth metadata origin. Shown
  // as a placeholder shape instead, same idiom as PUBLIC_URL_PLACEHOLDER in
  // the command builder above.
  { default: "https://your-host", name: "PDPP_REFERENCE_ORIGIN", sets: "Public origin in OAuth metadata" },
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
    <PdppConceptPage>
      <PdppRail toc={SELF_HOST_TOC} />
      <PdppConceptDoc>
        <PdppConceptDocHeader
          lede="Your own personal data server. Ask Claude, ChatGPT, or Codex about your Gmail, GitHub, Notion, and 30 more."
          title="Self-Host"
        />

        <section className="pdpp-section pdpp-section--lead" id="run">
          <Text as="h2" sectionIndex="01" size="title">
            Run it
          </Text>
          <PdppCommandBuilder />

          <Text className="mt-3.5!" size="callout">
            A tool running on this machine reaches the node directly. Anything hosted elsewhere, including web
            assistants, calls from its own servers and needs the public address above.
          </Text>
        </section>

        <section className="pdpp-section" id="features">
          <Text as="h2" sectionIndex="02" size="title">
            What you get
          </Text>
          <ul className="pdpp-features">
            {features.map((feature) => (
              <li key={feature.title}>
                <Text as="span" color="foreground" size="body" weight="semi">
                  {feature.title}
                </Text>{" "}
                <Text as="span" color="foreground" size="body">
                  {feature.body}
                </Text>
              </li>
            ))}
          </ul>
          <Text size="callout">
            Data that only lives on your machine, like Claude Code or Codex history, is ingested by the{" "}
            <a href={GITHUB_LOCAL_COLLECTOR} rel="noopener noreferrer" target="_blank">
              local collector →
            </a>
          </Text>
        </section>

        <section className="pdpp-section" id="configuration">
          <Text as="h2" sectionIndex="03" size="title">
            Advanced configuration
          </Text>
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
          <Text size="body">
            Serving a domain? Put HTTPS in front and set the public origin to match. Full runbook:{" "}
            <a href={GITHUB_DOCKER_README} rel="noopener noreferrer" target="_blank">
              deploy/docker/README.md →
            </a>
          </Text>
        </section>

        <section className="pdpp-section" id="implementations">
          <Text as="h2" sectionIndex="04" size="title">
            Other implementations
          </Text>
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
          <Text size="body">
            The specification defines conformance by role in{" "}
            <Link className="link-prose" href="/specification/spec-core#conformance">
              section 9
            </Link>
            .
          </Text>
          <p>
            <a
              className="group inline-flex items-center gap-1.5 text-primary no-underline hover:text-primary-emphasis focus-visible:text-primary-emphasis"
              href={GITHUB_ISSUES_URL}
              rel="noopener noreferrer"
              target="_blank"
            >
              <GithubIcon />
              <span className="link-prose group-hover:border-primary group-focus-visible:border-primary">
                Open an issue on GitHub
              </span>
              <span aria-hidden="true">→</span>
            </a>
          </p>
        </section>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
