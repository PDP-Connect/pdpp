// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { MetadataRoute } from "next";
import { REFERENCE_MATERIALS_SLUGS } from "./spec-nav-slugs.ts";

// Pure by design: takes plain { path, url } pairs rather than a fumadocs
// Page, so this can be unit-tested without loading the generated MDX source
// collection (.source/server.ts uses top-level await, which the node:test +
// tsx harness this repo uses for scripts/*.test.ts cannot transform — see
// scripts/seo-metadata.test.ts). src/app/sitemap.ts is the only caller and
// supplies the real fumadocs pages.
export interface DocPageRef {
  /** Repo-relative source path, e.g. "spec-core.md" or "README.md". */
  path: string;
  /** Resolved public URL, e.g. "/specification/spec-core". */
  url: string;
}

// Paths that are not canonical/indexable and must not appear in the sitemap
// (SEO/GEO standard MUST #4.3):
// - README.md: contributor-facing authoring notes (see sync-spec-docs.mjs)
// - reference-materials.md: reference index for implementation notes and design
//   rationale, not part of the normative spec (see [[...slug]]/page.tsx generateMetadata)
// - the reference materials themselves: implementation notes, change tracking,
//   auth design and reference topology. These were deliberately moved off the
//   specification rail onto a noindex index page that a reader has to navigate
//   to by hand, and robots.txt disallows that index — but listing the four
//   documents here still invited crawlers straight to them, which contradicts
//   both. Derived from REFERENCE_MATERIALS_SLUGS rather than repeated, so the
//   rail and the sitemap cannot disagree about what is hidden.
const NON_CANONICAL_DOC_PATHS = new Set([
  "README.md",
  "reference-materials.md",
  ...REFERENCE_MATERIALS_SLUGS.map((slug) => `${slug}.md`),
]);

// SEO/GEO standard MUST #4.3: a sitemap must contain only canonical,
// indexable URLs, and `lastmod` must represent the last substantive change to
// that page, not a deploy or build date.
export function buildSitemap(siteOrigin: string, docPages: readonly DocPageRef[], specLastModified: string) {
  // /design, /palette, /sandbox are excluded: they are noindex (see their own
  // layouts and robots.ts) and must not appear here.
  const staticEntries: MetadataRoute.Sitemap = [
    { url: siteOrigin },
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
