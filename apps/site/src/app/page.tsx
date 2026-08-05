// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Link from "next/link";
import { PdppConceptFooter } from "@/components/pdpp-concept/footer.tsx";
import { PdppHeroWater } from "@/components/pdpp-concept/hero-water.tsx";
import { PdppConceptMasthead } from "@/components/pdpp-concept/masthead.tsx";
import { SPEC_STATUS_STAMP } from "@/components/pdpp-concept/spec-status.ts";

// THE FRONT DOOR. Rewritten lean against Solid / opencode / x402, the three
// references the owner named. Visible text went from roughly 150 words to 61.
//
// What was REMOVED and must not come back without a decision: the search box
// (search is global, in the nav), "Copy page as Markdown" / index.md / llms.txt
// (machine-readability apparatus, not front-door content — the URLs still
// exist, only the visible links are gone), the "Where to go next" heading
// (it labelled a list of two on a page with one section), and the five long
// sections with their schematics.
//
// The word "slice" is gone sitewide. It was invented vocabulary: zero
// occurrences in spec-core.md, where "records" appears 64 times and "fields"
// 88 — and those two are what a grant literally names.
//
// THE HERO is records floating on water: three columns of real record fields
// drifting at a constant speed, on a velocity-and-height field the pointer
// disturbs. See hero-water.tsx for why it is a field rather than a per-record
// spring, and hero-field.ts for the fluid itself.
export default function Home() {
  return (
    <div className="pdpp-concept">
      <PdppConceptMasthead />

      <main className="pdpp-page pdpp-page--home">
        <PdppHeroWater />

        <article className="pdpp-doc pdpp-frontdoor">
          <h1>Personal Data Portability Protocol</h1>

          {/* Anchored to spec-core.md: "PDPP is an authorization and disclosure
              protocol for personal data". "Scoped" is the spec's own word;
              "open" is earned by the CSL-1.0 / Apache-2.0 licensing. */}
          <p className="pdpp-frontdoor__identity">An open protocol for scoped access to personal data.</p>

          <p className="pdpp-frontdoor__definition">
            A grant is how one person approves one application to read chosen records and fields, and a resource server
            enforces it on every request.
          </p>

          {/* The three worked examples from the specification, in its own order:
              top_artists, conversations, sleep_sessions. Left as a fragment
              rather than a sentence; it reads as the list it is, and it is the
              one line that addresses the reader directly. "Ninety days" is
              grt_003's time_range (exactly 90 days), so the line describes what
              is read rather than what is kept. */}
          <p className="pdpp-frontdoor__amplification">
            Ninety days of sleep scores, the artists you played, your own conversations.
          </p>

          {/* Kept verbatim: the owner praised this line and asked that it not be
              elevated to a centerpiece. It sits last. */}
          <p className="pdpp-frontdoor__amplification">
            It profiles{" "}
            <a href="https://oauth.net/2/" rel="noopener noreferrer" target="_blank">
              OAuth 2.0
            </a>{" "}
            and{" "}
            <a href="https://www.rfc-editor.org/info/rfc9396" rel="noopener noreferrer" target="_blank">
              RFC 9396
            </a>
            , the same pattern as{" "}
            <a href="https://www.smarthealthit.org/" rel="noopener noreferrer" target="_blank">
              SMART on FHIR
            </a>{" "}
            and{" "}
            <a href="https://www.openbanking.org.uk/" rel="noopener noreferrer" target="_blank">
              Open Banking
            </a>
            .
          </p>

          {/* Two CTAs, directly after the copy with no heading over them.
              "Self-host it" rather than "Run a node": "node" appears zero times
              in spec-core.md and arrives from a different technical culture.
              This label matches the masthead nav, so the route reads as one
              destination.

              Participate is a third, QUIET text link — a real destination, but
              not a peer: a visitor decides to read or to run first and joins
              after. */}
          <div className="pdpp-frontdoor__actions">
            <Link className="pdpp-cta pdpp-cta--primary" href="/specification">
              Read the specification
            </Link>
            <Link className="pdpp-cta pdpp-cta--secondary" href="/self-host">
              Self-host it
            </Link>
            <Link className="pdpp-cta pdpp-cta--quiet" href="/participate">
              Participate
            </Link>
          </div>

          <p className="pdpp-frontdoor__status">
            <span className="pdpp-stamp">{SPEC_STATUS_STAMP}</span>
          </p>
        </article>
      </main>

      <PdppConceptFooter />
    </div>
  );
}
