// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { PdppPrinciplesList } from "@/components/site/principles-list.tsx";
import { PdppSigningForm } from "@/components/site/signing-form.tsx";
import { PdppSupportersTable, readPublicSupporters } from "@/components/site/supporters.tsx";
import { Text } from "@/components/typography/text.tsx";
import { PRINCIPLES_FRONT_MATTER, PRINCIPLES_PREAMBLE } from "@/generated/spec-front-matter.ts";
import { repoBlobUrl } from "@/lib/site-facts.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/principles" },
  description: "The intentions behind the Personal Data Portability Protocol, and the public register of Supporters.",
  openGraph: { url: "/principles" },
  title: "Principles - PDPP",
};

// The Principles page.
//
// Every word of the preamble and the six principles comes from the repo-root
// PRINCIPLES.md through the generated module, never from this file. That
// document is what a Supporter signs; a paraphrase on the page they sign from
// would be a different document.
//
// The version strip states the version and publication date because a
// signature attaches to a version. It is the one fact a signatory needs before
// they act, and PRINCIPLES.md's own Status line is where it comes from.

export default async function Page() {
  const supporters = await readPublicSupporters();

  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <div className="flex flex-col gap-4 pt-10">
          <Text as="p" color="subtle" family="mono" size="stamp">
            PDPP Principles · v{PRINCIPLES_FRONT_MATTER.version} · {PRINCIPLES_FRONT_MATTER.status}
          </Text>
          <Text as="h1" size="display">
            The principles guiding PDPP
          </Text>
        </div>

        <div className="mt-8 flex max-w-[68ch] flex-col gap-4">
          {PRINCIPLES_PREAMBLE.map((paragraph) => (
            <Text as="p" key={paragraph.slice(0, 48)} size="lede" wrap="pretty">
              {paragraph}
            </Text>
          ))}
        </div>

        <div className="mt-10">
          <PdppPrinciplesList />
        </div>

        <PdppConceptSection id="who-can-sign" title="Who can sign">
          <div className="mt-6 flex max-w-[68ch] flex-col gap-4">
            <Text as="p" size="body" wrap="pretty">
              Anyone. Individuals, companies, universities, civil society groups, and public bodies are all welcome.
              Individuals appear as first name and last initial; organisations by name. Your email is never shown.
            </Text>
            <Text as="p" size="body" wrap="pretty">
              Individuals sign for themselves rather than their employer. Signing is not a commitment to build anything
              or a sign-off on every line of the specification, and you can withdraw by email at any time.
            </Text>
          </div>
          <div className="mt-8 max-w-[46rem]">
            <PdppSigningForm />
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="supporters" title="Supporters">
          <div className="mt-6 flex flex-col gap-4">
            <PdppSupportersTable supporters={supporters} />
            <Text as="p" color="subtle" family="mono" size="stamp">
              {/* The published register is one file, and this names it. A
                  reader who wants the list without the page can take it. */}
              <a className="hover:text-primary" href="/principles/supporters.json">
                /principles/supporters.json
              </a>
            </Text>
          </div>
        </PdppConceptSection>

        <div className="mt-10">
          <Text as="p" color="subtle" size="small">
            <a
              className="hover:text-primary"
              href={repoBlobUrl("PRINCIPLES.md")}
              rel="noopener noreferrer"
              target="_blank"
            >
              Read the signed document
            </a>
          </Text>
        </div>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
