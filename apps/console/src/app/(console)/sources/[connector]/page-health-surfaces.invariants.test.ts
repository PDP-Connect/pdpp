// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-regex guards for the connection-detail health surfaces:
 *
 *   1. one server-owned rendered verdict path for health explanation
 *   2. 14-day streak strip
 *   3. Auto-paused banner in the run timeline
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
const RE_FAILURE_EXPANDER_COMPONENT = /<FailureExpander/;
const RE_FAILURE_EXPANDER_TESTID = /data-testid="failure-expander"/;
const RE_CONNECTION_DIAGNOSTICS_COMPONENT = /<ConnectionDiagnostics/;
const RE_CONNECTION_DIAGNOSTICS_VERDICT_PROP = /renderedVerdict=\{connectionRenderedVerdict\}/;
const RE_DERIVE_STREAK_DOTS = /deriveStreakDots/;
const RE_STREAK_DOTS_CONDITIONAL = /streakDots\.length\s*>\s*0/;
const RE_STREAK_STRIP_COMPONENT = /<StreakStrip/;
const RE_STREAK_STRIP_TESTID = /data-testid="streak-strip"/;
const RE_DERIVE_AUTO_PAUSED_BANNER = /deriveAutoPausedBanner/;
const RE_AUTO_PAUSED_BANNER_CONDITIONAL = /autoPausedBanner\s*\?/;
const RE_AUTO_PAUSED_BANNER_ROW_COMPONENT = /<AutoPausedBannerRow/;
const RE_AUTO_PAUSED_BANNER_ROW_TESTID = /data-testid="auto-paused-banner-row"/;
const RE_AUTO_PAUSED_BANNER_TESTID = /data-testid="auto-paused-banner"/;
const RE_RECENT_RUNS_SECTION = /Recent syncs/;
const RE_ACQUISITION_COVERAGE_MAPPING = /acquisitionCoverage: summary\.acquisition_coverage \?\? null/;
const RE_ACQUISITION_COVERAGE_SECTION = /function AcquisitionCoverageSection/;
const RE_ACQUISITION_COVERAGE_TITLE = /title="Acquisition coverage"/;
const RE_ACQUISITION_COVERAGE_RECEIPT_LINK = /\/connect\/status\//;
const RE_ACQUISITION_COVERAGE_OWNER_COPY = /coverage receipts, not generic sync status/;
const RE_ACQUISITION_COVERAGE_SOURCE_NEUTRAL = /\bWhatsApp\b|\bTimeline\b|\bGoogle\b/i;

// ─── Surface 1: rendered-verdict health explanation ──────────────────────────

test("page no longer renders the legacy raw-health failure expander", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.doesNotMatch(src, RE_DERIVE_FAILURE_SUMMARY);
  assert.doesNotMatch(src, RE_FAILURE_EXPANDER_COMPONENT);
  assert.doesNotMatch(src, RE_FAILURE_EXPANDER_TESTID);
});

test("page routes health explanation through ConnectionDiagnostics rendered_verdict", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_CONNECTION_DIAGNOSTICS_COMPONENT);
  assert.match(src, RE_CONNECTION_DIAGNOSTICS_VERDICT_PROP);
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
  const runsSectionStr = "Recent syncs";
  const bannerIdx = src.indexOf(bannerStr);
  const runsSectionIdx = src.indexOf(runsSectionStr);
  assert.match(src, RE_AUTO_PAUSED_BANNER_TESTID);
  assert.match(src, RE_RECENT_RUNS_SECTION);
  assert.ok(bannerIdx > runsSectionIdx, "auto-paused banner should be inside the Recent syncs section");
});

test("connector detail page threads owner-only acquisition coverage into a source-neutral receipt section", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  const sectionStart = src.indexOf("function AcquisitionCoverageSection");
  const sectionEnd = src.indexOf("/**\n * Recent syncs", sectionStart);
  const sectionSrc = src.slice(sectionStart, sectionEnd);
  assert.match(src, RE_ACQUISITION_COVERAGE_MAPPING);
  assert.match(src, RE_ACQUISITION_COVERAGE_SECTION);
  assert.match(src, RE_ACQUISITION_COVERAGE_TITLE);
  assert.match(src, RE_ACQUISITION_COVERAGE_RECEIPT_LINK);
  assert.match(src, RE_ACQUISITION_COVERAGE_OWNER_COPY);
  assert.doesNotMatch(sectionSrc, RE_ACQUISITION_COVERAGE_SOURCE_NEUTRAL);
});
