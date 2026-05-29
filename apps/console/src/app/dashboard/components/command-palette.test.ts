import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listDashboardCommands, matchDashboardCommands } from "../lib/actions.ts";

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
const PALETTE_USES_REGISTRY = /import \{ listDashboardCommands \} from "\.\.\/lib\/actions\.ts"/;

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

test("command palette sources commands from the actions registry, not a hard-coded list", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.match(src, PALETTE_USES_REGISTRY);
});

test("actions registry exposes quick-owner-token pointing to /dashboard/deployment/tokens", () => {
  const all = listDashboardCommands();
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.ok(ownerToken, "quick-owner-token must exist in the registry");
  assert.equal(ownerToken.href, "/dashboard/deployment/tokens");
  assert.equal(ownerToken.section, "Quick action");
});

test("owner token is discoverable via keyword search for 'token'", () => {
  const results = matchDashboardCommands("token");
  const ids = results.map((c) => c.id);
  assert.ok(ids.includes("quick-owner-token"), `quick-owner-token must match 'token' query; got: ${ids.join(", ")}`);
});

test("owner token copy uses operator framing, not MCP client framing", () => {
  const all = listDashboardCommands();
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.ok(ownerToken);
  const copy = `${ownerToken.title} ${ownerToken.description}`.toLowerCase();
  assert.ok(!copy.includes("mcp client"), "copy must not imply ordinary MCP clients need owner tokens");
});
