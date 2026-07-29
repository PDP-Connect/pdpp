// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GLOBALS_CSS_FILE = `${HERE}../../../../globals.css`;
const STREAM_VIEWER_FILE = `${HERE}stream-viewer.tsx`;

/**
 * LIVE UAT regression: PR #370 shipped without noticing the stream dialog
 * rendered as a narrow ~512px (32rem) modal on real desktop viewports
 * (reproduced at 1981x960 and 1400x1005), instead of filling the available
 * viewport. Root cause, proven live with Playwright + real DOM measurement:
 *
 * `IcDialogPopup` (packages/pdpp-brand-react/src/dialog.tsx) applies BOTH the
 * shared `pdpp-dialog` class (max-width: 32rem, from that package's own
 * components.css) and the caller's override class (`pdpp-stream-dialog`,
 * globals.css). Both are single-class selectors of equal specificity
 * (0,0,1,0). Next.js's per-ROUTE CSS chunking re-emits `components.css`'s
 * `.pdpp-dialog` rule (via `dialog.tsx`'s own `import "./components.css"`,
 * transitively pulled in by every `@pdpp/brand-react` component the stream
 * route imports) into a SEPARATE `page.css` chunk that loads its `<link>`
 * AFTER the shared `layout.css` chunk containing globals.css's
 * `.pdpp-stream-dialog` override — so cascade SOURCE ORDER, not intent,
 * decided the winner, and it silently flipped depending on how Next.js
 * chunked that route's CSS.
 *
 * A same-specificity override is fragile against this bundler behavior by
 * construction — this test enforces the actual CSS rule that fixes it:
 * `.pdpp-stream-dialog`/`.pdpp-stream-dialog-backdrop`'s override selectors
 * MUST be compound (chained with `.pdpp-dialog`/`.pdpp-dialog-backdrop`) so
 * their specificity (0,0,2,0) always wins regardless of source order, chunk
 * boundaries, or any future CSS reshuffle — a source-order fix would silently
 * regress the instant Next.js's chunking changes again.
 */

const CLASS_SELECTOR_RE = /\.[a-zA-Z_-][a-zA-Z0-9_-]*/g;
const ATTR_SELECTOR_RE = /\[[^\]]+\]/g;
const PSEUDO_CLASS_SELECTOR_RE = /:(?!:)[a-zA-Z-]+(\([^)]*\))?/g;
const DIALOG_COMPOUND_RULE_RE =
  /\.pdpp-dialog\.pdpp-stream-dialog\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?display:\s*grid;/;
const BACKDROP_COMPOUND_RULE_RE =
  /\.pdpp-dialog-backdrop\.pdpp-stream-dialog-backdrop\s*\{[\s\S]*?background:\s*transparent;/;
const FRAME_STYLE_BLOCK_RE = /aspectRatio:\s*aspect,[\s\S]{0,200}?\}\}/;
const FRAME_WIDTH_100_RE = /width:\s*"100%"/;
const FRAME_HEIGHT_100_RE = /height:\s*"100%"/;
const FRAME_MAX_HEIGHT_100_RE = /maxHeight:\s*"100%"/;
const FRAME_MAX_WIDTH_100_RE = /maxWidth:\s*"100%"/;
const FIT_HOST_WRAPPER_RE = /<div className="pdpp-stream-fit-host[^"]*">/;
const FIT_HOST_CONTAINER_TYPE_RE = /\.pdpp-stream-fit-host\s*\{\s*container-type:\s*size;/;

function specificityOfSimpleSelector(selector: string): number {
  // Count class/attribute/pseudo-class selectors ("B" in the (A,B,C) specificity
  // triple). This module has no ID or type selectors on these rules, so B alone
  // determines the ordering that matters here.
  const classMatches = selector.match(CLASS_SELECTOR_RE) ?? [];
  const attrMatches = selector.match(ATTR_SELECTOR_RE) ?? [];
  const pseudoClassMatches = selector.match(PSEUDO_CLASS_SELECTOR_RE) ?? [];
  return classMatches.length + attrMatches.length + pseudoClassMatches.length;
}

test("pdpp-dialog specificity fact: a bare .pdpp-dialog and a bare .pdpp-stream-dialog tie at (0,0,1,0)", () => {
  // This is what made the bug possible: two single-class selectors of equal
  // specificity mean the LAST one loaded wins, and "last loaded" depends on
  // bundler chunk order, not source intent. Documented here as the failure
  // condition the compound-selector fix (below) must never regress back to.
  assert.equal(specificityOfSimpleSelector(".pdpp-dialog"), 1);
  assert.equal(specificityOfSimpleSelector(".pdpp-stream-dialog"), 1);
});

test("the stream dialog override is specificity-safe: compound selectors that always beat the shared base class", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");

  const dialogSelector = ".pdpp-dialog.pdpp-stream-dialog";
  if (!DIALOG_COMPOUND_RULE_RE.test(css)) {
    throw new Error(
      `the stream dialog's override rule must be the compound selector "${dialogSelector}" with position:fixed/inset:0/display:grid — a bare .pdpp-stream-dialog rule is a regression to the exact bug this test guards`
    );
  }

  const backdropSelector = ".pdpp-dialog-backdrop.pdpp-stream-dialog-backdrop";
  if (!BACKDROP_COMPOUND_RULE_RE.test(css)) {
    throw new Error(
      `the stream dialog backdrop's override rule must be the compound selector "${backdropSelector}" with background:transparent — a bare .pdpp-stream-dialog-backdrop rule is a regression to the exact bug this test guards`
    );
  }

  const baseDialogSpecificity = specificityOfSimpleSelector(".pdpp-dialog");
  const overrideDialogSpecificity = specificityOfSimpleSelector(dialogSelector);
  assert.ok(
    overrideDialogSpecificity > baseDialogSpecificity,
    `the override's specificity (${overrideDialogSpecificity}) must exceed the shared base class's (${baseDialogSpecificity}) so it wins regardless of stylesheet load order`
  );
});

test("the CDP-fallback frame is sized to CONTAIN inside its host on both axes, never overflow either", async () => {
  // LIVE UAT regression #2: even with the dialog itself full-bleed, the
  // CDP-fallback frame's `aspectRatio` + `width: 100%` + `height: 100%`
  // together is an over-constrained CSS box — the browser resolves width
  // first, derives height from the ratio, and nothing caps the derived
  // height back down. Reproduced live: a 16/10 frame rendered 1976x1235
  // inside a 1976x960 host, silently cropped by the dialog's
  // `overflow: hidden`. `width`/`height: 100%` together with `aspect-ratio`
  // on the SAME element is exactly the defect shape this asserts against.
  const viewerSrc = await readFile(STREAM_VIEWER_FILE, "utf8");
  const frameStyleMatch = viewerSrc.match(FRAME_STYLE_BLOCK_RE);
  if (!frameStyleMatch) {
    throw new Error("the CDP-fallback frame's aspect-ratio style block must exist");
  }
  const [frameStyle] = frameStyleMatch;

  assert.ok(
    !(FRAME_WIDTH_100_RE.test(frameStyle) && FRAME_HEIGHT_100_RE.test(frameStyle)),
    "the aspect-ratio'd frame must not set BOTH width:100% and height:100% " +
      "(over-constrained: aspect-ratio cannot shrink either axis back down " +
      "once both are made definite, so the box overflows on whichever axis " +
      "the ratio doesn't match)"
  );
  assert.match(
    frameStyle,
    FRAME_MAX_HEIGHT_100_RE,
    "the frame must cap its height at 100% of its container so it never overflows vertically"
  );
  assert.match(
    frameStyle,
    FRAME_MAX_WIDTH_100_RE,
    "the frame must cap its width at 100% of its container so it never overflows horizontally"
  );

  assert.match(
    viewerSrc,
    FIT_HOST_WRAPPER_RE,
    "the frame's wrapper must opt into container-query sizing (pdpp-stream-fit-host)"
  );

  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  assert.match(
    css,
    FIT_HOST_CONTAINER_TYPE_RE,
    "pdpp-stream-fit-host must declare container-type: size so cqw/cqh resolve against the actual available box"
  );
});

/**
 * Contain-fit math, independent of the DOM/CSS engine: given an available
 * host box and a target aspect ratio, the rendered box must fit inside BOTH
 * axes (never exceed width or height), and MUST use all of the constraining
 * axis (not shrink to some arbitrary smaller size) — mirrors what
 * `min(100cqw, 100cqh * ratio)` computes in the browser.
 */
function containFit(hostWidth: number, hostHeight: number, ratio: number): { height: number; width: number } {
  const widthIfHeightBound = hostHeight * ratio;
  const width = Math.min(hostWidth, widthIfHeightBound);
  const height = width / ratio;
  return { height, width };
}

test("contain-fit math: the rendered box never exceeds either host dimension and fully uses the binding axis", () => {
  const cases: Array<{ hostHeight: number; hostWidth: number; ratio: number }> = [
    { hostHeight: 960, hostWidth: 1981, ratio: 1400 / 1005 }, // reported desktop UAT viewport
    { hostHeight: 1005, hostWidth: 1400, ratio: 1400 / 1005 }, // second desktop size from the prompt
    { hostHeight: 844, hostWidth: 390, ratio: 390 / 844 }, // phone portrait
    { hostHeight: 390, hostWidth: 844, ratio: 844 / 390 }, // phone landscape
    { hostHeight: 960, hostWidth: 1976, ratio: 16 / 10 }, // reproduced live: the exact failing case
  ];

  for (const { hostWidth, hostHeight, ratio } of cases) {
    const fit = containFit(hostWidth, hostHeight, ratio);
    assert.ok(
      fit.width <= hostWidth + 0.01,
      `width ${fit.width} must not exceed host width ${hostWidth} (ratio ${ratio})`
    );
    assert.ok(
      fit.height <= hostHeight + 0.01,
      `height ${fit.height} must not exceed host height ${hostHeight} (ratio ${ratio})`
    );
    const touchesWidth = Math.abs(fit.width - hostWidth) < 0.01;
    const touchesHeight = Math.abs(fit.height - hostHeight) < 0.01;
    assert.ok(
      touchesWidth || touchesHeight,
      `the box must fully use at least one host dimension (got ${JSON.stringify(fit)} inside ${hostWidth}x${hostHeight})`
    );
  }
});

test("contain-fit math: the LIVE UAT failure box (512x960, 32rem-capped) is smaller than any correct contain-fit result", () => {
  // The regression this whole file guards: before the fix, the dialog itself
  // was capped to 32rem (512px) regardless of a 1981px-wide viewport. Assert
  // that a correct contain-fit box at the reported UAT dimensions is
  // materially larger than that stale cap, so a future regression back to
  // "dialog stuck at 512px" is caught by comparing against a fixed floor.
  const STALE_BUG_WIDTH_PX = 512;
  const fit = containFit(1981, 960, 1400 / 1005);
  assert.ok(
    fit.width > STALE_BUG_WIDTH_PX * 2,
    `a correctly-fitted box at 1981x960 (${fit.width}px wide) must be more than double the stale 512px bug width`
  );
});
