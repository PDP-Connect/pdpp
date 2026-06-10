// Focused tests for the per-record fingerprint cursor primitive. These pin
// the four scenarios the connector-author no-op confidence report (2026-05-26)
// names as the load-bearing contract:
//
//   1. identical second run emits no records;
//   2. run-clock-only diff does not re-emit;
//   3. source-field change re-emits that record (and only that record);
//   4. id absent from this run is pruned from the next STATE cursor.
//
// Plus the tolerant-decode behavior every existing implementation paid for
// independently, and the small ergonomic surface (`priorFingerprint`,
// anonymous records, `size`) connector authors depend on.

import assert from "node:assert/strict";
import { test } from "node:test";
import { openCarryForwardCursor, openFingerprintCursor, recordFingerprint } from "./fingerprint-cursor.ts";

// ─── recordFingerprint ──────────────────────────────────────────────────

test("recordFingerprint: stable across key order", () => {
  const a = { id: "X", a: 1, b: 2, nested: { x: 1, y: 2 } };
  const b = { nested: { y: 2, x: 1 }, b: 2, a: 1, id: "X" };
  assert.equal(recordFingerprint(a), recordFingerprint(b));
});

test("recordFingerprint: excluded keys do not shift the hash", () => {
  const a = { id: "T1", name: "Acme", fetched_at: "2026-05-26T12:00:00Z" };
  const b = { id: "T1", name: "Acme", fetched_at: "2026-05-26T13:00:00Z" };
  assert.notEqual(recordFingerprint(a), recordFingerprint(b), "without exclusion the hash moves");
  assert.equal(recordFingerprint(a, ["fetched_at"]), recordFingerprint(b, ["fetched_at"]));
});

// ─── Scenario 1: identical second run emits nothing ─────────────────────

test("identical second run: cursor reports no changes for every record", () => {
  const records = [
    { id: "U1", name: "alice" },
    { id: "U2", name: "bob" },
  ];

  const first = openFingerprintCursor(undefined);
  for (const r of records) {
    assert.equal(first.shouldEmit(r), true, "first run emits every record");
  }
  const stateAfterFirst = { fingerprints: first.toState() };

  const second = openFingerprintCursor(stateAfterFirst);
  for (const r of records) {
    assert.equal(second.shouldEmit(r), false, "identical second run does not re-emit");
  }
  assert.equal(second.size(), 2, "carry-forward intact across the no-emit run");
});

// ─── Scenario 2: run-clock field is excluded ────────────────────────────

test("run-clock exclusion: only `fetched_at` moved → no re-emit", () => {
  const first = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  const workspace = { id: "T123", name: "Acme", domain: "acme", fetched_at: "2026-05-26T12:00:00Z" };
  first.shouldEmit(workspace);

  const second = openFingerprintCursor({ fingerprints: first.toState() }, { excludeFromFingerprint: ["fetched_at"] });
  const advanced = { ...workspace, fetched_at: "2026-05-26T13:00:00Z" };
  assert.equal(second.shouldEmit(advanced), false, "fetched_at-only delta does not re-emit");
  assert.equal(second.size(), 1, "fingerprint carried forward");
});

// ─── Scenario 3: source-field change re-emits ───────────────────────────

test("source-field change: exactly the changed record re-emits", () => {
  const first = openFingerprintCursor(undefined);
  first.shouldEmit({ id: "U1", name: "alice", updated: 1000 });
  first.shouldEmit({ id: "U2", name: "bob", updated: 2000 });

  const second = openFingerprintCursor({ fingerprints: first.toState() });
  assert.equal(second.shouldEmit({ id: "U1", name: "alice", updated: 1000 }), false, "unchanged");
  assert.equal(second.shouldEmit({ id: "U2", name: "bob", updated: 3000 }), true, "changed");
});

// ─── Scenario 4: prior id absent → pruned ───────────────────────────────

test("pruneStale: id present in prior but absent from this run is dropped", () => {
  const first = openFingerprintCursor(undefined);
  first.shouldEmit({ id: "U1", name: "alice" });
  first.shouldEmit({ id: "U2", name: "bob" });

  const second = openFingerprintCursor({ fingerprints: first.toState() });
  // Only alice shows up this run; bob disappeared from the source.
  second.shouldEmit({ id: "U1", name: "alice" });

  // Pre-prune: bob is still carried.
  assert.equal(second.toState().U2, first.toState().U2, "carry-forward keeps bob until prune");
  assert.equal(second.size(), 2);

  second.pruneStale();
  const out = second.toState();
  assert.equal(out.U1 !== undefined, true, "seen id retained");
  assert.equal(out.U2, undefined, "absent id pruned");
  assert.equal(second.size(), 1);
});

test("pruneStale: empty seen-set on a full-scan stream drops every prior id", () => {
  const first = openFingerprintCursor(undefined);
  first.shouldEmit({ id: "U1", name: "alice" });

  const second = openFingerprintCursor({ fingerprints: first.toState() });
  // Run did nothing — source returned zero rows. On a requested full-scan
  // stream, this is correct: everything should be pruned.
  second.pruneStale();
  assert.equal(second.size(), 0);
});

test("pruneStale: seen-but-unchanged ids survive", () => {
  const first = openFingerprintCursor(undefined);
  first.shouldEmit({ id: "U1", name: "alice" });
  const firstFp = first.toState().U1;

  const second = openFingerprintCursor({ fingerprints: first.toState() });
  assert.equal(second.shouldEmit({ id: "U1", name: "alice" }), false, "no change → no emit");
  second.pruneStale();
  assert.equal(second.toState().U1, firstFp, "fingerprint carried through prune");
});

// ─── Tolerant decode ───────────────────────────────────────────────────

test("tolerant decode: empty / undefined / legacy / malformed → empty prior", () => {
  for (const prior of [undefined, null, {}, [], "garbage", 42, { fingerprints: 7 }, { fingerprints: ["bad"] }]) {
    const cursor = openFingerprintCursor(prior);
    // Without a prior, every record looks new.
    assert.equal(cursor.shouldEmit({ id: "X", v: 1 }), true, `prior=${JSON.stringify(prior)}`);
    assert.equal(cursor.priorFingerprint("X"), undefined);
  }
});

test("tolerant decode: legacy synced_at-only cursor → empty prior, run rebuilds map", () => {
  const cursor = openFingerprintCursor({ synced_at: "2026-05-20T00:00:00Z" });
  assert.equal(cursor.shouldEmit({ id: "X", v: 1 }), true, "no fingerprints field → re-emit");
  assert.equal(cursor.size(), 1, "this run seeds the map for next time");
});

test("tolerant decode: mixed-good-and-bad entries → only valid strings survive", () => {
  const cursor = openFingerprintCursor({
    fingerprints: {
      good: "abc123",
      wrongType: 42,
      empty: "",
      alsoGood: "def456",
    },
  });
  assert.equal(cursor.priorFingerprint("good"), "abc123");
  assert.equal(cursor.priorFingerprint("alsoGood"), "def456");
  assert.equal(cursor.priorFingerprint("wrongType"), undefined);
  assert.equal(cursor.priorFingerprint("empty"), undefined);
});

// ─── Ergonomic surface ─────────────────────────────────────────────────

test("anonymous records (no id) pass through and never touch cursor state", () => {
  const cursor = openFingerprintCursor(undefined);
  cursor.shouldEmit({ id: "U1", name: "alice" });
  assert.equal(cursor.size(), 1, "seeded by alice");

  // id null
  assert.equal(cursor.shouldEmit({ id: null, filename: "x" }), true);
  // id undefined
  assert.equal(cursor.shouldEmit({ filename: "y" }), true);
  // id empty string
  assert.equal(cursor.shouldEmit({ id: "", filename: "z" }), true);
  assert.equal(cursor.size(), 1, "anonymous records left the map alone");

  cursor.pruneStale();
  assert.equal(cursor.size(), 1, "alice retained after prune despite anonymous emits");
});

test("priorFingerprint: returns the prior cursor's value, unchanged across shouldEmit calls", () => {
  const first = openFingerprintCursor(undefined);
  first.shouldEmit({ id: "U1", name: "alice", updated: 1000 });
  const priorFp = first.toState().U1;

  const second = openFingerprintCursor({ fingerprints: first.toState() });
  // Even after shouldEmit advances the next-map, priorFingerprint still
  // reports the *prior* run's value — connector-specific
  // derived-field-preservation policies depend on this.
  second.shouldEmit({ id: "U1", name: "alice", updated: 2000 });
  assert.equal(second.priorFingerprint("U1"), priorFp);
});

test("priorFingerprints option: callers can pre-decode and inject the prior map", () => {
  const injected = new Map<string, string>([["U1", "preset-fp"]]);
  const cursor = openFingerprintCursor(undefined, { priorFingerprints: injected });
  assert.equal(cursor.priorFingerprint("U1"), "preset-fp");
  // shouldEmit is reading against the injected map.
  assert.equal(cursor.shouldEmit({ id: "U1", v: 1 }), true, "fingerprint differs from preset");
});

test("toState: empty cursor produces an empty object", () => {
  const cursor = openFingerprintCursor(undefined);
  assert.deepEqual(cursor.toState(), {});
  assert.equal(cursor.size(), 0);
});

// ─── Generic carry-forward cursor (the shared lifecycle layer) ──────────
//
// `openFingerprintCursor` is the `T = string` specialization over this
// lifecycle. Codex uses it directly with a structured `T`. These tests pin
// the lifecycle independent of any fingerprint payload: seed-from-prior,
// note-records-seen, prune-stale, serialize, and the prior/next split.

interface Fp {
  count: number;
  updated_at: number;
}

test("openCarryForwardCursor: seeds next map from prior so an un-noted id carries forward", () => {
  const prior = new Map<string, Fp>([["a", { updated_at: 1, count: 5 }]]);
  const cursor = openCarryForwardCursor<Fp>(prior);
  // Never note "a" this run — it must survive in toState (carry-forward).
  assert.deepEqual(cursor.toState().a, { updated_at: 1, count: 5 });
  assert.equal(cursor.size(), 1);
});

test("openCarryForwardCursor: prior() reports the prior value; note() does not change it", () => {
  const prior = new Map<string, Fp>([["a", { updated_at: 1, count: 5 }]]);
  const cursor = openCarryForwardCursor<Fp>(prior);
  cursor.note("a", { updated_at: 2, count: 9 });
  assert.deepEqual(cursor.prior("a"), { updated_at: 1, count: 5 }, "prior is the prior run's value");
  assert.deepEqual(cursor.toState().a, { updated_at: 2, count: 9 }, "toState reflects this run's note");
  assert.equal(cursor.prior("missing"), undefined);
});

test("openCarryForwardCursor: pruneStale drops un-noted ids, keeps noted ones", () => {
  const prior = new Map<string, Fp>([
    ["a", { updated_at: 1, count: 5 }],
    ["b", { updated_at: 1, count: 6 }],
  ]);
  const cursor = openCarryForwardCursor<Fp>(prior);
  cursor.note("a", { updated_at: 1, count: 5 });
  // Pre-prune both carried; post-prune only the noted id survives.
  assert.equal(cursor.size(), 2);
  cursor.pruneStale();
  assert.deepEqual(cursor.toState(), { a: { updated_at: 1, count: 5 } });
});

test("openCarryForwardCursor: empty prior → first run notes seed the map", () => {
  const cursor = openCarryForwardCursor<Fp>(new Map());
  assert.equal(cursor.size(), 0);
  cursor.note("a", { updated_at: 1, count: 5 });
  assert.equal(cursor.size(), 1);
  assert.deepEqual(cursor.toState().a, { updated_at: 1, count: 5 });
});
