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
const PALETTE_USES_REGISTRY = /import \{[^}]*\blistDashboardCommands\b[^}]*\} from "\.\.\/lib\/actions\.ts"/;
const EXPLORE_PRIMARY_GROUP_RE = /label:\s*["']Explore["'][\s\S]*a === ["']explore["'] \|\| a === ["']search["']/;
const EXPLORE_PRIMARY_GROUPS_RECORDS_RE =
  /label:\s*["']Explore["'][\s\S]*a === ["']explore["'] \|\| a === ["']search["'] \|\| a === ["']records["']/;
const PRIMARY_JUMP_NAV_RE = /label:\s*["']Jump["']/;
const PRIMARY_SOURCES_NAV_RE = /\{\s*href:\s*routes\.section\.records,\s*label:\s*["']Connections["']/;

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

test("primary shell navigation keeps Explore, Jump, and Connections distinct", async () => {
  const src = await readFile(SHELL_FILE, "utf8");
  const primaryNav = buildNavSource(src);
  assert.match(primaryNav, EXPLORE_PRIMARY_GROUP_RE);
  assert.doesNotMatch(primaryNav, EXPLORE_PRIMARY_GROUPS_RECORDS_RE, "Connections must not be grouped under Explore");
  assert.doesNotMatch(primaryNav, PRIMARY_JUMP_NAV_RE, "Jump belongs in the Explore subnav, not primary navigation");
  assert.match(primaryNav, PRIMARY_SOURCES_NAV_RE, "Connections must be primary navigation");
});

test("command palette sources commands from the actions registry, not a hard-coded list", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.match(src, PALETTE_USES_REGISTRY);
});

// live mode

test("actions registry exposes quick-owner-token in live mode pointing to /dashboard/deployment/tokens", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.ok(ownerToken, "quick-owner-token must exist in live mode");
  assert.equal(ownerToken.href, "/dashboard/deployment/tokens");
  assert.equal(ownerToken.section, "Quick action");
});

test("owner token is discoverable via keyword search for 'token' in live mode", () => {
  const results = matchDashboardCommands("token", { basePath: "/dashboard", mode: "live" });
  const ids = results.map((c) => c.id);
  assert.ok(ids.includes("quick-owner-token"), `quick-owner-token must match 'token' query; got: ${ids.join(", ")}`);
});

test("owner token copy uses operator framing, not MCP client framing", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.ok(ownerToken);
  const copy = `${ownerToken.title} ${ownerToken.description}`.toLowerCase();
  assert.ok(!copy.includes("mcp client"), "copy must not imply ordinary MCP clients need owner tokens");
});

test("Device exporters nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const deviceExporters = all.find((c) => c.id === "nav-device-exporters");
  assert.ok(deviceExporters, "nav-device-exporters must exist in live mode");
  assert.equal(deviceExporters.href, "/dashboard/device-exporters");
});

test("Event subscriptions nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const eventSubs = all.find((c) => c.id === "nav-event-subscriptions");
  assert.ok(eventSubs, "nav-event-subscriptions must exist in live mode");
  assert.equal(eventSubs.href, "/dashboard/event-subscriptions");
});

test("Schedules nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const schedules = all.find((c) => c.id === "nav-schedules");
  assert.ok(schedules, "nav-schedules must exist");
  assert.equal(schedules.href, "/dashboard/schedules");
});

test("Deployment nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const deployment = all.find((c) => c.id === "nav-deployment");
  assert.ok(deployment, "nav-deployment must exist");
  assert.equal(deployment.href, "/dashboard/deployment");
});

test("Connect nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const connect = all.find((c) => c.id === "nav-connect");
  assert.ok(connect, "nav-connect must exist in live mode");
  assert.equal(connect.href, "/dashboard/connect");
});

// mock-owner / sandbox mode

test("quick-owner-token is absent in mock-owner mode", () => {
  const all = listDashboardCommands({ basePath: "/sandbox", mode: "mock-owner" });
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.equal(ownerToken, undefined, "quick-owner-token must not appear in mock-owner/sandbox mode");
});

test("no /dashboard/deployment/tokens href leaks into sandbox commands", () => {
  const all = listDashboardCommands({ basePath: "/sandbox", mode: "mock-owner" });
  const leaked = all.filter((c) => c.href.includes("/dashboard/"));
  assert.equal(
    leaked.length,
    0,
    `sandbox commands must not contain /dashboard/ hrefs; found: ${leaked.map((c) => c.href).join(", ")}`
  );
});

test("Device exporters is absent in mock-owner mode", () => {
  const all = listDashboardCommands({ basePath: "/sandbox", mode: "mock-owner" });
  const deviceExporters = all.find((c) => c.id === "nav-device-exporters");
  assert.equal(deviceExporters, undefined, "nav-device-exporters must not appear in mock-owner mode");
});

test("Event subscriptions is absent in mock-owner mode", () => {
  const all = listDashboardCommands({ basePath: "/sandbox", mode: "mock-owner" });
  const eventSubs = all.find((c) => c.id === "nav-event-subscriptions");
  assert.equal(eventSubs, undefined, "nav-event-subscriptions must not appear in mock-owner mode");
});

test("Connect setup is absent in mock-owner mode", () => {
  const all = listDashboardCommands({ basePath: "/sandbox", mode: "mock-owner" });
  const connect = all.find((c) => c.id === "nav-connect");
  assert.equal(connect, undefined, "nav-connect must not appear in mock-owner mode");
});

test("sandbox commands use /sandbox/ base path", () => {
  const all = listDashboardCommands({ basePath: "/sandbox", mode: "mock-owner" });
  const nonSandbox = all.filter((c) => !c.href.startsWith("/sandbox"));
  assert.equal(
    nonSandbox.length,
    0,
    `all sandbox commands must start with /sandbox/; offenders: ${nonSandbox.map((c) => c.href).join(", ")}`
  );
});

// base path correctness

test("live mode commands use the supplied basePath, not a hard-coded /dashboard", () => {
  const all = listDashboardCommands({ basePath: "/custom", mode: "live" });
  const wrongPath = all.filter((c) => c.href.startsWith("/dashboard"));
  assert.equal(
    wrongPath.length,
    0,
    `commands must use caller-supplied basePath; found hard-coded /dashboard in: ${wrongPath.map((c) => c.href).join(", ")}`
  );
});
