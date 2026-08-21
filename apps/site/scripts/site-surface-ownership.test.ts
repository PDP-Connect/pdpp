// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));
const SOURCE_NOT_RE = /^@source not "([^"]+)";$/gm;
const SOURCE_FILE_RE = /\.tsx?$/;
const CLASSNAME_USAGE_RE = /className\s*=|cn\(/;

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
 * them three ways: excluded from BOTH builds (zero Tailwind utilities on
 * whichever route uses it), a path that no longer exists (stale entry), or
 * excluded from NEITHER (duplicate utility generation — the exact
 * cascade-order bug this two-build split exists to prevent). The test below
 * checks all three: the first two directly against the parsed lists, the
 * third by walking the real file tree (see `walkSourceFiles` and its
 * caller for what that check can and cannot prove).
 */
function parseSourceNotList(css: string, cssFileUrl: URL): string[] {
  const cssDir = dirname(fileURLToPath(cssFileUrl));
  return Array.from(css.matchAll(SOURCE_NOT_RE), ([fullMatch, relativePath]) => {
    assert.ok(relativePath, `@source not directive matched with no capture group: ${fullMatch}`);
    return resolve(cssDir, relativePath);
  });
}

/** Recursively lists every .ts/.tsx file (skipping *.test.ts[x]) under the given root-relative dirs. */
function walkSourceFiles(siteRoot: string, rootRelativeDirs: string[]): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (SOURCE_FILE_RE.test(entry.name) && !entry.name.includes(".test.")) {
        files.push(entryPath);
      }
    }
  };
  for (const relDir of rootRelativeDirs) {
    visit(join(siteRoot, relDir));
  }
  return files;
}

/** True if absPath equals, or lives under, any directory/file in the exclusion set. */
function isCoveredByExclusion(absPath: string, exclusionSet: Set<string>): boolean {
  for (const excluded of exclusionSet) {
    if (absPath === excluded || absPath.startsWith(`${excluded}${sep}`)) {
      return true;
    }
  }
  return false;
}

async function filterFilesWithClassNameUsage(absPaths: string[]): Promise<string[]> {
  const withContents = await Promise.all(
    absPaths.map(async (absPath) => ({ absPath, content: await readFile(absPath, "utf8") }))
  );
  return withContents.filter(({ content }) => CLASSNAME_USAGE_RE.test(content)).map(({ absPath }) => absPath);
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

  // The check above catches drift BETWEEN the two lists, but says nothing
  // about a file that was never added to EITHER — the "excluded from
  // neither" case the comment above also names. That file would get scanned
  // (and its classes generated) by both builds: not a missing-utility bug
  // like the both-excluded case, but the exact duplicate-generation /
  // cascade-order risk this two-build split exists to prevent (see the
  // `.flex` history in specification.css). Detecting that mechanically
  // would need a real import-graph trace from each route's entrypoint,
  // which this test does not attempt. What it can do cheaply: walk every
  // .ts/.tsx file under app/ and components/, find every one NOT covered by
  // either exclusion list (directory-prefix or exact-file match), and
  // require that set to contain only files with no className/cn(...) usage
  // at all — a file with no Tailwind class strings can't cause a cascade
  // bug regardless of which build(s) scan it, so it's safe to leave
  // unclassified. A file WITH class usage in that set is new, unclassified,
  // and Tailwind-relevant: exactly the silent-drift case. Today that set is
  // exactly {app/layout.tsx}, the root layout, which is shared by
  // construction (every route renders through it) — any OTHER member is new
  // and must be triaged into one of the two @source not lists.
  const allSourceFiles = walkSourceFiles(SITE_ROOT, ["app", "components"]);
  const siteExcludeSet = new Set(siteExcludes);
  const unclassified = allSourceFiles.filter(
    (absPath) => !(isCoveredByExclusion(absPath, siteExcludeSet) || isCoveredByExclusion(absPath, conceptExcludeSet))
  );
  const unclassifiedWithClassNames = await filterFilesWithClassNameUsage(unclassified);
  const relativeUnclassified = unclassifiedWithClassNames.map((absPath) => relative(SITE_ROOT, absPath));
  assert.deepEqual(
    relativeUnclassified,
    ["app/layout.tsx"],
    `Tailwind-relevant files excluded from NEITHER build (new/unclassified — add to one @source not list): ${relativeUnclassified.join(", ")}`
  );
});
