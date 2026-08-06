// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MetadataRoute } from "next";
import { SITE_ORIGIN } from "@/components/pdpp-concept/site-facts.ts";

// SEO/GEO standard MUST #1.5: robots.txt, page-level robots directives, and
// application responses must agree with the approved access policy.
//
// This site has no restrictive crawl policy on record (spec text is
// CSL-1.0, docs are CC-BY-4.0, reference code is Apache-2.0 — all openly
// licensed for reuse), so the default is Allow for every crawler class. The
// standard's MUST #3 crawler-access matrix (search/grounding vs.
// model-training vs. user-fetch, decided per named bot) is an explicit
// governance decision the policy owner has not recorded; this file does not
// invent one. /design and /palette (contributor-only, feature-flagged,
// already `noindex, nofollow` in their own layouts), /sandbox (mock demo
// data, already `noindex, nofollow` in its layout), and
// /specification/README (contributor-facing authoring notes, already
// `noindex, nofollow` in its own generateMetadata) are disallowed here too,
// so the crawl policy holds even for a crawler that ignores meta robots.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      allow: "/",
      disallow: ["/design", "/palette", "/sandbox", "/specification/README"],
      userAgent: "*",
    },
    sitemap: `${SITE_ORIGIN}/sitemap.xml`,
  };
}
