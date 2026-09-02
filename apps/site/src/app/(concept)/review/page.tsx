// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { Text } from "@/components/typography/text.tsx";
import { REPORTS_EMAIL_HREF } from "@/lib/site-config.ts";
import { GITHUB_NEW_ISSUE_URL } from "@/lib/site-facts.ts";
import { cn } from "@/lib/utils.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/review" },
  description: "The specification and its governance are open for public comment until 1 October 2026.",
  openGraph: { url: "/review" },
  title: "Review the specification - PDPP",
};

// The temporary Review page.
//
// This page and the reader's own version strip are the ONLY places on the site
// that name the review period. Everything else that referenced it (the nav
// dropdown entry, the ticker) is behind the reviewOpen flag, so when the
// period closes the flag goes off and this page is the single thing left to
// retire. A deadline repeated across a site has to be unwound from every place
// that repeated it.
//
// Section numerals ARE allowed here, unlike the rest of the site: this page's
// whole job is to point a reader at particular clauses to comment on, and
// "read §7" is the instruction. Step 1-3 are content, not section ordinals.

const CARD = cn("flex flex-col gap-3 bg-background p-6", "shadow-[0_0_0_1px_var(--border)]");

const READING = [
  "§5 Source declaration, including Declaration acceptance",
  "§7 Grant",
  "§8 Resource server interface",
  "§9 Conformance",
] as const;

const TIMELINE = [
  {
    date: "3 September",
    text: "The specification and Part A are frozen, the Principles are published, and Supporter signing opens.",
  },
  { date: "1 October", text: "The comment period closes, and answers are published after." },
  { date: "15 October", text: "The programme opens." },
] as const;

export default function Page() {
  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <div className="flex flex-col gap-4 pt-10">
          <Text as="p" color="subtle" family="mono" size="stamp">
            Formal review · open until 1 October 2026
          </Text>
          <Text as="h1" size="display">
            Review the specification
          </Text>
          {/* Copy delta 3: the "one document of nine sections" sentence is
              deleted from this lede. */}
          <Text as="p" className="max-w-[68ch]" size="lede" wrap="pretty">
            The Personal Data Portability Protocol v0.1.0 and its governance are open for public comment until 1
            October.
          </Text>
          <div className="flex flex-wrap gap-4 pt-2">
            <Text as="p" size="body">
              <Link className="text-primary hover:text-foreground" href="/specification">
                Open the specification →
              </Link>
            </Text>
            <Text as="p" size="body">
              <Link className="text-primary hover:text-foreground" href="/specification#governance">
                Open governance →
              </Link>
            </Text>
          </div>
        </div>

        <PdppConceptSection id="what-to-read" title="What to read">
          <Text as="p" className="mt-2" color="subtle" family="mono" size="stamp">
            Step 1
          </Text>
          <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2">
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                Specification · about 45 minutes
              </Text>
              <Text as="h3" size="lede" weight="semi">
                Four sections carry most of the weight
              </Text>
              <Text as="p" color="muted" size="small">
                If you only have twenty minutes, read §7.
              </Text>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {READING.map((item) => (
                  <li key={item}>
                    <Text as="span" family="mono" inline size="small">
                      {item}
                    </Text>
                  </li>
                ))}
              </ul>
              <Text as="p" className="mt-auto pt-2" size="small">
                <Link className="text-primary hover:text-foreground" href="/specification">
                  Open the specification →
                </Link>
              </Text>
            </div>
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                Governance · about 20 minutes
              </Text>
              <Text as="h3" size="lede" weight="semi">
                Two parts, one of them still open
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                Part A is how PDP-Connect runs from 15 October and is frozen during review. Part B is the proposed
                long-term structure and is where your comment will change the most. Two open questions: five steering
                committee seats or three, and whether one organisation one vote puts off large companies.
              </Text>
              <Text as="p" className="mt-auto pt-2" size="small">
                <Link className="text-primary hover:text-foreground" href="/specification#governance">
                  Open governance →
                </Link>
              </Text>
            </div>
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="how-to-comment" title="How to comment">
          <Text as="p" className="mt-2" color="subtle" family="mono" size="stamp">
            Step 2
          </Text>
          {/* Copy delta 1: the "In person / Working sessions" channel is
              deleted. Two channels remain. */}
          <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2">
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                On GitHub
              </Text>
              <Text as="h3" size="lede" weight="semi">
                One issue per point
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                Every section of the specification has a comment link that opens an issue with the section pre-filled.
                Say what is wrong, what you would change, and why.
              </Text>
              <Text as="p" className="mt-auto pt-2" size="small">
                <a
                  className="text-primary hover:text-foreground"
                  href={GITHUB_NEW_ISSUE_URL}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  Open an issue →
                </a>
              </Text>
            </div>
            <div className={CARD}>
              <Text as="p" color="subtle" size="stamp">
                By email
              </Text>
              <Text as="h3" size="lede" weight="semi">
                Same log, no account needed
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                Email your comments and we add them to the same public log, under whatever name you ask for.
              </Text>
              <Text as="p" className="mt-auto pt-2" family="mono" size="small">
                <a className="text-primary hover:text-foreground" href={REPORTS_EMAIL_HREF}>
                  pdpp-dev-reports@lfdecentralizedtrust.org →
                </a>
              </Text>
            </div>
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="what-happens" title="What happens to your comment">
          <Text as="p" className="mt-2" color="subtle" family="mono" size="stamp">
            Step 3
          </Text>
          {/* Copy delta 2: both sentences replaced. */}
          <Text as="p" className="mt-6 max-w-[68ch]" size="body" wrap="pretty">
            Every comment is logged in one public log. Substantive comments are answered: accepted, declined with a
            reason, or parked, and the answers are published there too. If a comment changes something substantial, the
            new text goes out for another 15 days before it is final. During that period we may hold one-to-one
            conversations with commenters.
          </Text>
          <ul className="mt-8 flex list-none flex-col gap-3 p-0">
            {TIMELINE.map((entry) => (
              <li className="flex flex-col gap-1 border-border border-l-2 pl-4 md:flex-row md:gap-4" key={entry.date}>
                <Text as="span" className="md:w-32 md:shrink-0" color="primary" family="mono" size="small">
                  {entry.date}
                </Text>
                <Text as="span" color="muted" size="small">
                  {entry.text}
                </Text>
              </li>
            ))}
          </ul>
        </PdppConceptSection>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
