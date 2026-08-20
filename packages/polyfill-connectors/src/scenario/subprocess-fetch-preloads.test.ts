// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for `scaleReplayDelayMs`/`REPLAY_TIME_SCALE`
 * (subprocess-fetch-preloads.ts) — the pure arithmetic
 * `writeReplayBridgePreload`'s generated `.mjs` source applies to every
 * `setTimeout`/`setInterval` delay it intercepts in a replaying subprocess.
 *
 * This is the arithmetic ONLY. The generated preload source itself runs
 * inside a spawned subprocess (a template-literal string, not an importable
 * module) and can't be unit-tested in-process — that end-to-end behavior
 * (relative ordering preserved, a paced replay actually completing fast) is
 * covered by bin/scenario-cli.test.ts instead. The inline copy of this same
 * arithmetic embedded in the generated source (see `writeReplayBridgePreload`'s
 * template literal) MUST stay byte-equivalent to `scaleReplayDelayMs` below —
 * there is no way to import this function into the subprocess, so a change
 * here must be mirrored there by hand (both files carry a doc comment saying
 * so).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { REPLAY_TIME_SCALE, scaleReplayDelayMs } from "./subprocess-fetch-preloads.ts";

test("REPLAY_TIME_SCALE is 100 (the documented, printed factor)", () => {
  assert.equal(REPLAY_TIME_SCALE, 100, "bin/scenario-verify.ts's printed line and this constant must agree");
});

test("scaleReplayDelayMs: scales a typical pacing delay down by REPLAY_TIME_SCALE, rounded up", () => {
  assert.equal(scaleReplayDelayMs(1000), 10, "a 1s pace scales to 10ms");
  assert.equal(scaleReplayDelayMs(20_000), 200, "a 20s pace scales to 200ms");
  assert.equal(scaleReplayDelayMs(30_000), 300, "a 30s backoff scales to 300ms");
});

test("scaleReplayDelayMs: relative ordering is preserved — a longer delay still scales to a longer delay", () => {
  const pace = scaleReplayDelayMs(20_000);
  const backoff = scaleReplayDelayMs(30_000);
  assert.ok(
    backoff > pace,
    `a 30s backoff (${String(backoff)}ms scaled) must stay longer than a 20s pace (${String(pace)}ms scaled)`
  );
});

test("scaleReplayDelayMs: rounds UP (ceil), never down to a false zero for a nonzero delay", () => {
  // 1ms / 100 = 0.01 -> ceil to 1, not floor to 0. A nonzero recorded delay
  // must never scale to a 0ms timer, which some code could misread as "did
  // not wait at all" rather than "waited a negligible amount".
  assert.equal(scaleReplayDelayMs(1), 1);
  assert.equal(scaleReplayDelayMs(50), 1);
  assert.equal(scaleReplayDelayMs(99), 1);
  assert.equal(scaleReplayDelayMs(100), 1);
  assert.equal(scaleReplayDelayMs(101), 2);
});

test("scaleReplayDelayMs: zero and negative delays floor at 0", () => {
  assert.equal(scaleReplayDelayMs(0), 0);
  assert.equal(scaleReplayDelayMs(-5), 0, "a nonsensical negative delay must not scale to a negative timer");
});

test("scaleReplayDelayMs: missing/undefined delay (setTimeout(fn) with no delay arg) treats it as 0, not NaN", () => {
  // globalThis.setTimeout(fn) with no delay argument is valid JS (delay
  // defaults to 0 per the HTML/Node timer spec) — the generated preload's
  // inline copy guards this with `(delayMs ?? 0)` before dividing, so
  // undefined must not propagate to NaN and silently break the connector's
  // timer.
  assert.equal(scaleReplayDelayMs(undefined), 0);
});
