// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { Text } from "@/components/typography/text.tsx";
import { isPlaceholder, REPORTS_EMAIL_HREF, siteConfig, siteFlags } from "@/lib/site-config.ts";
import { GITHUB_REPO_URL } from "@/lib/site-facts.ts";
import { cn } from "@/lib/utils.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/participate" },
  description: "Follow the work, sign the Principles, or build something and get it verified.",
  openGraph: { url: "/participate" },
  title: "Participate - PDPP",
};

const CARD = cn("flex flex-col gap-3 bg-background p-6", "shadow-[0_0_0_1px_var(--border)]");
const CELL = "px-3 py-2.5 text-left align-top";

/**
 * A channel link that refuses to be a link until its destination is real.
 *
 * An unset config value renders as a bracketed placeholder, which as an `href`
 * would be a link that looks live and goes nowhere. Worse for the mailing
 * list than for Discord: a reader who clicks "Subscribe" expects to hand over
 * an address, and a dead link at that moment reads as the site losing it.
 */
function ChannelLink({ href, label }: { href: string; label: string }) {
  if (isPlaceholder(href)) {
    return (
      <Text as="span" color="subtle" size="small">
        Link to follow
      </Text>
    );
  }
  return (
    <Text as="p" size="small">
      <a className="text-primary hover:text-foreground" href={href} rel="noopener noreferrer" target="_blank">
        {label}
      </a>
    </Text>
  );
}

interface RegisterEntry {
  organisation: string;
  role: string;
  since: string;
  specVersion: string;
  state: string;
  status: string;
}

interface TrustRegistry {
  basis: string;
  name: string;
  operator: string;
  recognisedFor: readonly string[];
  recognisedOn: string;
  url: string;
}

// Both registers are PR-driven files in this repo and hold no personal data.
// Read at build time: a fetch at request time would put a network hop in front
// of a file that ships in the repo and would 500 the page when it failed.
async function readJson<T>(...segments: string[]): Promise<readonly T[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(process.cwd(), "public", ...segments), "utf8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

const LEVELS = [
  {
    level: "Level 1",
    title: "Follow along",
    // Copy delta 1: working sessions removed from this list.
    body: "Discord, mailing list, comments. Nothing to sign, so regulators can take part off the record.",
    cta: "Channels and contacts ↓",
    href: "#channels",
  },
  {
    level: "Level 2",
    title: "Become a Supporter",
    body: "Sign the Principles and go on the public list. Opening shortly, once we have confirmed where the register will live.",
    cta: "Read the Principles",
    href: "/principles",
  },
  {
    level: "Level 3",
    title: "Become a Partner",
    body: "Get an implementation verified. Partners get drafts early, sit in working groups and vote. Organisations only, from 14 November.",
    cta: "How verification works ↓",
    href: "#get-verified",
  },
] as const;

const STEPS = [
  { step: "Step 1", title: "Build it", body: "A source, accessor or operator that implements Core." },
  {
    step: "Step 2",
    title: "Apply",
    body: "Open a pull request from the template for your role and attach your evidence. A machine checks it. Pass, and you are Conformant.",
  },
  {
    step: "Step 3",
    title: "Get reviewed",
    body: "For Verified, the technical committee reviews in public and votes, and you prove your organisation exists through a recognised trust registry. You get reasons either way, and can resubmit.",
  },
  {
    step: "Step 4",
    title: "You're on the register",
    body: "Your status is published with the date and version. Any Verified status makes you a Partner.",
  },
] as const;

const STATUSES = [
  ["Conformant Source", "Source", "Automated", "Declaration parses against the schema", "By 14 Nov 2026", "Not open"],
  [
    "Verified Source",
    "Source",
    "Reviewed",
    "Published by the platform that holds the data. Committee review, identity via a recognised trust registry",
    "By 14 Nov 2026",
    "Not open",
  ],
  [
    "Conformant Accessor",
    "Accessor",
    "Automated",
    "Registered, submission complete. No assessment",
    "By 14 Nov 2026",
    "Not open",
  ],
  [
    "Verified Accessor",
    "Accessor",
    "Reviewed",
    "Legal attestation, liability on a named entity. Committee review, identity via a recognised trust registry",
    "By 14 Nov 2026",
    "Not open",
  ],
  [
    "Verified Operator",
    "Operator",
    "Reviewed",
    "Passes the test suite, then full committee review. Identity via a recognised trust registry",
    "By 1 Jan 2027",
    "Not open",
  ],
] as const;

export default async function Page() {
  const register = await readJson<RegisterEntry>("register", "index.json");
  const trustRegistries = await readJson<TrustRegistry>("register", "trust-registries.json");

  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <div className="flex flex-col gap-4 pt-10">
          <Text as="h1" size="display">
            How to get involved
          </Text>
          <Text as="p" className="max-w-[68ch]" size="lede" wrap="pretty">
            Follow the work, sign the Principles, or build something and get it verified. All of it is voluntary, and
            none of it is needed to use PDPP.
          </Text>
        </div>

        <div className="mt-10 grid grid-cols-1 gap-px lg:grid-cols-3">
          {LEVELS.map((level) => (
            <div className={CARD} key={level.level}>
              <Text as="p" color="primary" family="mono" size="stamp">
                {level.level}
              </Text>
              <Text as="h2" size="lede" weight="semi">
                {level.title}
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                {level.body}
              </Text>
              <Text as="p" className="mt-auto pt-2" size="small">
                <Link className="text-primary hover:text-foreground" href={level.href}>
                  {level.cta}
                </Link>
              </Text>
            </div>
          ))}
        </div>

        <PdppConceptSection id="get-verified" title="Get verified">
          <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2 xl:grid-cols-4">
            {STEPS.map((step) => (
              <div className={CARD} key={step.step}>
                <Text as="p" color="primary" family="mono" size="stamp">
                  {step.step}
                </Text>
                <Text as="h3" size="lede" weight="semi">
                  {step.title}
                </Text>
                <Text as="p" color="muted" size="small" wrap="pretty">
                  {step.body}
                </Text>
              </div>
            ))}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Text as="p" size="small">
              <a
                className="text-primary hover:text-foreground"
                href={`${GITHUB_REPO_URL}/issues/new?template=apply-source.md`}
                rel="noopener noreferrer"
                target="_blank"
              >
                Apply as a Source →
              </a>
            </Text>
            <Text as="p" size="small">
              <a
                className="text-primary hover:text-foreground"
                href={`${GITHUB_REPO_URL}/issues/new?template=apply-accessor.md`}
                rel="noopener noreferrer"
                target="_blank"
              >
                Apply as an Accessor →
              </a>
            </Text>
            {/* Disabled with its date until operatorApplications is on. The
                suite an Operator is assessed against does not exist until then,
                so a live button would invite an application nobody can act on. */}
            {siteFlags.operatorApplications ? (
              <Text as="p" size="small">
                <a
                  className="text-primary hover:text-foreground"
                  href={`${GITHUB_REPO_URL}/issues/new?template=apply-operator.md`}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Apply as an Operator →
                </a>
              </Text>
            ) : (
              <Text aria-disabled="true" as="span" color="subtle" size="small">
                Apply as an Operator, opens 1 Jan 2027
              </Text>
            )}
          </div>
          <Text as="p" className="mt-4" color="muted" size="small">
            Not sure which fits, or not on GitHub? Write to {siteConfig.generalContact} and we will sort it with you.
          </Text>

          <Text as="h3" className="mt-12" size="lede" weight="semi">
            The statuses
          </Text>
          <div className="mt-4 overflow-x-auto border border-border">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-border border-b">
                  {["Status", "Role", "Level", "How established", "Opens", "State"].map((heading) => (
                    <th className={cn(CELL, "font-normal")} key={heading} scope="col">
                      <Text as="span" color="subtle" inline size="stamp">
                        {heading}
                      </Text>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {STATUSES.map((row) => (
                  <tr className="border-border/60 border-b last:border-b-0" key={row[0]}>
                    {row.map((cell, index) => (
                      <td className={CELL} key={cell}>
                        <Text as="span" color={index === 0 ? "inherit" : "muted"} inline size="small">
                          {cell}
                        </Text>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Text as="p" className="mt-3" color="muted" size="small" wrap="pretty">
            Conformant is a machine check. Verified is a human review, and makes you a Partner. No fee at any stage.
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="register" title="The register">
          <Text as="p" className="mt-6" color="muted" size="body">
            Applications open by 14 November.
          </Text>
          <div className="mt-4 overflow-x-auto border border-border">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-border border-b">
                  {["Organisation", "Role", "Status", "Spec version", "Since", "State"].map((heading) => (
                    <th className={cn(CELL, "font-normal")} key={heading} scope="col">
                      <Text as="span" color="subtle" inline size="stamp">
                        {heading}
                      </Text>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {register.length === 0 ? (
                  <tr>
                    <td className={CELL} colSpan={6}>
                      <Text as="span" color="muted" inline size="small">
                        Nothing listed yet.
                      </Text>
                    </td>
                  </tr>
                ) : (
                  register.map((entry) => (
                    <tr
                      className="border-border/60 border-b last:border-b-0"
                      key={`${entry.organisation}-${entry.status}`}
                    >
                      <td className={CELL}>
                        <Text as="span" inline size="small">
                          {entry.organisation}
                        </Text>
                      </td>
                      {[entry.role, entry.status, entry.specVersion, entry.since, entry.state].map((cell) => (
                        <td className={CELL} key={cell}>
                          <Text as="span" color="muted" inline size="small">
                            {cell}
                          </Text>
                        </td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <Text as="p" className="mt-3" color="subtle" family="mono" size="stamp">
            Kept on GitHub · machine readable at{" "}
            <a className="hover:text-primary" href="/register/index.json">
              /register/index.json
            </a>{" "}
            · Supporters are listed separately on the Principles page
          </Text>

          <Text as="h3" className="mt-12" size="lede" weight="semi">
            Recognised trust registries
          </Text>
          <Text as="p" className="mt-2 max-w-[68ch]" color="muted" size="small" wrap="pretty">
            A current entry on one of these stands in place of a KYB-style check when an organisation applies for a
            Verified status.
          </Text>
          <div className="mt-4 grid grid-cols-1 gap-px md:grid-cols-2">
            {trustRegistries.map((registry) => (
              <div className={CARD} key={registry.name}>
                <Text as="h4" size="body" weight="semi">
                  {registry.name}
                </Text>
                <Text as="p" color="subtle" size="stamp">
                  {registry.operator} · recognised {registry.recognisedOn}
                </Text>
                <Text as="p" color="muted" size="small" wrap="pretty">
                  {registry.basis}
                </Text>
                <Text as="p" className="mt-auto pt-2" size="small">
                  <a
                    className="text-primary hover:text-foreground"
                    href={registry.url}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {registry.name} →
                  </a>
                </Text>
              </div>
            ))}
          </div>
          <Text as="p" className="mt-3" color="subtle" family="mono" size="stamp">
            <a className="hover:text-primary" href="/register/trust-registries.json">
              /register/trust-registries.json
            </a>
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="channels" title="Channels and contacts">
          <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2">
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                Chat
              </Text>
              <Text as="h3" size="lede" weight="semi">
                #pdp-connect on Discord
              </Text>
              <Text as="p" color="muted" size="small">
                Where things are announced first.
              </Text>
              <div className="mt-auto pt-2">
                <ChannelLink href={siteConfig.discordUrl} label="Join →" />
              </div>
            </div>
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                Email
              </Text>
              <Text as="h3" size="lede" weight="semi">
                Mailing list
              </Text>
              <Text as="p" color="muted" size="small">
                New versions and comment periods. Low volume. Opening alongside the register.
              </Text>
              <div className="mt-auto pt-2">
                <ChannelLink href={siteConfig.mailingListUrl} label="Subscribe →" />
              </div>
            </div>
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                Governments and regulators
              </Text>
              <Text as="h3" size="lede" weight="semi">
                Take part without signing
              </Text>
              <Text as="p" color="muted" size="small">
                Observe anywhere, sign nothing. Ask for a briefing.
              </Text>
              <Text as="p" className="mt-auto pt-2" size="small">
                <a className="text-primary hover:text-foreground" href={`mailto:${siteConfig.generalContact}`}>
                  Contact →
                </a>
              </Text>
            </div>
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                Something wrong?
              </Text>
              <Text as="h3" size="lede" weight="semi">
                Report it
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                A wrong description, a name that should not be listed, anything about a status. Answered within five
                working days.
              </Text>
              <Text as="p" className="mt-auto pt-2" family="mono" size="small">
                <a className="text-primary hover:text-foreground" href={REPORTS_EMAIL_HREF}>
                  pdpp-dev-reports@lfdecentralizedtrust.org →
                </a>
              </Text>
            </div>
          </div>
        </PdppConceptSection>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
