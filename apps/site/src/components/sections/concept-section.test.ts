// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PdppConceptSection } from "./concept-section.tsx";

const SECTION_ANCHOR_RE = /<section[^>]*data-slot="pdpp-concept-section"[^>]*id="run"/;
const SECTION_INDEX_RE = /<span aria-hidden="true"[^>]*data-slot="pdpp-section-index"[^>]*>02<\/span>Features/;
const FIRST_SECTION_RHYTHM_RE = /first-of-type:mt-10/;

test("concept section renders anchor, indexed title, and children", () => {
  const html = renderToStaticMarkup(
    createElement(
      PdppConceptSection,
      { id: "run", sectionIndex: "02", title: "Features" },
      createElement("p", null, "Body copy")
    )
  );

  assert.match(html, SECTION_ANCHOR_RE);
  assert.match(html, SECTION_INDEX_RE);
  assert.ok(html.includes("<p>Body copy</p>"));
});

test("first section uses tighter top rhythm after the doc header", () => {
  const html = renderToStaticMarkup(
    createElement(PdppConceptSection, { id: "get-involved", sectionIndex: "01", title: "Get involved" })
  );

  assert.match(html, FIRST_SECTION_RHYTHM_RE);
});
