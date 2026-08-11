// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// `resolveNonNegativeMsOrInfinity` backs BOTH `resolveMaxRunWallClockMs` and
// `resolveDispatchLivenessCeilingMs` in runtime/scheduler.ts -- confirmed by
// reading both call sites, not asserted from this file alone. A pure
// function is the right place to prove the "resolved to 0 (disabled)" vs
// "resolved to the real default" distinction: an end-to-end scheduler test
// would need to wait out the real default (30 minutes / 4 hours) to draw
// that line with real timers, which this avoids entirely by asserting the
// resolved value directly.
//
// Migrating `resolveMaxRunWallClockMs` onto this shared resolver is a
// DELIBERATE, DOCUMENTED behavior change for two edge cases its hand-rolled
// form previously got wrong (and that `resolveDispatchLivenessCeilingMs`
// already got right): an explicit negative `maxRunWallClockMs` used to be
// silently accepted (only the env form rejected negatives -- the same
// asymmetry `dispatchLivenessCeilingMs` had); and an empty/whitespace
// `PDPP_MAX_RUN_WALL_CLOCK_MS` used to coerce to `0` via `Number("")`,
// silently disabling the connector-attempt watchdog instead of falling
// back to the 4-hour default. No test in this repo exercised either
// pre-migration edge case (grepped every `maxRunWallClockMs` test usage:
// all pass real config values -- `20`, `5000`, `Infinity` -- never a
// negative or a blank env var), so this migration has no observed
// regression surface; the "compatibility" tests below assert the SHARED
// contract holds identically for both callers' labels/env-var names.

import assert from "node:assert/strict";
import test from "node:test";
import { resolveNonNegativeMsOrInfinity } from "../runtime/scheduler-config.ts";

const DEFAULT_MS = 1_800_000;
const OPTION_NAME = "dispatchLivenessCeilingMs";
const ENV_VAR_NAME = "PDPP_DISPATCH_LIVENESS_CEILING_MS";

function resolve(value: number | undefined, envValue: string | undefined): number {
  return resolveNonNegativeMsOrInfinity(value, envValue, DEFAULT_MS, OPTION_NAME, ENV_VAR_NAME);
}

test("returns the default when both value and env are unset", () => {
  assert.equal(resolve(undefined, undefined), DEFAULT_MS);
});

test("empty or whitespace-only env is treated as UNSET, resolving to the default -- NOT 0", () => {
  assert.equal(resolve(undefined, ""), DEFAULT_MS);
  assert.equal(resolve(undefined, "   "), DEFAULT_MS);
  assert.notEqual(DEFAULT_MS, 0, "sanity: the default itself must not be 0, or this test proves nothing");
});

test('env "0" is a genuine explicit value (disabled), distinct from empty/unset', () => {
  assert.equal(resolve(undefined, "0"), 0);
});

test('env "Infinity" disables the budget', () => {
  assert.equal(resolve(undefined, "Infinity"), Number.POSITIVE_INFINITY);
});

test("a valid positive numeric env value resolves exactly", () => {
  assert.equal(resolve(undefined, "50"), 50);
});

test("a negative env value is rejected", () => {
  assert.throws(() => resolve(undefined, "-1"), /non-negative/);
});

test("a non-numeric env value is rejected", () => {
  assert.throws(() => resolve(undefined, "not-a-number"), /non-negative/);
});

test("an explicit value takes precedence over env", () => {
  assert.equal(resolve(5, "999"), 5);
});

test("an explicit value of 0 is accepted (disabled), not rejected", () => {
  assert.equal(resolve(0, undefined), 0);
});

test("an explicit value of Infinity is accepted (disabled)", () => {
  assert.equal(resolve(Number.POSITIVE_INFINITY, undefined), Number.POSITIVE_INFINITY);
});

test("an explicit negative value is rejected -- symmetric with the env rejection above", () => {
  assert.throws(() => resolve(-1, undefined), /non-negative/);
});

test("an explicit NaN is rejected", () => {
  assert.throws(() => resolve(Number.NaN, undefined), /non-negative/);
});

// ─── Compatibility with the second real caller (maxRunWallClockMs) ─────────
//
// Proves the shared contract holds identically for BOTH real callers'
// labels/env-var names -- not just the dispatchLivenessCeilingMs shape
// exercised above by the module-level `resolve` helper.

function resolveAsMaxRunWallClockMs(value: number | undefined, envValue: string | undefined): number {
  return resolveNonNegativeMsOrInfinity(value, envValue, 14_400_000, "maxRunWallClockMs", "PDPP_MAX_RUN_WALL_CLOCK_MS");
}

test("maxRunWallClockMs: returns its own 4-hour default, distinct from dispatchLivenessCeilingMs's 30-minute default", () => {
  assert.equal(resolveAsMaxRunWallClockMs(undefined, undefined), 14_400_000);
});

test("maxRunWallClockMs: empty/whitespace env resolves to the 4-hour default, NOT 0 -- the deliberate behavior change this migration makes", () => {
  assert.equal(resolveAsMaxRunWallClockMs(undefined, ""), 14_400_000);
  assert.equal(resolveAsMaxRunWallClockMs(undefined, "   "), 14_400_000);
});

test("maxRunWallClockMs: an explicit negative value is now rejected -- the deliberate behavior change this migration makes", () => {
  assert.throws(() => resolveAsMaxRunWallClockMs(-1, undefined), /non-negative/);
});

test("maxRunWallClockMs: error messages carry its own label/env-var name, not dispatchLivenessCeilingMs's", () => {
  assert.throws(() => resolveAsMaxRunWallClockMs(-1, undefined), /maxRunWallClockMs/);
  assert.throws(() => resolveAsMaxRunWallClockMs(undefined, "-1"), /PDPP_MAX_RUN_WALL_CLOCK_MS/);
});

test("maxRunWallClockMs: legitimate values (Infinity, a real budget, env override) are unchanged by the migration", () => {
  assert.equal(resolveAsMaxRunWallClockMs(Number.POSITIVE_INFINITY, undefined), Number.POSITIVE_INFINITY);
  assert.equal(resolveAsMaxRunWallClockMs(20, undefined), 20);
  assert.equal(resolveAsMaxRunWallClockMs(undefined, "5000"), 5000);
  assert.equal(resolveAsMaxRunWallClockMs(undefined, "Infinity"), Number.POSITIVE_INFINITY);
});
