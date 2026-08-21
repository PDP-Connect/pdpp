// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const SOURCE_NOT_RE = /^@source not "([^"]+)";$/gm;

/** Token-ownership probes — hoisted so the regexes compile once per module. */
const BACKGROUND_REBIND_RE = /--background: var\(--pdpp-editorial-paper\)/;
// 1280 is the median landing-page container across 16 measured protocol and
// infra sites (see the header of concept/tokens/semantic.css); 1080 sat at the
// 10th percentile. This pin exists to keep the value declared HERE rather than
// as a runtime primitive, so it moves with the token, not with the number.
const CONTAINER_PAGE_VALUE_RE = /--container-page: 1280px/;
const CONTAINER_PAGE_RE = /--container-page/;
const CONCEPT_MAX_RE = /--pdpp-editorial-max/;
const CONCEPT_SERIF_RE = /--pdpp-editorial-serif/;

function readSiteFile(path: string): Promise<string> {
  return readFile(`${SITE_ROOT}${path}`, "utf8");
}

test("site presentation ownership stays explicit at route boundaries", async () => {
  const [rootLayout, conceptLayout, specificationLayout, notFound, prosePage, conceptShell, siteCss] =
    await Promise.all([
      readSiteFile("app/layout.tsx"),
      readSiteFile("app/(concept)/layout.tsx"),
      readSiteFile("app/specification/layout.tsx"),
      readSiteFile("app/not-found.tsx"),
      readSiteFile("components/layout/prose-page.tsx"),
      readSiteFile("components/layout/concept-shell.tsx"),
      readSiteFile("styles/site.css"),
    ]);

  assert.equal(rootLayout.includes('import "@/styles/site.css"'), true);
  assert.equal(rootLayout.includes("<SiteProviders>"), true);
  assert.equal(rootLayout.includes("styles/surfaces"), false);

  assert.equal(conceptLayout.includes("styles/surfaces/concept/index.css"), true);
  assert.equal(conceptLayout.includes("<PdppConceptShell>"), true);

  assert.equal(specificationLayout.includes("styles/surfaces/concept/index.css"), true);
  assert.equal(specificationLayout.includes("styles/surfaces/specification.css"), true);
  assert.equal(specificationLayout.includes("<SpecificationShell>"), true);

  assert.equal(notFound.includes("styles/surfaces/concept/index.css"), true);
  assert.equal(notFound.includes("<PdppConceptShell>"), true);
  assert.equal(notFound.includes("<PdppConceptShell>"), true);

  assert.equal(prosePage.includes('import "./prose-page.css"'), true);
  assert.equal(prosePage.includes('className="prose-page '), true);

  assert.equal(conceptShell.includes("<PdppConceptMasthead />"), true);
  assert.equal(conceptShell.includes("<PdppConceptFooter />"), true);
  assert.equal(conceptShell.includes("data-surface={CONCEPT_SURFACE}"), true);
  assert.equal(conceptShell.includes("pdpp-editorial"), false);
  assert.equal(siteCss.includes("surfaces/"), false);
});

test("concept entrypoint owns Tailwind utility generation", async () => {
  const [entrypoint, tokenIndex, semanticCss, componentsCss, primitiveCss] = await Promise.all([
    readSiteFile("styles/surfaces/concept/index.css"),
    readSiteFile("styles/surfaces/concept/tokens/index.css"),
    readSiteFile("styles/surfaces/concept/tokens/semantic.css"),
    readSiteFile("styles/surfaces/concept/components.css"),
    readSiteFile("styles/surfaces/concept/tokens/primitive.css"),
  ]);

  assert.equal(entrypoint.includes("*@"), false, "concept CSS must not contain a corrupted at-rule boundary");
  assert.equal(entrypoint.includes("\nmport "), false, "every concept stylesheet import must retain its @ prefix");
  assert.equal(entrypoint.includes('@import "tailwindcss/utilities.css" layer(utilities)'), true);
  assert.equal(entrypoint.includes('@import "./tokens/index.css"'), true);
  assert.equal(
    entrypoint.indexOf('@import "./tokens/index.css"') < entrypoint.indexOf('@import "./components.css"'),
    true,
    "tokens must load before components.css"
  );
  assert.equal(tokenIndex.includes("compat-palette.css"), true);
  assert.equal(tokenIndex.includes("utilities.css"), false);
  assert.match(semanticCss, BACKGROUND_REBIND_RE);
  assert.match(semanticCss, CONTAINER_PAGE_VALUE_RE);
  assert.doesNotMatch(componentsCss, BACKGROUND_REBIND_RE);
  assert.doesNotMatch(primitiveCss, CONCEPT_MAX_RE);
  assert.doesNotMatch(primitiveCss, CONCEPT_SERIF_RE);
  assert.doesNotMatch(primitiveCss, CONTAINER_PAGE_RE);
});

/**
 * `site.css` and `concept/index.css` each carry a hand-written `@source not`
 * list — one entrypoint's exclusions are the other's exclusive territory, by
 * design (see the block comment above each list). Nothing mechanically ties
 * the two lists together, so a file move/rename/add can silently desync
 * them: excluded from BOTH builds (renders with zero Tailwind utilities on
 * whichever route uses it) or excluded from NEITHER (duplicate utility
 * generation, the exact cascade-order bug this two-build split exists to
 * prevent). This test is the mechanical tie.
 */
function parseSourceNotList(css: string, cssFileUrl: URL): string[] {
  const cssDir = dirname(fileURLToPath(cssFileUrl));
  return Array.from(css.matchAll(SOURCE_NOT_RE), ([fullMatch, relativePath]) => {
    assert.ok(relativePath, `@source not directive matched with no capture group: ${fullMatch}`);
    return resolve(cssDir, relativePath);
  });
}

test("the two Tailwind builds' @source not lists stay disjoint and current", async () => {
  const siteCssUrl = new URL("../src/styles/site.css", import.meta.url);
  const conceptCssUrl = new URL("../src/styles/surfaces/concept/index.css", import.meta.url);
  const [siteCss, conceptCss] = await Promise.all([readFile(siteCssUrl, "utf8"), readFile(conceptCssUrl, "utf8")]);

  const siteExcludes = parseSourceNotList(siteCss, siteCssUrl);
  const conceptExcludes = parseSourceNotList(conceptCss, conceptCssUrl);

  assert.ok(siteExcludes.length > 0, "site.css should still carry concept-exclusive @source not entries");
  assert.ok(conceptExcludes.length > 0, "concept/index.css should still carry non-concept @source not entries");

  // Every excluded path must exist on disk — an entry surviving a rename is
  // exactly the AGENTS.md-style staleness this repo's standing rule forbids.
  for (const absPath of [...siteExcludes, ...conceptExcludes]) {
    assert.ok(existsSync(absPath), `@source not path no longer exists on disk: ${absPath}`);
  }

  // No path may be excluded from BOTH builds — that file would render with
  // zero Tailwind utilities on whichever route actually imports it.
  const conceptExcludeSet = new Set(conceptExcludes);
  const excludedFromBoth = siteExcludes.filter((p) => conceptExcludeSet.has(p));
  assert.deepEqual(
    excludedFromBoth,
    [],
    `paths excluded from BOTH Tailwind builds (would render with no utilities): ${excludedFromBoth.join(", ")}`
  );
});
