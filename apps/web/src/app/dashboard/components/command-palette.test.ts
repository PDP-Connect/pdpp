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
const DASHBOARD_ONLY_CONNECTIONS_SHORTCUT_RE =
  /if\s*\(basePath === ["']\/dashboard["']\)\s*\{[\s\S]*shortcuts\.push\(\{ label: ["']Connections["'], href: `\$\{basePath\}\/records` \}\)/;
const EXPLORE_PRIMARY_GROUP_RE =
  /label:\s*["']Explore["'][\s\S]*a === ["']explore["'] \|\| a === ["']search["'] \|\| a === ["']records["']/;
const PRIMARY_JUMP_NAV_RE = /label:\s*["']Jump["']/;
const PRIMARY_CONNECTIONS_NAV_RE = /\{\s*href:\s*routes\.section\.records,\s*label:\s*["']Connections["']/;

function buildNavSource(src: string): string {
  return src.slice(src.indexOf("function buildNav"), src.indexOf("function resolveRoutes"));
}

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

test("primary shell navigation groups records and artifact jump under Explore", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  const primaryNav = buildNavSource(src);
  assert.match(primaryNav, EXPLORE_PRIMARY_GROUP_RE);
  assert.doesNotMatch(primaryNav, PRIMARY_JUMP_NAV_RE, "Jump belongs in the Explore subnav, not primary navigation");
  assert.doesNotMatch(
    primaryNav,
    PRIMARY_CONNECTIONS_NAV_RE,
    "Connections belongs in the Explore subnav, not primary navigation"
  );
});

test("sandbox command palette does not expose retired records shortcuts", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.match(
    src,
    DASHBOARD_ONLY_CONNECTIONS_SHORTCUT_RE,
    "Connections shortcut must be dashboard-only because /sandbox/records redirects to /sandbox/explore"
  );
});
