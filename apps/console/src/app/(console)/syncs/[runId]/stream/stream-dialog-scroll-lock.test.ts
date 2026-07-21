import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const GLOBALS_CSS_FILE = `${HERE}../../../../globals.css`;

/**
 * Static structure guard only. The behavioral contract (both axes locked
 * while the stream dialog is open at landscape dimensions; ordinary document
 * scrolling restored after close) is proved by
 * `scripts/manual-action-stream-smoke.mjs`'s
 * `assertDocumentScrollLockedWhileStreamDialogOpen` /
 * `assertOrdinaryScrollRestoredAfterClose` against a real Base UI dialog —
 * this file only guards that the CSS rule the behavior depends on exists and
 * is scoped to this route's own dialog class, not Base UI's inline-style
 * spelling or an unconditional lock.
 */

const HTML_HAS_STREAM_DIALOG_RE = /html:has\(\.pdpp-stream-dialog\)\s*\{\s*overflow:\s*hidden;\s*\}/;
const UNCONDITIONAL_HTML_OVERFLOW_HIDDEN_RE = /^html\s*\{[^}]*overflow:\s*hidden/m;

test("globals.css locks <html> overflow off .pdpp-stream-dialog's own presence, scoped (not unconditional)", async () => {
  const css = await readFile(GLOBALS_CSS_FILE, "utf8");
  assert.match(
    css,
    HTML_HAS_STREAM_DIALOG_RE,
    "must have html:has(.pdpp-stream-dialog) { overflow: hidden; } — a marker this stream route owns"
  );
  assert.equal(
    css.match(UNCONDITIONAL_HTML_OVERFLOW_HIDDEN_RE),
    null,
    "must not be an unconditional html { overflow: hidden } — that would break ordinary page scrolling everywhere"
  );
});
