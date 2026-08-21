// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppRail } from "@/components/layout/rail.tsx";
import { PdppConceptDocHeader } from "@/components/sections/concept-doc-header.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { PdppRuledList, PdppRuledListItem } from "@/components/sections/ruled-list.tsx";
import { Text } from "@/components/typography/text.tsx";
import { docsRoute, maintainersRoute } from "@/lib/spec-nav-slugs.ts";

// The unlisted index for everything that is NOT the specification.
//
// /specification carries the six normative documents and nothing else, so a
// reader lands on the protocol rather than on a directory. The material below
// still matters — it is how the protocol got its current shape, and what an
// implementation actually does — but it is not normative, so it does not
// compete for the rail.
//
// UNLISTED, not private: no chrome anywhere links here, robots.txt disallows it
// and every page is noindex (see app/robots.ts and MAINTAINER_DOC_SLUGS), but
// anyone with the URL can read it and no credentials are involved. Documents
// keep their /specification/<slug> URLs so links already published still
// resolve; only their visibility changed.
//
// Each entry says what the document IS and why it is not normative. A bare list
// of nine titles would make the reader open all nine to find the one they want.
export const metadata: Metadata = {
  alternates: { canonical: maintainersRoute },
  description: "Supporting documents for PDPP: design rationale, implementation notes, and open questions.",
  robots: { follow: false, index: false },
  title: "Maintainers - PDPP",
};

const MAINTAINERS_TOC = [
  { href: "#design", label: "Design rationale" },
  { href: "#implementation", label: "Implementation" },
  { href: "#open", label: "Open and deferred" },
] as const;

interface DocEntry {
  readonly body: string;
  readonly slug: string;
  readonly title: string;
}

// Grouped by the question a maintainer arrives with — why is it this way, what
// does the code do, what is still undecided — not by document type.
const DESIGN_DOCS: readonly DocEntry[] = [
  {
    body: "How the reference components fit together: native provider, polyfill path, runtime, and client flows. Describes the current topology, not a required one.",
    slug: "spec-architecture",
    title: "Reference Topology",
  },
  {
    body: "Why bearer token semantics land where they do at protocol boundaries. The conclusions are normative in the core specification; the reasoning is here.",
    slug: "spec-auth-design",
    title: "Auth Design",
  },
  {
    body: "Why incremental sync is grant-relative and cursor-based. Same split: the requirement is in the core specification, the argument for it is here.",
    slug: "spec-change-tracking",
    title: "Change Tracking",
  },
];

const IMPLEMENTATION_DOCS: readonly DocEntry[] = [
  {
    body: "What the forkable reference stack does today. Current behaviour of one implementation, which is not a protocol requirement.",
    slug: "reference-implementation",
    title: "Reference Implementation Notes",
  },
  {
    body: "Worked examples against the reference stack. A guide, so it dates faster than the specification it demonstrates.",
    slug: "reference-implementation-examples",
    title: "Reference Implementation Examples",
  },
  {
    body: "How connectors are built and what the ecosystem around them looks like. Describes what implementations do rather than what the protocol requires.",
    slug: "spec-connector-ecosystem",
    title: "Connector Ecosystem",
  },
];

const OPEN_DOCS: readonly DocEntry[] = [
  {
    body: "Questions the working group has not settled. Kept here rather than in the specification so an undecided question never reads as a decided one.",
    slug: "open-questions",
    title: "Open Questions",
  },
  {
    body: "Concerns held back from the current draft, with the reason each was deferred. Deferred is not rejected; several are expected to return.",
    slug: "spec-deferred",
    title: "Deferred Concerns",
  },
  {
    body: "Superseded. The query surface it describes was replaced; it stays reachable because earlier drafts and external links still cite it.",
    slug: "spec-data-query-api",
    title: "Data Query API",
  },
];

// Reuses PdppRuledList (self-host's "What you get") rather than a one-off
// list: same shape — a ruled list of title-then-description rows.
function DocList({ docs }: { docs: readonly DocEntry[] }) {
  return (
    <PdppRuledList>
      {docs.map((doc) => (
        <PdppRuledListItem key={doc.slug}>
          <Link className="link-prose" href={`${docsRoute}/${doc.slug}`}>
            {doc.title}
          </Link>{" "}
          <Text as="span" color="foreground" size="body">
            {doc.body}
          </Text>
        </PdppRuledListItem>
      ))}
    </PdppRuledList>
  );
}

export default function MaintainersPage() {
  return (
    <PdppConceptPage>
      <PdppRail toc={MAINTAINERS_TOC} />
      <PdppConceptDoc>
        <PdppConceptDocHeader
          lede="The documents behind the specification: why the protocol has its current shape, what the reference implementation does, and what is still undecided. None of it is normative."
          title="Maintainers"
        />

        <PdppConceptSection id="design" sectionIndex="01" title="Design rationale">
          <Text as="p" color="muted" size="body">
            Why the protocol is the way it is. The requirements themselves live in the{" "}
            <Link className="link-prose" href={docsRoute}>
              specification
            </Link>
            . These record the reasoning that produced them.
          </Text>
          <DocList docs={DESIGN_DOCS} />
        </PdppConceptSection>

        <PdppConceptSection id="implementation" sectionIndex="02" title="Implementation">
          <Text as="p" color="muted" size="body">
            What running code does today. Useful when building against PDPP, and binding on nobody.
          </Text>
          <DocList docs={IMPLEMENTATION_DOCS} />
        </PdppConceptSection>

        <PdppConceptSection id="open" sectionIndex="03" title="Open and deferred">
          <Text as="p" color="muted" size="body">
            Questions without answers yet, and material held back from the current draft.
          </Text>
          <DocList docs={OPEN_DOCS} />
        </PdppConceptSection>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
