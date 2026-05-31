import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSEMBLER_FILE = `${HERE}explore-data-assembler.ts`;
const LIVE_PAGE_FILE = `${HERE}page.tsx`;
const SANDBOX_PAGE_FILE = fileURLToPath(new URL("../../sandbox/explore/page.tsx", import.meta.url));
const NEXT_CONFIG_FILE = fileURLToPath(new URL("../../../../next.config.mjs", import.meta.url));
const CHROME_FILE = fileURLToPath(new URL("../../../../../../packages/pdpp-brand/chrome.ts", import.meta.url));

const LOAD_TIMELINE_RE = /\bloadTimeline\b/;
const CONNECTOR_INSTANCE_ID_RE =
  /connectorInstanceId:\s*summary\.connector_instance_id\s*\?\?\s*summary\.connection_id/;
const CONNECTION_ID_RE = /connectionId:\s*summary\.connection_id/;
const CONNECTION_DISPLAY_RE = /connectionDisplayName:\s*connectorSummaryDisplayName\(summary\)/;
const CONNECTION_DISPLAY_HELPER_RE = /function connectorSummaryDisplayName\(summary: RefConnectorSummary\)/;

const ASSEMBLER_IMPORT_RE = /from\s+["'][^"']*explore-data-assembler(?:\.ts)?["']/;
const INLINE_FEED_LOADER_RE =
  /\bfunction\s+loadEmptyQueryFeed\b|\bfunction\s+loadTimeRangeFeed\b|\bfunction\s+loadSearchFeed\b/;
const SANDBOX_SPECIMEN_LABEL_RE = /Sandbox specimen/;
const SANDBOX_ILLUSTRATIVE_READ_URL_RE = /rs\.pdpp\.example/;
const TOP_LEVEL_EXPLORE_REDIRECT_SOURCE_RE = /source:\s*['"]\/explore['"]/;
const TOP_LEVEL_EXPLORE_REDIRECT_DESTINATION_RE = /destination:\s*['"]\/dashboard\/explore['"]/;
const SITE_NAV_DASHBOARD_TEXT_RE = /text:\s*["']Dashboard["']/;
const SITE_NAV_DASHBOARD_LINK_RE = /link:\s*["']\/dashboard["']/;

test("time-range explorer keeps connection identity instead of using connector-scoped timeline rows", async () => {
  const src = await readFile(ASSEMBLER_FILE, "utf8");

  assert.doesNotMatch(src, LOAD_TIMELINE_RE);
  assert.match(src, CONNECTOR_INSTANCE_ID_RE);
  assert.match(src, CONNECTION_ID_RE);
  assert.match(src, CONNECTION_DISPLAY_RE);
  assert.match(src, CONNECTION_DISPLAY_HELPER_RE);
});

test("live explore page delegates to the shared assembler", async () => {
  const src = await readFile(LIVE_PAGE_FILE, "utf8");
  assert.match(src, ASSEMBLER_IMPORT_RE, "live page must import explore-data-assembler");
  assert.doesNotMatch(src, INLINE_FEED_LOADER_RE, "live page must not define inline feed loader functions");
});

test("sandbox explore page delegates to the shared assembler", async () => {
  const src = await readFile(SANDBOX_PAGE_FILE, "utf8");
  assert.match(src, ASSEMBLER_IMPORT_RE, "sandbox page must import explore-data-assembler");
  assert.doesNotMatch(src, INLINE_FEED_LOADER_RE, "sandbox page must not define inline feed loader functions");
});

test("sandbox explore labels seeded data and illustrative read URLs as specimens", async () => {
  const src = await readFile(SANDBOX_PAGE_FILE, "utf8");
  assert.match(src, SANDBOX_SPECIMEN_LABEL_RE, "sandbox Explore must visibly label the seeded specimen");
  assert.match(src, SANDBOX_ILLUSTRATIVE_READ_URL_RE, "sandbox Explore must identify illustrative read URLs");
});

test("next.config.mjs has a top-level /explore redirect to /dashboard/explore", async () => {
  const src = await readFile(NEXT_CONFIG_FILE, "utf8");
  assert.match(src, TOP_LEVEL_EXPLORE_REDIRECT_SOURCE_RE, "must have /explore source redirect");
  assert.match(src, TOP_LEVEL_EXPLORE_REDIRECT_DESTINATION_RE, "must redirect to /dashboard/explore");
});

test("chrome.ts siteNav includes a Dashboard entry pointing at /dashboard", async () => {
  const src = await readFile(CHROME_FILE, "utf8");
  assert.match(src, SITE_NAV_DASHBOARD_TEXT_RE, "siteNav must include Dashboard entry");
  assert.match(src, SITE_NAV_DASHBOARD_LINK_RE, "Dashboard entry must link to /dashboard");
});
