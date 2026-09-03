// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { Text } from "@/components/typography/text.tsx";
import { GITHUB_REPO_URL } from "@/lib/site-facts.ts";
import { cn } from "@/lib/utils.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/build" },
  description: "The specification, a reference server you can run today, and guidance for the three roles.",
  openGraph: { url: "/build" },
  title: "Build - PDPP",
};

// The Build page: the "I want to implement this" intent.
//
// SECTION CITATIONS: the prototype's copy cites Core by section number
// throughout ("Core §5 →", "Start with Core §4 and §5"). The build rule is
// that the § glyph and numbered section citations do not appear in site copy
// outside the reader and /review, because a section number that moves leaves
// every page that cites it wrong. The citations are kept as WAYFINDING but
// named rather than numbered: "Source declaration" rather than "Core §5". The
// link still lands on the same anchor, and the reader shows the numeral.

const CARD = cn(
  "flex flex-col gap-3 bg-background p-6",
  // Hairline per card so an odd wrap leaves no dangling rule.
  "shadow-[0_0_0_1px_var(--border)]"
);

interface RoleCard {
  anchor: string;
  cta: string;
  eyebrow: string;
  start: string;
  title: string;
  body: string;
}

const ROLES: readonly RoleCard[] = [
  {
    anchor: "/specification#source-declaration",
    cta: "Source declaration",
    eyebrow: "I hold data",
    title: "Make a source",
    body: "You have data, on a platform or in a connector, and you want apps to be able to ask for it with consent. You need to write a source declaration that validates against the source declaration section, then serve records through a resource server that conforms to the resource server interface.",
    start: "Start with the record model and the source declaration, then the declaration schema and the validator.",
  },
  {
    anchor: "/specification#selection-request",
    cta: "Selection request",
    eyebrow: "I want data",
    title: "Make an accessor",
    body: "You are building an app or agent that needs someone's data. You ask for exactly what you need with a selection request, receive a grant, and query within it. If you have done OAuth, this is OAuth with a stricter scope.",
    start: "Start with the selection request and the grant, then the client example in the reference implementation.",
  },
  {
    anchor: "/self-host",
    cta: "Deploy the reference server",
    eyebrow: "I run the server",
    title: "Make an operator",
    body: "You run the authorization server, the resource server, or both. Yours is the code that records the grant and refuses anything outside it. The resource server interface is your contract, and the conformance section is what the test suite will check.",
    start: "Start by running the reference implementation, then read the resource server interface against it.",
  },
];

interface Faq {
  answer: string;
  cta: string;
  href: string;
  question: string;
  role: string;
}

const FAQS: readonly Faq[] = [
  {
    role: "Building a source",
    question: "How do I get data out of a platform and into a declaration?",
    answer:
      "The Collection Profile is one worked approach to collection, scheduling and refresh for connector-backed sources. Use it if you do not already have a pipeline. If you do, you conform as long as your declaration validates and your server answers queries.",
    cta: "Collection Profile",
    href: "/specification/spec-collection-profile",
  },
  {
    role: "Building an operator",
    question: "How does my server find a platform's declaration, and know it is real?",
    answer:
      "Discovery and Trust walks through locating a provider-native declaration under RFC 9728 and what to check before accepting it. The requirements themselves are in Core, under declaration acceptance, and this document is the how-to.",
    cta: "Discovery and Trust",
    href: "/specification/spec-discovery-and-trust",
  },
  {
    role: "Building an accessor",
    question: "Which purpose code do I put in my request?",
    answer:
      "Every grant names a purpose from the registry. Most requests fit an existing code, and ai_training is the one that triggers a protocol-level consent step. If nothing fits you can propose one, and proposals are considered on a published cycle.",
    cta: "Purpose registry",
    href: "/specification#purpose-registry",
  },
  {
    role: "Any role",
    question: "Core can't express the query I need. Now what?",
    answer:
      "Extension profiles add lexical search, aggregation and semantic query on top of Core without changing what Core means. Check whether one already covers your case before writing your own; an extension that weakens Core semantics is rejected.",
    cta: "Extension profiles",
    href: "/specification/spec-ext-lexical-search",
  },
];

export default function Page() {
  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <div className="flex flex-col gap-4 pt-10">
          <Text as="h1" size="display">
            Build with PDPP
          </Text>
          <Text as="p" className="max-w-[68ch]" size="lede" wrap="pretty">
            Everything you need to build on PDPP is here: the specification, a reference server you can run today, and
            guidance for the parts people tend to get stuck on.
          </Text>
          <Text as="p" size="small">
            <a className="hover:text-primary" href={GITHUB_REPO_URL} rel="noopener noreferrer" target="_blank">
              Open Core, clone the reference implementation
            </a>
          </Text>
        </div>

        <PdppConceptSection id="what-are-you-building" title="What are you building?">
          <div className="mt-6 grid grid-cols-1 gap-px lg:grid-cols-3">
            {ROLES.map((role) => (
              <div className={CARD} key={role.title}>
                <Text as="p" color="primary" family="mono" size="stamp">
                  {role.eyebrow}
                </Text>
                <Text as="h3" size="lede" weight="semi">
                  {role.title}
                </Text>
                <Text as="p" color="muted" size="small" wrap="pretty">
                  {role.body}
                </Text>
                <Text as="p" color="muted" size="small" wrap="pretty">
                  {role.start}
                </Text>
                <Text as="p" className="mt-auto pt-2" size="small">
                  <Link className="text-primary hover:text-foreground" href={role.anchor}>
                    {role.cta} →
                  </Link>
                </Text>
              </div>
            ))}
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="run-it" title="Run it in under an hour">
          <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2">
            <div className={CARD}>
              <Text as="h3" size="lede" weight="semi">
                Reference implementation
              </Text>
              <Text as="p" color="subtle" size="stamp">
                Deploy on Docker, Railway or Fly.io
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                A complete authorization and resource server with scoped access, revocation, and an MCP endpoint so you
                can point an assistant at it and watch grants get enforced. Use it to see the protocol behave before you
                write your own.
              </Text>
              <Text as="p" className="mt-auto pt-2" size="small">
                <Link className="text-primary hover:text-foreground" href="/self-host">
                  Deploy guide →
                </Link>
              </Text>
            </div>
            <div className={CARD}>
              <Text as="h3" size="lede" weight="semi">
                Try a real source
              </Text>
              <Text as="p" color="subtle" size="stamp">
                Connect GitHub or ChatGPT to it
              </Text>
              <Text as="p" color="muted" size="small" wrap="pretty">
                DataConnect ships signed connectors for both. Install it, grant an app one stream for one week, then
                revoke it, and you have seen the whole protocol.
              </Text>
              <Text as="p" className="mt-auto pt-2" size="small">
                <Link className="text-primary hover:text-foreground" href="/self-host">
                  DataConnect releases →
                </Link>
              </Text>
            </div>
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="faqs" title="Community FAQs">
          <div className="mt-6 grid grid-cols-1 gap-px md:grid-cols-2">
            {FAQS.map((faq) => (
              <div className={CARD} key={faq.question}>
                <Text as="p" color="primary" family="mono" size="stamp">
                  {faq.role}
                </Text>
                <Text as="h3" size="body" weight="semi">
                  {faq.question}
                </Text>
                <Text as="p" color="muted" size="small" wrap="pretty">
                  {faq.answer}
                </Text>
                <Text as="p" className="mt-auto pt-2" size="small">
                  <Link className="text-primary hover:text-foreground" href={faq.href}>
                    {faq.cta} →
                  </Link>
                </Text>
              </div>
            ))}
          </div>
          <Text as="p" className="mt-8" size="body">
            <Link className="text-primary hover:text-foreground" href="/participate#get-verified">
              Built on PDPP? Get it verified →
            </Link>
          </Text>
        </PdppConceptSection>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
