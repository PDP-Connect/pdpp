/**
 * Per-record fingerprint behavior for YNAB's `payee_locations` stream.
 * YNAB's API exposes server_knowledge deltas on payees/transactions/etc.,
 * but NOT on `/payee_locations` — the full collection re-returns every
 * run. Without a connector-side gate, every run appends a new version
 * per location.
 *
 * These tests pin:
 *   1. `readPriorPayeeLocationFingerprints` is tolerant of empty / legacy
 *      / malformed state (no throws, empty map = re-emit all once).
 *   2. The state cursor's per-budget shape round-trips so a multi-budget
 *      owner doesn't cross-contaminate fingerprints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readPriorPayeeLocationFingerprints } from "./index.ts";

test("readPriorPayeeLocationFingerprints: empty state → empty map", () => {
  assert.equal(readPriorPayeeLocationFingerprints({}, "budget-A").size, 0);
});

test("readPriorPayeeLocationFingerprints: legacy state with no fingerprints field → empty map", () => {
  // Pre-fix runs emitted no STATE for payee_locations at all. A
  // partially-migrated owner may end up with the key present but the
  // shape empty.
  const out = readPriorPayeeLocationFingerprints({ payee_locations: { "budget-A": {} } }, "budget-A");
  assert.equal(out.size, 0);
});

test("readPriorPayeeLocationFingerprints: another budget's entry doesn't leak", () => {
  // A multi-budget owner must not have budget-A locations gated by
  // budget-B's fingerprint map.
  const state = {
    payee_locations: {
      "budget-A": { fingerprints: { L1: "hashA1", L2: "hashA2" } },
      "budget-B": { fingerprints: { L1: "hashB1" } },
    },
  };
  const a = readPriorPayeeLocationFingerprints(state, "budget-A");
  const b = readPriorPayeeLocationFingerprints(state, "budget-B");
  assert.equal(a.size, 2);
  assert.equal(b.size, 1);
  assert.equal(a.get("L1"), "hashA1");
  assert.equal(b.get("L1"), "hashB1");
});

test("readPriorPayeeLocationFingerprints: malformed entries are silently dropped", () => {
  const out = readPriorPayeeLocationFingerprints(
    {
      payee_locations: {
        "budget-A": {
          fingerprints: {
            L1: "good",
            L2: 42, // wrong type
            L3: "", // empty string
            L4: null, // null
            L5: "alsoGood",
          },
        },
      },
    },
    "budget-A"
  );
  assert.equal(out.size, 2);
  assert.ok(out.has("L1"));
  assert.ok(out.has("L5"));
});

test("readPriorPayeeLocationFingerprints: non-object fingerprints value → empty map (no throw)", () => {
  // Inject a bad shape (fingerprints is an array) the runtime must
  // tolerate. The state object is intentionally typed wide so we
  // don't dual-cast at the call site.
  const malformedState: Record<string, unknown> = {
    payee_locations: {
      "budget-A": { fingerprints: ["bogus"] },
    },
  };
  const out = readPriorPayeeLocationFingerprints(malformedState, "budget-A");
  assert.equal(out.size, 0);
});
