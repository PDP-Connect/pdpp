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
 * (owner-authenticated /stream-playground?backend=neko, dialog opened): the
 * content that overflows is the Stage-1 orientation shell (`<main
 * class="min-h-dvh">`) — it stays mounted in the document behind the dialog
 * (React renders `<StreamOverlay>` as a SIBLING of the shell, not a
 * replacement — see stream-viewer.tsx's `StreamSurface` return) and, at
 * short landscape heights, is taller than the viewport by design (the same
 * box stream-orientation-shell-landscape.test.ts already covers for the
 * PRE-open state). That overflow is invisible once the dialog covers it, but
 * still drives `document.documentElement.scrollHeight` past `clientHeight`
 * — live-measured: scrollHeight 411 vs clientHeight 390 at 844x390 with the
 * dialog open.
 *
 * REVISION (independent review `streaming-presentation-polish-review-luna-
 * 0720.md`, P2): the first version of this fix used
 * `html:has(body[style*="overflow: hidden"])` — it worked, but coupled
 * EVERY page's scroll behavior to the exact inline-style STRING Base UI
 * happens to write onto `<body>` today. That's fragile in two directions: a
 * future Base UI version that spells the lock differently silently
 * un-fixes this bug, and ANY other dialog on the console that locks body
 * scroll the same way would ALSO lock `<html>`, even outside the stream
 * surface — broader than intended and not something this file's tests could
 * express or guard.
 *
 * Fixed by keying off `.pdpp-stream-dialog`'s own DOM presence instead —
 * this stream route's own IcDialogPopup class, not an inference about Base
 * UI's internals. Live-verified (Playwright, real dev server, real Base UI
 * Dialog + a real n.eko session via an isolated `pdpp-neko:local` Docker
 * container): the element is absent before open (count 0), present only
 * while open (count 1, `data-open` set), and fully removed again after a
 * real close completes (count 0 — not merely hidden/animated-out), so
 * presence is a safe, non-fragile proxy for "the stream dialog is open"
 * that this surface owns end-to-end. See the accompanying report for the
 * full transcript.
 */

const HTML_HAS_STREAM_DIALOG_RE = /html:has\(\.pdpp-stream-dialog\)\s*\{\s*overflow:\s*hidden;\s*\}/;
const UNCONDITIONAL_HTML_OVERFLOW_HIDDEN_RE = /^html\s*\{[^}]*overflow:\s*hidden/m;
const DATA_SCROLL_LOCKED_RE = /html > body\[data-scroll-locked\]/;
// The exact prior-version selector this fix replaces — must not reappear as
// an actual CSS RULE (selector immediately followed by `{`), since it's the
// fragile, Base-UI-coupled shape the review flagged. Deliberately does not
// match a bare mention of the string in a comment (this file's own header
// above, and globals.css's revision-history comment, both cite the old
// selector in prose — that's documentation, not a regression).
const BODY_INLINE_STYLE_COUPLED_RULE_RE = /html:has\(body\[style\*="overflow: hidden"\]\)\s*\{/;

test("globals.css locks <html> overflow off .pdpp-stream-dialog's own DOM presence, not Base UI's inline-style spelling", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  assert.match(
    css,
    HTML_HAS_STREAM_DIALOG_RE,
    "must have html:has(.pdpp-stream-dialog) { overflow: hidden; } — a marker this stream surface owns, so the " +
      "lock's correctness never depends on how Base UI happens to spell its own body scroll-lock"
  );
  assert.ok(
    !BODY_INLINE_STYLE_COUPLED_RULE_RE.test(css),
    'the prior html:has(body[style*="overflow: hidden"]) CSS RULE must not reappear — it couples every page\'s ' +
      "scroll behavior to Base UI's current inline-style text, which is exactly the fragile coupling this revision removes"
  );
});

test("the fix must NOT be an unconditional overflow:hidden on <html> — that would break normal page scrolling outside any dialog", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  const unscoped = css.match(UNCONDITIONAL_HTML_OVERFLOW_HIDDEN_RE);
  assert.equal(
    unscoped,
    null,
    `found an unconditional "html { overflow: hidden }" rule (${JSON.stringify(unscoped?.[0])}) — this app has ordinary document-scrolling pages (dashboards, lists) outside the stream dialog; the lock must be scoped to when the stream dialog is actually open`
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

/**
 * Runtime/DOM regression: node --test in this app has no jsdom dependency
 * (see neko-client.ts's pointer-mapping tests for the same documented
 * constraint), so this asserts the exact CSS containment property that
 * makes the fix correct, independent of a browser engine: `:has()` with a
 * descendant-presence selector matches the SAME condition regardless of
 * where in `<body>`'s subtree `.pdpp-stream-dialog` renders (Base UI portals
 * dialogs to `document.body` by default), so the rule fires whenever the
 * stream dialog is anywhere in the document — exactly "is the stream dialog
 * currently mounted," independent of DOM depth/portal target. The actual
 * browser-engine behavior (both scroll axes locked while open; ordinary
 * scrolling restored after close) was verified live against a real Chromium
 * + real Base UI Dialog + real n.eko session — see the report for the full
 * before/after transcript (scrollHeight/clientHeight, computed overflow,
 * and dialog element count at each stage).
 */
const CLASS_ATTR_RE = /class="([^"]*)"/g;
const WHITESPACE_RE = /\s+/;

function htmlHasSelectorMatchesAnyDepth(markup: string, targetClass: string): boolean {
  // :has() is a relative selector — it matches if the target exists ANYWHERE
  // in the descendant subtree, regardless of nesting depth or portal target.
  // This mirrors that semantic without a real CSS engine: any element whose
  // `class` attribute contains targetClass as a whitespace-delimited token,
  // anywhere in the markup (not just a direct child), satisfies the
  // condition — the real DOM.querySelector(".pdpp-stream-dialog") the
  // compound `class="pdpp-dialog pdpp-stream-dialog"` attribute actually has.
  // Reset lastIndex: this module-level regex has the `g` flag (stateful
  // between calls) and this function can be invoked more than once per test
  // run, including after an early return mid-loop.
  CLASS_ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec iteration idiom
  while ((match = CLASS_ATTR_RE.exec(markup))) {
    const classValue = match[1] ?? "";
    if (classValue.split(WHITESPACE_RE).includes(targetClass)) {
      CLASS_ATTR_RE.lastIndex = 0;
      return true;
    }
  }
  return false;
}

test(":has() semantics: the selector's match condition is DOM-presence-anywhere, not direct-child — matches Base UI's portal-to-body mount", () => {
  const portaledDeep =
    '<html><body><div id="portal-root"><div class="pdpp-dialog pdpp-stream-dialog">...</div></div></body></html>';
  const notPresent = "<html><body><main>...</main></body></html>";

  assert.ok(
    htmlHasSelectorMatchesAnyDepth(portaledDeep, "pdpp-stream-dialog"),
    "the dialog nested several levels deep inside a portal container must still satisfy html:has(.pdpp-stream-dialog) — " +
      "this is exactly how Base UI actually mounts it (Portal -> Backdrop/Popup wrapper -> Popup)"
  );
  assert.ok(
    !htmlHasSelectorMatchesAnyDepth(notPresent, "pdpp-stream-dialog"),
    "absent .pdpp-stream-dialog must not satisfy the selector"
  );
});
