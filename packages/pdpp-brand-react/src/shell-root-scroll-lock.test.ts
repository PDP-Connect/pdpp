// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shell must own the ONLY scroll container.
 *
 * `.rr-app` is viewport-height with `overflow: hidden`, and `.rr-content` is
 * the intended scroller. That is not sufficient on its own: `overflow: hidden`
 * clips PAINT but does not remove the clipped content from the root scroller's
 * scrollable extent, and html/body keep the UA default `overflow: visible`. So
 * the document stayed draggable underneath the fixed frame — the owner scrolled
 * the list, then dragged the whole page down into dead space below it.
 *
 * Reported by the owner against /sources on mobile, 2026-08-08 ("scrolling
 * inside vs outside the table is weird ... you can scroll down into empty space
 * outside"). Measured live at 375×667 before the fix: a real touch drag on the
 * page background moved `window.scrollY` to 436px of empty space (259px at
 * 390×844); after, both are 0 with `.rr-content` still scrolling its full range.
 *
 * The lock is scoped to `html:has(.rr-app)` rather than a bare `html` rule so
 * only pages that actually render this fixed-viewport frame lose document
 * scrolling. `syncs/[runId]/stream/stream.css` fixed the same defect class for
 * one route with the same selector grammar; the shell owns the general case.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SHELL_CSS = fileURLToPath(new URL("./shell.css", import.meta.url));

const ROOT_LOCK = /html:has\(\.rr-app\)\s*\{\s*overflow:\s*hidden;\s*\}/;
const BARE_HTML_RULE = /^\s*html\s*\{/m;
const CONTENT_SCROLLS = /overflow-y:\s*auto/;
const CONTENT_SHRINKS = /min-height:\s*0/;

test("the root scroller is locked while the shell frame is mounted", async () => {
  const css = await readFile(SHELL_CSS, "utf8");
  assert.match(
    css,
    ROOT_LOCK,
    "html:has(.rr-app) { overflow: hidden } must remain — without it the document scrolls into dead space below the frame"
  );
});

test("the lock is conditioned on the shell's presence, not applied to html unconditionally", async () => {
  // A bare `html { overflow: hidden }` would also freeze routes that do not
  // render the shell (and the print stylesheet), which is a different bug.
  const css = await readFile(SHELL_CSS, "utf8");
  assert.doesNotMatch(
    css,
    BARE_HTML_RULE,
    "no unconditional html rule; the lock must stay scoped to html:has(.rr-app)"
  );
});

test(".rr-content stays the scrolling element", async () => {
  // The lock removes the OUTER scroller. If .rr-content ever stops scrolling,
  // the page becomes unreadable below the fold rather than merely awkward.
  const css = await readFile(SHELL_CSS, "utf8");
  const start = css.indexOf(".rr-content {");
  assert.notEqual(start, -1, ".rr-content must exist in shell.css");
  const body = css.slice(start, css.indexOf("}", start));
  assert.match(body, CONTENT_SCROLLS, ".rr-content is the one scroll container");
  assert.match(body, CONTENT_SHRINKS, "min-height:0 lets the flex child actually shrink and scroll");
});
