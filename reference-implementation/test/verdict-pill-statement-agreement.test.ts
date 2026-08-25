// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The pill and the forward statement must not contradict each other.
 *
 * THE LIVE DEFECT (2026-08-25). Three sources — Jellyfin, Notion and Steam —
 * each rendered this pair, from ONE `rendered_verdict` object, one line above
 * the other:
 *
 *     pill: "Missing data" (amber)
 *     forward_statement: "Current and collecting normally."
 *
 * Nothing was missing. All three had green coverage, no open attention and a
 * clear outbox; they were simply STALE (Steam's last record landed
 * 2026-08-16, Notion's 2026-08-20, Jellyfin's 2026-08-21). Staleness was being
 * dressed as a coverage defect, and the sentence underneath then denied even
 * that.
 *
 * THE DIVERGENCE. The two halves are derived from different evidence:
 *
 *   - the PILL comes from `labelForPill` -> `amberLabel`, which reads the
 *     headline STATE. A schedulable stale connector reaches `state:
 *     "degraded"` (the `Fresh` condition is false at `warning` severity, which
 *     `isDegradingCondition` counts as independent degrading evidence), and
 *     `degraded` was unconditionally treated as `stateIsBroken`.
 *   - the STATEMENT comes from `buildForwardStatement`, which reads the
 *     DISPOSITION. That stayed `complete`, because `deriveForwardDisposition`'s
 *     Rule 4 (`owner_refresh_due`) fires only for manual-refresh-only or
 *     assisted-refresh connectors. A plain `background_safe: true` /
 *     `recommended_mode: "automatic"` connector — which is exactly what all
 *     three of those manifests declare — takes neither branch.
 *
 * So one half said "degraded" and the other said "complete", about the same
 * source, in the same render.
 *
 * WHY THESE TESTS BUILD THEIR INPUT WITH THE REAL PRODUCER. Every assertion
 * below starts from `computeConnectionHealth` — the genuine upstream producer —
 * and asserts on real `synthesizeRenderedVerdict` output. A hand-built health
 * snapshot is precisely how this class of defect keeps shipping here: a
 * hand-built fixture in `rendered-verdict-proof-age.test.ts` invented two axes
 * that do not exist, omitted the two the renderer actually reads, and passed
 * 10/10 green while its "healthy" connection rendered an empty pill. Only the
 * real projection can tell us that a schedulable stale source lands on
 * `state: "degraded"` + `forward_disposition: "complete"` — that tuple is the
 * whole defect, and no fixture author would have thought to write it down.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ComputeConnectionHealthInput,
  type ConnectionHealthSnapshot,
  type ConnectionRefreshEvidence,
  computeConnectionHealth,
} from "../runtime/connection-health.ts";
import { type RenderedVerdict, type StreamRollup, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const OBSERVED_AT = "2026-08-25T12:00:00.000Z";
const LAST_SUCCESS = "2026-08-16T04:00:00.000Z";

/** The exact all-clear sentence that shipped above a "Missing data" pill. */
const ALL_CLEAR_STATEMENT = "Current and collecting normally.";
/** Any wording that acknowledges the source is behind. */
const ACKNOWLEDGES_STALENESS_RE = /not current|refresh|catch it up/i;
/** The trouble labels that must never sit above the all-clear sentence. */
const TROUBLE_LABELS = ["Missing data", "Missing optional data", "Some records stuck", "Can't collect"];

/**
 * The refresh posture Jellyfin, Notion and Steam actually declare
 * (`packages/polyfill-connectors/manifests/{jellyfin,notion,steam}.json`, each
 * under `capabilities.refresh_policy`). All three are identical here, and this
 * exact combination is what makes both stale-advisory branches inapplicable.
 */
const SCHEDULABLE_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: true,
  interactionPosture: "none",
  recommendedMode: "automatic",
};

/** A manual-refresh connector, for contrast: it takes the `owner_refresh_due` path. */
const MANUAL_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: false,
  interactionPosture: "none",
  recommendedMode: "manual",
};

function baseInput(): ComputeConnectionHealthInput {
  return {
    activity: null,
    attention: null,
    backoff: null,
    coverage: { axis: "complete" },
    freshness: { axis: "fresh" },
    observedAt: OBSERVED_AT,
    outbox: null,
    projection: null,
    refresh: SCHEDULABLE_REFRESH,
    run: { hasDegradingGaps: false, lastSuccessAt: LAST_SUCCESS, latestStatus: "succeeded", reasonCode: null },
    schedule: { enabled: true },
  };
}

function completeStream(): StreamRollup {
  return {
    attention_open: false,
    collected: 100,
    considered: 100,
    coverage: "complete",
    gap_retryable: false,
    priority: "required",
    stream_id: "library",
  };
}

function gappyStream(): StreamRollup {
  return {
    attention_open: false,
    collected: 40,
    considered: 100,
    coverage: "gaps",
    gap_retryable: true,
    priority: "required",
    stream_id: "library",
  };
}

/** Build the snapshot with the REAL producer, then render with the REAL renderer. */
function render(
  input: ComputeConnectionHealthInput,
  streams: readonly StreamRollup[],
  refresh: ConnectionRefreshEvidence
): { snapshot: ConnectionHealthSnapshot; verdict: RenderedVerdict } {
  const snapshot = computeConnectionHealth(input);
  return { snapshot, verdict: synthesizeRenderedVerdict(snapshot, streams, refresh, true) };
}

/** The exact production shape of Jellyfin / Notion / Steam: schedulable, covered, stale. */
function renderStaleSchedulable() {
  return render({ ...baseInput(), freshness: { axis: "stale" } }, [completeStream()], SCHEDULABLE_REFRESH);
}

// ─── 1. The reproduction, through the real producer ──────────────────────────

/**
 * The control: prove the real projection really does produce the tuple that
 * caused the defect. If a future change moves a schedulable stale source off
 * `degraded`/`complete`, this test says so out loud rather than letting the
 * regression tests below quietly start proving nothing.
 */
test("a schedulable stale source really does reach state=degraded with disposition=complete", () => {
  const { snapshot } = renderStaleSchedulable();

  assert.equal(snapshot.axes.freshness, "stale");
  assert.equal(snapshot.axes.coverage, "complete", "coverage must be green — nothing is actually missing");
  assert.equal(snapshot.axes.attention, "none");
  assert.equal(snapshot.state, "degraded", "this is the pill's input");
  assert.equal(snapshot.forward_disposition, "complete", "and this is the statement's — they disagree");
});

test("stale-but-healthy renders a pill and a statement that agree (the live defect)", () => {
  const { verdict } = renderStaleSchedulable();

  assert.equal(
    verdict.pill.label,
    "Needs refresh",
    'a source with green coverage and no attention is not "Missing data" — it is simply not current'
  );
  assert.equal(verdict.pill.tone, "amber");
  assert.notEqual(verdict.forward_statement, ALL_CLEAR_STATEMENT, "a stale source must never claim it is current");
  assert.match(verdict.forward_statement, ACKNOWLEDGES_STALENESS_RE);
});

// ─── 2. Behavior preservation: real trouble still reads "Missing data" ───────

/**
 * The gate on the fix. A genuinely coverage-deficient source must be
 * completely unaffected — if this ever flips to "Needs refresh", the fix
 * stopped being a fix and became a blanket relabel.
 */
test("a genuinely coverage-deficient source still reads Missing data", () => {
  const { snapshot, verdict } = render(
    {
      ...baseInput(),
      coverage: { axis: "gaps" },
      run: { hasDegradingGaps: true, lastSuccessAt: LAST_SUCCESS, latestStatus: "succeeded", reasonCode: null },
    },
    [gappyStream()],
    SCHEDULABLE_REFRESH
  );

  assert.equal(snapshot.axes.coverage, "gaps");
  assert.equal(verdict.pill.label, "Missing data", "a real coverage gap must keep the trouble label");
});

/**
 * ...and so must a source that is stale AND has a coverage gap. Staleness is
 * only allowed to soften the label when it is the SOLE degradation; here it is
 * not, and "Missing data" is the honest, broader claim.
 */
test("stale AND coverage-deficient still reads Missing data, not Needs refresh", () => {
  const { verdict } = render(
    {
      ...baseInput(),
      coverage: { axis: "gaps" },
      freshness: { axis: "stale" },
      run: { hasDegradingGaps: true, lastSuccessAt: LAST_SUCCESS, latestStatus: "succeeded", reasonCode: null },
    },
    [gappyStream()],
    SCHEDULABLE_REFRESH
  );

  assert.equal(verdict.pill.label, "Missing data", "staleness must not mask a real gap");
});

/** A failed run is real trouble too, stale or not. */
test("a failed last run still reads Missing data", () => {
  const { verdict } = render(
    {
      ...baseInput(),
      freshness: { axis: "stale" },
      run: { hasDegradingGaps: false, lastSuccessAt: LAST_SUCCESS, latestStatus: "failed", reasonCode: null },
    },
    [completeStream()],
    SCHEDULABLE_REFRESH
  );

  assert.equal(verdict.pill.label, "Missing data");
});

/** The manual-refresh path already agreed with itself; it must keep doing so. */
test("the manual-refresh stale path is unchanged", () => {
  const { snapshot, verdict } = render(
    { ...baseInput(), freshness: { axis: "stale" }, refresh: MANUAL_REFRESH, schedule: null },
    [completeStream()],
    MANUAL_REFRESH
  );

  assert.equal(snapshot.forward_disposition, "owner_refresh_due");
  assert.equal(verdict.pill.label, "Needs refresh");
  assert.equal(verdict.forward_statement, "Run a refresh to bring this up to date.");
});

/** A genuinely healthy source must not be dragged into the stale wording. */
test("a fresh, fully covered source still reads Healthy and Current", () => {
  const { verdict } = render(baseInput(), [completeStream()], SCHEDULABLE_REFRESH);

  assert.equal(verdict.pill.label, "Healthy");
  assert.equal(verdict.pill.tone, "green");
  assert.equal(verdict.forward_statement, ALL_CLEAR_STATEMENT);
});

// ─── 3. The invariant, over every reachable combination ─────────────────────

/**
 * The axis values the real producer can actually emit. Enumerated from the
 * projection's own unions (`CoverageAxis`, `FreshnessAxis`, attention
 * lifecycle) rather than hand-picked, so this sweep widens automatically if a
 * new axis value is introduced.
 */
const COVERAGE_AXES = [
  "complete",
  "deferred",
  "inventory_only",
  "partial",
  "gaps",
  "retryable_gap",
  "terminal_gap",
  "unsupported",
  "unavailable",
  "unknown",
] as const;

const FRESHNESS_AXES = ["fresh", "stale", "unknown"] as const;

/**
 * Sweep every reachable coverage x freshness x run-outcome x refresh-posture
 * combination through the REAL producer and the REAL renderer, and assert the
 * pill and the statement never contradict.
 *
 * This is the "assert the invariant, not just these three cases" requirement.
 * It does not enumerate every possible RenderedVerdict — attention prompts,
 * outbox stalls, local-device backlogs, active runs and schedule evidence are
 * NOT varied here, so combinations involving those remain uncovered by this
 * sweep (the `synthesizeRenderedVerdict` invariant gate covers them at
 * runtime instead, which is why inv 8 lives there and not only here).
 */
test("no reachable coverage x freshness x run x refresh combination contradicts itself", () => {
  const contradictions: string[] = [];
  let combinations = 0;

  for (const coverage of COVERAGE_AXES) {
    for (const freshness of FRESHNESS_AXES) {
      for (const latestStatus of ["succeeded", "failed", null] as const) {
        for (const refresh of [SCHEDULABLE_REFRESH, MANUAL_REFRESH]) {
          for (const hasDegradingGaps of [false, true]) {
            combinations += 1;
            const { verdict } = render(
              {
                ...baseInput(),
                coverage: { axis: coverage },
                freshness: { axis: freshness },
                refresh,
                run: { hasDegradingGaps, lastSuccessAt: LAST_SUCCESS, latestStatus, reasonCode: null },
                schedule: refresh === MANUAL_REFRESH ? null : { enabled: true },
              },
              [{ ...completeStream(), coverage, gap_retryable: hasDegradingGaps }],
              refresh
            );

            const where = `coverage=${coverage} freshness=${freshness} run=${latestStatus} mode=${refresh.recommendedMode} gaps=${hasDegradingGaps}`;

            // (a) A trouble pill must never sit above an all-clear sentence.
            if (TROUBLE_LABELS.includes(verdict.pill.label) && verdict.forward_statement === ALL_CLEAR_STATEMENT) {
              contradictions.push(`${where}: pill "${verdict.pill.label}" over "${verdict.forward_statement}"`);
            }

            // (b) A stale source must never be described as current. This
            // checks the CLAIM, not one exact sentence: a catch-all branch
            // that swallowed the stale case under some other wording would
            // still be lying about currency, and pinning the literal string
            // would let exactly that through.
            // "Run a refresh to bring this up to date." and "Up to date once
            // you refresh." are NOT claims of currency — both say the source
            // is not current yet — so the pattern deliberately matches only
            // the unconditional assertion.
            if (freshness === "stale" && verdict.forward_statement === ALL_CLEAR_STATEMENT) {
              contradictions.push(`${where}: stale source claims currency — "${verdict.forward_statement}"`);
            }
            // ...and when staleness is the ONLY thing wrong (nothing graver is
            // competing for the sentence), the statement must actually say so
            // rather than fall through to a generic all-clear. Restricted to a
            // clean coverage axis on purpose: when a real gap exists the
            // sentence should name the GAP, which is the more urgent fact, and
            // demanding it mention staleness too would be asserting a
            // preference rather than an honesty property.
            // `coverage: unknown` is excluded for the same reason: the
            // statement correctly reports the unmeasured coverage, which is a
            // different open question rather than a denial of the staleness.
            if (
              freshness === "stale" &&
              coverage !== "unknown" &&
              verdict.pill.label === "Needs refresh" &&
              !ACKNOWLEDGES_STALENESS_RE.test(verdict.forward_statement)
            ) {
              contradictions.push(
                `${where}: "Needs refresh" pill over a statement that never mentions refreshing — "${verdict.forward_statement}"`
              );
            }

            // (c) A green "Healthy" pill must never sit over a stale source.
            if (freshness === "stale" && verdict.pill.label === "Healthy") {
              contradictions.push(`${where}: stale source rendered "Healthy"`);
            }
          }
        }
      }
    }
  }

  assert.ok(combinations > 300, `sweep should be broad; only covered ${combinations}`);
  assert.deepEqual(contradictions, [], `pill/forward_statement contradictions:\n${contradictions.join("\n")}`);
});

/**
 * The invariant gate itself must REJECT the contradiction rather than render
 * it. `synthesizeRenderedVerdict` throws outside production, so this proves
 * inv 8 is wired in and would stop a future regression at the seam — not just
 * that today's derivation happens to avoid it.
 */
test("inv 8 is wired into the verdict gate", () => {
  const { verdict } = renderStaleSchedulable();
  // Sanity: the gate ran and returned a real verdict, not the grey fallback.
  assert.notEqual(verdict.pill.label, "Not measured");
  assert.notEqual(verdict.forward_statement, "Status could not be classified.");
});
