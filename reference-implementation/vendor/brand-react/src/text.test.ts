// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Type-ladder contract: textVariants.size ↔ @pdpp/brand tokens/semantic.css (1:1).
// Sole owner for that assertion — do not duplicate in pdpp-concept/text.test.ts.
// @see docs/design-system/styling-in-apps.md § Enforcement (tests)

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Text, type TextSize } from "./text.tsx";
import { textVariants } from "./text-variants.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRAND_SEMANTIC_CSS = join(HERE, "../../pdpp-brand/styles/tokens/semantic.css");
const TEXT_VARIANTS_TS = join(HERE, "text-variants.ts");

/** Base `--text-{rung}:` tokens only — not `--text-{rung}--line-height` compounds. */
const TEXT_RUNG_TOKEN_RE = /^\s*--text-([a-z]+):\s/gm;
const TEXT_VARIANTS_SIZE_BLOCK_RE = /size:\s*\{([\s\S]*?)^\s{4}\},/m;
const TEXT_VARIANTS_SIZE_KEY_RE = /^\s{6}(\w+):/gm;

function parseSemanticTextRungs(css: string): Set<string> {
  const rungs = new Set<string>();
  for (const match of css.matchAll(TEXT_RUNG_TOKEN_RE)) {
    const [, rung] = match;
    if (rung) {
      rungs.add(rung);
    }
  }
  return rungs;
}

/**
 * The parsed keys ARE the variant table's own size keys, so `TextSize` is the
 * honest element type — the `text size rungs` test is what proves the cast.
 */
function parseTextVariantSizes(source: string): Set<TextSize> {
  const blockMatch = source.match(TEXT_VARIANTS_SIZE_BLOCK_RE);
  assert.ok(blockMatch, "expected textVariants size block");
  const [, block] = blockMatch;
  assert.ok(block);
  const sizes = new Set<TextSize>();
  for (const match of block.matchAll(TEXT_VARIANTS_SIZE_KEY_RE)) {
    const [, key] = match;
    if (key && key !== "inherit") {
      sizes.add(key as TextSize);
    }
  }
  return sizes;
}

test("text size rungs match brand tokens/semantic.css (1:1)", () => {
  const css = readFileSync(BRAND_SEMANTIC_CSS, "utf8");
  const variants = readFileSync(TEXT_VARIANTS_TS, "utf8");
  const tokenRungs = parseSemanticTextRungs(css);
  const variantSizes = parseTextVariantSizes(variants);

  // Widened for the set difference; `variantSizes` stays typed for the loop below.
  const variantSizeNames = new Set<string>(variantSizes);
  const missingTokens = [...variantSizeNames].filter((rung) => !tokenRungs.has(rung));
  const missingVariants = [...tokenRungs].filter((rung) => !variantSizeNames.has(rung));

  assert.deepEqual(
    missingTokens,
    [],
    `textVariants.size keys without --text-* in brand semantic.css: ${missingTokens.join(", ")}`
  );
  assert.deepEqual(
    missingVariants,
    [],
    `--text-* rungs in brand semantic.css without textVariants.size: ${missingVariants.join(", ")}`
  );

  for (const rung of variantSizes) {
    assert.match(textVariants({ size: rung }), new RegExp(`\\btext-${rung}\\b`), `${rung} must emit text-${rung}`);
  }
});

/**
 * The boundary this package exists to hold: the table is shared, the values
 * are not. A literal palette name here would make one surface's palette the
 * global contract — which is exactly the coupling that kept `Text` stuck in
 * apps/site.
 */
/** Whole-token palette leaks — not substrings (`link-prose` contains "ink"). */
const PALETTE_LEAKS = [/\bteal\b/i, /\bpaper\b/i, /\bslate\b/i, /\bzinc\b/i, /\bemerald\b/i, /\bonteal\b/i, /\bink\b/i];

test("no variant emits a literal palette name", () => {
  const emitted: string[] = [];
  const colors = ["inherit", "foreground", "muted", "primary", "background"] as const;
  const sizes = ["eyebrow", "small", "body", "lede", "heading", "title", "display", "hero"] as const;

  for (const color of colors) {
    for (const size of sizes) {
      emitted.push(textVariants({ color, size }));
    }
  }

  const all = emitted.join(" ");
  for (const leak of PALETTE_LEAKS) {
    assert.doesNotMatch(all, leak, `variant table leaks palette token ${leak}`);
  }
});

const TEXT_FOREGROUND = /text-foreground/;
const TEXT_MUTED_FOREGROUND = /text-muted-foreground/;
const TEXT_PRIMARY = /text-primary/;
const TEXT_BACKGROUND = /text-background/;

test("shared colors emit brand/shadcn utilities", () => {
  assert.match(textVariants({ color: "foreground" }), TEXT_FOREGROUND);
  assert.match(textVariants({ color: "muted" }), TEXT_MUTED_FOREGROUND);
  assert.match(textVariants({ color: "primary" }), TEXT_PRIMARY);
  assert.match(textVariants({ color: "background" }), TEXT_BACKGROUND);
});

const TRACKING_ARBITRARY = /tracking-\[/;
const TEXT_EYEBROW = /text-eyebrow/;
const UPPERCASE = /uppercase/;

test("eyebrow does not hardcode tracking — token owns letter-spacing", () => {
  const classes = textVariants({ size: "eyebrow" });
  assert.doesNotMatch(classes, TRACKING_ARBITRARY);
  assert.match(classes, TEXT_EYEBROW);
  assert.match(classes, UPPERCASE);
});

const TEXT_PRETTY = /text-pretty/;
const TEXT_BALANCE = /text-balance/;

test("default wrap policy compounds by size; wrap= override wins", () => {
  assert.match(textVariants({ size: "body" }), TEXT_PRETTY);
  assert.match(textVariants({ size: "heading" }), TEXT_BALANCE);
  assert.doesNotMatch(textVariants({ size: "body", wrap: "balanced" }), TEXT_PRETTY);
  assert.match(textVariants({ size: "body", wrap: "balanced" }), TEXT_BALANCE);
  assert.doesNotMatch(textVariants({ size: "heading", wrap: "pretty" }), TEXT_BALANCE);
  assert.match(textVariants({ size: "heading", wrap: "pretty" }), TEXT_PRETTY);
});

const STRAIGHT_QUOTES = /the &quot;id&quot; is &#x27;x&#x27;/;
const CURLED_QUOTES = /the “id” is ‘x’/;
const CURLED_CONTRACTION = /it’s fine/;
const OPENS_H1 = /^<h1 /;
const DISPLAY_SIZE = /text-display/;
const LIST_DISC = /list-disc/;
const PRE_WRAP = /whitespace-pre-wrap/;
const OVERFLOW_HIDDEN = /overflow-hidden/;
const INNER_TRUNCATE_SPAN = /<span class="min-w-0 truncate">a long label<\/span>/;

test("smart quotes are opt-in so machine output stays verbatim", () => {
  const raw = renderToStaticMarkup(createElement(Text, { children: `the "id" is 'x'` }));
  assert.match(raw, STRAIGHT_QUOTES);

  const curled = renderToStaticMarkup(createElement(Text, { children: `the "id" is 'x'`, smartQuotes: true }));
  assert.match(curled, CURLED_QUOTES);
});

test("contractions curl to an apostrophe, not an opening quote", () => {
  const html = renderToStaticMarkup(createElement(Text, { children: "it's fine", smartQuotes: true }));
  assert.match(html, CURLED_CONTRACTION);
});

test("as= controls semantics independently of visual size", () => {
  const html = renderToStaticMarkup(createElement(Text, { as: "h1", size: "display", children: "Title" }));
  assert.match(html, OPENS_H1);
  assert.match(html, DISPLAY_SIZE);
});

test("li and pre hosts pick up their structural variants", () => {
  const li = renderToStaticMarkup(createElement(Text, { as: "li", children: "item" }));
  assert.match(li, LIST_DISC);

  const pre = renderToStaticMarkup(createElement(Text, { as: "pre", children: "code" }));
  assert.match(pre, PRE_WRAP);
});

test("withIcon + truncate moves the ellipsis onto an inner span", () => {
  const html = renderToStaticMarkup(createElement(Text, { children: "a long label", truncate: true, withIcon: true }));
  assert.match(html, OVERFLOW_HIDDEN);
  assert.match(html, INNER_TRUNCATE_SPAN);
});
