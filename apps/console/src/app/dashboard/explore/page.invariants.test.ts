import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// explore-data-assembler.ts moved to the shared @pdpp/operator-ui package;
// resolve it from the repo root. page.tsx + next.config.mjs stay console-local.
const REPO_ROOT = new URL("../../../../../../", import.meta.url);
const ASSEMBLER_FILE = fileURLToPath(
  new URL("packages/operator-ui/src/explore/explore-data-assembler.ts", REPO_ROOT)
);
const LIVE_PAGE_FILE = `${HERE}page.tsx`;
const NEXT_CONFIG_FILE = fileURLToPath(new URL("../../../../next.config.mjs", import.meta.url));

const LOAD_TIMELINE_RE = /\bloadTimeline\b/;
const CONNECTOR_INSTANCE_ID_RE =
  /connectorInstanceId:\s*summary\.connector_instance_id\s*\?\?\s*summary\.connection_id/;
const CONNECTION_ID_RE = /connectionId:\s*summary\.connection_id/;
const CONNECTION_DISPLAY_RE = /connectionDisplayName:\s*connectorSummaryDisplayName\(summary\)/;
const CONNECTION_DISPLAY_HELPER_RE = /function connectorSummaryDisplayName\(summary: RefConnectorSummary\)/;

const ASSEMBLER_IMPORT_RE = /from\s+["'][^"']*explore-data-assembler(?:\.ts)?["']/;
const INLINE_FEED_LOADER_RE =
  /\bfunction\s+loadEmptyQueryFeed\b|\bfunction\s+loadTimeRangeFeed\b|\bfunction\s+loadSearchFeed\b/;
const EXPLORE_REDIRECT_SOURCE_RE = /source:\s*['"]\/explore['"]/;
const EXPLORE_REDIRECT_DESTINATION_RE = /destination:\s*['"]\/dashboard\/explore['"]/;

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

test("next.config.mjs has a top-level /explore redirect to /dashboard/explore", async () => {
  const src = await readFile(NEXT_CONFIG_FILE, "utf8");
  assert.match(src, EXPLORE_REDIRECT_SOURCE_RE, "must have /explore source redirect");
  assert.match(src, EXPLORE_REDIRECT_DESTINATION_RE, "must redirect to /dashboard/explore");
});
