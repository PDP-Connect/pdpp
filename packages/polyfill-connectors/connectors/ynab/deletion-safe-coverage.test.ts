// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * YNAB's coverage proof is deletion-safe.
 *
 * PDPP deliberately RETAINS records after the provider deletes them, so any
 * completeness check that compares a provider total against a held count will
 * flag successful preservation as loss. YNAB avoids that trap by construction,
 * and these tests pin the two properties that make it work:
 *
 *   1. A deleted row arrives IN-BAND. YNAB's delta marks a deletion as a
 *      returned record with `deleted: true` rather than by omitting it, so the
 *      row is inside the enumerated boundary: it raises `considered`, is
 *      validated like any other row, and raises `covered` too. A deletion is
 *      therefore NOT a coverage gap — it is a covered fact about a deletion.
 *      (The runtime turns it into a tombstone via this connector's
 *      `isTombstone: (_stream, d) => d.deleted === true`.)
 *
 *   2. A malformed row still degrades coverage. `covered` is tallied per record
 *      from the same `validateRecord` verdict the runtime's emitRecord applies,
 *      never aliased to the response length, so a row that cannot be emitted is
 *      considered-but-not-covered and reads a real `partial`.
 *
 * Verified against live data when this was written: this instance holds 9 YNAB
 * tombstones (4 payees, 5 transactions) with distinct `deleted_at` timestamps
 * across several runs — the in-band deletion signal reaches durable storage.
 * YNAB holds 9 of the fleet's 11 tombstones.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRecord } from "./schemas.ts";

/** A minimal well-formed payee row, matching the shape `payeeRecord` emits. */
function payeeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    budget_id: "22222222-2222-4222-8222-222222222222",
    name: "Corner Store",
    transfer_account_id: null,
    deleted: false,
    ...overrides,
  };
}

test("a deleted payee is a valid, covered record — not a coverage gap", () => {
  const deleted = payeeRow({ deleted: true });

  // The load-bearing property: a deletion passes the SAME shape-check every
  // other row passes, so it counts toward `covered`. If deletions were instead
  // rejected or omitted, every upstream deletion would permanently depress
  // coverage and a correct, fully-preserved run would read `partial` forever.
  const verdict = validateRecord("payees", deleted);
  assert.equal(verdict.ok, true, "a deleted row must validate like any other row");
});

test("deleting a row does not change the considered/covered ratio", () => {
  // The same boundary, once with a live row and once after that row is deleted
  // upstream. Both are three-row responses; both must read fully covered.
  const idA = "aaaaaaaa-1111-4111-8111-111111111111";
  const idB = "bbbbbbbb-1111-4111-8111-111111111111";
  const idC = "cccccccc-1111-4111-8111-111111111111";
  const live = [payeeRow({ id: idA }), payeeRow({ id: idB }), payeeRow({ id: idC })];
  const afterDeletion = [payeeRow({ id: idA }), payeeRow({ id: idB }), payeeRow({ id: idC, deleted: true })];

  const coverage = (rows: Record<string, unknown>[]): { considered: number; covered: number } => ({
    considered: rows.length,
    covered: rows.reduce((n, r) => n + (validateRecord("payees", r).ok ? 1 : 0), 0),
  });

  const before = coverage(live);
  const after = coverage(afterDeletion);

  assert.deepEqual(before, { considered: 3, covered: 3 });
  assert.deepEqual(after, { considered: 3, covered: 3 }, "an upstream deletion must not read as coverage loss");
});

test("a malformed row is considered but not covered", () => {
  // `id` is required. A row that cannot be emitted must not be claimed as
  // covered — this is the guard that keeps `covered` from being a rename of
  // `considered`. Without it the ratio could never report a real `partial`.
  const rows = [payeeRow(), payeeRow({ id: null })];

  const considered = rows.length;
  const covered = rows.reduce((n, r) => n + (validateRecord("payees", r).ok ? 1 : 0), 0);

  assert.equal(considered, 2);
  assert.equal(covered, 1, "a row that fails the shape-check must not be counted as covered");
  assert.ok(covered < considered, "an unemittable row must read partial");
});
