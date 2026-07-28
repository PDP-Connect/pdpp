// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Falsifiability proof for the lexical-retrieval conformance harness.
 *
 * Runs the harness against a deliberately broken in-memory driver whose
 * lexical reads are non-conformant in two specific ways: (1) it silently
 * drops every field after the first on upsert, so queries that should
 * hit on a dropped field return zero results; (2) it flips tie ordering
 * non-deterministically across consecutive calls, so identical queries
 * against identical state produce different sequences. These are the
 * failure modes the harness's upsert/query and deterministic-tie
 * scenarios pin.
 *
 * If the harness is sound, at least one scenario MUST fail when exercised
 * against this broken driver. If every scenario passed, the harness would
 * be a green-path wrapper rather than a real conformance gate, and this
 * test would refuse to confirm coverage.
 *
 * The broken driver is test-only and SHALL NOT be used as a production
 * adapter or environment profile.
 *
 * Spec: openspec/changes/add-lexical-retrieval-conformance-harness/specs/
 *       reference-implementation-architecture/spec.md
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createBrokenLexicalRetrievalDriver } from "./helpers/broken-lexical-retrieval-driver.ts";
import { runLexicalRetrievalConformance } from "./helpers/lexical-retrieval-conformance.ts";

const REGEXP_1 = /deterministic|repeated identical/i;
const REGEXP_2 = /searchable-field|excludes hits matched only on excluded|deleteRecord/i;

test("harness detects at least one lexical invariant violation in a broken driver", async () => {
  const scenarios: { name: string; fn: () => Promise<void> }[] = [];
  const collect = (name: string, fn: () => Promise<void>) => {
    scenarios.push({ fn, name });
  };

  runLexicalRetrievalConformance({
    label: "broken-in-memory",
    makeDriver: () => createBrokenLexicalRetrievalDriver(),
    test: collect,
  });

  assert.ok(scenarios.length > 0, "harness must register at least one scenario");

  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  const outcomes = [];
  for (const scenario of scenarios) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
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

  // Specifically expect at least one of: the upsert/query scenario fails
  // because the broken driver dropped the body field; the deterministic-
  // ties scenario fails because the broken driver flips ordering on every
  // call.
  const droppedFieldFailed = failures.some((f) => REGEXP_2.test(f.name));
  const tieOrderFailed = failures.some((f) => REGEXP_1.test(f.name));
  assert.ok(
    droppedFieldFailed || tieOrderFailed,
    `expected the dropped-field or tie-order scenario to fail. failures=${JSON.stringify(
      failures.map((f) => f.name),
      null,
      2
    )}`
  );
});
