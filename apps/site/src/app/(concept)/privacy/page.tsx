// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppConceptSection } from "@/components/sections/concept-section.tsx";
import { Text } from "@/components/typography/text.tsx";
import { siteConfig } from "@/lib/site-config.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  description: "What PDP-Connect stores when you sign the Principles, what is published, and how to withdraw.",
  openGraph: { url: "/privacy" },
  title: "Privacy - PDPP",
};

// The privacy statement for the interim Supporter register.
//
// Every party-specific value comes from config: the controller and the contact
// address are not settled until LF Decentralized Trust hosting is confirmed,
// and a page that guessed either would be making a legal claim on someone
// else's behalf. Until they are set the reader sees a bracketed placeholder,
// which is honest, rather than a plausible-looking name that is wrong.
//
// This page covers ONLY the signing system. The site sets no cookies for
// analytics and runs no third-party tracker, so there is nothing else to
// state; if that ever changes this page grows a section rather than a separate
// document appearing somewhere else.

const STORED = [
  "The name you entered, and for an organisation the organisation name, the signatory's name and their role.",
  "Your email address.",
  "Your country and, for an organisation, its type.",
  "The four consent choices you made on the form.",
  "The version of the Principles you signed and the time your signature was confirmed.",
] as const;

const PUBLISHED = [
  "A public name: your first name and last initial if you signed as an individual, or the organisation name if you signed for an organisation.",
  "Your country.",
  "The type, for organisations.",
  "The date you signed and the version of the Principles you signed.",
] as const;

export default function Page() {
  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <div className="flex flex-col gap-4 pt-10">
          <Text as="h1" size="display">
            Privacy
          </Text>
          <Text as="p" className="max-w-[68ch]" size="lede" wrap="pretty">
            This page describes what happens to the details you give when you sign the PDPP Principles. It is the only
            place on this site where personal data is collected.
          </Text>
        </div>

        <PdppConceptSection id="controller" title="Who holds your details">
          <Text as="p" className="mt-6 max-w-[68ch]" size="body" wrap="pretty">
            Your details are held by {siteConfig.controllerName} on behalf of PDP-Connect until LF Decentralized Trust
            hosting is confirmed, and will be transferred then. This is an interim arrangement, and the transfer is
            described in the project's register documentation.
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="purposes" title="Why we hold it">
          <Text as="p" className="mt-6 max-w-[68ch]" size="body" wrap="pretty">
            To confirm that a signature is genuine, to publish the register of Supporters, and, if you asked for it, to
            tell you about new versions of the specification and comment periods. We do not use it for anything else,
            and we never sell or share it.
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="stored" title="What is stored">
          <ul className="mt-6 flex max-w-[68ch] list-disc flex-col gap-2 pl-5">
            {STORED.map((item) => (
              <li key={item}>
                <Text as="span" size="body">
                  {item}
                </Text>
              </li>
            ))}
          </ul>
          <Text as="p" className="mt-4 max-w-[68ch]" color="muted" size="small" wrap="pretty">
            This is held in a private repository that only the project's maintainers can read.
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="published" title="What is published">
          <ul className="mt-6 flex max-w-[68ch] list-disc flex-col gap-2 pl-5">
            {PUBLISHED.map((item) => (
              <li key={item}>
                <Text as="span" size="body">
                  {item}
                </Text>
              </li>
            ))}
          </ul>
          <Text as="p" className="mt-4 max-w-[68ch]" size="body" wrap="pretty">
            Your email address is never published. Neither is the name or role of the person who signed for an
            organisation.
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="confirmation" title="Confirming and withdrawing">
          <div className="mt-6 flex max-w-[68ch] flex-col gap-4">
            <Text as="p" size="body" wrap="pretty">
              When you submit the form we send one email to the address you gave, containing a link to a confirmation
              page. The page asks you to confirm your signature. The link expires after 48 hours and can be used once.
              If you do not use it, nothing is published and the details you submitted are discarded.
            </Text>
            <Text as="p" size="body" wrap="pretty">
              That same email carries a withdrawal link. Using it deletes your record. Only the date of the withdrawal
              is kept, with nothing that identifies you, so we can account for the size of the register over time. Your
              entry leaves the public list the next time it is published.
            </Text>
            <Text as="p" size="body" wrap="pretty">
              No other email is ever sent by this system.
            </Text>
          </div>
        </PdppConceptSection>

        <PdppConceptSection id="retention" title="How long it is kept">
          <Text as="p" className="mt-6 max-w-[68ch]" size="body" wrap="pretty">
            Until you withdraw, or until the register is transferred to LF Decentralized Trust, whichever comes first.
            On transfer, the whole register moves to the successor controller and the interim copy is deleted.
          </Text>
        </PdppConceptSection>

        <PdppConceptSection id="contact" title="Asking about your details">
          <Text as="p" className="mt-6 max-w-[68ch]" size="body" wrap="pretty">
            Write to {siteConfig.privacyContact} to ask what is held about you, to correct it, or to have it deleted.
          </Text>
          <Text as="p" className="mt-4" size="small">
            <Link className="text-primary hover:text-foreground" href="/principles">
              Back to the Principles →
            </Link>
          </Text>
        </PdppConceptSection>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
