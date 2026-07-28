const TOP_LEVEL_REGEX_1 = /append order|terminal/;
const TOP_LEVEL_REGEX_2 = /full extent/;
const TOP_LEVEL_REGEX_3 = /paged walk preserves append order when every event shares/;
const TOP_LEVEL_REGEX_4 = /paged walk per correlation is stable when correlations are interleaved/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Falsifiability proof for the disclosure-spine conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver whose
 * spine reads are non-conformant in two specific ways: (1) `listPage` returns
 * events in reverse append order, breaking timeline ordering and terminal
 * lookup; (2) `listSummaries` derives `event_count`/`first_at`/`last_at` from
 * a truncated hydration window instead of the full correlation extent. These
 * are the failure modes the harness's append-order, terminal, and summary-
 * extent scenarios pin.
 *
 * If the harness is sound, at least one scenario MUST fail when exercised
 * against this broken driver. If every scenario passed, the harness would be
 * a green-path wrapper rather than a real conformance gate, and this test
 * would refuse to confirm coverage.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-disclosure-spine-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createBrokenInMemoryDisclosureSpineDriver } from "./helpers/broken-disclosure-spine-driver.ts";
import { runDisclosureSpineConformance } from "./helpers/disclosure-spine-conformance.ts";

interface ConformanceScenario {
  fn: () => Promise<void> | void;
  name: string;
}

interface ConformanceOutcome {
  err?: string;
  name: string;
  ok: boolean;
}

test("harness detects at least one spine invariant violation in a broken driver", async () => {
  const scenarios: ConformanceScenario[] = [];
  const collect = (name: string, fn: () => Promise<void> | void) => {
    scenarios.push({ fn, name });
  };

  runDisclosureSpineConformance({
    label: "broken-in-memory",
    makeDriver: () => createBrokenInMemoryDisclosureSpineDriver(),
    test: collect,
  });

  assert.ok(scenarios.length > 0, "harness must register at least one scenario");

  const outcomes: ConformanceOutcome[] = [];
  for (const scenario of scenarios) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      await scenario.fn();
      outcomes.push({ name: scenario.name, ok: true });
    } catch (err) {
      outcomes.push({
        err: err instanceof Error ? err.message : String(err),
        name: scenario.name,
        ok: false,
      });
    }
  }

  const failures = outcomes.filter((o) => !o.ok);
  assert.ok(
    failures.length > 0,
    `harness did not catch any broken-driver invariant — coverage may be theater. outcomes=${JSON.stringify(outcomes, null, 2)}`
  );

  // Specifically expect the append-order scenario to fail (broken driver
  // reverses the timeline) and the summary extent scenario to fail (broken
  // driver truncates extent to the hydration window).
  const orderingFailed = failures.some((f) => TOP_LEVEL_REGEX_1.test(f.name));
  const summaryExtentFailed = failures.some((f) => TOP_LEVEL_REGEX_2.test(f.name));
  // The tied-timestamp paged-walk scenario and the interleaved-appends paged-walk
  // scenario protect the cursor-stability invariant the spine `event_seq` change
  // pinned: a backend whose pagination depends on a private physical row identity
  // can still pass the single-page tied scenario while losing order across pages.
  // The broken driver reverses listPage, so both paged-walk scenarios fail —
  // require that signal so the harness keeps proving cursor stability.
  // Spec: openspec/changes/replace-spine-rowid-cursor-with-event-seq/specs/
  //       reference-implementation-architecture/spec.md
  const pagedTiedFailed = failures.some((f) => TOP_LEVEL_REGEX_3.test(f.name));
  const pagedInterleavedFailed = failures.some((f) => TOP_LEVEL_REGEX_4.test(f.name));
  assert.ok(
    orderingFailed,
    `expected the append-order or terminal scenario to fail. failures=${JSON.stringify(
      failures.map((f) => f.name),
      null,
      2
    )}`
  );
  assert.ok(
    summaryExtentFailed,
    `expected the summary-extent scenario to fail. failures=${JSON.stringify(
      failures.map((f) => f.name),
      null,
      2
    )}`
  );
  assert.ok(
    pagedTiedFailed,
    `expected the paged tied-timestamp scenario to fail. failures=${JSON.stringify(
      failures.map((f) => f.name),
      null,
      2
    )}`
  );
  assert.ok(
    pagedInterleavedFailed,
    `expected the paged interleaved-correlation scenario to fail. failures=${JSON.stringify(
      failures.map((f) => f.name),
      null,
      2
    )}`
  );
});
