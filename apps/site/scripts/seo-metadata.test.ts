// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import robots from "@/app/robots.ts";
import { SITE_ORIGIN } from "@/lib/site-facts.ts";
import { buildSitemap, type DocPageRef } from "@/lib/sitemap-entries.ts";
import { MAINTAINER_DOC_SLUGS, maintainersRoute, specDocExtension } from "@/lib/spec-nav-slugs.ts";

// SEO/GEO standard MUST #1.5: robots.txt must agree with the approved access
// policy. MUST #4.3: a sitemap must contain only canonical, indexable URLs.
//
// These pin robots.ts and sitemap-entries.ts against the "no robots.txt / no
// sitemap.xml at all" regression the audit found (both 404'd before this
// pass) and against the specific defects the audit hit while building the
// fix: a duplicate /specification entry, and content/docs/README.md —
// contributor-facing authoring notes, not a protocol page — leaking into the
// indexable set.

test("robots.txt allows the public site and blocks non-canonical surfaces", () => {
  const result = robots();

  assert.equal(result.sitemap, `${SITE_ORIGIN}/sitemap.xml`);

  const rules = Array.isArray(result.rules) ? result.rules[0] : result.rules;
  assert.ok(rules, "robots() must declare at least one rule");
  assert.equal(rules.userAgent, "*");
  assert.equal(rules.allow, "/");

  const disallow = Array.isArray(rules.disallow) ? rules.disallow : [rules.disallow];
  for (const path of [
    "/sandbox",
    "/specification/README",
    maintainersRoute,
    // Disallowing only the index left the documents it links crawlable, so a
    // crawler that never saw the index still indexed all of them.
    ...MAINTAINER_DOC_SLUGS.map((slug) => `/specification/${slug}`),
  ]) {
    assert.ok(disallow.includes(path), `robots.txt must disallow ${path}`);
  }
});

const FIXTURE_PAGES: DocPageRef[] = [
  { path: "index.mdx", url: "/specification" },
  { path: "README.md", url: "/specification/README" },
  { path: "spec-core.mdx", url: "/specification/spec-core" },
  { path: "spec-discovery-and-trust.mdx", url: "/specification/spec-discovery-and-trust" },
  // Every maintainer document, not just a sample. These were absent from the
  // fixture, which is why the suite stayed green while they leaked into the
  // live sitemap. Extensions are mixed: see GENERATED_MDX_SPEC_SLUGS.
  ...MAINTAINER_DOC_SLUGS.map((slug) => ({
    path: `${slug}.${specDocExtension(slug)}`,
    url: `/specification/${slug}`,
  })),
];

test("sitemap contains only canonical URLs, each exactly once", () => {
  const urls = buildSitemap(SITE_ORIGIN, FIXTURE_PAGES, "2026-04-06").map((entry) => entry.url);

  for (const url of urls) {
    assert.ok(url.startsWith(SITE_ORIGIN), `${url} must be absolute under ${SITE_ORIGIN}`);
  }

  const seen = new Set<string>();
  for (const url of urls) {
    assert.ok(!seen.has(url), `${url} must appear in the sitemap exactly once`);
    seen.add(url);
  }
});

test("sitemap excludes contributor-facing authoring notes and every maintainer document", () => {
  const urls = buildSitemap(SITE_ORIGIN, FIXTURE_PAGES, "2026-04-06").map((entry) => entry.url);

  assert.ok(!urls.includes(`${SITE_ORIGIN}/specification/README`), "README.md is authoring notes, not a spec page");
  assert.ok(!urls.includes(`${SITE_ORIGIN}${maintainersRoute}`), "/maintainers is unlisted, not a canonical page");
  for (const slug of MAINTAINER_DOC_SLUGS) {
    assert.ok(
      !urls.includes(`${SITE_ORIGIN}/specification/${slug}`),
      `${slug} is unlisted and noindex; listing it in the sitemap invites crawlers straight to it`
    );
  }
});

test("sitemap includes the front door, nav destinations, and every real doc page exactly once", () => {
  const urls = buildSitemap(SITE_ORIGIN, FIXTURE_PAGES, "2026-04-06").map((entry) => entry.url);

  assert.ok(urls.includes(SITE_ORIGIN), "front door must be in the sitemap");
  assert.ok(urls.includes(`${SITE_ORIGIN}/self-host`));
  assert.ok(urls.includes(`${SITE_ORIGIN}/participate`));
  assert.ok(urls.includes(`${SITE_ORIGIN}/specification`), "the docs index itself must be listed exactly once");
  assert.ok(urls.includes(`${SITE_ORIGIN}/specification/spec-core`));
  // A normative companion specification: unlisting the maintainer documents
  // must not take the specification set itself out of the sitemap.
  assert.ok(urls.includes(`${SITE_ORIGIN}/specification/spec-discovery-and-trust`));
});

test("sitemap stamps doc pages with the declared spec date, not a build timestamp", () => {
  const entries = buildSitemap(SITE_ORIGIN, FIXTURE_PAGES, "2026-04-06");
  const specCore = entries.find((entry) => entry.url === `${SITE_ORIGIN}/specification/spec-core`);

  assert.equal(specCore?.lastModified, "2026-04-06");
});
