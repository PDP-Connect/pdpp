import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GLOBALS_CSS_FILE = `${HERE}../../../../globals.css`;

/**
 * LIVE UAT regression: mobile landscape (844x390, phone rotated) showed a
 * real, visible document-level scrollbar (both horizontal and vertical
 * scroll thumbs) while the stream dialog was open, plus the dialog's own
 * corner-controls overlapping page content. The dialog itself measured
 * correctly full-bleed with no internal overflow (`.pdpp-stream-dialog`
 * fills the viewport; `.pdpp-stream-frame` is contained inside it per
 * stream-dialog-layout.test.ts's existing guards) — the scrollbar was NOT a
 * dialog-sizing bug.
 *
 * Root cause, reproduced live with Playwright against the real dev server
 * (owner-authenticated /stream-playground?backend=neko, dialog opened):
 * base-ui's Dialog scroll-lock sets `overflow: hidden` as an inline style on
 * `<body>` only — confirmed via `document.body.getAttribute("style")` ===
 * `"overflow: hidden;"` with the dialog open. In standards mode the
 * document's scrolling element is `<html>`, not `<body>`
 * (`document.scrollingElement === document.documentElement`), so locking
 * body's own overflow does not stop `<html>` from scrolling if content
 * overflows html's box. The content that overflows: the Stage-1 orientation
 * shell (`<main class="min-h-dvh">`) stays mounted in the document behind
 * the dialog (React renders `<StreamOverlay>` as a SIBLING of the shell, not
 * a replacement — see stream-viewer.tsx's `StreamSurface` return) and, at
 * short landscape heights, is taller than the viewport by design (the same
 * box stream-orientation-shell-landscape.test.ts already covers for the
 * PRE-open state). That overflow is invisible once the dialog covers it, but
 * still drives `document.documentElement.scrollHeight` past
 * `clientHeight` — live-measured: scrollHeight 411 vs clientHeight 390 at
 * 844x390 with the dialog open, with `<html>`'s own computed `overflow`
 * still `visible` throughout.
 *
 * Fix: mirror the lock onto `<html>` via `:has()`, scoped to exactly when
 * base-ui has locked body scroll (not an unconditional `overflow: hidden` on
 * `<html>`, which would break normal page scrolling everywhere outside a
 * dialog). This is a host-layout-boundary fix — it holds for any dialog on
 * this surface and any viewport size a dialog might open at, not a
 * per-viewport patch for the two UAT dimensions.
 */

const HTML_HAS_BODY_SCROLL_LOCK_RE = /html:has\(body\[style\*="overflow: hidden"\]\)\s*\{\s*overflow:\s*hidden;\s*\}/;
const UNCONDITIONAL_HTML_OVERFLOW_HIDDEN_RE = /^html\s*\{[^}]*overflow:\s*hidden/m;
const DATA_SCROLL_LOCKED_RE = /html > body\[data-scroll-locked\]/;

test("globals.css mirrors base-ui's body scroll-lock onto <html>, scoped via :has() to only when body is actually locked", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  assert.match(
    css,
    HTML_HAS_BODY_SCROLL_LOCK_RE,
    'must have html:has(body[style*="overflow: hidden"]) { overflow: hidden; } — <html>, not <body>, is the real scrolling element in standards mode, so body-only locking does not stop the page-level scrollbar'
  );
});

test("the fix must NOT be an unconditional overflow:hidden on <html> — that would break normal page scrolling outside any dialog", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  const unscoped = css.match(UNCONDITIONAL_HTML_OVERFLOW_HIDDEN_RE);
  assert.equal(
    unscoped,
    null,
    `found an unconditional "html { overflow: hidden }" rule (${JSON.stringify(unscoped?.[0])}) — this app has ordinary document-scrolling pages (dashboards, lists) outside the stream dialog; the lock must be scoped to when a dialog has actually locked body scroll`
  );
});

test("the existing (dead) data-scroll-locked rule is left in place — this fix does not depend on it and does not need to remove it", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  assert.match(
    css,
    DATA_SCROLL_LOCKED_RE,
    "sanity: the pre-existing data-scroll-locked rule (a different, currently-inert scroll-lock convention) is untouched by this change"
  );
});
