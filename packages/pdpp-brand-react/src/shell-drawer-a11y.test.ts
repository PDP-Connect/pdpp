// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHELL_FRAME = `${HERE}shell-frame.tsx`;
const SHELL_CSS = `${HERE}shell.css`;
const DRAWER_SELECTOR = ".pdpp-dialog.rr-drawer";
const BACKDROP_SELECTOR = ".pdpp-dialog-backdrop.rr-drawer-overlay";
const CONTROLLED_DIALOG = /<IcDialog modal onOpenChange=\{setDrawerOpen\} open=\{drawerOpen\}>/;
const DIALOG_TRIGGER = /<IcDialogTrigger className="rr-chrome-btn rr-menu-btn" type="button">/;
const DIALOG_POPUP = /<IcDialogPopup aria-label="Primary navigation" className="rr-drawer">/;
const DIALOG_CLOSE = /<IcDialogClose aria-label="Close navigation"/;
const NAV_CLOSE = /<NavList onNavigate=\{closeDrawer\}/;
const GLOBAL_KEY_LISTENER = /window\.addEventListener\("keydown"/;
const CONDITIONAL_DRAWER = /drawerOpen\s*&&/;
const PORTAL_BACKDROP = /<IcDialogPortal>[\s\S]*<IcDialogBackdrop className="rr-drawer-overlay"/;
const FIXED_POSITION = /position:\s*fixed/;
const VIEWPORT_INSET = /inset|top:\s*0/;
const BACKDROP_COLOR = /background:\s*oklch\(0 0 0 \/ 0\.5\)/;
const ABOVE_BACKDROP = /z-index:\s*71/;
const RIGHT_EDGE_RESET = /right:\s*auto/;
const MAX_WIDTH_RESET = /max-width:\s*none/;
const TRANSFORM_RESET = /transform:\s*none/;
const SHELL_MASTHEAD_SCOPE = /\.rr-app,\s*\.pdpp-dialog\.rr-drawer\s*\{[\s\S]*--rr-masthead-height:\s*52px/;
const SHELL_MARK_SCOPE =
  /\.rr-app,\s*\.pdpp-dialog\.rr-drawer\s*\{[\s\S]*--pdpp-mark-warm:[\s\S]*--pdpp-mark-cool:[\s\S]*--pdpp-mark-counter:/;
const DARK_SHELL_MARK_SCOPE =
  /\[data-theme="dark"\] \.rr-app,[\s\S]*\[data-theme="dark"\] \.pdpp-dialog\.rr-drawer\s*\{[\s\S]*--pdpp-mark-warm:[\s\S]*--pdpp-mark-cool:[\s\S]*--pdpp-mark-counter:/;

function ruleBody(css: string, selector: string, requiredDeclaration?: string): string {
  let from = 0;
  while (from < css.length) {
    const start = css.indexOf(`${selector} {`, from);
    assert.notEqual(start, -1, `${selector} must exist in shell.css`);
    const end = css.indexOf("}", start);
    assert.notEqual(end, -1, `${selector} must have a closing brace`);
    const body = css.slice(start, end);
    if (!requiredDeclaration || body.includes(requiredDeclaration)) {
      return body;
    }
    from = end + 1;
  }
  assert.fail(`${selector} must contain ${requiredDeclaration}`);
}

test("the mobile drawer is a controlled modal dialog with a real trigger", async () => {
  const source = await readFile(SHELL_FRAME, "utf8");

  // The existing Base UI dialog primitive owns the keyboard and focus state
  // machine. Keeping the shell controlled makes trigger, navigation, backdrop,
  // and Escape closes converge on the same state setter.
  assert.match(source, CONTROLLED_DIALOG);
  assert.match(source, DIALOG_TRIGGER);
  assert.match(source, DIALOG_POPUP);
  assert.match(source, DIALOG_CLOSE);
  assert.match(source, NAV_CLOSE);
});

test("drawer behavior is delegated to the modal primitive, not a global key listener", async () => {
  const source = await readFile(SHELL_FRAME, "utf8");

  // Base UI handles Escape, focus containment/return, and inertness for
  // modal=true. A shell-level listener would also close unrelated dialogs and
  // would bypass the primitive's focus-return bookkeeping.
  assert.doesNotMatch(source, GLOBAL_KEY_LISTENER);
  assert.doesNotMatch(source, CONDITIONAL_DRAWER);
  assert.match(source, PORTAL_BACKDROP);
});

test("the portaled drawer owns its cascade geometry and shell tokens", async () => {
  const css = await readFile(SHELL_CSS, "utf8");
  const backdrop = ruleBody(css, BACKDROP_SELECTOR);
  const popup = ruleBody(css, DRAWER_SELECTOR, "position: fixed;");

  assert.match(backdrop, FIXED_POSITION);
  assert.match(backdrop, VIEWPORT_INSET);
  assert.match(backdrop, BACKDROP_COLOR);
  assert.match(popup, FIXED_POSITION);
  assert.match(popup, ABOVE_BACKDROP);
  assert.match(popup, RIGHT_EDGE_RESET);
  assert.match(popup, MAX_WIDTH_RESET);
  assert.match(popup, TRANSFORM_RESET);
  assert.match(css, SHELL_MASTHEAD_SCOPE);
  assert.match(css, SHELL_MARK_SCOPE);
  assert.match(css, DARK_SHELL_MARK_SCOPE);
});
