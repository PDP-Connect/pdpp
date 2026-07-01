import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;
const OVERVIEW_FILE = `${HERE}components/views/standing-overview.tsx`;
const MODEL_FILE = `${HERE}components/views/standing-view-model.ts`;
const TEST_FILE = `${HERE}components/views/standing-view-model.test.ts`;

const STANDING_OVERVIEW_RENDER = /<StandingOverview\b/;
const SHARED_SOURCE_WORK_INPUT = /sourceWork: sourceWorkFromConnectors\(connectors\)/;
const SHARED_SOURCE_WORK_PRECEDENCE =
  /function activeSourceWork[\s\S]*if \(sourceWorkHasRows\(input\.sourceWork\)\)[\s\S]*return input\.sourceWork/;
const SHARED_SOURCE_WORK_HERO_PRECEDENCE =
  /const sourceWork = activeSourceWork\(input\)[\s\S]*sourceWork\.needsOwner\.length > 0[\s\S]*buildFailureHero[\s\S]*projectionState === "stale" \|\| projectionState === "failed"[\s\S]*sourceWork\.review\.length > 0[\s\S]*buildAdvisoryHero/;
const SOURCE_WORK_SECTIONS_RENDERED =
  /data-row-count=\{rowCount\}[\s\S]*sections\.map\(\(section\)[\s\S]*section\.rows\.map\(\(a\)/;
const PROJECTION_COPY_TESTS = /hero uses owner-safe copy for failed projection details/;
const FORBIDDEN_COPY_INVARIANTS = /projection\|rebuild\|bulk write\|unknown connection\|SQL/i;

test("dashboard home renders the active Standing Overview path", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, STANDING_OVERVIEW_RENDER);
  assert.match(src, SHARED_SOURCE_WORK_INPUT);
});

test("Standing Overview prefers shared source work before legacy advisory buckets", async () => {
  const src = await readFile(MODEL_FILE, "utf8");

  assert.match(src, SHARED_SOURCE_WORK_PRECEDENCE);
  assert.match(src, SHARED_SOURCE_WORK_HERO_PRECEDENCE);
});

test("Standing Overview renders sectioned shared source-work rows", async () => {
  const src = await readFile(OVERVIEW_FILE, "utf8");

  assert.match(src, SOURCE_WORK_SECTIONS_RENDERED);
});

test("Standing Overview tests pin owner-safe projection copy invariants", async () => {
  const src = await readFile(TEST_FILE, "utf8");

  assert.match(src, PROJECTION_COPY_TESTS);
  assert.match(src, FORBIDDEN_COPY_INVARIANTS);
});
