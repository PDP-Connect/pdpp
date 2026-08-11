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
const SHARED_SOURCE_WORK_AUTHORITY = /function activeSourceWork[\s\S]*return input\.sourceWork/;
// The fleet verdict owns the hero, and now outranks the stale/partial-read
// states as well: totals catching up is a self-resolving delay with no owner
// action, while a source that stopped collecting is work only the owner can
// clear. Ordering those the other way spent the single hero slot on the
// transient state. This pins fleet health AHEAD of both projection staleness
// and overviewLoadIssues.
const SERVER_FLEET_VERDICT_HERO_PRECEDENCE =
  /function computeHero\(input: StandingInputs\)[\s\S]*const fleetHealthHero = input\.fleetHealth \? buildFleetHealthHero\(input\.fleetHealth, input\.hrefs\) : null;[\s\S]*if \(fleetHealthHero\)[\s\S]*return fleetHealthHero[\s\S]*projectionState === "stale"[\s\S]*overviewLoadIssues\.length > 0/;
// Overview renders the section summary and the shared row copy. The row is
// the owner-facing trust correction: it carries the exact source label and
// sanctioned next action already classified by the shared model.
const SOURCE_WORK_SECTIONS_RENDERED =
  /data-row-count=\{rowCount\}[\s\S]*sections\.map\(\(section\)[\s\S]*rr-attn__section-count/;
const SOURCE_WORK_ROWS_RENDERED = /section\.rows\.map\(\(row\)[\s\S]*rr-attn__row[\s\S]*row\.what[\s\S]*row\.why/;
const SOURCE_WORK_SYNCS_LINK_RE = /href=\{syncsHref\}/;
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

test("Standing Overview uses source work for detail while the server fleet verdict owns the aggregate hero", async () => {
  const src = await readFile(MODEL_FILE, "utf8");

  assert.match(src, SHARED_SOURCE_WORK_AUTHORITY);
  assert.match(src, SERVER_FLEET_VERDICT_HERO_PRECEDENCE);
});

test("Standing Overview renders sectioned shared source-work rows and links to Syncs for deeper recovery", async () => {
  const src = await readFile(OVERVIEW_FILE, "utf8");

  assert.match(src, SOURCE_WORK_SECTIONS_RENDERED);
  assert.match(src, SOURCE_WORK_ROWS_RENDERED, "Overview must render the shared source label and next-step row");
  assert.match(src, SOURCE_WORK_SYNCS_LINK_RE, "Overview must link into Syncs for the full attention list");
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

// ---- terminal gate REVISE (2026-08-11), finding 1: Overview pagination ----

const LOAD_OVERVIEW_CONNECTORS_USES_BOUNDED_PAGE =
  /async function loadOverviewConnectors\(\s*state:[\s\S]*loadConnectorSummaryPage\(state,/;
const OVERVIEW_RENDERS_PAGER = /<ConnectorSummaryPager[\s\S]*basePath="\/"[\s\S]*hasMore=\{page\.hasMore\}/;
const NO_LIST_ALL_CONNECTOR_SUMMARIES_IN_PAGE = /\blistAllConnectorSummaries\b/;
const OVERVIEW_SOURCE_PAGE_ERROR = /function DashboardSourcePageControls[\s\S]*page\.kind === "error"/;
const OVERVIEW_RENDERS_SOURCE_PAGE_ERROR = /<ConnectorSummaryPageError/;

test("Overview's connector load is ONE bounded page with an honest continuation pager", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, LOAD_OVERVIEW_CONNECTORS_USES_BOUNDED_PAGE);
  assert.match(src, OVERVIEW_RENDERS_PAGER);
  assert.doesNotMatch(
    src,
    NO_LIST_ALL_CONNECTOR_SUMMARIES_IN_PAGE,
    "the exhaustive fold must never return to the Overview render path"
  );
});

test("Overview exposes an error state when its bounded source page cannot be loaded", async () => {
  const src = await readFile(PAGE_FILE, "utf8");

  assert.match(src, OVERVIEW_SOURCE_PAGE_ERROR);
  assert.match(src, OVERVIEW_RENDERS_SOURCE_PAGE_ERROR);
});
