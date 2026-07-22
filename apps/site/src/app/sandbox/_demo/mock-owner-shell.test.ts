// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * walkthrough) are NOT `DashboardShell` callers — they are supporting
 * surfaces and must stay distinct from the in-mode dashboard so the
 * visitor can tell "I'm in the dashboard" apart from "I'm reading docs."
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
const SANDBOX_OVERVIEW_CONTENT_IMPORT_RE = /from\s+["'](?:\.\/|\.\.\/)overview-content\.tsx["']/;
const SANDBOX_OVERVIEW_CONTENT_RENDER_RE = /<SandboxOverviewContent\s*\/>/;
const SANDBOX_FOOTER_NAME_RE = /SandboxFooter/;
const SANDBOX_FOOTER_RENDER_RE = /<SandboxFooter\s*\/>/;
const SANDBOX_MODE_BANNER_COMPONENT_RE = /function SandboxModeBanner/;
// The site shell always renders in mock-owner mode (no live branch), so the
// banner is unconditional — no mode guard required. Accept either form.
const SANDBOX_MODE_BANNER_RENDER_RE = /<SandboxModeBanner\s*\/>/;
const SANDBOX_OVERVIEW_ROUTE_RE = /export const sandboxRoutes: Routes = makeRoutes\(["']\/sandbox["']\);/;
// The unified palette derives every command href (including Overview) from
// `basePath`, scoped by `mode`. In the sandbox that is `basePath=/sandbox` +
// `mode="mock-owner"`, which keeps the palette inside the sandbox.
// Sandbox mounts the unified palette scoped to /sandbox (routes.basePath) with
// the legacy folder segments (records/runs/traces) passed explicitly, so the
// shared registry does not default to the clean console segments (§10.B).
const COMMAND_PALETTE_MODE_RE =
  /<CommandPalette\s+basePath=\{routes\.basePath\}\s+mode=["']mock-owner["']\s+segments=\{LEGACY_SEGMENTS\}\s*\/>/;
const SITE_HEADER_RE = /SiteHeader|currentLabel=["']Sandbox["']/;
const FORCE_DYNAMIC_RE = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/;
const REDIRECT_IMPORT_RE = /import\s+\{\s*redirect\s*\}\s+from\s+["']next\/navigation["']/;
const SANDBOX_EXPLORE_REDIRECT_RE =
  /redirect\(\s*(?:sandboxExploreRedirectHref\(|`\/sandbox\/explore|\(["']\/sandbox\/explore)/;
const SANDBOX_EXPLORE_HELPER_RE = /sandboxExploreRedirectHref/;
const EXPLORER_PEEK_PARAM_RE = /explorerPeekParam/;

const PRIMARY_DASHBOARD_PAGES = [
  "page.tsx",
  "overview/page.tsx",
  "explore/page.tsx",
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

const RETIRED_SANDBOX_RECORDS_PAGES = [
  "records/page.tsx",
  "records/[connector]/page.tsx",
  "records/[connector]/[stream]/page.tsx",
  "records/[connector]/[stream]/[recordKey]/page.tsx",
  "records/timeline/page.tsx",
];

/**
 * Routes that used to exist in the pre-split public app. In `apps/site`, these
 * operator route files must stay absent; the shared dashboard components are
 * allowed to remain until `packages/operator-ui` extraction.
 */
const DASHBOARD_DIR = join(SANDBOX_DIR, "..", "dashboard");
const FORMER_OPERATOR_ROUTE_FILES = [
  "page.tsx",
  "explore/page.tsx",
  "records/page.tsx",
  "schedules/page.tsx",
  "search/page.tsx",
  "grants/page.tsx",
  "runs/page.tsx",
  "traces/page.tsx",
  "deployment/page.tsx",
];

const SANDBOX_PARITY_PAGES = [
  "page.tsx",
  "explore/page.tsx",
  "records/page.tsx",
  "schedules/page.tsx",
  "search/page.tsx",
  "grants/page.tsx",
  "runs/page.tsx",
  "traces/page.tsx",
  "deployment/page.tsx",
];

const EDUCATIONAL_PAGES = ["api-examples/page.tsx", "walkthrough/page.tsx"];

/**
 * Every sandbox page that ships in the sandbox tree. Used by the leakage
 * check: no sandbox surface should import `dashboardRoutes`, because doing
 * so would silently send the unauthenticated mock-owner visitor into the
 * live operator surface (broken auth, broken data binding, and the visitor
 * stops being inside the sandbox).
 */
const ALL_SANDBOX_PAGES = [...PRIMARY_DASHBOARD_PAGES, ...RETIRED_SANDBOX_RECORDS_PAGES, ...EDUCATIONAL_PAGES];

const DASHBOARD_ROUTES_IMPORT_RE = /\bdashboardRoutes\b/;
const SHARED_ROUTES_FILE = join(
  SANDBOX_DIR,
  "..",
  "..",
  "..",
  "..",
  "..",
  "packages",
  "operator-ui",
  "src",
  "components",
  "views",
  "routes.ts"
);

test("primary /sandbox dashboard pages render DashboardShell in mock-owner mode", async () => {
  const offenders: string[] = [];
  const overviewContent = await readFile(join(SANDBOX_DIR, "overview-content.tsx"), "utf8");
  assert.match(overviewContent, DASHBOARD_SHELL_IMPORT_RE, "overview-content must import DashboardShell");
  assert.match(overviewContent, MOCK_OWNER_MODE_RE, "overview-content must render DashboardShell in mock-owner mode");

  await Promise.all(
    PRIMARY_DASHBOARD_PAGES.map(async (rel) => {
      const full = join(SANDBOX_DIR, rel);
      const src = await readFile(full, "utf8");
      const delegatesToOverviewContent =
        SANDBOX_OVERVIEW_CONTENT_IMPORT_RE.test(src) && SANDBOX_OVERVIEW_CONTENT_RENDER_RE.test(src);
      if (delegatesToOverviewContent) {
        return;
      }
      if (!DASHBOARD_SHELL_IMPORT_RE.test(src)) {
        offenders.push(`${rel}: missing DashboardShell import`);
        return;
      }
      if (!MOCK_OWNER_MODE_RE.test(src)) {
        offenders.push(`${rel}: DashboardShell rendered without mode="mock-owner"`);
      }
    })
  );
  assert.deepEqual(
    offenders,
    [],
    `primary sandbox dashboard pages must use DashboardShell in mock-owner mode:\n${offenders.join("\n")}`
  );
});

test("primary /sandbox dashboard pages do NOT use the educational sandbox shell", async () => {
  const offenders: string[] = [];
  await Promise.all(
    PRIMARY_DASHBOARD_PAGES.map(async (rel) => {
      const full = join(SANDBOX_DIR, rel);
      const src = await readFile(full, "utf8");
      if (SANDBOX_SHELL_IMPORT_RE.test(src)) {
        offenders.push(rel);
      }
    })
  );
  assert.deepEqual(
    offenders,
    [],
    `primary sandbox dashboard pages must not import the educational shell:\n${offenders.join("\n")}`
  );
});

test("retired sandbox records pages redirect into the single Explore canvas", async () => {
  const offenders: string[] = [];
  await Promise.all(
    RETIRED_SANDBOX_RECORDS_PAGES.map(async (rel) => {
      const full = join(SANDBOX_DIR, rel);
      const src = await readFile(full, "utf8");
      if (!REDIRECT_IMPORT_RE.test(src)) {
        offenders.push(`${rel}: missing redirect import`);
      }
      if (!SANDBOX_EXPLORE_REDIRECT_RE.test(src)) {
        offenders.push(`${rel}: does not redirect to /sandbox/explore`);
      }
      if (DASHBOARD_SHELL_IMPORT_RE.test(src)) {
        offenders.push(`${rel}: must not render DashboardShell after retirement`);
      }
    })
  );
  const helper = await readFile(join(SANDBOX_DIR, "records", "explore-redirect.ts"), "utf8");
  assert.match(helper, SANDBOX_EXPLORE_HELPER_RE, "records redirect helper must be named for grepability");
  assert.match(helper, EXPLORER_PEEK_PARAM_RE, "record-detail redirects must preserve peek identity");
  assert.deepEqual(
    offenders,
    [],
    `retired sandbox records routes must redirect into /sandbox/explore:\n${offenders.join("\n")}`
  );
});

test("educational pages do NOT render DashboardShell (they are docs surfaces)", async () => {
  const offenders: string[] = [];
  await Promise.all(
    EDUCATIONAL_PAGES.map(async (rel) => {
      const full = join(SANDBOX_DIR, rel);
      const src = await readFile(full, "utf8");
      if (DASHBOARD_SHELL_IMPORT_RE.test(src)) {
        offenders.push(rel);
      }
    })
  );
  assert.deepEqual(offenders, [], `educational pages must not render DashboardShell:\n${offenders.join("\n")}`);
});

test("/sandbox layout does not render global site chrome around mock-owner dashboard pages", async () => {
  const src = await readFile(join(SANDBOX_DIR, "layout.tsx"), "utf8");
  assert.equal(
    SITE_HEADER_RE.test(src),
    false,
    "sandbox layout must not render SiteHeader; dashboard-mode pages already render DashboardShell"
  );
});

test("query-driven sandbox pages are dynamic so server pages receive search params", async () => {
  await Promise.all(
    ["explore/page.tsx", "search/page.tsx", "grants/page.tsx", "runs/page.tsx", "traces/page.tsx"].map(async (rel) => {
      const src = await readFile(join(SANDBOX_DIR, rel), "utf8");
      assert.match(src, FORCE_DYNAMIC_RE, `${rel} must be force-dynamic because it reads searchParams`);
    })
  );
});

test("DashboardShell renders the sandbox footer with no live AS/RS probe", async () => {
  const src = await readFile(join(SANDBOX_DIR, "..", "dashboard", "components", "shell.tsx"), "utf8");
  // In the public site there is no live branch; the shell is fixed to the
  // mock-owner sandbox binding and must not probe a configured AS/RS.
  assert.match(src, SANDBOX_FOOTER_NAME_RE, "shell must define a SandboxFooter for mock-owner mode");
  assert.match(src, SANDBOX_FOOTER_RENDER_RE, "shell must render <SandboxFooter />");
  // The sandbox mode banner must also be present: a persistent top-of-content
  // notice that demo data is not production. The footer is sidebar-only and
  // easily missed; the banner sits above every page's content.
  assert.match(src, SANDBOX_MODE_BANNER_COMPONENT_RE, "shell must define a SandboxModeBanner component");
  assert.match(src, SANDBOX_MODE_BANNER_RENDER_RE, "shell must render <SandboxModeBanner /> when mode is mock-owner");
});

test("sandboxRoutes overview is `/sandbox`", async () => {
  const src = await readFile(SHARED_ROUTES_FILE, "utf8");
  assert.match(src, SANDBOX_OVERVIEW_ROUTE_RE);
});

test("operator route files are absent from the public site's shared shell folder", async () => {
  const present: string[] = [];
  await Promise.all(
    FORMER_OPERATOR_ROUTE_FILES.map(async (rel) => {
      try {
        await readFile(join(DASHBOARD_DIR, rel), "utf8");
        present.push(rel);
      } catch {
        // Expected: apps/site retains shared components, not operator route files.
      }
    })
  );
  assert.deepEqual(present, [], `public site must not retain operator route files:\n${present.join("\n")}`);
});

test("/sandbox keeps the core dashboard-shaped routes", async () => {
  const missing: string[] = [];
  await Promise.all(
    SANDBOX_PARITY_PAGES.map(async (rel) => {
      try {
        await readFile(join(SANDBOX_DIR, rel), "utf8");
      } catch {
        missing.push(`/sandbox/${rel}`);
      }
    })
  );
  assert.deepEqual(
    missing,
    [],
    `sandbox route coverage violated — these route files are missing:\n${missing.join("\n")}`
  );
});

test("DashboardShell mounts the unified CommandPalette in mock-owner mode with the sandbox basePath", async () => {
  const src = await readFile(join(SANDBOX_DIR, "..", "dashboard", "components", "shell.tsx"), "utf8");
  assert.match(src, COMMAND_PALETTE_MODE_RE, "command palette must be scoped to /sandbox in mock-owner mode");
});

test("sandbox pages do not import dashboardRoutes (would link out of the sandbox)", async () => {
  const offenders: string[] = [];
  await Promise.all(
    ALL_SANDBOX_PAGES.map(async (rel) => {
      const full = join(SANDBOX_DIR, rel);
      const src = await readFile(full, "utf8");
      if (DASHBOARD_ROUTES_IMPORT_RE.test(src)) {
        offenders.push(rel);
      }
    })
  );
  assert.deepEqual(
    offenders,
    [],
    `sandbox pages must use sandboxRoutes, not dashboardRoutes — these reference dashboardRoutes:\n${offenders.join("\n")}`
  );
});
