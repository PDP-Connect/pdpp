/**
 * Source-regex guards for the three health surfaces added to the connector
 * detail page (change #14 in the ux-debt register):
 *
 *   1. "What's wrong?" / "What's missing?" expander  (§C of the mocks)
 *   2. 14-day streak strip                           (§B.2 of the mocks)
 *   3. Auto-paused banner in the run timeline        (§D.4 of the mocks)
 *
 * These are structural invariants, not behavioural tests. Behavioural
 * coverage for the pure derivation helpers lives in
 * `connection-evidence.test.ts`.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PAGE_FILE = `${HERE}page.tsx`;

// ─── Top-level regex constants (biome useTopLevelRegex) ───────────────────────

const RE_DERIVE_FAILURE_SUMMARY = /deriveFailureSummary/;
const RE_FAILURE_SUMMARY_CONDITIONAL = /failureSummary\s*\?/;
const RE_FAILURE_EXPANDER_COMPONENT = /<FailureExpander/;
const RE_FAILURE_EXPANDER_TESTID = /data-testid="failure-expander"/;
const RE_FAILURE_EXPANDER_RECONNECT_TESTID = /data-testid="failure-expander-reconnect"/;
const RE_ADD_SOURCE_HREF = /addSourceHrefForConnector\(connectorId\)/;
const RE_FAILURE_EXPANDER_VIEW_RUNS_TESTID = /data-testid="failure-expander-view-runs"/;
const RE_RUNS_CONNECTOR_ID_PARAM = /\/dashboard\/runs\?connector_id=/;
const RE_DERIVE_STREAK_DOTS = /deriveStreakDots/;
const RE_STREAK_DOTS_CONDITIONAL = /streakDots\.length\s*>\s*0/;
const RE_STREAK_STRIP_COMPONENT = /<StreakStrip/;
const RE_STREAK_STRIP_TESTID = /data-testid="streak-strip"/;
const RE_DERIVE_AUTO_PAUSED_BANNER = /deriveAutoPausedBanner/;
const RE_AUTO_PAUSED_BANNER_CONDITIONAL = /autoPausedBanner\s*\?/;
const RE_AUTO_PAUSED_BANNER_ROW_COMPONENT = /<AutoPausedBannerRow/;
const RE_AUTO_PAUSED_BANNER_ROW_TESTID = /data-testid="auto-paused-banner-row"/;
const RE_AUTO_PAUSED_BANNER_TESTID = /data-testid="auto-paused-banner"/;
const RE_RECENT_RUNS_SECTION = /Recent runs/;

// ─── Surface 1: failure expander ─────────────────────────────────────────────

test("page imports deriveFailureSummary from connection-evidence", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_DERIVE_FAILURE_SUMMARY);
});

test("page renders FailureExpander when failureSummary is truthy", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The conditional render must gate on failureSummary
  assert.match(src, RE_FAILURE_SUMMARY_CONDITIONAL);
  assert.match(src, RE_FAILURE_EXPANDER_COMPONENT);
});

test("failure expander has a data-testid for integration targeting", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_FAILURE_EXPANDER_TESTID);
});

test("failure expander reconnect CTA links to add-source flow", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_FAILURE_EXPANDER_RECONNECT_TESTID);
  assert.match(src, RE_ADD_SOURCE_HREF);
});

test("failure expander view-runs CTA links to runs list filtered by connector", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_FAILURE_EXPANDER_VIEW_RUNS_TESTID);
  assert.match(src, RE_RUNS_CONNECTOR_ID_PARAM);
});

// ─── Surface 2: streak strip ──────────────────────────────────────────────────

test("page imports deriveStreakDots from connection-evidence", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_DERIVE_STREAK_DOTS);
});

test("page renders StreakStrip when streakDots is non-empty", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_STREAK_DOTS_CONDITIONAL);
  assert.match(src, RE_STREAK_STRIP_COMPONENT);
});

test("streak strip has a data-testid for integration targeting", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_STREAK_STRIP_TESTID);
});

// ─── Surface 3: auto-paused banner ───────────────────────────────────────────

test("page imports deriveAutoPausedBanner from connection-evidence", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_DERIVE_AUTO_PAUSED_BANNER);
});

test("page renders AutoPausedBannerRow inside the runs DataList when banner is truthy", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_AUTO_PAUSED_BANNER_CONDITIONAL);
  assert.match(src, RE_AUTO_PAUSED_BANNER_ROW_COMPONENT);
});

test("auto-paused banner row has a data-testid for integration targeting", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_AUTO_PAUSED_BANNER_ROW_TESTID);
});

test("auto-paused banner is placed inside the runs DataList, not outside", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  // The banner li must appear after the "Recent runs" section heading.
  // Check positional ordering via indexOf so we don't need another regex.
  const bannerStr = 'data-testid="auto-paused-banner"';
  const runsSectionStr = "Recent runs";
  const bannerIdx = src.indexOf(bannerStr);
  const runsSectionIdx = src.indexOf(runsSectionStr);
  assert.match(src, RE_AUTO_PAUSED_BANNER_TESTID);
  assert.match(src, RE_RECENT_RUNS_SECTION);
  assert.ok(bannerIdx > runsSectionIdx, "auto-paused banner should be inside the Recent runs section");
});
