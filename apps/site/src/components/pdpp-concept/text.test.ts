// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Concept Text facade tests only (defaults, sectionIndex, structural hosts).
// The eight-rung ladder contract is enforced in @pdpp/brand-react/src/text.test.ts —
// not here. Concept sizes (stamp/callout/deck) are packaging, not ladder rungs.
// @see docs/design-system/styling-in-apps.md § Enforcement (tests)

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Text } from "./text.tsx";

const SECTION_INDEX_PATTERN = /<span aria-hidden="true"[^>]*data-slot="pdpp-section-index"[^>]*>03<\/span>Portability/;
const ICON_TRUNCATION_PATTERN =
  /<svg[^>]*class="shrink-0"[^>]*><\/svg><span class="min-w-0 truncate">A long label<\/span>/;
const STAMP_EYEBROW_LETTER_SPACING_PATTERN = /--text-eyebrow--letter-spacing:0\.04em/;

const classesFor = (html: string, tag: string): Set<string> => {
  const match = html.match(new RegExp(`<${tag}[^>]* class="([^"]*)"`));
  assert.ok(match, `expected ${tag} to have a class attribute`);
  const [, className] = match;
  assert.ok(className);
  return new Set(className.split(" "));
};

test("formats plain-text quotes and forwards native attributes", () => {
  const html = renderToStaticMarkup(
    createElement(Text, {
      "aria-label": "quotation",
      children: `She said "it's ready".`,
      "data-slot": "custom-text",
      id: "intro",
    })
  );

  assert.ok(html.startsWith("<p "));
  assert.ok(html.includes('aria-label="quotation"'));
  assert.ok(html.includes('data-slot="custom-text"'));
  assert.ok(html.includes('id="intro"'));
  assert.ok(html.endsWith(">She said “it’s ready”.</p>"));
});

test("preserves title section-index markup and positioning classes", () => {
  const html = renderToStaticMarkup(
    createElement(Text, { as: "h2", children: "Portability", size: "title", sectionIndex: "03" })
  );

  assert.ok(html.startsWith("<h2 "));
  assert.ok(classesFor(html, "h2").has("min-[1000px]:relative"));
  assert.match(html, SECTION_INDEX_PATTERN);
});

test("keeps icon-aware truncation on the outer host and text child", () => {
  const html = renderToStaticMarkup(
    createElement(Text, {
      children: [createElement("svg", { "aria-hidden": true, className: "shrink-0", key: "icon" }), "A long label"],
      truncate: true,
      withIcon: true,
    })
  );

  const outerClasses = classesFor(html, "p");
  assert.ok(outerClasses.has("inline-flex"));
  assert.ok(outerClasses.has("overflow-hidden"));
  assert.ok(!outerClasses.has("truncate"));
  assert.match(html, ICON_TRUNCATION_PATTERN);
});

test("stamp size rebinds eyebrow letter-spacing via concept cva", () => {
  const html = renderToStaticMarkup(createElement(Text, { size: "stamp", children: "Status" }));
  assert.match(html, STAMP_EYEBROW_LETTER_SPACING_PATTERN);
});

test("deck size does not pin font-normal so weight prop applies", () => {
  const html = renderToStaticMarkup(createElement(Text, { children: "Lead", size: "deck", weight: "semi" }));
  const classes = classesFor(html, "p");
  assert.ok(classes.has("font-semibold"));
  assert.ok(!classes.has("font-normal"));
});

test("infers list and preformatted variants from the native host", () => {
  const listHtml = renderToStaticMarkup(createElement(Text, { as: "li", children: "List item" }));
  const preHtml = renderToStaticMarkup(createElement(Text, { as: "pre", children: "line one\nline two" }));

  assert.ok(classesFor(listHtml, "li").has("list-disc"));
  assert.ok(classesFor(preHtml, "pre").has("whitespace-pre-wrap"));
  assert.ok(classesFor(preHtml, "pre").has("font-mono"));
});
