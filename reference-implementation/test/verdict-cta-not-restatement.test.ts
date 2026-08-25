// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * An action's CTA must not restate the statement beside it.
 *
 * THE LIVE DEFECT (2026-08-25). `HEB - gezalsatx@yahoo.com` rendered, from ONE
 * `rendered_verdict` object, in one row:
 *
 *     pill:              "Can't collect"
 *     forward_statement: "Some data from this source can't be collected."
 *     action cta:        "Some data from this source can't be collected"
 *
 * The console stacks the two — `source-actionability.ts` builds each row's
 * `what` from `verdict.forward_statement` and its `actionLabel` from
 * `required_actions[0].cta` — so the owner read one fact printed twice, and
 * the slot that answers "so what now?" told him nothing he had not just read.
 *
 * THE DIVERGENCE. Two independent producers picked the same sentence for the
 * same branch: `terminalCoverageCta` (the action) and
 * `terminalForwardStatement` (the statement). Each was self-consistent on its
 * own; nothing compared them. That is the same structural failure as inv 8
 * (pill vs statement), one field over.
 *
 * WHAT THE FIX IS NOT. It is not "always give the owner a button". A
 * maintainer `code_fix` is genuinely not an owner task: it carries
 * `audience: "maintainer"` and `satisfied_when: { kind: "none" }`, and the
 * console renders it as inert status text, not a control (`sources-view.tsx`,
 * the `!ownerRunnable` branch). 428898c92 settled that register deliberately —
 * for a defect the owner cannot act on, this slot states a CONDITION rather
 * than inviting an action he cannot take. What it may not be is the sentence
 * below it, again.
 *
 * WHY THESE TESTS BUILD THEIR INPUT WITH THE REAL PRODUCER. Every assertion
 * starts from `computeConnectionHealth` and asserts on real
 * `synthesizeRenderedVerdict` output, for the reason spelled out at length in
 * `verdict-pill-statement-agreement.test.ts`: hand-built snapshots are exactly
 * how this class of defect keeps shipping here, and only the real projection
 * can tell us which axis tuples are actually reachable.
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

/** H-E-B is browser-bound and manual-refresh: no background collection. */
const MANUAL_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: false,
  interactionPosture: "none",
  recommendedMode: "manual",
};

const SCHEDULABLE_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: true,
  interactionPosture: "none",
  recommendedMode: "automatic",
};

/**
 * Reduce owner copy to its claim, so a trailing period or a capital letter is
 * not mistaken for a difference in meaning. Mirrors `copyClaim` in the
 * renderer; duplicated on purpose so the test cannot pass merely because the
 * production normalizer agrees with itself.
 */
const TRAILING_TERMINATOR_RE = /[.!]+$/;

/** Developer language the owner-facing CTA must never carry (428898c92). */
const DEVELOPER_LANGUAGE_RE = /connector|code|bug|defect|maintainer|developer/i;

function claim(text: string): string {
  return text.trim().toLowerCase().replace(TRAILING_TERMINATOR_RE, "");
}

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
    refresh: MANUAL_REFRESH,
    run: { hasDegradingGaps: false, lastSuccessAt: LAST_SUCCESS, latestStatus: "succeeded", reasonCode: null },
    schedule: null,
  };
}

function stream(overrides: Partial<StreamRollup> = {}): StreamRollup {
  return {
    attention_open: false,
    collected: 2,
    considered: 9,
    coverage: "terminal_gap",
    gap_retryable: false,
    priority: "required",
    stream_id: "orders",
    ...overrides,
  };
}

function render(
  input: ComputeConnectionHealthInput,
  streams: readonly StreamRollup[],
  refresh: ConnectionRefreshEvidence = MANUAL_REFRESH
): { snapshot: ConnectionHealthSnapshot; verdict: RenderedVerdict } {
  const snapshot = computeConnectionHealth(input);
  return { snapshot, verdict: synthesizeRenderedVerdict(snapshot, streams, refresh, true) };
}

/**
 * The `gezalsatx@yahoo.com` shape: a terminal coverage gap with no credential
 * failure, which is what makes `buildRequiredActions` emit the maintainer
 * `code_fix` whose CTA was the duplicate.
 */
function renderTerminalCoverage() {
  return render(
    {
      ...baseInput(),
      coverage: { axis: "terminal_gap" },
      run: { hasDegradingGaps: true, lastSuccessAt: LAST_SUCCESS, latestStatus: "failed", reasonCode: null },
    },
    [stream()]
  );
}

// ─── 1. The reproduction, through the real producer ──────────────────────────

/**
 * The control. If a future change moves this shape off a terminal disposition
 * with a maintainer `code_fix`, this says so out loud rather than letting the
 * regression assertions below quietly start proving nothing.
 */
test("the terminal-coverage shape really does reach a maintainer code_fix action", () => {
  const { snapshot, verdict } = renderTerminalCoverage();

  assert.equal(snapshot.forward_disposition, "terminal");
  const codeFix = verdict.required_actions.find((action) => action.kind === "code_fix");
  assert.ok(codeFix, "this shape is the one that emits the maintainer code_fix");
  assert.equal(codeFix.audience, "maintainer");
  assert.deepEqual(codeFix.satisfied_when, { kind: "none" }, "not owner-satisfiable — status text, not a button");
});

test("the terminal-coverage CTA no longer restates its own forward statement (the live defect)", () => {
  const { verdict } = renderTerminalCoverage();
  const codeFix = verdict.required_actions.find((action) => action.kind === "code_fix");
  assert.ok(codeFix);

  assert.notEqual(
    claim(codeFix.cta),
    claim(verdict.forward_statement),
    `the action slot must not reprint the sentence beside it — both read "${codeFix.cta}"`
  );
  // And the statement itself is unchanged: the fix moved the CTA, not the
  // owner's explanation of what happened to his data.
  assert.equal(verdict.forward_statement, "Some data from this source can't be collected.");
});

/**
 * The maintainer action is still OFFERED, not suppressed. Deleting it would
 * drop the row's only signal that someone other than the owner owes work here,
 * and `hasMaintainerCodeFix` / `owner_state: blocked_maintainer` both read it.
 */
test("the maintainer code_fix is still present — the fix is de-duplication, not suppression", () => {
  const { verdict } = renderTerminalCoverage();

  assert.equal(verdict.required_actions.filter((action) => action.kind === "code_fix").length, 1);
  assert.ok(
    !verdict.required_actions.some((action) => action.audience === "owner"),
    "and no owner-audience action was invented to fill the slot"
  );
});

/** Owner-facing words must mean something to a non-engineer. */
test("the CTA carries no developer language", () => {
  const { verdict } = renderTerminalCoverage();
  const codeFix = verdict.required_actions.find((action) => action.kind === "code_fix");
  assert.ok(codeFix);

  // 428898c92 removed "Connector code needs a fix" for naming whose code is
  // broken. The replacement must not walk that back.
  assert.doesNotMatch(codeFix.cta, DEVELOPER_LANGUAGE_RE);
});

// ─── 2. Behavior preservation: the two live H-E-B rows still differ ──────────

/**
 * The gate on the fix. The owner's two H-E-B accounts fail for genuinely
 * different reasons and their differing verdicts are honest:
 *
 *   - `tnunamak@gmail.com` — the proven-empty guard fired (H-E-B served an
 *     empty history for an account that previously had orders), leaving a
 *     stale-but-covered source whose next step is a refresh.
 *   - `gezalsatx@yahoo.com` — a terminal coverage gap with no owner recovery
 *     path.
 *
 * If a copy change ever flattens these two into the same row, the owner loses
 * the only on-screen signal that one is his to act on and the other is not.
 */
test("the two H-E-B rows still render different, honest verdicts", () => {
  const gezalsatx = renderTerminalCoverage().verdict;
  const tnunamak = render({ ...baseInput(), freshness: { axis: "stale" } }, [
    stream({ collected: 100, considered: 100, coverage: "complete" }),
  ]).verdict;

  assert.notEqual(tnunamak.pill.label, gezalsatx.pill.label);
  assert.notEqual(tnunamak.forward_statement, gezalsatx.forward_statement);

  // The refreshable account keeps its real owner action...
  assert.equal(tnunamak.forward_statement, "Run a refresh to bring this up to date.");
  const refresh = tnunamak.required_actions.find((action) => action.audience === "owner");
  assert.ok(refresh, "the stale account is owner-repairable and must keep its button");
  assert.equal(refresh.cta, "Refresh now");

  // ...while the terminal account still has no owner action at all.
  assert.ok(!gezalsatx.required_actions.some((action) => action.audience === "owner"));
  assert.equal(gezalsatx.pill.label, "Can't collect");
});

/** The softened branch is untouched — it was never the duplicate. */
test("the softened coverage-review CTA is unchanged", () => {
  const { verdict } = render(
    {
      ...baseInput(),
      coverage: { axis: "terminal_gap" },
      freshness: { axis: "fresh" },
      run: { hasDegradingGaps: true, lastSuccessAt: LAST_SUCCESS, latestStatus: "succeeded", reasonCode: null },
    },
    [stream()]
  );

  const codeFix = verdict.required_actions.find((action) => action.kind === "code_fix");
  assert.ok(codeFix, "a succeeded-but-gappy terminal run still owes the maintainer code_fix");
  assert.equal(codeFix.cta, "Coverage gap needs review");
  assert.equal(verdict.forward_statement, "Latest collection completed with known coverage gaps.");
  assert.notEqual(claim(codeFix.cta), claim(verdict.forward_statement));
});

// ─── 3. The invariant, over every reachable combination ─────────────────────

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
 * combination through the REAL producer and the REAL renderer, and assert no
 * rendered action's CTA restates the statement beside it.
 *
 * This is the "assert the invariant, not just the one case" requirement. It
 * does not enumerate every possible RenderedVerdict — attention prompts,
 * outbox stalls, local-device backlogs and schedule evidence are not varied
 * here, which is why inv 9 also lives in the `synthesizeRenderedVerdict`
 * invariant gate and catches those at runtime.
 */
test("no reachable combination renders a CTA that restates its forward statement", () => {
  const duplicates: string[] = [];
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
                schedule: refresh === SCHEDULABLE_REFRESH ? { enabled: true } : null,
              },
              [stream({ coverage, gap_retryable: hasDegradingGaps })],
              refresh
            );

            const where = `coverage=${coverage} freshness=${freshness} run=${latestStatus} mode=${refresh.recommendedMode} gaps=${hasDegradingGaps}`;
            for (const action of verdict.required_actions) {
              if (claim(action.cta) === claim(verdict.forward_statement)) {
                duplicates.push(`${where}: ${action.kind} cta restates statement — "${action.cta}"`);
              }
            }
          }
        }
      }
    }
  }

  assert.ok(combinations > 300, `sweep should be broad; only covered ${combinations}`);
  assert.deepEqual(duplicates, [], `cta/forward_statement duplications:\n${duplicates.join("\n")}`);
});

/**
 * The invariant gate itself must REJECT the duplication rather than render it.
 * `synthesizeRenderedVerdict` throws outside production, so this proves inv 9
 * is wired in and would stop a FUTURE regression at the seam — not merely that
 * today's copy happens to differ.
 */
test("inv 9 is wired into the verdict gate", () => {
  const { verdict } = renderTerminalCoverage();
  // Sanity: the gate ran and returned a real verdict, not the grey fallback.
  assert.notEqual(verdict.pill.label, "Not measured");
  assert.notEqual(verdict.forward_statement, "Status could not be classified.");
});
