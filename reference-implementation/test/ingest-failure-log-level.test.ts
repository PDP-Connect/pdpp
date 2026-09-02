// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A retryable ingest write is BACKPRESSURE, not an error, and the log level
 * must say so.
 *
 * `connector_instance_busy` means writer admission is saturated. The runtime
 * handles it by itself — bounded retry, then success. Logging that at `error`
 * produced **59 of 82** error lines in a two-hour production window, all from
 * a single connection, none of them an outcome anyone needed to act on.
 *
 * That is the same defect class as a source row naming a remedy the system
 * will not perform: ordinary operation printed as failure teaches the reader to
 * discount the channel, so the one line that IS a real failure gets skimmed
 * past with the other fifty-eight.
 *
 * The line itself stays — `records.ts`'s own comment explains that without it
 * the cause of a systemic ingest failure was visible NOWHERE, since the HTTP
 * response redacts driver detail by design. This pins the LEVEL, not the
 * message, and pins both directions so quieting the noise cannot also quiet a
 * genuine failure.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { classifyIngestFailure, ingestFailureLogLevel } from "../server/records.ts";

/**
 * The predicate the log level keys on. Asserting the classifier directly keeps
 * this test at unit speed and independent of server bootstrap — the level
 * expression is `classified.retryable ? console.warn : console.error`, so
 * `retryable` IS the contract under test.
 */
function levelFor(error: unknown): "error" | "warn" {
  return ingestFailureLogLevel(classifyIngestFailure(error));
}


test("writer-admission saturation classifies RETRYABLE, so it logs as a warning", () => {
  // The exact production shape: 59 of 82 lines in the observed window.
  const busy = Object.assign(new Error("connector-instance writer admission is saturated"), {
    code: "connector_instance_busy",
  });
  assert.equal(
    levelFor(busy),
    "warn",
    "backpressure the runtime resolves on its own must not be logged at error — that is what drowned the real failures"
  );
});

test("a non-retryable ingest failure stays an ERROR", () => {
  // The negative control that makes the split meaningful. Quieting saturation
  // must never quiet a failure nothing will fix on its own.
  // A real member of `PERMANENT_INGEST_FAILURE_CODES`, not an invented driver
  // code: the classifier is an ALLOWLIST, so only these three are permanent.
  const fatal = Object.assign(new Error("connector instance is not writable"), {
    code: "connector_instance_not_writable",
  });
  assert.equal(levelFor(fatal), "error", "a permanent fault is not backpressure; it must keep the level that gets read");
});

test("an UNKNOWN code defaults to retryable, so the warn path is the common one", () => {
  // `classifyIngestFailure` is an allowlist: only the three permanent codes are
  // non-retryable, everything else defaults systemic/retryable by design. That
  // is exactly why the level split matters — the DEFAULT path is the one that
  // was screaming at `error`, not an edge case.
  const unknown = Object.assign(new Error("some driver said no"), { code: "42703" });
  assert.equal(levelFor(unknown), "warn", "unknown defaults to retryable — see PERMANENT_INGEST_FAILURE_CODES");

  // And prose alone never flips it: an error with no code at all is still
  // classified by the allowlist, not by what its message happens to say.
  assert.equal(
    levelFor(new Error("connector_instance_not_writable")),
    "warn",
    "the phrase in a message is not a code — the classifier decides, not the words"
  );
});
