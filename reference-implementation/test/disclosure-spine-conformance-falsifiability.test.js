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

import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrokenInMemoryDisclosureSpineDriver } from './helpers/broken-disclosure-spine-driver.js';
import { runDisclosureSpineConformance } from './helpers/disclosure-spine-conformance.js';

test('harness detects at least one spine invariant violation in a broken driver', async () => {
  const scenarios = [];
  const collect = (name, fn) => {
    scenarios.push({ name, fn });
  };

  runDisclosureSpineConformance({
    label: 'broken-in-memory',
    test: collect,
    makeDriver: () => createBrokenInMemoryDisclosureSpineDriver(),
  });

  assert.ok(scenarios.length > 0, 'harness must register at least one scenario');

  const outcomes = [];
  for (const scenario of scenarios) {
    try {
      await scenario.fn();
      outcomes.push({ name: scenario.name, ok: true });
    } catch (err) {
      outcomes.push({
        name: scenario.name,
        ok: false,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const failures = outcomes.filter((o) => !o.ok);
  assert.ok(
    failures.length > 0,
    `harness did not catch any broken-driver invariant — coverage may be theater. outcomes=${JSON.stringify(outcomes, null, 2)}`,
  );

  // Specifically expect the append-order scenario to fail (broken driver
  // reverses the timeline) and the summary extent scenario to fail (broken
  // driver truncates extent to the hydration window).
  const orderingFailed = failures.some((f) =>
    /append order|terminal/.test(f.name),
  );
  const summaryExtentFailed = failures.some((f) =>
    /full extent/.test(f.name),
  );
  // The tied-timestamp paged-walk scenario and the interleaved-appends paged-walk
  // scenario protect the cursor-stability invariant the spine `event_seq` change
  // pinned: a backend whose pagination depends on a private physical row identity
  // can still pass the single-page tied scenario while losing order across pages.
  // The broken driver reverses listPage, so both paged-walk scenarios fail —
  // require that signal so the harness keeps proving cursor stability.
  // Spec: openspec/changes/replace-spine-rowid-cursor-with-event-seq/specs/
  //       reference-implementation-architecture/spec.md
  const pagedTiedFailed = failures.some((f) =>
    /paged walk preserves append order when every event shares/.test(f.name),
  );
  const pagedInterleavedFailed = failures.some((f) =>
    /paged walk per correlation is stable when correlations are interleaved/.test(f.name),
  );
  assert.ok(
    orderingFailed,
    `expected the append-order or terminal scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
  assert.ok(
    summaryExtentFailed,
    `expected the summary-extent scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
  assert.ok(
    pagedTiedFailed,
    `expected the paged tied-timestamp scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
  assert.ok(
    pagedInterleavedFailed,
    `expected the paged interleaved-correlation scenario to fail. failures=${JSON.stringify(failures.map((f) => f.name), null, 2)}`,
  );
});
