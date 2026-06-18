import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { listDashboardCommands, matchDashboardCommands } from "../lib/actions.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const COMMAND_PALETTE_FILE = `${HERE}command-palette.tsx`;
const RECORDROOM_SHELL_FILE = fileURLToPath(
  new URL("../../../../../../packages/pdpp-brand-react/src/shell-frame.tsx", import.meta.url)
);
const RECORDROOM_SHELL_BRIDGE_FILE = `${HERE}recordroom-shell-with-palette.tsx`;
const DASHBOARD_PALETTE_PROVIDER_FILE = `${HERE}dashboard-palette-provider.tsx`;

const MODULE_MUTABLE_OPENER = /let\s+openRef|noopOpen|openRef\s*=\s*\{/;
const CONTEXT_PROVIDER = /const CommandPaletteContext = createContext<CommandPaletteContextValue \| null>\(null\)/;
const CONTEXT_HOOK = /function useCommandPalette\(\): CommandPaletteContextValue/;
const TRIGGER_USES_CONTEXT = /const palette = useCommandPalette\(\)[\s\S]*onClick=\{palette\.open\}/;
const PALETTE_USES_CONTEXT = /const palette = useCommandPalette\(\)[\s\S]*if \(!palette\.isOpen\)/;
const LAYOUT_PROVIDER_WRAP = /<CommandPaletteProvider>[\s\S]*\{children\}[\s\S]*<CommandPalette basePath="\/dashboard" mode="live" \/>[\s\S]*<\/CommandPaletteProvider>/;
const SHELL_BRIDGE_USES_CONTEXT = /const \{ toggle \} = useCommandPalette\(\)/;
const SHELL_BRIDGE_WIRES_JUMP = /<RecordroomShell build=\{build\} host=\{host\} onJump=\{toggle\}>/;
const PALETTE_USES_REGISTRY = /import \{[^}]*\blistDashboardCommands\b[^}]*\} from "\.\.\/lib\/actions\.ts"/;
const NAV_ITEM_RE = (label: string, href: string) =>
  new RegExp(`\\{\\s*label:\\s*["']${label}["'],\\s*href:\\s*["']${href.replaceAll("/", "\\/")}["']\\s*\\}`);
const NAV_GROUP_RE = (heading: string, labels: string[]) =>
  new RegExp(`heading:\\s*["']${heading}["'][\\s\\S]*${labels.map((label) => `label:\\s*["']${label}["']`).join("[\\s\\S]*")}`);

test("command palette uses React context, not a module-level mutable opener", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.equal(MODULE_MUTABLE_OPENER.test(src), false);
  assert.match(src, CONTEXT_PROVIDER);
  assert.match(src, CONTEXT_HOOK);
  assert.match(src, TRIGGER_USES_CONTEXT);
  assert.match(src, PALETTE_USES_CONTEXT);
});

test("dashboard layout provides the live command palette to the Recordroom shell bridge", async () => {
  const provider = await readFile(DASHBOARD_PALETTE_PROVIDER_FILE, "utf8");
  const bridge = await readFile(RECORDROOM_SHELL_BRIDGE_FILE, "utf8");
  assert.match(provider, LAYOUT_PROVIDER_WRAP);
  assert.match(bridge, SHELL_BRIDGE_USES_CONTEXT);
  assert.match(bridge, SHELL_BRIDGE_WIRES_JUMP);
});

test("live Recordroom shell navigation covers owner routes with one clear label per concept", async () => {
  const src = await readFile(RECORDROOM_SHELL_FILE, "utf8");
  assert.match(src, NAV_ITEM_RE("Overview", "/dashboard"));
  assert.match(src, NAV_ITEM_RE("Explore", "/dashboard/explore"));
  assert.match(src, NAV_GROUP_RE("Collection", ["Sources", "Syncs", "Schedules"]));
  assert.match(src, NAV_GROUP_RE("Sharing", ["Connect AI apps", "Grants", "Traces"]));
  assert.match(src, NAV_GROUP_RE("Server", ["Deployment", "Device exporters", "Event subscriptions"]));
  assert.doesNotMatch(src, /label:\s*["']Standing["']/, "Standing must not ship as owner-facing nav");
  assert.doesNotMatch(src, /label:\s*["']Jump["']/, "Jump is command-palette chrome, not primary nav");
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

test("runs route is labeled Syncs in the command palette to match the page and sidebar", () => {
  const all = listDashboardCommands({ basePath: "/dashboard", mode: "live" });
  const syncs = all.find((c) => c.id === "nav-runs");
  assert.ok(syncs, "nav-runs command must exist");
  assert.equal(syncs.title, "Syncs");
  assert.equal(syncs.href, "/dashboard/runs");
  assert.equal(
    all.some((c) => c.title === "Runs"),
    false,
    "owner-facing command titles must not reintroduce the old Runs label"
  );
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
