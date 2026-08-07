// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { PdppConceptDoc, PdppConceptPage } from "@/components/pdpp-concept/concept-page.tsx";
import { PdppFrontDoor } from "@/components/pdpp-concept/front-door.tsx";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/components/pdpp-concept/site-facts.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/" },
  openGraph: {
    description: SITE_DESCRIPTION,
    title: SITE_TITLE,
    type: "website",
    url: "/",
  },
};

export default function Home() {
  return (
    <PdppConceptPage home>
      <PdppConceptDoc>
        <PdppFrontDoor />
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
