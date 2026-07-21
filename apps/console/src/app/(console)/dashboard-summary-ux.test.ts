// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
  /const sourceWork = activeSourceWork\(input\)[\s\S]*sourceAttentionHeadline\(sourceWork\)\.needsYou > 0[\s\S]*buildFailureHero[\s\S]*projectionState === "stale" \|\| projectionState === "failed"[\s\S]*sourceWork\.review\.length > 0[\s\S]*buildAdvisoryHero/;
const SOURCE_WORK_SECTIONS_RENDERED =
  /data-row-count=\{rowCount\}[\s\S]*sections\.map\(\(section\)[\s\S]*section\.rows\.map\(\(a\)/;
const NOTIFICATIONS_BLOCK_RENDERED =
  /function NotificationsBlock\([\s\S]*<h2 className="rr-stand-block__title">Notifications<\/h2>[\s\S]*href=\{href\}/;
const OVERVIEW_PASSES_NOTIFICATIONS_HREF = /notificationsHref=\{HREFS\.notifications\}/;
const PROJECTION_COPY_TESTS = /hero uses owner-safe copy for failed projection details/;
const FORBIDDEN_COPY_INVARIANTS = /projection\|rebuild\|bulk write\|unknown connection\|SQL/i;
// The "What's been read" block is a GROUPED preview linking to the grouped
// Traces audit log (raw per-event detail is one drill further). The CTA must
// not claim "every read" — that overstates the preview as an exhaustive log.
// Match the rendered anchor text (leading `>` before the label) so an
// explanatory comment mentioning the retired copy doesn't trip the guard.
const READS_HONEST_CTA = />\s*audit log →/;
const READS_OVERCLAIMED_CTA = />\s*every read →/;

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

test("Standing Overview links to notification setup as a first-class utility", async () => {
  const page = await readFile(PAGE_FILE, "utf8");
  const overview = await readFile(OVERVIEW_FILE, "utf8");

  assert.match(page, OVERVIEW_PASSES_NOTIFICATIONS_HREF);
  assert.match(overview, NOTIFICATIONS_BLOCK_RENDERED);
});

test("Standing Overview tests pin owner-safe projection copy invariants", async () => {
  const src = await readFile(TEST_FILE, "utf8");

  assert.match(src, PROJECTION_COPY_TESTS);
  assert.match(src, FORBIDDEN_COPY_INVARIANTS);
});

test('"What\'s been read" CTA names the audit log and does not overclaim "every read"', async () => {
  const src = await readFile(OVERVIEW_FILE, "utf8");

  // The overview shows a grouped preview; the link lands on the grouped Traces
  // audit log (raw per-event detail is a further drill). The CTA must match
  // that reality, not imply the preview is the exhaustive log.
  assert.match(src, READS_HONEST_CTA);
  assert.doesNotMatch(src, READS_OVERCLAIMED_CTA);
});
