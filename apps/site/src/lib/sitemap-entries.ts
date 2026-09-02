// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MetadataRoute } from "next";
import {
  GOVERNANCE_SLUG,
  governanceRoute,
  MAINTAINER_DOC_SLUGS,
  PRINCIPLES_SLUG,
  principlesRoute,
  specDocExtension,
} from "./spec-nav-slugs.ts";

// Pure by design: takes plain { path, url } pairs rather than a fumadocs
// Page, so this can be unit-tested without loading the generated MDX source
// collection (.source/server.ts uses top-level await, which the node:test +
// tsx harness this repo uses for scripts/*.test.ts cannot transform — see
// scripts/seo-metadata.test.ts). src/app/sitemap.ts is the only caller and
// supplies the real fumadocs pages.
export interface DocPageRef {
  /** Repo-relative source path, e.g. "spec-core.mdx" or "README.md". */
  path: string;
  /** Resolved public URL, e.g. "/specification/spec-core". */
  url: string;
}

// Paths that are not canonical/indexable and must not appear in the sitemap
// (SEO/GEO standard MUST #4.3):
// - README.md: contributor-facing authoring notes (see sync-spec-docs.mjs)
// - every maintainer document: guides, rationale, deferred concerns and open
//   questions, deliberately unlisted so they never compete with the
//   specification. /maintainers (the index that lists them) is itself absent
//   from the sitemap because it is not a static entry below. Listing the
//   documents here would invite crawlers straight to what the rail, robots.txt
//   and their own noindex all keep out. Derived from MAINTAINER_DOC_SLUGS
//   rather than repeated, so the rail and the sitemap cannot disagree about
//   what is unlisted.
// - governance.mdx and principles.mdx: canonical at /governance and
//   /principles, not at the /specification/<slug> URLs fumadocs derives for
//   them (those URLs 308-redirect). Listing the fumadocs URL would put a
//   redirect in the sitemap; the canonical routes are added as static entries
//   below instead.
//
// Extensions come from specDocExtension rather than a hardcoded ".md": some
// maintainer docs are single-sourced from a root spec-*.md and generated as
// .mdx (see GENERATED_MDX_SPEC_SLUGS), others (reference-implementation*,
// open-questions) are hand-authored .md files this repo's generator never
// touches.
const NON_CANONICAL_DOC_PATHS = new Set([
  "README.md",
  `${GOVERNANCE_SLUG}.mdx`,
  `${PRINCIPLES_SLUG}.mdx`,
  ...MAINTAINER_DOC_SLUGS.map((slug) => `${slug}.${specDocExtension(slug)}`),
]);

// SEO/GEO standard MUST #4.3: a sitemap must contain only canonical,
// indexable URLs, and `lastmod` must represent the last substantive change to
// that page, not a deploy or build date.
export function buildSitemap(siteOrigin: string, docPages: readonly DocPageRef[], specLastModified: string) {
  // /design, /palette, /sandbox are excluded: they are noindex (see their own
  // layouts and robots.ts) and must not appear here.
  const staticEntries: MetadataRoute.Sitemap = [
    { url: siteOrigin },
    { url: `${siteOrigin}${governanceRoute}` },
    { url: `${siteOrigin}${principlesRoute}` },
    { url: `${siteOrigin}/self-host` },
    { url: `${siteOrigin}/participate` },
  ];

  // Spec/docs pages get `lastmod: specLastModified` — the `Date:` header
  // declared in spec-core.md (see spec-status.ts), the one per-content
  // revision date this codebase tracks. It is not necessarily the true
  // last-substantive-change date for every individual page (see
  // spec-status.ts for the known drift between that header and git history
  // after the LFDT history squash); using it is still more honest than a
  // build timestamp, and omitting `lastmod` is legal and preferable to
  // fabricating one. Front-door and static marketing pages carry no
  // comparable per-page revision signal in this codebase, so they omit
  // `lastmod` entirely rather than reporting a deploy time.
  //
  // index.mdx already resolves to url === "/specification" (fumadocs' own
  // root-index convention), so the docs index needs no separate static entry
  // — adding one would duplicate this loop's own first entry.
  const specEntries: MetadataRoute.Sitemap = docPages
    .filter((page) => !NON_CANONICAL_DOC_PATHS.has(page.path))
    .map((page) => ({
      lastModified: specLastModified,
      url: `${siteOrigin}${page.url}`,
    }));

  return [...staticEntries, ...specEntries];
}
