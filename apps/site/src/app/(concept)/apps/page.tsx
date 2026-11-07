// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import Link from "next/link";
import { PdppConceptDoc, PdppConceptPage } from "@/components/layout/concept-page.tsx";
import { PdppAppDirectory } from "@/components/site/app-directory.tsx";
import { Text } from "@/components/typography/text.tsx";
import { buildDirectory } from "@/lib/app-directory.ts";
import { readConnectorSnapshot, readRegisterEntries } from "@/lib/app-directory-sources.ts";
import { readPublicSupporters } from "@/lib/public-supporters.ts";
import { repoBlobUrl } from "@/lib/site-facts.ts";

export const metadata: Metadata = {
  alternates: { canonical: "/apps" },
  description: "Search for an app to see what you can do with its data through PDPP today.",
  openGraph: { url: "/apps" },
  title: "Is your app on PDPP? - PDPP",
};

const DATA_CONNECTORS_URL = "https://github.com/PDP-Connect/data-connectors";

// "Is your app on PDPP?"
//
// A read-only view over lists PDPP already publishes: the signed connector
// catalogue (loaded live and cached for an hour, with a copy in the repo as the
// fallback), the Supporters register and the conformance register. No data is
// collected and nothing is sent anywhere. The search runs in the visitor's
// browser over rows built here, so the page is static between regenerations.
export default async function Page() {
  const [snapshot, supporters, register] = await Promise.all([
    readConnectorSnapshot(),
    readPublicSupporters(),
    readRegisterEntries(),
  ]);
  const directory = buildDirectory({ register, snapshot, supporters });

  return (
    <PdppConceptPage>
      <PdppConceptDoc>
        <div className="flex flex-col gap-4 pt-10">
          <Text as="h1" size="display">
            Is your app on PDPP?
          </Text>
          <Text as="p" className="max-w-[68ch]" size="lede" wrap="pretty">
            Search for an app to see what you can do with its data through PDPP today, and whether the company has
            signed or registered.
          </Text>
          <Text as="p" className="max-w-[68ch]" color="muted" size="small" wrap="pretty">
            Each connector is open source and brings your data from that app into PDPP. A company has not signed the
            Principles or registered with PDPP unless its entry says so.
          </Text>
        </div>

        <div className="mt-10">
          <PdppAppDirectory entries={directory.entries} />
        </div>

        <Text as="p" className="mt-12 max-w-[68ch]" color="subtle" size="small" wrap="pretty">
          Connector catalogue updated {directory.catalogueUpdated}. Company status comes from the public{" "}
          <Link className="hover:text-primary" href="/principles#supporters">
            Supporters
          </Link>{" "}
          and conformance registers, as set out in{" "}
          <a
            className="hover:text-primary"
            href={repoBlobUrl("GOVERNANCE.md")}
            rel="noopener noreferrer"
            target="_blank"
          >
            GOVERNANCE.md
          </a>
          . Connectors are built in{" "}
          <a className="hover:text-primary" href={DATA_CONNECTORS_URL} rel="noopener noreferrer" target="_blank">
            PDP-Connect/data-connectors
          </a>
          .
        </Text>
      </PdppConceptDoc>
    </PdppConceptPage>
  );
}
