/**
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
import { formatStreamCollectionFacts, indexCollectionReportByStream } from "./collection-report.ts";
import type { RefCollectionReportEntry } from "./ref-client.ts";

// Regexes hoisted to module scope (lint: useTopLevelRegex), matching the idiom
// in `forward-disposition.test.ts`.
const COLLECTED_42_COPY = /42 collected/;
const CONSIDERED_UNKNOWN_COPY = /considered unknown/i;
const FABRICATED_42_FRACTION = /42 ?\/ ?42/;
const CLAIMS_COMPLETE_COPY = /\bcomplete\b/i;
const HOSTED_SERVICE_COPY = /\bwe['’]?ll\b|\bwe sync\b|\bour service\b|\bnightly\b|sign up/i;
const CONNECTOR_NAME_COPY = /\bgmail\b|\bchatgpt\b|\bslack\b|\bchase\b|\bspotify\b/i;

function entry(overrides: Partial<RefCollectionReportEntry>): RefCollectionReportEntry {
  return {
    stream: "items",
    collected: 0,
    considered: "unknown",
    covered: "unknown",
    checkpoint: "unknown",
    coverage_condition: "unknown",
    forward_disposition: "resumable",
    pending_detail_gaps: 0,
    skipped: null,
    ...overrides,
  };
}

test("indexCollectionReportByStream tolerates absence and indexes by stream name", () => {
  assert.equal(indexCollectionReportByStream(null).size, 0);
  assert.equal(indexCollectionReportByStream(undefined).size, 0);
  assert.equal(indexCollectionReportByStream([]).size, 0);

  const byStream = indexCollectionReportByStream([
    entry({ stream: "items", collected: 3 }),
    entry({ stream: "other_items", collected: 1 }),
  ]);
  assert.equal(byStream.size, 2);
  assert.equal(byStream.get("items")?.collected, 3);
  assert.equal(byStream.get("other_items")?.collected, 1);
});

test("a duplicate stream name keeps the first entry", () => {
  const byStream = indexCollectionReportByStream([
    entry({ stream: "items", collected: 5 }),
    entry({ stream: "items", collected: 9 }),
  ]);
  assert.equal(byStream.size, 1);
  assert.equal(byStream.get("items")?.collected, 5);
});

test("THE HONESTY GATE: collected records with an unknown considered denominator never imply completeness", () => {
  const facts = formatStreamCollectionFacts(
    entry({ stream: "items", collected: 42, considered: "unknown", coverage_condition: "unknown" })
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
    entry({ stream: "items", collected: 7, considered: 10, coverage_condition: "partial" })
  );
  assert.equal(facts.countsLabel, "7 / 10 collected");
  assert.equal(facts.coverage.value, "partial");
});

test("a known covered numerator renders covered / considered without hiding the collected count", () => {
  const facts = formatStreamCollectionFacts(
    entry({
      stream: "items",
      collected: 0,
      considered: 10,
      covered: 10,
      coverage_condition: "complete",
      forward_disposition: "complete",
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
      stream: "items",
      collected: 10,
      considered: 10,
      coverage_condition: "complete",
      forward_disposition: "complete",
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
  const facts = formatStreamCollectionFacts(entry({ stream: "items", collected: 0, considered: "unknown" }));
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
  // A pending gap can only raise concern: a complete coverage chip plus a
  // pending gap is at least warning, never plain success.
  assert.equal(facts.tone, "warning");
});

test("a negative / non-finite pending gap count is clamped to zero (never a negative cue)", () => {
  const negative = formatStreamCollectionFacts(entry({ pending_detail_gaps: -1 }));
  assert.equal(negative.pendingDetailGaps, 0);
  const nan = formatStreamCollectionFacts(entry({ pending_detail_gaps: Number.NaN }));
  assert.equal(nan.pendingDetailGaps, 0);
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
