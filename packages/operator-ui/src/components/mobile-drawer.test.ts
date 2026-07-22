// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MOBILE_DRAWER_FILE = `${HERE}mobile-drawer.tsx`;

const MODULE_MUTABLE_SETTER = /let\s+setOpenRef|noopSetOpen|=\s*setOpen;/;
const CONTEXT_PROVIDER = /const MobileDrawerContext = createContext<MobileDrawerContextValue \| null>\(null\)/;
const CONTEXT_HOOK = /function useMobileDrawer\(\): MobileDrawerContextValue/;
const TRIGGER_USES_CONTEXT = /const drawer = useMobileDrawer\(\)[\s\S]*onClick=\{drawer\.open\}/;
const DRAWER_USES_CONTEXT =
  /const drawer = useMobileDrawer\(\)[\s\S]*<Dialog modal onOpenChange=\{drawer\.setOpen\} open=\{drawer\.isOpen\}>/;

// The shell↔provider wrap assertion that previously lived here moved to each
// app's shell test (apps/console shell.invariants.test.ts), because `shell.tsx`
// is forked per app and stays app-local — only the shared `mobile-drawer.tsx`
// lives in this package.
test("mobile drawer uses React context, not a module-level mutable setter", async () => {
  const src = await readFile(MOBILE_DRAWER_FILE, "utf8");
  assert.equal(MODULE_MUTABLE_SETTER.test(src), false);
  assert.match(src, CONTEXT_PROVIDER);
  assert.match(src, CONTEXT_HOOK);
  assert.match(src, TRIGGER_USES_CONTEXT);
  assert.match(src, DRAWER_USES_CONTEXT);
});
