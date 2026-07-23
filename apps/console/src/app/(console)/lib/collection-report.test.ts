// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * biome-ignore-all lint/performance/useTopLevelRegex: Copy assertions are
 * clearer as local regex literals in tests.
 *
 * Unit tests for the per-stream Collection Report formatter
 * (`define-connector-progress-evidence-contract`, Tranche C, consumed by the
 * connector detail page).
 *
 * These pin the honesty contract the console MUST preserve when it renders the
 * reference's derived `collection_report`:
 *   1. An unknown considered denominator never becomes a fabricated fraction,
 *      and a stream the reference left `unknown` is never shown as `complete`.
 *   2. The per-stream coverage chip and forward disposition reuse the exact
 *      connection-level vocabulary (`formatCoverageAxis` / `formatForward
 *      Disposition`), so a stream entry can never disagree with the headline.
 *   3. Objective facts (collected count, pending detail gaps, skip) ride
 *      through verbatim; a skip or pending gap can only raise the row tone,
 *      never lower it.
 *   4. Absence is tolerated: an empty / missing report yields an empty index,
 *      so a reference predating the field renders nothing per stream.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  collectionReportHasOpenGaps,
  formatStreamCollectionFacts,
  indexCollectionReportByStream,
  runStatusWithCollectionReportGaps,
  streamOwnerActionCueNeeded,
} from "./collection-report.ts";
import type { RefCollectionReportEntry } from "./ref-client.ts";

// Regexes hoisted to module scope (lint: useTopLevelRegex), matching the idiom
// in `forward-disposition.test.ts`.
const COLLECTED_42_COPY = /42 collected/;
const CONSIDERED_UNKNOWN_COPY = /considered unknown/i;
const FABRICATED_42_FRACTION = /42 ?\/ ?42/;
const CLAIMS_COMPLETE_COPY = /\bcomplete\b/i;
const HOSTED_SERVICE_COPY = /\bwe['’]?ll\b|\bwe sync\b|\bour service\b|\bnightly\b|sign up/i;
const CONNECTOR_NAME_COPY = /\bgmail\b|\bchatgpt\b|\bslack\b|\bchase\b|\bspotify\b/i;
const IMPOSSIBLE_COLLECTED_FRACTION = /3 ?\/ ?2/;
const IMPOSSIBLE_COVERED_FRACTION = /6 ?\/ ?4/;
const CLAMPED_COPY = /clamped/i;
const COVERED_EXCEEDED_DENOMINATOR_COPY =
  /accounted for 3 of 4 considered records.*more than the considered denominator/i;
const RAW_COLLECTED_3_COPY = /\b3\b/;
const COLLECTED_5_COPY = /collected 5/;
const STRATEGY_NUMERATOR_COPY = /not the coverage numerator/i;

function entry(overrides: Partial<RefCollectionReportEntry>): RefCollectionReportEntry {
  return {
    checkpoint: "unknown",
    collected: 0,
    considered: "unknown",
    coverage_condition: "unknown",
    covered: "unknown",
    forward_disposition: "resumable",
    pending_detail_gaps: 0,
    skipped: null,
    stream: "items",
    ...overrides,
  };
}

test("indexCollectionReportByStream tolerates absence and indexes by stream name", () => {
  assert.equal(indexCollectionReportByStream(null).size, 0);
  assert.equal(indexCollectionReportByStream(undefined).size, 0);
  assert.equal(indexCollectionReportByStream([]).size, 0);

  const byStream = indexCollectionReportByStream([
    entry({ collected: 3, stream: "items" }),
    entry({ collected: 1, stream: "other_items" }),
  ]);
  assert.equal(byStream.size, 2);
  assert.equal(byStream.get("items")?.collected, 3);
  assert.equal(byStream.get("other_items")?.collected, 1);
});

test("a duplicate stream name keeps the first entry", () => {
  const byStream = indexCollectionReportByStream([
    entry({ collected: 5, stream: "items" }),
    entry({ collected: 9, stream: "items" }),
  ]);
  assert.equal(byStream.size, 1);
  assert.equal(byStream.get("items")?.collected, 5);
});

test("collectionReportHasOpenGaps distinguishes clean completion from unresolved coverage", () => {
  assert.equal(
    collectionReportHasOpenGaps([
      entry({
        collected: 0,
        considered: 1,
        coverage_condition: "complete",
        covered: 1,
        forward_disposition: "owner_refresh_due",
      }),
    ]),
    false
  );
  assert.equal(collectionReportHasOpenGaps([entry({ coverage_condition: "retryable_gap" })]), true);
  assert.equal(collectionReportHasOpenGaps([entry({ coverage_condition: "terminal_gap" })]), true);
  assert.equal(collectionReportHasOpenGaps([entry({ coverage_condition: "unknown" })]), true);
  assert.equal(collectionReportHasOpenGaps([entry({ coverage_condition: "complete", pending_detail_gaps: 1 })]), true);
  assert.equal(
    collectionReportHasOpenGaps([
      entry({ coverage_condition: "complete", skipped: { reason: "qfx_download_failed" } }),
    ]),
    true
  );
});

test("runStatusWithCollectionReportGaps promotes only clean success statuses when the report has gaps", () => {
  const gapReport = [entry({ coverage_condition: "terminal_gap" })];
  assert.equal(runStatusWithCollectionReportGaps("succeeded", gapReport), "succeeded_with_gaps");
  assert.equal(runStatusWithCollectionReportGaps("success", gapReport), "succeeded_with_gaps");
  assert.equal(runStatusWithCollectionReportGaps("completed", gapReport), "succeeded_with_gaps");
  assert.equal(runStatusWithCollectionReportGaps("failed", gapReport), "failed");
  assert.equal(
    runStatusWithCollectionReportGaps("succeeded", [
      entry({ collected: 0, considered: 1, coverage_condition: "complete", covered: 1 }),
    ]),
    "succeeded"
  );
});

test("THE HONESTY GATE: collected records with an unknown considered denominator never imply completeness", () => {
  const facts = formatStreamCollectionFacts(
    entry({ collected: 42, considered: "unknown", coverage_condition: "unknown", stream: "items" })
  );
  // The coverage chip stays unknown, never complete.
  assert.equal(facts.coverage.value, "unknown");
  assert.notEqual(facts.coverage.value, "complete");
  // The counts line shows the raw count and an EXPLICIT unknown denominator —
  // never a "42 / 42" fraction that would read as complete.
  assert.match(facts.countsLabel ?? "", COLLECTED_42_COPY);
  assert.match(facts.countsLabel ?? "", CONSIDERED_UNKNOWN_COPY);
  assert.doesNotMatch(facts.countsLabel ?? "", FABRICATED_42_FRACTION);
  assert.doesNotMatch(facts.countsLabel ?? "", CLAIMS_COMPLETE_COPY);
});

test("a known considered denominator renders collected / considered", () => {
  const facts = formatStreamCollectionFacts(
    entry({ collected: 7, considered: 10, coverage_condition: "partial", stream: "items" })
  );
  assert.equal(facts.countsLabel, "7 / 10 collected");
  assert.equal(facts.coverage.value, "partial");
});

test("strategy-backed complete streams do not render collected / considered as a partial-looking fraction", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      checkpoint: "committed",
      collected: 9,
      considered: 52,
      coverage_condition: "complete",
      coverage_strategy: "checkpoint_window",
      forward_disposition: "complete",
      stream: "pull_requests",
    })
  );
  assert.equal(facts.countsLabel, "checkpoint covered · 9 collected");
  assert.doesNotMatch(facts.countsLabel ?? "", /9 ?\/ ?52/);
  assert.match(facts.countsTitle, /considered 52 records/);
  assert.match(facts.countsTitle, STRATEGY_NUMERATOR_COPY);
  assert.equal(facts.coverage.value, "complete");
});

test("full-inventory complete streams name the inventory proof instead of implying missing records", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      checkpoint: "committed",
      collected: 5,
      considered: 100,
      coverage_condition: "complete",
      coverage_strategy: "full_inventory",
      forward_disposition: "complete",
      stream: "repositories",
    })
  );
  assert.equal(facts.countsLabel, "inventory covered · 5 collected");
  assert.doesNotMatch(facts.countsLabel ?? "", /5 ?\/ ?100/);
  assert.match(facts.countsTitle, /considered 100 records/);
  assert.match(facts.countsTitle, STRATEGY_NUMERATOR_COPY);
});

test("zero-emission singleton proofs still show the proof instead of collection count unavailable", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      checkpoint: "committed",
      collected: 0,
      considered: "unknown",
      coverage_condition: "complete",
      coverage_strategy: "singleton_presence",
      forward_disposition: "complete",
      stream: "user",
    })
  );
  assert.equal(facts.countsLabel, "presence checked");
  assert.match(facts.countsTitle, STRATEGY_NUMERATOR_COPY);
});

test("THE CLAMP: collected > considered never renders an impossible fraction (phase 2 lie fix)", () => {
  // A connector that over-reported (collected 3, considered 2) would otherwise
  // render "3 / 2 collected" — an impossible tuple. The displayed numerator is
  // clamped to the denominator; the raw count is disclosed in the title.
  const facts = formatStreamCollectionFacts(
    entry({ collected: 3, considered: 2, coverage_condition: "complete", stream: "items" })
  );
  assert.equal(facts.countsLabel, "2 / 2 collected");
  assert.doesNotMatch(facts.countsLabel ?? "", IMPOSSIBLE_COLLECTED_FRACTION);
  // The raw count is preserved, never silently dropped.
  assert.match(facts.countsTitle, RAW_COLLECTED_3_COPY);
  assert.match(facts.countsTitle, CLAMPED_COPY);
});

test("THE CLAMP: covered > considered is clamped too, raw covered preserved in the title", () => {
  const facts = formatStreamCollectionFacts(
    entry({ collected: 5, considered: 4, coverage_condition: "complete", covered: 6, stream: "items" })
  );
  assert.equal(facts.countsLabel, "4 / 4 covered · 5 collected");
  assert.doesNotMatch(facts.countsLabel ?? "", IMPOSSIBLE_COVERED_FRACTION);
  assert.match(facts.countsTitle, CLAMPED_COPY);
});

test("THE CLAMP: collected over-report does not imply covered exceeded the denominator", () => {
  const facts = formatStreamCollectionFacts(
    entry({ collected: 5, considered: 4, coverage_condition: "partial", covered: 3, stream: "items" })
  );
  assert.equal(facts.countsLabel, "3 / 4 covered · 5 collected");
  assert.doesNotMatch(facts.countsTitle, COVERED_EXCEEDED_DENOMINATOR_COPY);
  assert.match(facts.countsTitle, COLLECTED_5_COPY);
});

test("a known covered numerator renders covered / considered without hiding the collected count", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      collected: 0,
      considered: 10,
      coverage_condition: "complete",
      covered: 10,
      forward_disposition: "complete",
      stream: "items",
    })
  );
  assert.equal(facts.countsLabel, "10 / 10 covered · 0 collected");
  assert.match(facts.countsTitle, /accounted for 10 of 10/);
  assert.match(facts.countsTitle, /suppressed because they were unchanged/);
  assert.equal(facts.coverage.value, "complete");
});

test("a satisfied known denominator can read complete (the reference's verdict, not ours)", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      collected: 10,
      considered: 10,
      coverage_condition: "complete",
      forward_disposition: "complete",
      stream: "items",
    })
  );
  assert.equal(facts.countsLabel, "10 / 10 collected");
  assert.equal(facts.coverage.value, "complete");
  assert.equal(facts.coverage.tone, "success");
  // We only echo `complete` because the reference derived it from a satisfied
  // denominator — the formatter never upgrades unknown to complete on its own.
  assert.equal(facts.disposition?.value, "complete");
});

test("zero collected with no considered denominator shows no fabricated progress number", () => {
  const facts = formatStreamCollectionFacts(entry({ collected: 0, considered: "unknown", stream: "items" }));
  assert.equal(facts.countsLabel, null);
});

test("the coverage chip and forward disposition reuse the connection-level vocabulary verbatim", () => {
  const facts = formatStreamCollectionFacts(
    entry({ coverage_condition: "terminal_gap", forward_disposition: "terminal" })
  );
  // `terminal_gap` is rendered with the same owner-facing "won't backfill"
  // wording the connection coverage chip uses, and danger tone.
  assert.equal(facts.coverage.value, "won't backfill");
  assert.equal(facts.coverage.tone, "danger");
  assert.equal(facts.disposition?.label, "won't backfill");
  assert.equal(facts.disposition?.tone, "danger");
});

test("a recognized resumable disposition needs no owner action and never claims completeness", () => {
  const facts = formatStreamCollectionFacts(entry({ forward_disposition: "resumable" }));
  assert.equal(facts.disposition?.ownerActionNeeded, false);
  assert.doesNotMatch(facts.disposition?.label ?? "", CLAIMS_COMPLETE_COPY);
});

test("an owner-initiated disposition flags that the owner must act", () => {
  const awaiting = formatStreamCollectionFacts(entry({ forward_disposition: "awaiting_owner" }));
  assert.equal(awaiting.disposition?.ownerActionNeeded, true);
  const refresh = formatStreamCollectionFacts(entry({ forward_disposition: "owner_refresh_due" }));
  assert.equal(refresh.disposition?.ownerActionNeeded, true);
});

test("pending detail gaps ride through and raise the row tone to at least warning", () => {
  const facts = formatStreamCollectionFacts(
    entry({ coverage_condition: "complete", forward_disposition: "complete", pending_detail_gaps: 3 })
  );
  assert.equal(facts.pendingDetailGaps, 3);
  assert.equal(facts.pendingDetailGapsIsFloor, false);
  assert.equal(facts.pendingDetailGapsLabel, "3 pending gaps");
  // A pending gap can only raise concern: a complete coverage chip plus a
  // pending gap is at least warning, never plain success.
  assert.equal(facts.tone, "warning");
});

test("bounded pending detail-gap counts render as floors", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      coverage_condition: "retryable_gap",
      forward_disposition: "resumable",
      pending_detail_gaps: 100,
      pending_detail_gaps_is_floor: true,
    })
  );
  assert.equal(facts.pendingDetailGaps, 100);
  assert.equal(facts.pendingDetailGapsIsFloor, true);
  assert.equal(facts.pendingDetailGapsLabel, "at least 100 pending gaps");
});

test("a negative / non-finite pending gap count is clamped to zero (never a negative cue)", () => {
  const negative = formatStreamCollectionFacts(entry({ pending_detail_gaps: -1 }));
  assert.equal(negative.pendingDetailGaps, 0);
  assert.equal(negative.pendingDetailGapsLabel, null);
  const nan = formatStreamCollectionFacts(entry({ pending_detail_gaps: Number.NaN }));
  assert.equal(nan.pendingDetailGaps, 0);
  assert.equal(nan.pendingDetailGapsLabel, null);
});

test("a skip surfaces a humanized one-line note and never lowers the tone below warning", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      coverage_condition: "retryable_gap",
      skipped: { reason: "rate_limited", recovery_action: "retry_by_runtime" },
    })
  );
  assert.equal(facts.skipLabel, "skipped · rate limited");
  assert.ok(facts.tone === "warning" || facts.tone === "danger");
});

test("no skip yields no skip label", () => {
  const facts = formatStreamCollectionFacts(entry({ skipped: null }));
  assert.equal(facts.skipLabel, null);
});

test("an empty / whitespace skip reason is treated as no skip note", () => {
  const blank = formatStreamCollectionFacts(entry({ skipped: { reason: "   " } }));
  assert.equal(blank.skipLabel, null);
});

test("the counts line never names a connector or promises a hosted sync service", () => {
  for (const disposition of ["complete", "resumable", "awaiting_owner", "owner_refresh_due", "terminal"] as const) {
    const facts = formatStreamCollectionFacts(entry({ collected: 5, considered: 8, forward_disposition: disposition }));
    const text = `${facts.countsLabel ?? ""} ${facts.countsTitle} ${facts.disposition?.label ?? ""} ${facts.disposition?.title ?? ""}`;
    assert.doesNotMatch(text, HOSTED_SERVICE_COPY, `disposition ${disposition} must not promise a hosted service`);
    assert.doesNotMatch(text, CONNECTOR_NAME_COPY, `disposition ${disposition} must stay connector-agnostic`);
  }
});

test("owner action cue renders only when the stream action is owner-satisfiable", () => {
  const refresh = formatStreamCollectionFacts(entry({ forward_disposition: "owner_refresh_due" }));
  assert.equal(streamOwnerActionCueNeeded(refresh.disposition, true), true);
  assert.equal(streamOwnerActionCueNeeded(refresh.disposition, false), false);

  const resumable = formatStreamCollectionFacts(entry({ forward_disposition: "resumable" }));
  assert.equal(streamOwnerActionCueNeeded(resumable.disposition, true), false);
});

test("an accepted-absence coverage axis never degrades a stream's coverage tone", () => {
  // A manifest-declared accepted-absence policy (deferred / inventory_only /
  // unavailable / unsupported) is a settled, non-degrading coverage verdict:
  // the coverage chip itself must stay neutral (never warning/danger) for
  // every accepted-absence axis, regardless of the stream's separate forward
  // disposition. (The row's overall `tone` also folds in the forward
  // disposition and any pending gaps/skips, which can legitimately raise it —
  // e.g. `forward_disposition: "complete"` reads success — so this test pins
  // the coverage axis specifically, which is the signal that must not degrade.)
  for (const axis of ["deferred", "inventory_only", "unavailable", "unsupported"] as const) {
    const facts = formatStreamCollectionFacts(
      entry({ collected: 0, considered: "unknown", coverage_condition: axis, forward_disposition: "unmeasured" })
    );
    assert.equal(facts.coverage.tone, "neutral", `${axis} coverage tone must stay neutral`);
    assert.notEqual(facts.tone, "warning");
    assert.notEqual(facts.tone, "danger");
  }
});

test("the stream-row deferred pill reads optional/not-collected, not policy jargon", () => {
  // formatStreamCollectionFacts reuses formatCoverageAxis verbatim, so the
  // per-stream row must pick up the same visible fix as the connection-level
  // chip — the owner reads this exact value on the source detail page.
  const facts = formatStreamCollectionFacts(
    entry({ collected: 0, considered: "unknown", coverage_condition: "deferred", forward_disposition: "unmeasured" })
  );
  assert.doesNotMatch(facts.coverage.value, /\bdeferre?s?\b/i);
  assert.match(facts.coverage.value, /optional/i);
  assert.match(facts.coverage.value, /not collected/i);
});

test("required missing evidence (unknown coverage) stays distinct from accepted absence", () => {
  // A required stream with no coverage proof and no manifest accepted-absence
  // declaration resolves to `unknown` — this must keep reading as missing
  // evidence, never as a settled accepted-absence policy, so the two states
  // remain distinguishable on the stream row after the copy-only fix.
  const unmeasured = formatStreamCollectionFacts(
    entry({ collected: 0, considered: "unknown", coverage_condition: "unknown", forward_disposition: "unmeasured" })
  );
  assert.equal(unmeasured.coverage.value, "unknown");
  assert.notEqual(
    unmeasured.coverage.title,
    formatStreamCollectionFacts(entry({ coverage_condition: "deferred" })).coverage.title
  );
  assert.notEqual(
    unmeasured.coverage.title,
    formatStreamCollectionFacts(entry({ coverage_condition: "unavailable" })).coverage.title
  );
});

test("active pending work (checking) stays distinct from accepted absence", () => {
  // A stream mid-run reads `checking`, which is a different signal than a
  // settled accepted-absence policy — neither implies the other.
  const checking = formatStreamCollectionFacts(
    entry({ collected: 0, considered: "unknown", coverage_condition: "unknown", forward_disposition: "checking" })
  );
  assert.equal(checking.disposition?.value, "checking");
  for (const axis of ["deferred", "inventory_only", "unavailable", "unsupported"] as const) {
    const accepted = formatStreamCollectionFacts(entry({ coverage_condition: axis, forward_disposition: "complete" }));
    assert.notEqual(checking.disposition?.title, accepted.coverage.title);
  }
});
