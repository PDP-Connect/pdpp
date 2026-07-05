/**
 * Command-palette guards.
 *
 * Two layers, matching this repo's test infra (there is no jsdom/testing-library
 * JSX render harness, so DOM interaction is asserted through source-regex static
 * guards plus pure-function behavior tests):
 *
 *   1. Behavior (pure functions): the command registry filters live, and the
 *      row model surfaces an explicit free-text search row only when the owner
 *      has typed something.
 *   2. Static structure guards: exactly one ⌘K listener owns the palette (the
 *      provider — the shell no longer has its own), the palette is built on the
 *      dismiss/focus-trap dialog primitive, the input autofocuses via the
 *      primitive, and free-text search is an explicit selectable row rather than
 *      the default Enter redirect the Jump audit flagged.
 *
 * The full click/keyboard interaction (single-open parity, first-outside-click
 * close, focus-on-open) is a Playwright residual — see the shell-palette report.
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LEGACY_SEGMENTS } from "@pdpp/operator-ui/components/command-registry";
import { CONSOLE_SEGMENTS } from "@pdpp/operator-ui/components/views/routes";
import { listDashboardCommands, matchDashboardCommands } from "../lib/actions.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// The console palette is a thin re-export of the ONE unified implementation in
// @pdpp/operator-ui; behavior/structure guards read the shared implementation.
const CONSOLE_PALETTE_REEXPORT_FILE = `${HERE}command-palette.tsx`;
const COMMAND_PALETTE_FILE = fileURLToPath(
  new URL("../../../../../../packages/operator-ui/src/components/command-palette.tsx", import.meta.url)
);
const OPERATOR_UI_PALETTE_DIR = fileURLToPath(
  new URL("../../../../../../packages/operator-ui/src/components/", import.meta.url)
);
const RECORDROOM_SHELL_FILE = fileURLToPath(
  new URL("../../../../../../packages/pdpp-brand-react/src/shell-frame.tsx", import.meta.url)
);
const RECORDROOM_SHELL_BRIDGE_FILE = `${HERE}recordroom-shell-with-palette.tsx`;
const DASHBOARD_PALETTE_PROVIDER_FILE = `${HERE}dashboard-palette-provider.tsx`;

const MODULE_MUTABLE_OPENER = /let\s+openRef|noopOpen|openRef\s*=\s*\{/;
const CONTEXT_PROVIDER = /const CommandPaletteContext = createContext<CommandPaletteContextValue \| null>\(null\)/;
const CONTEXT_HOOK = /function useCommandPalette\(\): CommandPaletteContextValue/;
const TRIGGER_USES_CONTEXT = /const palette = useCommandPalette\(\)[\s\S]*onClick=\{palette\.open\}/;
const PALETTE_USES_CONTEXT = /const palette = useCommandPalette\(\)/;
const LAYOUT_PROVIDER_WRAP =
  /<CommandPaletteProvider>[\s\S]*\{children\}[\s\S]*<CommandPalette basePath=\{CONSOLE_BASE_PATH\} mode="live" segments=\{CONSOLE_SEGMENTS\} \/>[\s\S]*<\/CommandPaletteProvider>/;
const SHELL_BRIDGE_USES_CONTEXT = /const \{ toggle \} = useCommandPalette\(\)/;
const SHELL_BRIDGE_WIRES_JUMP = /<RecordroomShell build=\{build\} host=\{host\} onJump=\{toggle\}>/;
const PALETTE_USES_REGISTRY = /import \{[^}]*\bmatchDashboardCommands\b[^}]*\} from "\.\/command-registry\.ts"/;
const CONSOLE_REEXPORTS_UNIFIED_RE =
  /export \{[\s\S]*CommandPalette[\s\S]*\} from "@pdpp\/operator-ui\/components\/command-palette"/;
const CRUMB_IN_FOOTBLOCK_RE = /className="rr-side__foot"[\s\S]*\{host\} · \{build\}/;
const PROVIDER_SHORTCUT_RE = /\(e\.metaKey \|\| e\.ctrlKey\) && e\.key\.toLowerCase\(\) === "k"/;
const SHELL_HAS_SHORTCUT_RE = /metaKey[\s\S]{0,40}ctrlKey[\s\S]{0,80}"k"/;
const PALETTE_IMPORTS_DIALOG_RE = /import \{[^}]*\bDialog\b[^}]*\} from "\.\.\/ui\/dialog\.tsx"/;
const PALETTE_DIALOG_ONOPENCHANGE_RE = /<Dialog[\s\S]*onOpenChange=\{[\s\S]*palette\.close\(\)/;
const PALETTE_INITIAL_FOCUS_RE = /initialFocus=\{inputRef\}/;
const PALETTE_NO_MICROTASK_RE = /queueMicrotask/;
const PALETTE_MATCH_CALL_RE = /matchDashboardCommands\(query, \{ basePath, mode, segments \}\)/;
const PALETTE_SEARCH_ROW_RE = /command-palette-search-row/;
const PALETTE_SEARCH_KIND_RE = /kind === "search"/;
const PALETTE_NO_FORM_SUBMIT_RE = /onSubmit=\{submit\}/;
const PALETTE_NO_SEARCH_REDIRECT_RE = /\/search\?q=/;
const NAV_LABEL_STANDING_RE = /label:\s*["']Standing["']/;
const NAV_LABEL_JUMP_RE = /label:\s*["']Jump["']/;
const NAV_LABEL_RUNS_RE = /label:\s*["']Runs["']/;
const NAV_LABEL_TRACES_RE = /label:\s*["']Traces["']/;
const WORDMARK_SPAN_RE = /rr-side__name">([^<]+)</g;
const WORDMARK_PDPP_RE = /PDPP/;
const RECORDROOM_AS_COPY_RE = />\s*Recordroom\s*</;
const CRUMB_LITERAL_RE = /\{host\} · \{build\}/g;
const HEAD_CRUMB_CLASS_RE = /rr-head__crumb/;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /^\s*\/\/.*$/gm;
const PALETTE_IMPL_FILE_RE = /command-palette.*\.tsx$/;
const CLEAN_SANDBOX_SEGMENT_LEAK_RE = /\/(sources|syncs|audit)(\b|\/|\?|#)/;
const NAV_ITEM_RE = (label: string, href: string) =>
  new RegExp(`\\{\\s*label:\\s*["']${label}["'],\\s*href:\\s*["']${href.replaceAll("/", "\\/")}["']\\s*\\}`);
const NAV_GROUP_RE = (heading: string, labels: string[]) =>
  new RegExp(
    `heading:\\s*["']${heading}["'][\\s\\S]*${labels.map((label) => `label:\\s*["']${label}["']`).join("[\\s\\S]*")}`
  );

// ── Provider owns the ONE ⌘K listener; the shell has none ──────────────────

test("the palette provider owns the only ⌘K/Ctrl+K keydown listener", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.equal(MODULE_MUTABLE_OPENER.test(src), false);
  assert.match(src, CONTEXT_PROVIDER);
  assert.match(src, CONTEXT_HOOK);
  assert.match(src, TRIGGER_USES_CONTEXT);
  assert.match(src, PALETTE_USES_CONTEXT);
  // The provider registers a metaKey/ctrlKey + "k" keydown.
  assert.match(src, PROVIDER_SHORTCUT_RE);
});

test("RecordroomShell does NOT register a second ⌘K listener (single-listener invariant)", async () => {
  const src = await readFile(RECORDROOM_SHELL_FILE, "utf8");
  // The shell keeps an Escape-closes-drawer keydown, but must not re-add a
  // ⌘K/Ctrl+K handler — that is the double-fire the Jump audit found.
  assert.doesNotMatch(
    src,
    SHELL_HAS_SHORTCUT_RE,
    "RecordroomShell must not own a ⌘K listener; the palette provider does"
  );
});

test("dashboard layout provides the live command palette to the Recordroom shell bridge", async () => {
  const provider = await readFile(DASHBOARD_PALETTE_PROVIDER_FILE, "utf8");
  const bridge = await readFile(RECORDROOM_SHELL_BRIDGE_FILE, "utf8");
  assert.match(provider, LAYOUT_PROVIDER_WRAP);
  assert.match(bridge, SHELL_BRIDGE_USES_CONTEXT);
  assert.match(bridge, SHELL_BRIDGE_WIRES_JUMP);
});

// ── Exactly one palette implementation; the console only re-exports it ──────

test("the console palette is a thin re-export of the ONE unified operator-ui palette", async () => {
  const consoleSrc = await readFile(CONSOLE_PALETTE_REEXPORT_FILE, "utf8");
  assert.match(consoleSrc, CONSOLE_REEXPORTS_UNIFIED_RE);
  // The console file must NOT define its own palette component/provider.
  assert.doesNotMatch(consoleSrc, CONTEXT_PROVIDER, "console must not define a second CommandPaletteContext");
  // There is exactly one command-palette.tsx implementation in operator-ui;
  // no legacy duplicate lingers beside it.
  const operatorFiles = await readdir(OPERATOR_UI_PALETTE_DIR);
  const paletteImpls = operatorFiles.filter((f) => PALETTE_IMPL_FILE_RE.test(f) && !f.endsWith(".test.tsx"));
  assert.deepEqual(
    paletteImpls,
    ["command-palette.tsx"],
    `expected one palette impl, found: ${paletteImpls.join(", ")}`
  );
});

// ── Palette is built on the dismiss/focus-trap primitive, filters live, and ──
// ── offers free-text search as an explicit row, not a default Enter redirect ──

test("palette is built on the base-ui Dialog skin (focus-trap + first-outside-click dismiss)", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.match(src, PALETTE_IMPORTS_DIALOG_RE);
  assert.match(src, PALETTE_DIALOG_ONOPENCHANGE_RE);
  // Autofocus the input deterministically via the primitive, not a microtask hack.
  assert.match(src, PALETTE_INITIAL_FOCUS_RE);
  assert.equal(
    PALETTE_NO_MICROTASK_RE.test(src),
    false,
    "focus must come from the dialog primitive, not queueMicrotask"
  );
});

test("palette filters live via matchDashboardCommands", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  assert.match(src, PALETTE_USES_REGISTRY);
  assert.match(src, PALETTE_MATCH_CALL_RE);
});

test("free-text search is an explicit selectable row, not the default Enter redirect", async () => {
  const src = await readFile(COMMAND_PALETTE_FILE, "utf8");
  // A dedicated search row exists and routes to Explore only when activated.
  assert.match(src, PALETTE_SEARCH_ROW_RE);
  assert.match(src, PALETTE_SEARCH_KIND_RE);
  // The old behavior — a form submit that unconditionally pushed to /search on
  // Enter — must be gone.
  assert.equal(PALETTE_NO_FORM_SUBMIT_RE.test(src), false, "Enter must not auto-redirect via a form submit");
  assert.equal(
    PALETTE_NO_SEARCH_REDIRECT_RE.test(src),
    false,
    "Enter must not silently redirect into the search route"
  );
});

// ── Behavior: live filtering + row model ───────────────────────────────────

test("matchDashboardCommands narrows to matching commands as the owner types", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const filtered = matchDashboardCommands("audit", { basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  assert.ok(filtered.length > 0, "‘audit’ must match at least one command");
  assert.ok(filtered.length < all.length, "a specific query must narrow the list");
  assert.ok(
    filtered.every((c) => `${c.title} ${c.description} ${c.keywords.join(" ")}`.toLowerCase().includes("audit")),
    "every result must actually contain the query"
  );
});

test("empty query returns the full mode-scoped command list (sensible default set)", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const empty = matchDashboardCommands("", { basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  assert.equal(empty.length, all.length);
});

// ── Owner-noun labels: Runs → Syncs, Traces → Audit ────────────────────────

test("live Recordroom shell navigation uses the owner nouns (Sources, Syncs, Audit)", async () => {
  const src = await readFile(RECORDROOM_SHELL_FILE, "utf8");
  assert.match(src, NAV_ITEM_RE("Overview", "/"));
  assert.match(src, NAV_ITEM_RE("Explore", "/explore"));
  assert.match(src, NAV_GROUP_RE("Collection", ["Sources", "Syncs", "Schedules"]));
  assert.match(src, NAV_GROUP_RE("Sharing", ["Connect AI apps", "Grants", "Audit"]));
  assert.match(src, NAV_GROUP_RE("Server", ["Notifications", "Deployment", "Device exporters", "Event subscriptions"]));
  assert.doesNotMatch(src, NAV_LABEL_STANDING_RE, "Standing must not ship as owner-facing nav");
  assert.doesNotMatch(src, NAV_LABEL_JUMP_RE, "Jump is command-palette chrome, not primary nav");
  assert.doesNotMatch(src, NAV_LABEL_RUNS_RE, "Runs must be renamed to Syncs in the live nav");
  assert.doesNotMatch(src, NAV_LABEL_TRACES_RE, "Traces must be renamed to Audit in the live nav");
});

// ── Generated hrefs are clean: no /dashboard leaks (§10.B contract) ─────────

test("live command hrefs are clean top-level routes and never contain /dashboard", () => {
  const live = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const leaks = live.filter((c) => c.href.includes("/dashboard"));
  assert.deepEqual(leaks, [], `live commands must not emit /dashboard hrefs: ${leaks.map((c) => c.href).join(", ")}`);
  // Sources/Syncs/Audit resolve to their clean segments, not the legacy ones.
  assert.equal(live.find((c) => c.id === "nav-records")?.href, "/sources");
  assert.equal(live.find((c) => c.id === "nav-runs")?.href, "/syncs");
  assert.equal(live.find((c) => c.id === "nav-traces")?.href, "/audit");
  assert.equal(live.find((c) => c.id === "nav-notifications")?.href, "/notifications");
  // Overview is the clean root.
  assert.equal(live.find((c) => c.id === "nav-overview")?.href, "/");
});

test("the console default (no basePath) is the clean owner console, not the legacy /dashboard prefix", () => {
  const live = listDashboardCommands();
  const leaks = live.filter((c) => c.href.includes("/dashboard"));
  assert.deepEqual(leaks, [], "the default command set must not emit /dashboard hrefs");
  assert.equal(live.find((c) => c.id === "nav-overview")?.href, "/");
});

test("the owner-visible wordmark is PDPP, never Recordroom", async () => {
  const src = await readFile(RECORDROOM_SHELL_FILE, "utf8");
  // The three brand render sites (sidebar, header, drawer) say PDPP.
  const wordmarks = src.match(WORDMARK_SPAN_RE) ?? [];
  assert.ok(wordmarks.length >= 2, "expected the sidebar + drawer wordmark spans");
  for (const w of wordmarks) {
    assert.match(w, WORDMARK_PDPP_RE, "sidebar/drawer wordmark must render PDPP");
  }
  // No owner-visible JSX text node renders the internal component name.
  assert.doesNotMatch(src, RECORDROOM_AS_COPY_RE, "Recordroom must not appear as owner-visible copy");
});

test("the {host} · {build} crumb renders in exactly one owner-facing place", async () => {
  const raw = await readFile(RECORDROOM_SHELL_FILE, "utf8");
  // Strip block + line comments so documentation that *mentions* the crumb does
  // not count as a render site.
  const src = raw.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "");
  const crumbSites = src.match(CRUMB_LITERAL_RE) ?? [];
  assert.equal(
    crumbSites.length,
    1,
    `the {host} · {build} crumb must render from exactly one component (found ${crumbSites.length})`
  );
  // That one component is the sidebar/drawer FootBlock. The header crumb is gone.
  assert.doesNotMatch(src, HEAD_CRUMB_CLASS_RE, "the header crumb must be removed");
  assert.match(src, CRUMB_IN_FOOTBLOCK_RE, "the crumb lives in the sidebar FootBlock");
});

// live mode

test("actions registry exposes quick-owner-token in live mode pointing to /deployment/tokens", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.ok(ownerToken, "quick-owner-token must exist in live mode");
  assert.equal(ownerToken.href, "/deployment/tokens");
  assert.equal(ownerToken.section, "Quick action");
});

test("owner token is discoverable via keyword search for 'token' in live mode", () => {
  const results = matchDashboardCommands("token", { basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const ids = results.map((c) => c.id);
  assert.ok(ids.includes("quick-owner-token"), `quick-owner-token must match 'token' query; got: ${ids.join(", ")}`);
});

test("owner token copy uses operator framing, not MCP client framing", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.ok(ownerToken);
  const copy = `${ownerToken.title} ${ownerToken.description}`.toLowerCase();
  assert.ok(!copy.includes("mcp client"), "copy must not imply ordinary MCP clients need owner tokens");
});

test("Device exporters nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const deviceExporters = all.find((c) => c.id === "nav-device-exporters");
  assert.ok(deviceExporters, "nav-device-exporters must exist in live mode");
  assert.equal(deviceExporters.href, "/device-exporters");
});

test("Event subscriptions nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const eventSubs = all.find((c) => c.id === "nav-event-subscriptions");
  assert.ok(eventSubs, "nav-event-subscriptions must exist in live mode");
  assert.equal(eventSubs.href, "/event-subscriptions");
});

test("Schedules nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const schedules = all.find((c) => c.id === "nav-schedules");
  assert.ok(schedules, "nav-schedules must exist");
  assert.equal(schedules.href, "/schedules");
});

test("runs route is labeled Syncs in the command palette to match the page and sidebar", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const syncs = all.find((c) => c.id === "nav-runs");
  assert.ok(syncs, "nav-runs command must exist");
  assert.equal(syncs.title, "Syncs");
  assert.equal(syncs.href, "/syncs");
  assert.equal(
    all.some((c) => c.title === "Runs"),
    false,
    "owner-facing command titles must not reintroduce the old Runs label"
  );
});

test("traces route is labeled Audit in the command palette to match the sidebar and page", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const audit = all.find((c) => c.id === "nav-traces");
  assert.ok(audit, "nav-traces command must exist");
  assert.equal(audit.title, "Audit");
  assert.equal(audit.href, "/audit");
  assert.equal(
    all.some((c) => c.title === "Traces"),
    false,
    "owner-facing command titles must not reintroduce the old Traces label"
  );
});

test("Deployment nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const deployment = all.find((c) => c.id === "nav-deployment");
  assert.ok(deployment, "nav-deployment must exist");
  assert.equal(deployment.href, "/deployment");
});

test("Notifications nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const notifications = all.find((c) => c.id === "nav-notifications");
  assert.ok(notifications, "nav-notifications must exist in live mode");
  assert.equal(notifications.href, "/notifications");
});

test("Connect nav command is present in live mode", () => {
  const all = listDashboardCommands({ basePath: "", mode: "live", segments: CONSOLE_SEGMENTS });
  const connect = all.find((c) => c.id === "nav-connect");
  assert.ok(connect, "nav-connect must exist in live mode");
  assert.equal(connect.href, "/connect");
});

// mock-owner / sandbox mode
//
// These model the REAL sandbox caller (`apps/site/src/app/dashboard/components/
// shell.tsx`), which passes `basePath: "/sandbox"` AND `segments:
// LEGACY_SEGMENTS` so the sandbox keeps its legacy `records`/`runs`/`traces`
// folder routes. Passing the legacy segments here (rather than relying on the
// clean-console default) keeps the tests faithful to what the sandbox renders.
const SANDBOX_OPTS = { basePath: "/sandbox", mode: "mock-owner", segments: LEGACY_SEGMENTS } as const;

test("quick-owner-token is absent in mock-owner mode", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const ownerToken = all.find((c) => c.id === "quick-owner-token");
  assert.equal(ownerToken, undefined, "quick-owner-token must not appear in mock-owner/sandbox mode");
});

test("no legacy /dashboard href leaks into sandbox commands", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const leaked = all.filter((c) => c.href.includes("/dashboard"));
  assert.equal(
    leaked.length,
    0,
    `sandbox commands must not contain legacy /dashboard hrefs; found: ${leaked.map((c) => c.href).join(", ")}`
  );
});

test("sandbox commands keep the legacy folder segments, not the clean console ones", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  // The sandbox's physical routes are still /sandbox/records, /sandbox/runs,
  // /sandbox/traces — the clean Sources/Syncs/Audit segments must NOT leak here.
  assert.equal(all.find((c) => c.id === "nav-records")?.href, "/sandbox/records");
  assert.equal(all.find((c) => c.id === "nav-runs")?.href, "/sandbox/runs");
  assert.equal(all.find((c) => c.id === "nav-traces")?.href, "/sandbox/traces");
  const cleanLeaks = all.filter((c) => CLEAN_SANDBOX_SEGMENT_LEAK_RE.test(c.href));
  assert.deepEqual(
    cleanLeaks,
    [],
    `sandbox must not emit clean console segments; found: ${cleanLeaks.map((c) => c.href).join(", ")}`
  );
});

test("Device exporters is absent in mock-owner mode", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const deviceExporters = all.find((c) => c.id === "nav-device-exporters");
  assert.equal(deviceExporters, undefined, "nav-device-exporters must not appear in mock-owner mode");
});

test("Event subscriptions is absent in mock-owner mode", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const eventSubs = all.find((c) => c.id === "nav-event-subscriptions");
  assert.equal(eventSubs, undefined, "nav-event-subscriptions must not appear in mock-owner mode");
});

test("Notifications is absent in mock-owner mode", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const notifications = all.find((c) => c.id === "nav-notifications");
  assert.equal(notifications, undefined, "nav-notifications must not appear without a sandbox route");
});

test("Connect setup is absent in mock-owner mode", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const connect = all.find((c) => c.id === "nav-connect");
  assert.equal(connect, undefined, "nav-connect must not appear in mock-owner mode");
});

test("sandbox commands use /sandbox/ base path", () => {
  const all = listDashboardCommands(SANDBOX_OPTS);
  const nonSandbox = all.filter((c) => !c.href.startsWith("/sandbox"));
  assert.equal(
    nonSandbox.length,
    0,
    `all sandbox commands must start with /sandbox/; offenders: ${nonSandbox.map((c) => c.href).join(", ")}`
  );
});

// base path correctness

test("live mode commands use the supplied basePath, not a hard-coded prefix", () => {
  const all = listDashboardCommands({ basePath: "/custom", mode: "live" });
  const wrongPath = all.filter((c) => !c.href.startsWith("/custom"));
  assert.equal(
    wrongPath.length,
    0,
    `commands must use caller-supplied basePath; found hrefs not under /custom: ${wrongPath.map((c) => c.href).join(", ")}`
  );
});
