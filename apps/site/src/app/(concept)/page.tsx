// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { PdppHeroWaterStill } from "@/components/sections/hero-water-still.tsx";
import { PdppPrinciplesList } from "@/components/site/principles-list.tsx";
import { PdppSupportersTable, readPublicSupporters } from "@/components/site/supporters.tsx";
import { PdppWhatChanges } from "@/components/site/what-changes.tsx";
import { Text } from "@/components/typography/text.tsx";
import { cn } from "@/lib/utils.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  description:
    "Lets personal data move freely, with consent. Decide what an app can see, for what, and for how long.",
  openGraph: { url: "/" },
  title: "PDPP: Personal Data Portability Protocol",
};

// The front door.
//
// The hero's right-hand element is the repo's own scrolling data columns, not
// the grant card the prototype shows there. Two reasons, and they agree: the
// design export puts the columns in the hero, and the grant card already
// appears below in "What changes", where it carries the comparison. Rendering
// it twice would spend the page's one strong artifact on decoration.
//
// The columns are aria-hidden inside their own component: they are texture
// standing in for "records flowing", not content, and announcing eighteen rows
// of sample fields to a screen reader before the page's actual argument would
// bury it.

const CTA = cn(
  "inline-flex w-fit items-center border border-primary bg-primary px-5 py-2.5",
  "font-sans text-[15px] text-on-primary-emphasis no-underline",
  "hover:border-primary-emphasis hover:bg-primary-emphasis hover:text-on-primary-emphasis!"
);

export default async function Page() {
  const supporters = await readPublicSupporters();

  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <section className="grid grid-cols-1 items-center gap-10 pt-12 pb-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
          <div className="flex flex-col gap-5">
            <Text as="p" color="subtle" family="mono" size="stamp">
              The Personal Data Portability Protocol
            </Text>
            <Text as="h1" size="hero">
              The open standard for personal data.
            </Text>
            <Text as="p" className="max-w-[54ch]" size="lede" wrap="pretty">
              Lets personal data move freely, with consent. Decide what an app can see, for what, and for how long.
            </Text>
            <Link className={CTA} href="/principles">
              Become a Supporter
            </Link>
          </div>
          {/* Fixed height so the mask has something to fade against; the
              columns scroll inside it rather than growing the hero. */}
          <div className="h-[22rem] max-lg:hidden">
            <PdppHeroWaterStill />
          </div>
        </section>

        <PdppConceptSection id="what-changes" title="What changes">
          <PdppWhatChanges className="mt-8" />
        </PdppConceptSection>

        <PdppConceptSection id="principles" title="The Principles">
          <div className="mt-8">
            <PdppPrinciplesList compact />
          </div>
          <Link className={cn(CTA, "mt-8")} href="/principles">
            Become a Supporter
          </Link>
        </PdppConceptSection>

        <PdppConceptSection id="supporters" title="Supporters">
          <div className="mt-6 flex flex-col gap-4">
            <PdppSupportersTable supporters={supporters} />
            <Text as="p" size="small">
              <Link className="text-primary hover:text-foreground" href="/principles#supporters">
                All Supporters →
              </Link>
            </Text>
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="build" title="Build on PDPP">
          <Text as="p" className="mt-6 max-w-[68ch]" size="lede" wrap="pretty">
            One specification, a reference server you can run today, and three roles to build for. Pick yours.
          </Text>
          <Text as="p" className="mt-6" size="body">
            <Link className="text-primary hover:text-foreground" href="/build">
              Start building →
            </Link>
          </Text>
        </PdppConceptSection>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
