// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { Button } from "@/components/pdpp-concept/button.tsx";
import { PdppConceptDoc, PdppConceptPage } from "@/components/pdpp-concept/concept-page.tsx";
import { PdppConceptShell } from "@/components/pdpp-concept/concept-shell.tsx";
import "@/styles/surfaces/concept/index.css";

// Unmatched routes sit outside the concept route group, so the root 404 owns
// the concept presentation explicitly instead of falling back to Next.js's
// generic, unstyled page.
export default function NotFound() {
  return (
    <PdppConceptShell>
      <PdppConceptPage home>
        <PdppConceptDoc>
          <h1>Page not found</h1>
          <p className="m-0! mb-4! text-[20px] leading-[1.5]">
            There is no page at this address. It may have moved, or the link may be out of date.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-x-4 gap-y-3 max-[460px]:flex-col max-[460px]:items-stretch max-[460px]:**:data-[slot=pdpp-concept-button]:justify-center">
            <Button nativeButton={false} render={<Link href="/" />} variant="primary">
              Go to the front door
            </Button>
            <Button nativeButton={false} render={<Link href="/specification" />} variant="secondary">
              Read the specification
            </Button>
          </div>
        </PdppConceptDoc>
      </PdppConceptPage>
    </PdppConceptShell>
  );
}
