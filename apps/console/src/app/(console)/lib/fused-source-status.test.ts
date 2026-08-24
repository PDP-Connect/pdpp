// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The fused status line's contract, with the emphasis on the one rule that
 * matters: the line must never read cheerier than its worst axis.
 *
 * The interesting cases are all AXIS DISAGREEMENTS — syncing-but-blocked,
 * fresh-but-failing, stale-but-syncing — because agreement is trivial and
 * disagreement is where the old last-writer-wins behavior fabricated green.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fuseSourceStatus } from "./fused-source-status.ts";
import type { SourceStatusFlag } from "./source-actionability.ts";

function flag(over: Partial<SourceStatusFlag> = {}): SourceStatusFlag {
  return { dot: "●", freshnessNote: null, kind: "healthy", label: "Working", tone: "success", ...over };
}

// Hoisted to satisfy useTopLevelRegex.
const OPENS_WITH_BLOCKED = /^Blocked/;
const ENDS_WITH_SYNCING_NOW = /Syncing now$/;
const MENTIONS_SYNCING = /Syncing/;
const MENTIONS_REFRESHING_NOW = /Refreshing now/;
const PERIOD_BEFORE_SEPARATOR = /\. ·/;

const SYNCING_COLLAPSE: SourceStatusFlag = {
  dot: "◌",
  freshnessNote: null,
  kind: "pending",
  label: "Syncing",
  tone: "muted",
};

test("a healthy source fuses state, freshness, and activity into one line", () => {
  const fused = fuseSourceStatus(flag({ freshnessNote: "Last refreshed 2 hours ago." }), { syncing: true });

  assert.equal(fused.line, "Working · Last refreshed 2 hours ago · Syncing now");
  assert.equal(fused.state, "Working");
  assert.equal(fused.freshness, "Last refreshed 2 hours ago");
  assert.equal(fused.syncing, true);
});

test("an in-flight run never hides a blocked verdict", () => {
  // The defect this whole module exists to kill. Today's derivation returns the
  // "Syncing" collapse here, erasing "Blocked" — the owner sees a source that
  // looks busy and fine while it is actually failing.
  const fused = fuseSourceStatus(SYNCING_COLLAPSE, {
    syncing: true,
    verdictFallback: flag({
      freshnessNote: "Last refreshed 6 days ago.",
      kind: "blocked",
      label: "Blocked",
      tone: "destructive",
    }),
  });

  assert.equal(fused.state, "Blocked", "the worst honest verdict must own the state slot");
  assert.equal(fused.tone, "destructive", "tone must follow the worst axis, not the activity");
  assert.equal(fused.line, "Blocked · Last refreshed 6 days ago · Syncing now");
  assert.match(fused.line, OPENS_WITH_BLOCKED, "the line must not open with a reassuring word");
});

test("an in-flight run never hides a needs-attention verdict", () => {
  const fused = fuseSourceStatus(SYNCING_COLLAPSE, {
    syncing: true,
    verdictFallback: flag({ kind: "degraded", label: "Needs attention", tone: "warning" }),
  });

  assert.equal(fused.state, "Needs attention");
  assert.equal(fused.tone, "warning");
  assert.equal(fused.line, "Needs attention · Syncing now");
});

test("syncing survives as its own clause rather than replacing the state", () => {
  // Activity is additive: the owner learns BOTH that it is broken and that
  // something is being done about it right now.
  const fused = fuseSourceStatus(SYNCING_COLLAPSE, {
    syncing: true,
    verdictFallback: flag({ kind: "blocked", label: "Blocked", tone: "destructive" }),
  });

  assert.equal(fused.syncing, true);
  assert.match(fused.line, ENDS_WITH_SYNCING_NOW);
  assert.notEqual(fused.state, "Syncing", "'Syncing' describes an action, never a state");
});

test("a healthy verdict does not upgrade a worse rendered state", () => {
  // Guards the comparison direction: the fallback wins only when it is no
  // BETTER than the flag. A stale-but-green verdict must not overwrite a
  // blocked lifecycle state.
  const fused = fuseSourceStatus(flag({ kind: "blocked", label: "Blocked", tone: "destructive" }), {
    verdictFallback: flag({ kind: "healthy", label: "Working", tone: "success" }),
  });

  assert.equal(fused.state, "Blocked");
  assert.equal(fused.tone, "destructive");
});

test("a source that never refreshed says so instead of omitting freshness", () => {
  const fused = fuseSourceStatus(flag({ freshnessNote: null }), { hasEverSucceeded: false });

  assert.equal(fused.freshness, "Never updated");
  assert.equal(fused.line, "Working · Never updated");
});

test("unknown freshness is omitted rather than guessed", () => {
  // A source that HAS succeeded but carries no freshness annotation must not
  // have one invented for it; the slot is simply absent.
  const fused = fuseSourceStatus(flag({ freshnessNote: null }), { hasEverSucceeded: true });

  assert.equal(fused.freshness, null);
  assert.equal(fused.line, "Working");
});

test("the server's own 'Refreshing now' annotation is not doubled up", () => {
  // rendered-verdict.ts already folds activity into the freshness annotation.
  // This module owns the activity slot, so that phrasing must be dropped
  // rather than printed beside our own clause.
  const fused = fuseSourceStatus(flag({ freshnessNote: "Refreshing now." }), { syncing: true });

  assert.equal(fused.freshness, null);
  assert.equal(fused.line, "Working · Syncing now");
  assert.doesNotMatch(fused.line, MENTIONS_REFRESHING_NOW);
});

test("a paused source is never shown as syncing even with a stale run flag", () => {
  const fused = fuseSourceStatus(flag({ kind: "paused", label: "Paused", tone: "muted" }), { syncing: true });

  assert.equal(fused.syncing, false);
  assert.equal(fused.line, "Paused");
});

test("a revoked source is never shown as syncing", () => {
  const fused = fuseSourceStatus(flag({ kind: "revoked", label: "Revoked", tone: "muted" }), { syncing: true });

  assert.equal(fused.syncing, false);
  assert.doesNotMatch(fused.line, MENTIONS_SYNCING);
});

test("freshness punctuation is normalized so the separator reads cleanly", () => {
  const fused = fuseSourceStatus(flag({ freshnessNote: "  Last refreshed 3 days ago.  " }), {});

  assert.equal(fused.freshness, "Last refreshed 3 days ago");
  assert.doesNotMatch(fused.line, PERIOD_BEFORE_SEPARATOR);
});

/** How many times `needle` appears in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("a state label that already carries its freshness note renders it exactly once", () => {
  // Owner-reported 2026-08-23 against live production data: the /sources row for
  // "peregrine Claude Code" read
  //   Can't collect · Freshness has not been measured yet. · Freshness has not been measured yet
  // — the same sentence twice, differing only by the trailing period that
  // `freshnessSlot` strips.
  //
  // The flag here is shaped EXACTLY as `deriveRenderedSourceStatus` builds it:
  // it pre-concatenates the freshness note into `label` for its single-slot
  // consumers. Every other test in this file passes a bare label, which is
  // precisely why the double-render survived. See
  // `sources-view-model.test.ts` ("carries freshness annotations from rendered
  // verdict") for the derivation's own pin on that concatenated contract.
  const note = "Freshness has not been measured yet.";
  const fused = fuseSourceStatus(
    flag({
      freshnessNote: note,
      kind: "blocked",
      label: `Can't collect · ${note}`,
      tone: "destructive",
    }),
    { hasEverSucceeded: true, syncing: false }
  );

  assert.equal(
    occurrences(fused.line, "Freshness has not been measured yet"),
    1,
    `the freshness sentence must appear exactly once, got: ${fused.line}`
  );
  assert.equal(fused.line, "Can't collect · Freshness has not been measured yet");
  assert.equal(fused.state, "Can't collect", "the state slot is the bare pill label");
  assert.equal(fused.freshness, "Freshness has not been measured yet");
});

test("the freshness note is stripped from the state slot even while syncing", () => {
  // The syncing clause must not push the duplicate off the end of the line and
  // hide the regression: assert the COUNT with all three slots populated.
  const note = "Last refreshed 3 days ago.";
  const fused = fuseSourceStatus(
    flag({ freshnessNote: note, kind: "degraded", label: `Needs attention · ${note}`, tone: "warning" }),
    { syncing: true }
  );

  assert.equal(occurrences(fused.line, "Last refreshed 3 days ago"), 1, `got: ${fused.line}`);
  assert.equal(fused.line, "Needs attention · Last refreshed 3 days ago · Syncing now");
});

test("a state label is left alone when it merely ends in words like its note", () => {
  // Only an exact trailing `" · <note>"` is a pre-concatenation. A label that
  // coincidentally overlaps must not be truncated.
  const fused = fuseSourceStatus(flag({ freshnessNote: "Last refreshed 3 days ago.", label: "Working" }), {});

  assert.equal(fused.state, "Working");
  assert.equal(fused.line, "Working · Last refreshed 3 days ago");
});
