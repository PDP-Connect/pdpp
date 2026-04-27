import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMMAND_PALETTE_FILE = `${HERE}command-palette.tsx`;
const SHELL_FILE = `${HERE}shell.tsx`;

const MODULE_MUTABLE_OPENER = /let\s+openRef|noopOpen|openRef\s*=\s*\{/;
const CONTEXT_PROVIDER = /const CommandPaletteContext = createContext<CommandPaletteContextValue \| null>\(null\)/;
const CONTEXT_HOOK = /function useCommandPalette\(\): CommandPaletteContextValue/;
const TRIGGER_USES_CONTEXT = /const palette = useCommandPalette\(\)[\s\S]*onClick=\{palette\.open\}/;
const PALETTE_USES_CONTEXT = /const palette = useCommandPalette\(\)[\s\S]*if \(!palette\.isOpen\)/;
const SHELL_IMPORTS_PROVIDER = /import \{ CommandPalette, CommandPaletteProvider, CommandPaletteTrigger \}/;
const SHELL_PROVIDER_WRAP =
  /<CommandPaletteProvider>[\s\S]*<Topbar overviewHref=\{routes\.section\.overview\} \/>[\s\S]*<CommandPalette [\s\S]*<\/CommandPaletteProvider>/;

test("command palette uses React context, not a module-level mutable opener", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.equal(MODULE_MUTABLE_OPENER.test(src), false);
  assert.match(src, CONTEXT_PROVIDER);
  assert.match(src, CONTEXT_HOOK);
  assert.match(src, TRIGGER_USES_CONTEXT);
  assert.match(src, PALETTE_USES_CONTEXT);
});

test("dashboard shell wraps the topbar trigger and palette in the same provider", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  assert.match(src, SHELL_IMPORTS_PROVIDER);
  assert.match(src, SHELL_PROVIDER_WRAP);
});
