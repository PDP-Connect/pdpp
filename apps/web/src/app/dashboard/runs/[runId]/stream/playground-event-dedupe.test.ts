import assert from "node:assert/strict";
import { test } from "node:test";

import {
  claimPlaygroundEvent,
  createPlaygroundSeenRegistry,
  PLAYGROUND_SEEN_REGISTRY_MAX,
} from "./playground-event-dedupe.ts";

test("claimPlaygroundEvent claims a fresh seq+pageId pair exactly once", () => {
  const r = createPlaygroundSeenRegistry();
  assert.equal(claimPlaygroundEvent(r, { pageId: "P1", seq: 1, type: "click" }), "claimed");
  assert.equal(claimPlaygroundEvent(r, { pageId: "P1", seq: 1, type: "click" }), "duplicate");
  assert.equal(claimPlaygroundEvent(r, { pageId: "P1", seq: 2, type: "click" }), "claimed");
});

test("claimPlaygroundEvent scopes seq dedupe to pageId so a remote reload does not silently drop new events", () => {
  // Brittle bare-watermark behaviour we are explicitly avoiding:
  // page A emits seq 1..10, then the page reloads as page B and
  // restarts seq at 1. Under a high-watermark dedupe, B's seq=1..9
  // would all be skipped because they fall under the prior
  // watermark of 10. With pageId-scoped keys, B's events are
  // independently claimed.
  const r = createPlaygroundSeenRegistry();
  for (let s = 1; s <= 10; s += 1) {
    assert.equal(claimPlaygroundEvent(r, { pageId: "page-A", seq: s, type: "click" }), "claimed");
  }
  // Now the page reloads — same seq numbers, new pageId.
  for (let s = 1; s <= 10; s += 1) {
    assert.equal(
      claimPlaygroundEvent(r, { pageId: "page-B", seq: s, type: "click" }),
      "claimed",
      `page-B seq ${s} must NOT be deduped against page-A`
    );
  }
  // A duplicate of an old page-A event still dedupes (the registry
  // hasn't evicted that key yet).
  assert.equal(claimPlaygroundEvent(r, { pageId: "page-A", seq: 5, type: "click" }), "duplicate");
});

test("claimPlaygroundEvent handles missing/invalid seq by claiming (we never silently drop unkeyable events)", () => {
  const r = createPlaygroundSeenRegistry();
  assert.equal(claimPlaygroundEvent(r, { pageId: "P", type: "click" }), "claimed");
  assert.equal(
    claimPlaygroundEvent(r, { pageId: "P", seq: "1", type: "click" } as unknown as Record<string, unknown>),
    "claimed"
  );
  assert.equal(claimPlaygroundEvent(r, null), "unkeyable");
  assert.equal(claimPlaygroundEvent(r, undefined), "unkeyable");
  assert.equal(claimPlaygroundEvent(r, "not-an-event" as unknown as Record<string, unknown>), "unkeyable");
});

test("claimPlaygroundEvent falls back to anon pageId so legacy events still scope to seq", () => {
  // Pre-pageId playground builds emit events without `pageId`. The
  // registry must still dedupe by seq within one session, just under
  // a stable "anon" scope.
  const r = createPlaygroundSeenRegistry();
  assert.equal(claimPlaygroundEvent(r, { seq: 1, type: "click" }), "claimed");
  assert.equal(claimPlaygroundEvent(r, { seq: 1, type: "click" }), "duplicate");
  assert.equal(claimPlaygroundEvent(r, { pageId: "", seq: 1, type: "click" }), "duplicate");
});

test("claimPlaygroundEvent bounds memory by evicting oldest keys past the cap", () => {
  // Use a tiny cap to make eviction observable. The contract: when
  // the registry exceeds cap, the OLDEST inserted key is evicted
  // first. After eviction, that key is no longer treated as a
  // duplicate (acceptable risk: the playground ring is 24 entries
  // and the production cap is 512, so the evicted key is well past
  // any window where it could still be in flight from the remote).
  const r = createPlaygroundSeenRegistry();
  for (let s = 1; s <= 5; s += 1) {
    assert.equal(claimPlaygroundEvent(r, { pageId: "P", seq: s, type: "click" }, { max: 3 }), "claimed");
  }
  // Cap=3 retains seq 3,4,5 — seq 1,2 evicted.
  assert.equal(claimPlaygroundEvent(r, { pageId: "P", seq: 5, type: "click" }, { max: 3 }), "duplicate");
  assert.equal(claimPlaygroundEvent(r, { pageId: "P", seq: 4, type: "click" }, { max: 3 }), "duplicate");
  assert.equal(claimPlaygroundEvent(r, { pageId: "P", seq: 3, type: "click" }, { max: 3 }), "duplicate");
  // seq 1 was evicted — re-claiming it is allowed (it's a different event).
  assert.equal(claimPlaygroundEvent(r, { pageId: "P", seq: 1, type: "click" }, { max: 3 }), "claimed");
});

test("PLAYGROUND_SEEN_REGISTRY_MAX is well above the playground ring buffer size", () => {
  // The remote playground page caps its ring buffer at 24 events.
  // The viewer-side dedupe registry must be at least an order of
  // magnitude larger so an evicted key cannot still be in the
  // remote buffer waiting to be drained again.
  assert.ok(
    PLAYGROUND_SEEN_REGISTRY_MAX >= 24 * 10,
    `PLAYGROUND_SEEN_REGISTRY_MAX=${PLAYGROUND_SEEN_REGISTRY_MAX} must comfortably exceed the remote ring buffer`
  );
});
