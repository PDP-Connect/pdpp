// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure decision coverage for `shouldYieldBeforeNextIngestRecord`
 * (server/records.ts) — the function that decides whether the ingest
 * batch loop should yield to the event loop before moving to the next
 * record.
 *
 * Isolated from timing/setImmediate: this is a synchronous, deterministic
 * function of its four inputs, so these are pure counterweight tests, not
 * a benchmark. They pin two decisions that a timing-based test cannot
 * reliably distinguish from noise:
 *
 * 1. The explicit yield applies to SQLite only — ingestPostgresRecord
 *    already yields on real query I/O per record (see
 *    /tmp/as-latency-review.md), so an explicit yield there is pure
 *    unnecessary overhead with no starvation to fix. FALSE for Postgres,
 *    budget-dependent TRUE for SQLite.
 * 2. Never yields on the last record of a batch — no further batch work
 *    follows it before the function returns.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shouldYieldBeforeNextIngestRecord } from "../server/records.ts";

test("shouldYieldBeforeNextIngestRecord returns false for Postgres regardless of elapsed time", () => {
  assert.equal(
    shouldYieldBeforeNextIngestRecord({
      backendIsSqlite: false,
      isLastRecord: false,
      lastYieldAt: 0,
      now: 1_000_000, // far past any budget
    }),
    false,
    "Postgres already yields on real query I/O per record; an explicit yield here is unnecessary overhead"
  );
});

test("shouldYieldBeforeNextIngestRecord returns true for SQLite once the budget elapses", () => {
  assert.equal(
    shouldYieldBeforeNextIngestRecord({
      backendIsSqlite: true,
      isLastRecord: false,
      lastYieldAt: 0,
      now: 1_000_000, // far past any budget
    }),
    true,
    "SQLite's writeTransaction has no libuv yield of its own — the mechanism this fix addresses"
  );
});

test("shouldYieldBeforeNextIngestRecord returns false for SQLite before the budget elapses", () => {
  assert.equal(
    shouldYieldBeforeNextIngestRecord({
      backendIsSqlite: true,
      isLastRecord: false,
      lastYieldAt: 100,
      now: 100.5, // 0.5ms elapsed, under the 1ms shipped budget
    }),
    false,
    "should not yield before accumulated work exceeds the budget"
  );
});

test("shouldYieldBeforeNextIngestRecord never yields on the last record, SQLite or Postgres", () => {
  for (const backendIsSqlite of [true, false]) {
    assert.equal(
      shouldYieldBeforeNextIngestRecord({
        backendIsSqlite,
        isLastRecord: true,
        lastYieldAt: 0,
        now: 1_000_000, // far past any budget — would yield if isLastRecord didn't short-circuit
      }),
      false,
      `backendIsSqlite=${backendIsSqlite}: no further batch work follows the last record before the function returns`
    );
  }
});

test("shouldYieldBeforeNextIngestRecord: last-record guard takes precedence over an elapsed SQLite budget", () => {
  // Regression pin: a future refactor that reorders the two guards (backend
  // check vs. last-record check) must not accidentally make the last record
  // yield again just because the backend check happens to run first.
  assert.equal(
    shouldYieldBeforeNextIngestRecord({
      backendIsSqlite: true,
      isLastRecord: true,
      lastYieldAt: 0,
      now: 500,
    }),
    false
  );
});
