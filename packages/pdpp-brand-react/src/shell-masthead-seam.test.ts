// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The sidebar/content seam must read as one continuous rule.
 *
 * `.rr-side__brand` (the PDPP lockup) and `.rr-head` (the main header) sit on
 * either side of the sidebar's right border, and both draw a bottom rule. They
 * only read as ONE line when they share a height. They previously did not:
 * `.rr-side` added 18px of top padding before a brand block with its own 2/16px
 * padding, landing that rule ~16px below `.rr-head`'s, so the corner visibly
 * stepped.
 *
 * Reported by the owner against the Overview page, 2026-08-07, twice — the
 * first fix was applied to `DashboardShell`, which no content page renders
 * (that component has since been deleted as dead code). This guard is pinned to
 * the stylesheet the live `RecordroomShell` actually uses.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SHELL_CSS = fileURLToPath(new URL("./shell.css", import.meta.url));

function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `${selector} must exist in shell.css`);
  const end = css.indexOf("}", start);
  return css.slice(start, end);
}

test("the masthead height is defined once as a token", async () => {
  const css = await readFile(SHELL_CSS, "utf8");
  const matches = css.match(/--rr-masthead-height:\s*\d+px/g) ?? [];
  assert.equal(matches.length, 1, "exactly one definition — two would let the seam drift again");
});

test("both sides of the seam derive their height from that one token", async () => {
  const css = await readFile(SHELL_CSS, "utf8");
  for (const selector of [".rr-side__brand", ".rr-head"]) {
    assert.match(
      ruleBody(css, selector),
      /height:\s*var\(--rr-masthead-height\)/,
      `${selector} must take its height from --rr-masthead-height, not a hand-tuned value`
    );
  }
});

test("both sides of the seam draw a bottom rule", async () => {
  const css = await readFile(SHELL_CSS, "utf8");
  for (const selector of [".rr-side__brand", ".rr-head"]) {
    assert.match(ruleBody(css, selector), /border-bottom:\s*1px solid var\(--border\)/, `${selector} draws the rule`);
  }
});

test("the sidebar adds no top padding above the masthead", async () => {
  // `padding: 18px 0 14px` here is what broke the alignment originally: it
  // pushed the lockup down so its rule no longer met the header's.
  const css = await readFile(SHELL_CSS, "utf8");
  const side = ruleBody(css, ".rr-side");
  const padding = side.match(/padding:\s*([^;]+);/)?.[1] ?? "";
  assert.doesNotMatch(padding, /^\s*[1-9]/, "top padding must stay 0; put spacing below the masthead instead");
});
