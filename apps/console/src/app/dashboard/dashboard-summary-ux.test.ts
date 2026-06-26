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
const ADVISORY_INPUT_DERIVATION = /advisoryOwnerActionsFromConnectors\(connectorsRes\.value\.data\)/;
const ADVISORY_BUCKET = /advisoryOwnerActions: AdvisoryOwnerActionConnection\[\]/;
const ADVISORY_HERO_PRECEDENCE =
  /projectionState === "stale" \|\| projectionState === "failed"[\s\S]*input\.advisoryOwnerActions\.length > 0[\s\S]*buildAdvisoryHero/;
const ADVISORY_ROWS_RENDERED =
  /const rows = \[\.\.\.attention, \.\.\.advisoryOwnerActions, \.\.\.sourceIssues, \.\.\.overviewIssues\]/;
const PROJECTION_COPY_TESTS = /hero uses owner-safe copy for failed projection details/;
const FORBIDDEN_COPY_INVARIANTS = /projection\|rebuild\|bulk write\|unknown connection\|SQL/i;

test("dashboard home renders the active Standing Overview path", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, STANDING_OVERVIEW_RENDER);
  assert.match(src, ADVISORY_INPUT_DERIVATION);
});

test("Standing Overview has an advisory owner-action bucket before calm hero copy", async () => {
  const src = await readFile(MODEL_FILE, "utf8");

  assert.match(src, ADVISORY_BUCKET);
  assert.match(src, ADVISORY_HERO_PRECEDENCE);
});

test("Standing Overview renders advisory owner actions as review rows", async () => {
  const src = await readFile(OVERVIEW_FILE, "utf8");

  assert.match(src, ADVISORY_ROWS_RENDERED);
});

test("Standing Overview tests pin owner-safe projection copy invariants", async () => {
  const src = await readFile(TEST_FILE, "utf8");

  assert.match(src, PROJECTION_COPY_TESTS);
  assert.match(src, FORBIDDEN_COPY_INVARIANTS);
});
