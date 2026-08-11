// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SHELL_FRAME = `${HERE}shell-frame.tsx`;
const SHELL_CSS = `${HERE}shell.css`;
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

test("the drawer backdrop covers the viewport while the popup stays above it", async () => {
  const css = await readFile(SHELL_CSS, "utf8");
  const backdrop = css.slice(
    css.indexOf(".rr-drawer-overlay {"),
    css.indexOf("}", css.indexOf(".rr-drawer-overlay {"))
  );
  const popup = css.slice(css.indexOf(".rr-drawer {"), css.indexOf("}", css.indexOf(".rr-drawer {")));

  assert.match(backdrop, FIXED_POSITION);
  assert.match(backdrop, VIEWPORT_INSET);
  assert.match(backdrop, BACKDROP_COLOR);
  assert.match(popup, ABOVE_BACKDROP);
});
