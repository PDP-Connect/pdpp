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
const RE_STORED_CREDENTIAL_ACTION_USES_EXPLICIT_COPY = /case "stored_credential"[\s\S]*label: "Update credential"/;
const RE_BROWSER_SESSION_ACTION_USES_SERVER_CTA = /case "browser_session"[\s\S]*label: action\.cta/;
const RE_CONFIRMATION_IMPORT = /import \{ ConnectionConfirmation \} from "\.\/connection-confirmation\.tsx"/;
const RE_CONFIRMATION_RENDER = /<ConnectionConfirmation[\s\S]*pendingHorizons=\{coverageHorizons\}/;
const RE_CONFIRMATION_STRUCTURED_ACK =
  /acknowledgedLoss=\{connectionRenderedVerdict\?\.detail\.acknowledged_loss \?\? null\}/;
const RE_CONFIRMATION_GAP_WIRING = /latestKnownGaps=\{latestKnownGaps\}/;
const RE_NO_RENDERED_FORWARD_STATEMENT = /renderedForwardStatement=/;

// Owner-found 2026-08-28: the "Complete the requested action" chip was dead —
// `provider_interaction` fell through to `default` and pointed at the
// add-source page, while the only surface that can satisfy the prompt is the
// waiting run's dock at /syncs/<runId>/stream. The run's assistance window
// expires, so a chip that leads elsewhere costs the interaction outright (the
// same night, a Venmo run died `assistance_timed_out`).
//
// `page.tsx` imports `server-only`, so it cannot be imported by a test; these
// are source assertions by necessity, not by preference. They pin the
// DESTINATION and the encode, not merely that a case exists.
const RE_PROVIDER_INTERACTION_CASE = /case "provider_interaction":/;
const RE_PROVIDER_INTERACTION_TARGETS_RUN_STREAM =
  /`\/syncs\/\$\{encodeURIComponent\(action\.target\.run_id\)\}\/stream`/;
const RE_PROVIDER_INTERACTION_REQUIRES_SYNC_TARGET = /action\.target\?\.kind === "sync" && action\.target\.run_id/;

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

test("connector detail page labels each reauthentication surface precisely", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_STORED_CREDENTIAL_ACTION_USES_EXPLICIT_COPY);
  assert.match(src, RE_BROWSER_SESSION_ACTION_USES_SERVER_CTA);
});

test("owner confirmation is reachable from the connection detail page through structured backend evidence", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(src, RE_CONFIRMATION_IMPORT);
  assert.match(src, RE_CONFIRMATION_RENDER);
  assert.match(src, RE_CONFIRMATION_STRUCTURED_ACK);
  assert.match(src, RE_CONFIRMATION_GAP_WIRING);
  assert.doesNotMatch(
    src,
    RE_NO_RENDERED_FORWARD_STATEMENT,
    "confirmation eligibility must not depend on rendered prose"
  );
});

// The defect this pins: `exactSyncTargetFromAttention` reads `run_id` off the
// attention record with NO liveness check, and an `expired` record keeps its
// `run_id` forever. So an `add_info` chip with a validated sync target still
// linked to a concluded run — the owner clicked "Complete the requested action"
// and nothing happened, because the run that owned the interaction had ended
// and taken the interaction with it (production: ChatGPT chaka.dondo@gmail.com,
// three consecutive `expired` records each still carrying a run id).
//
// A validated target is necessary but NOT sufficient. `running` must gate it.
const RE_ADD_INFO_GUARDS_ON_RUNNING = /if \(!running\) \{/;

test("an add_info sync target is only clickable while a run is actually waiting", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    RE_ADD_INFO_GUARDS_ON_RUNNING,
    "a validated sync target is not enough — an expired attention record keeps its run_id, so the chip must also require a live run before linking to /syncs/<runId>"
  );
});

test("a provider interaction routes to the waiting run's stream dock", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    RE_PROVIDER_INTERACTION_CASE,
    "provider_interaction must not fall through to the add-source default"
  );
  assert.match(
    src,
    RE_PROVIDER_INTERACTION_TARGETS_RUN_STREAM,
    "the chip must open /syncs/<runId>/stream — the interaction dock lives on the run, and its assistance window expires"
  );
});

test("the run-stream destination is guarded and encoded", async () => {
  const src = await readFile(PAGE_FILE, "utf8");
  assert.match(
    src,
    RE_PROVIDER_INTERACTION_REQUIRES_SYNC_TARGET,
    "without a sync target there is no dock to open, so it must fall back rather than build a broken /syncs//stream"
  );
});
