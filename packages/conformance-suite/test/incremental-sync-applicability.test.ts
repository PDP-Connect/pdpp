// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// RS-7/RS-8 (and the RS-6 cursor-token-space case) must derive applicability
// from the seeded stream inventory, not from the target's self-reported
// `incrementalSync` capability flag.
//
// Protected risk: Core Section 4 and Section 9 RS item 7 bind incremental
// sync to any `mutable_state` stream a target serves — it is not an optional
// feature a target opts into. Gating `appliesWhen` on
// `adapter.capabilities.incrementalSync` let a target that serves
// mutable-state data hide the whole requirement as `unsupported` merely by
// leaving that boolean false, which is exactly the shape of a false
// declaration this suite exists to catch rather than trust.
//
// A cheaper test (asserting the catalogue's `appliesWhen` prose, or unit
// testing `hasMutableStateStream` in isolation) would miss the regression:
// the defect lived in the runner wiring a case's `appliesWhen` to the wrong
// signal, which only shows up by running a case against a real adapter and
// inspecting the outcome the runner actually produces.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeContext, runCase } from "../src/harness/runner.ts";
import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../src/targets/reference-adapter.ts";
import type { StreamFixture } from "../src/targets/reference-server.ts";
import { QUERY_SURFACE_CASES } from "../src/tests/query-surface.ts";

function caseById(caseId: string) {
  const found = QUERY_SURFACE_CASES.find((c) => c.caseId === caseId);
  assert.ok(found, `No case with id ${caseId}`);
  return found;
}

async function runAgainst(caseId: string, fixtures: readonly StreamFixture[]) {
  const adapter = new ReferenceTargetAdapter(fixtures);
  const { streams } = await adapter.setup();
  try {
    return await runCase(caseById(caseId), makeContext(adapter, streams));
  } finally {
    await adapter.teardown();
  }
}

// DEFAULT_FIXTURES already carries mutable_state ("conversations") and
// append_only ("messages"), and the reference target always declares
// `incrementalSync: false` — that mismatch is the exact scenario the fix
// must not let through as `unsupported`.
const MUTABLE_PLUS_APPEND_ONLY = DEFAULT_FIXTURES;

const APPEND_ONLY_ONLY: readonly StreamFixture[] = DEFAULT_FIXTURES.filter((f) => f.semantics === "append_only");

describe("RS-7/RS-8 applicability derives from seeded stream semantics, not the incrementalSync flag", () => {
  it("stays applicable when a mutable_state stream is seeded, even though incrementalSync is false", async () => {
    for (const caseId of [
      "RS-7/deletion-surfaces-as-a-tombstone",
      "RS-8/terminal-page-carries-next-changes-since",
      "RS-6/cursor-not-accepted-as-changes-since",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case runs against its own isolated adapter instance.
      const result = await runAgainst(caseId, MUTABLE_PLUS_APPEND_ONLY);
      assert.notEqual(
        result.outcome,
        "unsupported",
        `${caseId} must not be "unsupported" when a mutable_state stream is seeded: the target's ` +
          "false incrementalSync declaration must not hide a requirement its own data obligates."
      );
    }
  });

  it("runs RS-7 and RS-8 to a definite verdict against a seeded mutable_state stream", async () => {
    // Both cases previously asserted the reference target's own defect: RS-8
    // "fail" (it served no next_changes_since) and RS-7 "skip" (it could not
    // produce a resume token to delete against). The target now implements
    // `changes_since` and tombstones, so both pass.
    //
    // What is asserted here instead is the property that survives a fix: given
    // a seeded mutable_state stream, neither case may report `unsupported`.
    // That outcome would claim the requirement does not bind this target at
    // all, which is exactly the false exemption this file exists to prevent —
    // and it is reachable only by gating `appliesWhen` on the target's own
    // `incrementalSync` boolean instead of on the data it actually serves.
    for (const caseId of ["RS-7/deletion-surfaces-as-a-tombstone", "RS-8/terminal-page-carries-next-changes-since"]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case runs against its own isolated adapter instance.
      const result = await runAgainst(caseId, MUTABLE_PLUS_APPEND_ONLY);
      assert.equal(
        result.outcome,
        "pass",
        `${caseId} must pass against the reference target, which serves a mutable_state stream and implements ` +
          `changes_since. Got "${result.outcome}": ${result.detail ?? "(no detail)"}`
      );
    }
  });

  it("reports the RS-6 cursor-space case as pass once the fixture can issue a page cursor", async () => {
    // This case previously skipped alongside RS-7, for a different reason that
    // has since stopped holding: it needs a PAGE cursor to present in the
    // changes_since slot, and the reference server used to return has_more:
    // false with no next_cursor, so there was never one to present. Now that
    // the fixture paginates (for the order-mismatch case at clause 8.9-11) the
    // cursor exists, the case runs to completion, and the fixture correctly
    // refuses it — distinct token spaces, per Section 8.
    //
    // This is the assertion that would catch a regression in either half: a
    // fixture that stopped paginating would skip here, and one that went back
    // to serving a page cursor as a sync token would fail.
    const result = await runAgainst("RS-6/cursor-not-accepted-as-changes-since", MUTABLE_PLUS_APPEND_ONLY);
    assert.equal(
      result.outcome,
      "pass",
      'RS-6/cursor-not-accepted-as-changes-since must report "pass": a real page cursor is now obtainable ' +
        "from the fixture, and offering it as changes_since must be refused rather than served."
    );
  });

  it("stays unsupported when the seeded inventory is genuinely append-only only", async () => {
    for (const caseId of [
      "RS-7/deletion-surfaces-as-a-tombstone",
      "RS-8/terminal-page-carries-next-changes-since",
      "RS-6/cursor-not-accepted-as-changes-since",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case runs against its own isolated adapter instance.
      const result = await runAgainst(caseId, APPEND_ONLY_ONLY);
      assert.equal(
        result.outcome,
        "unsupported",
        `${caseId} must be "unsupported" against an inventory with no mutable_state stream: incremental ` +
          "sync's tombstone and terminal-page obligations do not bind an append-only-only target."
      );
    }
  });

  it("selects the mutable_state stream, not an arbitrary first stream, from a mixed inventory", async () => {
    // Reverse DEFAULT_FIXTURES so the append_only stream ("messages") is
    // first and the mutable_state stream ("conversations") is last. If a
    // case fell back to `streams[0]` it would pick the append-only stream,
    // which can never carry a tombstone or a meaningful terminal-page
    // resume token, and RS-7 would report skip/fail for the wrong reason
    // (no mutable data observed) instead of exercising real mutable-state
    // behaviour.
    const reversed = [...DEFAULT_FIXTURES].reverse();
    assert.equal(reversed[0]?.semantics, "append_only", "Precondition: the reordered fixture list starts append-only.");
    assert.ok(
      reversed.some((f) => f.semantics === "mutable_state"),
      "Precondition: the reordered fixture list still contains a mutable_state stream."
    );

    const result = await runAgainst("RS-7/deletion-surfaces-as-a-tombstone", reversed);
    // The reference target's changes_since is unimplemented, so the case
    // cannot reach a pass/fail; what this proves is that it ran against a
    // mutable_state stream at all rather than short-circuiting as
    // unsupported (which only a wrongly-selected append_only stream, or the
    // old incrementalSync gate, would cause).
    assert.notEqual(
      result.outcome,
      "unsupported",
      "The mixed inventory contains a mutable_state stream, so the case must not report unsupported " +
        "regardless of which stream happens to sit first in the array."
    );
  });
});

it("an empty fixture inventory is missing evidence, not append-only inapplicability", async () => {
  const outcomes = await Promise.all(
    [
      "RS-7/deletion-surfaces-as-a-tombstone",
      "RS-8/terminal-page-carries-next-changes-since",
      "RS-6/cursor-not-accepted-as-changes-since",
    ].map(async (caseId) => (await runAgainst(caseId, [])).outcome)
  );
  assert.deepEqual(outcomes, ["skip", "skip", "skip"]);
});
