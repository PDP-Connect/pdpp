// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SLVP touch-target bar (>=44px in at least one dimension) for the two
 * default-size `IcButton` variants in the owner's danger zone.
 *
 * Red-team finding (docs/inbox/redteam-slvp-findings.md, P2 #5): at 390x844,
 * "Revoke connection" and "Delete connection and erase its records" — the
 * two most consequential actions in the app — measured 42px tall, 2px short
 * of the owner's stated bar. JSDOM/SSR compute no real layout, so this pins
 * the CSS SOURCE values a real browser resolves into that measured height,
 * the same technique `shell-masthead-seam.test.ts` uses for the header seam.
 *
 * `.pdpp-btn--sm` deliberately opts OUT of the 44px floor (compact inline
 * contexts, e.g. Save/Cancel beside the rename field) — pinned here too so
 * a future edit can't silently drop the intentional exception.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CSS_FILE = fileURLToPath(new URL("./components.css", import.meta.url));

const MIN_HEIGHT_VALUE_RE = /min-height:\s*(\d+)px/;
const MIN_HEIGHT_ZERO_RE = /min-height:\s*0/;
const NEGATIVE_INSET_VALUE_RE = /inset:\s*-(\d+(?:\.\d+)?)px/;

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} must exist in components.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("the default-size button (Revoke, Delete, and every other unsized IcButton) meets the 44px touch-target floor", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const rule = ruleBody(css, ".pdpp-btn");
  const minHeight = rule.match(MIN_HEIGHT_VALUE_RE)?.[1];
  assert.ok(minHeight, ".pdpp-btn must declare a min-height");
  assert.ok(Number(minHeight) >= 44, `.pdpp-btn min-height (${minHeight}px) must be >= 44px`);
});

test("the compact button size deliberately opts out of the 44px floor, not silently", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const rule = ruleBody(css, ".pdpp-btn--sm");
  assert.match(
    rule,
    MIN_HEIGHT_ZERO_RE,
    ".pdpp-btn--sm must explicitly reset min-height, or it inherits 44px from .pdpp-btn"
  );
});

test("the Explore facet-exclude toggle grows its hit area via a pseudo-element without resizing the visible glyph", async () => {
  const css = await readFile(CSS_FILE, "utf8");
  const rule = ruleBody(css, ".rr-x-facet-not::before");
  const inset = rule.match(NEGATIVE_INSET_VALUE_RE)?.[1];
  assert.ok(inset, ".rr-x-facet-not::before must expand via a negative inset");
  // Visible glyph is ~21x20 (grid-sized, 4px 5px padding); doubling the inset
  // must clear 44px in the shorter (height) dimension.
  assert.ok(
    Number(inset) * 2 + 20 >= 44,
    `expansion (${inset}px/side) does not clear the 44px bar on the ~20px-tall glyph`
  );
});
