import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ASSEMBLER_FILE = `${HERE}explore-data-assembler.ts`;
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
  assert.match(src, /source:\s*['"]\/explore['"]/, "must have /explore source redirect");
  assert.match(src, /destination:\s*['"]\/dashboard\/explore['"]/, "must redirect to /dashboard/explore");
});
