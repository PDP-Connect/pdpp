// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDocHeader } from "@/components/pdpp-concept/concept-doc-header.tsx";
import { PdppConceptDoc, PdppConceptPage } from "@/components/pdpp-concept/concept-page.tsx";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { DiscordIcon, GithubIcon } from "@/components/pdpp-concept/icons.tsx";
import { PdppRail } from "@/components/pdpp-concept/rail.tsx";
import {
  DISCORD_INVITE_URL,
  GITHUB_MAINTAINERS_URL,
  GITHUB_NEW_ISSUE_URL,
  GITHUB_REPO_URL,
} from "@/components/pdpp-concept/site-facts.ts";
import { SPEC_STATUS } from "@/components/pdpp-concept/spec-status.ts";
import { Text } from "@/components/pdpp-concept/text.tsx";

const PARTICIPATE_TOC = [
  { href: "#get-involved", label: "Get involved" },
  { href: "#how-it-changes", label: "How the specification changes" },
  { href: "#status", label: "Where PDPP is today" },
] as const;

export const metadata: Metadata = {
  alternates: { canonical: "/participate" },
  description: "Ask a question about the PDPP draft, or propose a change to the protocol.",
  openGraph: { url: "/participate" },
  title: "Participate - PDPP",
};

// This is a PARTICIPATE page: where someone who wants to get involved finds the
// people, the process, and the places to talk. Not an About page.
//
// Went from 6 sections to 3. What was CUT and why:
//   Maintainers table   — a roster with a Status column of three identical
//                         "Active" values is About-page furniture. 4 of 6
//                         comparable projects (MCP, Solid, x402, Kubernetes,
//                         OpenTelemetry, LFDT) name no individuals on the site
//                         at all; names live in a version-controlled
//                         MAINTAINERS.md. Replaced by a pointer to that file,
//                         which is also the canonical list, so it cannot go
//                         stale.
//   License table       — the footer now carries all three licenses, labelled
//                         and linked. Nothing here was unique to this page.
//   Implementations     — belongs on /reference, the page about running one.
//                         It was duplicated across both.
//
// The extra horizontal rules between sections are gone (Callum's note: AI has
// added too many lines).
const changeSteps = [
  {
    body: "Against the specification files, reviewed in the open. Editorial and non-normative fixes need nothing more than this.",
    title: "Every change is a public pull request",
  },
  {
    body: "What breaks and what the change impacts, written before the code.",
    title: "A normative change states its rationale first",
  },
  {
    body: "The reference implementation moves in the same release.",
    title: "New behavior ships with tests",
  },
] as const;

export default function ParticipatePage() {
  return (
    <>
      <PdppConceptPage>
        <PdppRail toc={PARTICIPATE_TOC} />
        <PdppConceptDoc>
          <PdppConceptDocHeader
            lede="Ask a question about the draft, or propose a change to the protocol."
            title="Participate"
          />

          {/* Actionable links FIRST, directly under the lede. The owner's note:
              landing here, you should be able to open an issue or find Discord
              immediately. These were previously ruled-list rows — an h3, an
              explanatory sentence, and a right-aligned link floating away from
              its own label, which is document prose, not an interface.

              Descriptions dropped entirely: "Open an issue" next to a GitHub
              mark does not need a sentence explaining that it opens an issue.

              /issues/new, not /issues — the owner said "I want to open an
              issue", which is the compose action, not the index. */}
          <section className="pdpp-section pdpp-section--lead" id="get-involved">
            <Text as="h2" intent="title" sectionIndex="01">
              Get involved
            </Text>
            <div className="pdpp-channels">
              <a className="pdpp-channel" href={GITHUB_NEW_ISSUE_URL} rel="noopener noreferrer" target="_blank">
                <GithubIcon className="pdpp-icon-github pdpp-channel__icon" />
                <span className="pdpp-channel__label">Open an issue</span>
                <span aria-hidden="true" className="pdpp-channel__arrow">
                  →
                </span>
              </a>
              <a className="pdpp-channel" href={GITHUB_REPO_URL} rel="noopener noreferrer" target="_blank">
                <GithubIcon className="pdpp-icon-github pdpp-channel__icon" />
                <span className="pdpp-channel__label">PDP-Connect/pdpp</span>
                <span aria-hidden="true" className="pdpp-channel__arrow">
                  →
                </span>
              </a>
              <a className="pdpp-channel" href={DISCORD_INVITE_URL} rel="noopener noreferrer" target="_blank">
                <DiscordIcon className="pdpp-icon-discord pdpp-channel__icon" />
                <span className="pdpp-channel__label">#pdp-connect on Discord</span>
                <span aria-hidden="true" className="pdpp-channel__arrow">
                  →
                </span>
              </a>
            </div>
            <Text color="soft" intent="note">
              In an issue, name the part of the specification your question applies to and what the text does not let
              you decide. A maintainer answers there.
            </Text>
          </section>

          {/* Grounded against the WHATWG Working Mode and the OpenTelemetry OTEP
              README, which document a change as EVIDENCE REQUIREMENTS rather
              than a stage pipeline. The previous version invented a four-stage
              pipeline (proposal / PR / review / consultation) that no comparable
              project runs and this lab cannot honour. */}
          <section className="pdpp-section" id="how-it-changes">
            <Text as="h2" intent="title" sectionIndex="02">
              How the specification changes
            </Text>
            <Text intent="body">
              Normative text lives in the root <code>spec-*.md</code> files. Everything else, including the
              specification pages on this site, is a downstream copy.
            </Text>
            <div className="pdpp-ruled-list pdpp-ruled-list--plain">
              {changeSteps.map((step) => (
                <div className="pdpp-ruled-list__item" key={step.title}>
                  <div className="pdpp-ruled-list__body">
                    <Text as="h3" intent="heading">
                      {step.title}
                    </Text>
                    <Text intent="body">{step.body}</Text>
                  </div>
                </div>
              ))}
              <div className="pdpp-ruled-list__item">
                <div className="pdpp-ruled-list__body">
                  <Text as="h3" intent="heading">
                    Two maintainers approve before merge
                  </Text>
                  <Text intent="body">
                    Maintainers are the editors of the current draft, listed in{" "}
                    <a href={GITHUB_MAINTAINERS_URL} rel="noopener noreferrer" target="_blank">
                      MAINTAINERS.md
                    </a>
                    .
                  </Text>
                </div>
              </div>
            </div>
            <Text intent="body">
              Interfaces may still change: {SPEC_STATUS.version} has not been through public consultation, which opens
              before v1.0 is pinned. Governance and the license split are recorded in{" "}
              <Link href="/specification#specification-governance">specification governance</Link>.
            </Text>
          </section>

          {/* Renamed from "Status of this document". The owner spotted that the
              content is PDPP-project-wide status, not the status of this page,
              and the heading was the thing that was wrong. Content kept. */}
          <section className="pdpp-section" id="status">
            <Text as="h2" intent="title" sectionIndex="03">
              Where PDPP is today
            </Text>
            <Text intent="body">
              {SPEC_STATUS.version} is a {SPEC_STATUS.label.toLowerCase()}.
            </Text>
            <ul className="pdpp-updates">
              <li>
                <Text
                  as="time"
                  className="normal-case tracking-[0.04em]"
                  color="faint"
                  dateTime="2026-07"
                  intent="eyebrow"
                  numeric="tabular"
                >
                  2026 · Jul
                </Text>
                <Text intent="note">
                  LFDT Labs proposal accepted; repositories public under the PDP-Connect organization.
                </Text>
              </li>
              <li>
                <Text
                  as="time"
                  className="normal-case tracking-[0.04em]"
                  color="faint"
                  dateTime="2026-04"
                  intent="eyebrow"
                  numeric="tabular"
                >
                  2026 · Apr
                </Text>
                <Text intent="note">
                  Core protocol {SPEC_STATUS.version} published as a normative draft alongside the forkable reference
                  implementation.
                </Text>
              </li>
            </ul>
          </section>
        </PdppConceptDoc>
      </PdppConceptPage>

      <PdppConceptFooter />
    </>
  );
}
