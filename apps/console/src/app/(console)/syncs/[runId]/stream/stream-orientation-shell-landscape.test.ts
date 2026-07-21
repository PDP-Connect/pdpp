import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GLOBALS_CSS_FILE = `${HERE}../../../../globals.css`;
const STREAM_VIEWER_FILE = `${HERE}stream-viewer.tsx`;

/**
 * RS1.5 FINAL review P2 (second finding): the pre-open stream orientation
 * shell (`StreamSurface`'s `OrientationCard` wrapper) overflows the document
 * at short mobile-landscape viewports even though the dialog/backdrop/media/
 * corner-controls are all correctly in-bounds once opened.
 *
 * Root cause, proven with a real DOM measurement in an isolated local dev
 * server: the wrapper `<div className="... px-5 py-16">` (stream-viewer.tsx ~1551)
 * uses `py-16` (64px top+bottom, 128px total) block padding unconditionally.
 * At 844x390 the card's own content plus that padding needs 405.27px total —
 * 15.27px taller than the 390px block viewport — so normal block layout
 * grows `main.min-h-dvh` and this wrapper past the viewport, producing a
 * real document scrollbar. This is NOT caused by the dialog, backdrop,
 * scroll-lock, or corner controls (all measured exactly in-bounds); it is
 * present before the dialog even opens.
 *
 * Fix: a `pdpp-stream-orientation-shell` class on that same wrapper, with a
 * `@media (orientation: landscape) and (max-height: 30rem)` rule in
 * globals.css reducing its block padding to `3rem` (48px each side, 96px
 * total) — enough that the same content comfortably fits 390px. Portrait and
 * desktop viewports are untouched (the media query excludes them), and the
 * shared dialog/backdrop CSS (17dbf438f's fix) is not touched at all.
 */

const ORIENTATION_SHELL_CLASS_RE = /className="pdpp-stream-orientation-shell[^"]*"/;
const ORIENTATION_SHELL_PY16_RE = /className="pdpp-stream-orientation-shell[^"]*\bpy-16\b[^"]*"/;
const LANDSCAPE_MEDIA_QUERY_RE =
  /@media \(orientation:\s*landscape\)\s*and\s*\(max-height:\s*30rem\)\s*\{\s*\.pdpp-stream-orientation-shell\s*\{\s*padding-block:\s*3rem;/;
const DIALOG_COMPOUND_RULE_STILL_PRESENT_RE = /\.pdpp-dialog\.pdpp-stream-dialog\s*\{[\s\S]*?position:\s*fixed;/;

test("the pre-open orientation shell wrapper carries the landscape-scoped class alongside its default py-16 padding", async () => {
  const src = await readFile(STREAM_VIEWER_FILE, "utf8");
  assert.match(
    src,
    ORIENTATION_SHELL_CLASS_RE,
    "StreamSurface's pre-mint wrapper must carry pdpp-stream-orientation-shell so the landscape-scoped override in globals.css can target it"
  );
  assert.match(
    src,
    ORIENTATION_SHELL_PY16_RE,
    "the default py-16 (128px total) padding must remain the BASE case — only short landscape should override it, never remove the Tailwind utility outright"
  );
});

test("globals.css scopes the padding reduction to short landscape only, via unlayered CSS that beats the py-16 utility", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  assert.match(
    css,
    LANDSCAPE_MEDIA_QUERY_RE,
    "must have @media (orientation: landscape) and (max-height: 30rem) { .pdpp-stream-orientation-shell { padding-block: 3rem; } } — a global or unconditional padding change would also shrink the card on portrait/desktop, which is not this bug"
  );

  // Regression guard: the fix must not touch the shared dialog CSS
  // (17dbf438f) at all — this is a distinct defect in a different element.
  assert.match(
    css,
    DIALOG_COMPOUND_RULE_STILL_PRESENT_RE,
    "the shared .pdpp-dialog.pdpp-stream-dialog compound-selector fix (17dbf438f) must remain untouched"
  );
});

/**
 * Numeric oracle for the orientation shell's box model, calibrated against
 * the reviewer's real DOM measurement (405.265625px needed at 844x390 with
 * py-16's 128px total padding — see the file header). Mirrors normal CSS
 * block layout: total wrapper height = padding-block (both edges) +
 * content height, and the fix must keep that total within the viewport's
 * block size for the exact case that failed, without changing content or
 * touching portrait/desktop cases (which never hit this path).
 */
const MEASURED_CONTENT_HEIGHT_PX = 405.265_625 - 64 - 64; // reviewer's total minus py-16's 128px, isolating card content
const PY_16_PADDING_EACH_SIDE_PX = 64;
const PY_12_PADDING_EACH_SIDE_PX = 48;

function wrapperTotalHeight(paddingEachSidePx: number): number {
  return MEASURED_CONTENT_HEIGHT_PX + paddingEachSidePx * 2;
}

test("orientation shell box model: py-16 (unscoped) overflows 844x390, matching the reviewer's exact live measurement", () => {
  const total = wrapperTotalHeight(PY_16_PADDING_EACH_SIDE_PX);
  assert.ok(
    Math.abs(total - 405.265_625) < 0.01,
    `sanity: reconstructing the box model from the reviewer's own numbers must reproduce their measured 405.265625px total (got ${total})`
  );
  assert.ok(total > 390, `py-16's 128px total padding must overflow a 390px short-landscape viewport (got ${total})`);
});

test("orientation shell box model: py-12 (landscape-scoped fix) fits 844x390 with room to spare", () => {
  const total = wrapperTotalHeight(PY_12_PADDING_EACH_SIDE_PX);
  assert.ok(total <= 390, `py-12's 96px total padding must fit inside a 390px short-landscape viewport (got ${total})`);
  assert.ok(
    390 - total >= 10,
    `the fix should leave a comfortable margin, not land exactly at the edge (got ${390 - total}px slack)`
  );
});

test("orientation shell box model: the SAME content at portrait/desktop dimensions never needed the reduced padding in the first place", () => {
  // These are the exact counterexample viewports from stream-dialog-layout.test.ts
  // (17dbf438f's UAT set) plus the failing case's block dimension, proving the
  // media query's `max-height: 30rem` (480px) boundary correctly excludes them —
  // this is a landscape+short-height-specific fix, not a general padding change.
  const nonOffendingViewports = [
    { name: "phone portrait", height: 844 },
    { name: "desktop 1981x960", height: 960 },
    { name: "desktop 1400x1005", height: 1005 },
  ];
  const MAX_HEIGHT_QUERY_BOUNDARY_PX = 30 * 16; // 30rem at a 16px root font size

  for (const { name, height } of nonOffendingViewports) {
    assert.ok(
      height > MAX_HEIGHT_QUERY_BOUNDARY_PX,
      `${name} (${height}px tall) must be OUTSIDE the max-height: 30rem query, so it keeps py-16's default padding unchanged`
    );
    const total = wrapperTotalHeight(PY_16_PADDING_EACH_SIDE_PX);
    assert.ok(
      total <= height,
      `${name}: the unscoped py-16 total (${total}px) already fit within ${height}px — this viewport never needed the fix, confirming the bug was specific to short landscape`
    );
  }
});
