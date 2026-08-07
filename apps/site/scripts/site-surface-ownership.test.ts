// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

/** Token-ownership probes — hoisted so the regexes compile once per module. */
const BACKGROUND_REBIND_RE = /--background: var\(--pdpp-concept-paper\)/;
const CONTAINER_PAGE_VALUE_RE = /--container-page: 1080px/;
const CONTAINER_PAGE_RE = /--container-page/;
const CONCEPT_MAX_RE = /--pdpp-concept-max/;
const CONCEPT_SERIF_RE = /--pdpp-concept-serif/;

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
      readSiteFile("components/docs/prose-page.tsx"),
      readSiteFile("components/pdpp-concept/concept-shell.tsx"),
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
  assert.equal(conceptShell.includes("pdpp-concept"), false);
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
