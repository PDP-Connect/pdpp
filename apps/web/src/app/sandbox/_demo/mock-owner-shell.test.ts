/**
 * Static guard tests for the mock-owner dashboard mode.
 *
 * The primary `/sandbox/**` dashboard surfaces should render the live
 * `DashboardShell` in `mode="mock-owner"` instead of a forked shell.
 * These tests walk the sandbox source tree and check by string match
 * (no rendering required) so the guarantee survives refactors and is
 * cheap to run in CI.
 *
 * They also assert that the educational pages (api-examples,
 * walkthrough) and the launcher (`/sandbox/page.tsx`) are NOT
 * `DashboardShell` callers — they are supporting surfaces and must
 * stay distinct from the in-mode dashboard so the visitor can tell
 * "I'm in the dashboard" apart from "I'm reading docs."
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SANDBOX_DIR = join(HERE, "..");

const DASHBOARD_SHELL_IMPORT_RE = /from\s+["']@\/app\/dashboard\/components\/shell\.tsx["']/;
const SANDBOX_SHELL_IMPORT_RE = /from\s+["'].*_demo\/components\/shell\.tsx["']/;
const MOCK_OWNER_MODE_RE = /mode=["']mock-owner["']/;
const SANDBOX_OVERVIEW_LINK_RE = /\/sandbox\/overview/;
const MOCK_OWNER_FOOTER_NAME_RE = /MockOwnerFooter/;
const MOCK_OWNER_BRANCH_RE = /mode\s*===\s*["']mock-owner["']/;
const MOCK_OWNER_FOOTER_RENDER_RE = /<MockOwnerFooter\s*\/>/;
const SANDBOX_OVERVIEW_ROUTE_RE = /overview:\s*["']\/sandbox\/overview["']/;
const COMMAND_PALETTE_OVERVIEW_RE =
  /<CommandPalette\s+basePath=\{routes\.basePath\}\s+overviewHref=\{routes\.section\.overview\}\s*\/>/;
const SITE_HEADER_RE = /SiteHeader|currentLabel=["']Sandbox["']/;
const FORCE_DYNAMIC_RE = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/;
const BUTTON_VARIANTS_IMPORT_RE = /from\s+["']@\/components\/ui\/button\.tsx["']/;
const PRIMARY_CTA_RE = /buttonVariants\(\{\s*variant:\s*["']default["'],\s*size:\s*["']lg["']\s*\}\)/;
const HAND_ROLLED_PRIMARY_RE = /bg-foreground|text-background/;

const PRIMARY_DASHBOARD_PAGES = [
  "overview/page.tsx",
  "records/page.tsx",
  "records/timeline/page.tsx",
  "records/[connector]/page.tsx",
  "records/[connector]/[stream]/page.tsx",
  "records/[connector]/[stream]/[recordKey]/page.tsx",
  "search/page.tsx",
  "grants/page.tsx",
  "grants/[grantId]/page.tsx",
  "runs/page.tsx",
  "runs/[runId]/page.tsx",
  "traces/page.tsx",
  "traces/[traceId]/page.tsx",
  "schedules/page.tsx",
  "deployment/page.tsx",
];

/**
 * Routes that must exist on both /dashboard and /sandbox so the two surfaces
 * stay in lockstep. The check is a presence check rather than a behavior
 * check — its job is to trip when one side gets renamed or deleted without
 * the other.
 */
const DASHBOARD_DIR = join(SANDBOX_DIR, "..", "dashboard");
const PARITY_PAGES = [
  "page.tsx",
  "records/page.tsx",
  "schedules/page.tsx",
  "search/page.tsx",
  "grants/page.tsx",
  "runs/page.tsx",
  "traces/page.tsx",
  "deployment/page.tsx",
];

const SANDBOX_PARITY_PAGES = [
  "overview/page.tsx",
  "records/page.tsx",
  "schedules/page.tsx",
  "search/page.tsx",
  "grants/page.tsx",
  "runs/page.tsx",
  "traces/page.tsx",
  "deployment/page.tsx",
];

const EDUCATIONAL_PAGES = ["api-examples/page.tsx", "walkthrough/page.tsx"];

test("primary /sandbox dashboard pages render DashboardShell in mock-owner mode", async () => {
  const offenders: string[] = [];
  for (const rel of PRIMARY_DASHBOARD_PAGES) {
    const full = join(SANDBOX_DIR, rel);
    const src = await readFile(full, "utf8");
    if (!DASHBOARD_SHELL_IMPORT_RE.test(src)) {
      offenders.push(`${rel}: missing DashboardShell import`);
      continue;
    }
    if (!MOCK_OWNER_MODE_RE.test(src)) {
      offenders.push(`${rel}: DashboardShell rendered without mode="mock-owner"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `primary sandbox dashboard pages must use DashboardShell in mock-owner mode:\n${offenders.join("\n")}`
  );
});

test("primary /sandbox dashboard pages do NOT use the educational sandbox shell", async () => {
  const offenders: string[] = [];
  for (const rel of PRIMARY_DASHBOARD_PAGES) {
    const full = join(SANDBOX_DIR, rel);
    const src = await readFile(full, "utf8");
    if (SANDBOX_SHELL_IMPORT_RE.test(src)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `primary sandbox dashboard pages must not import the educational shell:\n${offenders.join("\n")}`
  );
});

test("educational pages do NOT render DashboardShell (they are docs surfaces)", async () => {
  const offenders: string[] = [];
  for (const rel of EDUCATIONAL_PAGES) {
    const full = join(SANDBOX_DIR, rel);
    const src = await readFile(full, "utf8");
    if (DASHBOARD_SHELL_IMPORT_RE.test(src)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, [], `educational pages must not render DashboardShell:\n${offenders.join("\n")}`);
});

test("/sandbox launcher is not DashboardShell-rendered", async () => {
  const src = await readFile(join(SANDBOX_DIR, "page.tsx"), "utf8");
  assert.equal(
    DASHBOARD_SHELL_IMPORT_RE.test(src),
    false,
    "the /sandbox launcher must not render DashboardShell — it is the entrypoint, not the dashboard"
  );
  assert.match(src, SANDBOX_OVERVIEW_LINK_RE, "the launcher must link into /sandbox/overview");
});

test("/sandbox launcher uses shared button variants for CTA contrast", async () => {
  const src = await readFile(join(SANDBOX_DIR, "page.tsx"), "utf8");
  assert.match(src, BUTTON_VARIANTS_IMPORT_RE);
  assert.match(src, PRIMARY_CTA_RE, "launcher primary CTA must use the design-system default button");
  assert.equal(
    HAND_ROLLED_PRIMARY_RE.test(src),
    false,
    "launcher must not hand-roll primary CTA foreground/background colors"
  );
});

test("/sandbox layout does not render global site chrome around mock-owner dashboard pages", async () => {
  const src = await readFile(join(SANDBOX_DIR, "layout.tsx"), "utf8");
  assert.equal(
    SITE_HEADER_RE.test(src),
    false,
    "sandbox layout must not render SiteHeader; dashboard-mode pages already render DashboardShell"
  );
});

test("/sandbox/search is dynamic so the server page receives ?q=... search params", async () => {
  const src = await readFile(join(SANDBOX_DIR, "search", "page.tsx"), "utf8");
  assert.match(src, FORCE_DYNAMIC_RE);
});

test("DashboardShell in mock-owner mode swaps in the mock-owner footer (no live AS/RS probe)", async () => {
  const src = await readFile(join(SANDBOX_DIR, "..", "dashboard", "components", "shell.tsx"), "utf8");
  // Both branches exist; the shell must not emit only the live footer.
  assert.match(src, MOCK_OWNER_FOOTER_NAME_RE, "shell must define a MockOwnerFooter for mock-owner mode");
  // The conditional explicitly picks the mock-owner footer when the
  // mode is "mock-owner". This regex is intentionally lax to let small
  // refactors of the conditional still pass.
  assert.match(src, MOCK_OWNER_BRANCH_RE, "shell must branch on mode === 'mock-owner'");
  assert.match(src, MOCK_OWNER_FOOTER_RENDER_RE, "shell must render <MockOwnerFooter /> in mock-owner mode");
});

test("sandboxRoutes overview is `/sandbox/overview`, distinct from the launcher", async () => {
  const src = await readFile(join(SANDBOX_DIR, "..", "dashboard", "components", "views", "routes.ts"), "utf8");
  assert.match(src, SANDBOX_OVERVIEW_ROUTE_RE);
});

test("/dashboard and /sandbox have parity for the core dashboard routes", async () => {
  const missing: string[] = [];
  for (const rel of PARITY_PAGES) {
    try {
      await readFile(join(DASHBOARD_DIR, rel), "utf8");
    } catch {
      missing.push(`/dashboard/${rel}`);
    }
  }
  for (const rel of SANDBOX_PARITY_PAGES) {
    try {
      await readFile(join(SANDBOX_DIR, rel), "utf8");
    } catch {
      missing.push(`/sandbox/${rel}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `dashboard/sandbox parity violated — these route files are missing:\n${missing.join("\n")}`
  );
});

test("DashboardShell passes the mode-specific overview route to CommandPalette", async () => {
  const src = await readFile(join(SANDBOX_DIR, "..", "dashboard", "components", "shell.tsx"), "utf8");
  assert.match(
    src,
    COMMAND_PALETTE_OVERVIEW_RE,
    "command palette Overview must point to /sandbox/overview in mock-owner mode, not the /sandbox launcher"
  );
});
