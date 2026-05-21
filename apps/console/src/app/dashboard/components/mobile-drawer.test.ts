import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const MOBILE_DRAWER_FILE = `${HERE}mobile-drawer.tsx`;
const SHELL_FILE = `${HERE}shell.tsx`;

const MODULE_MUTABLE_SETTER = /let\s+setOpenRef|noopSetOpen|=\s*setOpen;/;
const CONTEXT_PROVIDER = /const MobileDrawerContext = createContext<MobileDrawerContextValue \| null>\(null\)/;
const CONTEXT_HOOK = /function useMobileDrawer\(\): MobileDrawerContextValue/;
const TRIGGER_USES_CONTEXT = /const drawer = useMobileDrawer\(\)[\s\S]*onClick=\{drawer\.open\}/;
const DRAWER_USES_CONTEXT =
  /const drawer = useMobileDrawer\(\)[\s\S]*<Dialog modal onOpenChange=\{drawer\.setOpen\} open=\{drawer\.isOpen\}>/;
const SHELL_IMPORTS_PROVIDER = /import \{ MobileDrawer, MobileDrawerProvider, MobileDrawerTrigger \}/;
const SHELL_PROVIDER_WRAP =
  /<MobileDrawerProvider>[\s\S]*<Topbar overviewHref=\{routes\.section\.overview\} \/>[\s\S]*<MobileDrawer>[\s\S]*<\/MobileDrawer>[\s\S]*<\/MobileDrawerProvider>/;

test("mobile drawer uses React context, not a module-level mutable setter", async () => {
  const src = await readFile(MOBILE_DRAWER_FILE, "utf8");
  assert.equal(MODULE_MUTABLE_SETTER.test(src), false);
  assert.match(src, CONTEXT_PROVIDER);
  assert.match(src, CONTEXT_HOOK);
  assert.match(src, TRIGGER_USES_CONTEXT);
  assert.match(src, DRAWER_USES_CONTEXT);
});

test("dashboard shell wraps the topbar trigger and drawer in the same provider", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, SHELL_IMPORTS_PROVIDER);
  assert.match(src, SHELL_PROVIDER_WRAP);
});
