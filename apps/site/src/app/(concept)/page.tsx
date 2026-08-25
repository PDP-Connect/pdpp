// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import { PdppConceptDoc, PdppConceptFrontPage } from "@/components/layout/concept-page.tsx";
import { PdppFrontDoor } from "@/components/sections/front-door.tsx";
import { SITE_DESCRIPTION, SITE_TITLE } from "@/lib/site-facts.ts";

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
    <PdppConceptFrontPage>
      <PdppConceptDoc>
        <PdppFrontDoor />
      </PdppConceptDoc>
    </PdppConceptFrontPage>
  );
}
