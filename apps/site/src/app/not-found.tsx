// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";

// The concept has no 404 (it is four static pages with no unmatched routes);
// this app serves /docs/[[...slug]] and other dynamic routes, so a missing
// page is reachable. Without this file Next.js renders its own generic
// fallback — unstyled, no masthead, no footer — which breaks the document
// register on the one page a mistyped or stale link is most likely to hit.
export default function NotFound() {
  return (
    <div className="pdpp-concept">
      <PdppConceptMasthead />

      <main className="pdpp-page pdpp-page--home">
        <article className="pdpp-doc pdpp-frontdoor">
          <h1>Page not found</h1>
          <p className="pdpp-frontdoor__definition">
            There is no page at this address. It may have moved, or the link may be out of date.
          </p>
          <div className="pdpp-frontdoor__actions">
            <Link className="pdpp-cta pdpp-cta--primary" href="/">
              Go to the front door
            </Link>
            <Link className="pdpp-cta pdpp-cta--secondary" href="/specification">
              Read the specification
            </Link>
          </div>
        </article>
      </main>

      <PdppConceptFooter />
    </div>
  );
}
