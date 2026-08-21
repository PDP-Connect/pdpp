// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SKELETON — intentionally not implemented. See
 * openspec/changes/own-run-lifecycle-state-machine.
 *
 * Covers transitions T10/T11 (successor adjudication) as legal transitions of
 * the machine rather than a sibling reconciliation path.
 *
 * Property: repeated adjudication over overlapping orphan sets produces
 *   exactly one terminal event per orphan, never adjudicates a run in the
 *   newest boot epoch, and never revises a record count.
 * Generator: orphan populations spanning several retired epochs, plus a run
 *   in the newest boot epoch, adjudicated by 1-3 successive passes with
 *   overlapping scopes (boot reconciler and the owner-operated repair tool).
 * Invariant: one terminal event per orphan; newest-epoch runs untouched;
 *   record counts unchanged; the event and its projection agree.
 *
 * Behavior to preserve exactly (D14) -- this is a refactor of truth-keeping,
 * so these are gates, not aspirations:
 *
 *  1. Idempotency keys on `caused_by_event_id` via the
 *     `spine_run_abandoned_cause_unique` partial index. The existing code
 *     catches ONLY that named constraint and never blanket-catches 23505 /
 *     SQLITE_CONSTRAINT_UNIQUE. A blanket catch would swallow real defects.
 *  2. The newest-epoch exclusion is load-bearing. Without it, adjudication
 *     declares LIVE work abandoned and frees its resource for a competing
 *     run. The production dry run reported 123 before the exclusion and 121
 *     after; the two extras were runs a live container had started ninety
 *     seconds earlier.
 *  3. Eligibility is decided by epoch comparison, never by an age threshold.
 *  4. An interruption while awaiting owner interaction carries its own
 *     distinct reason. Collapsing it into the generic reason changes
 *     observable output -- an owner who was sent an OTP that then became
 *     useless is told why.
 *  5. `records_emitted` is never revised. Records durably ingested before the
 *     interruption stay committed.
 *  6. Provenance stays distinguishable: the boot reconciler and the repair
 *     tool record different sources for otherwise identical events.
 */

import test from "node:test";

test("run lifecycle: successor adjudication", async (t) => {
  await t.test(
    "repeated passes emit exactly one terminal event per orphan",
    { todo: "requires adjudication expressed as an owner-module transition" },
    () => {
      // Overlap the scopes of successive passes deliberately.
    }
  );

  await t.test(
    "a run in the newest boot epoch is never adjudicated",
    { todo: "requires the owner module" },
    () => {
      // Live work. Adjudicating it reintroduces duplicate execution.
    }
  );

  await t.test(
    "eligibility never consults an age threshold",
    { todo: "requires the owner module" },
    () => {
      // A very old run in the newest epoch stays untouched; a very recent run
      // in a retired epoch is adjudicated. Age must not be the discriminator.
    }
  );

  await t.test(
    "an interruption while awaiting owner interaction keeps its distinct reason",
    { todo: "requires the owner module" },
    () => {
      // Observable-behavior preservation.
    }
  );

  await t.test(
    "the terminal event and its durable projection commit together",
    { todo: "requires the owner module" },
    () => {
      // Kill the transaction between the two writes and assert neither
      // landed. Today both adjudication paths bypass emitSpineEvent with raw
      // INSERTs and hand-write their own projection to compensate.
    }
  );

  await t.test(
    "record counts are never revised by adjudication",
    { todo: "requires the owner module" },
    () => {
      // An abandon must not rewrite records_emitted to zero.
    }
  );
});
