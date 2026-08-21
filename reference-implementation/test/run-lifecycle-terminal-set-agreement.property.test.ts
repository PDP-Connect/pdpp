// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine.
 *
 * Covers the single-declaration requirement: the terminal set must be
 * declared once, and every consumer must agree.
 *
 * Property: for every terminal state, every consumer of the terminal set
 *   classifies a run in that state as terminal, and both backends agree.
 * Generator: the cross-product of (terminal state) x (consumer of the
 *   terminal set) x (storage backend).
 * Invariant: unanimous classification.
 *
 * This test fails today, by construction, on six live divergences.
 * `lib/spine.ts:1066` declares the canonical five and its own comment states
 * "All run-status projection code must read from this set; never hardcode
 * subset checks." Six declarations do exactly that:
 *
 *   omitting `run.abandoned`:
 *     server/connector-summary-read-model.ts:1253
 *     server/db.ts:5437  (SPINE_TERMINAL_EVENT_TYPES_SQL)
 *     server/postgres-storage.ts:2692, :2716, :2744, :2793
 *     server/connector-summary-evidence-engine.ts:1599, :1799
 *   omitting `run.browser_surface_failed`:
 *     lib/postgres-spine.ts:570
 *     server/postgres-storage.ts:2336
 *
 * db.ts:5433 says it is "kept in sync with" connector-summary-read-model.ts.
 * The two agree with each other and both disagree with the spine. Note also
 * that the SQLite-side and PostgreSQL-side omissions differ, so the two
 * backends disagree about what "terminal" means.
 *
 * Consequence: an abandoned run is invisible to the connector-summary fold.
 * The 121 runs adjudicated by the sibling owner-epoch change are exactly the
 * population this hides.
 */

import test from "node:test";

test("run lifecycle: the terminal set has one declaration", async (t) => {
  await t.test(
    "every consumer classifies every terminal state as terminal",
    { todo: "requires the single declaration; currently fails on six divergences" },
    () => {
      // Enumerate consumers from the declaration site, so a NEW divergent
      // consumer is caught too. Hardcoding today's list would make this test
      // stale the moment someone adds the seventh.
    }
  );

  await t.test(
    "SQLite and PostgreSQL agree on terminal classification",
    { todo: "requires the single declaration" },
    () => {
      // The two backends currently omit DIFFERENT members.
    }
  );

  await t.test(
    "an abandoned run is visible to the connector-summary fold",
    { todo: "requires the single declaration" },
    () => {
      // The specific observable consequence of the omission.
    }
  );

  await t.test(
    "adding a terminal state requires exactly one edit",
    { todo: "requires the single declaration" },
    () => {
      // The structural property. A comment asking two constants to stay in
      // sync is not a mechanism.
    }
  );
});
