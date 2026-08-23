// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { eventEndorseStatus, traceOverall } from "./trace-timeline-status.ts";

// ─── The defect: a green "complete" for a timeline nobody can read ───────────

test("a trace of events with NO status is never summarised as complete", () => {
  // `SpineEvent.status` is `string | null`, so this is a real input, not a
  // hypothetical. The old detail page called any non-empty event set lacking
  // the exact spellings failed/rejected "complete" in green — while the table
  // right below it rendered every one of these rows as "—".
  const overall = traceOverall([{ status: null }, { status: null }]);

  assert.notEqual(overall.label, "complete", "the console cannot see that this trace finished");
  assert.equal(overall.status, "unknown", "an unreadable timeline must render neutral, never green");
});

test("an unrecognised status is never summarised as complete", () => {
  const overall = traceOverall([{ status: "quarantined_pending_review" }]);

  assert.notEqual(overall.label, "complete");
  assert.equal(overall.status, "unknown", "a status the console has never seen proves nothing about the outcome");
});

test("a still-open trace reads in progress, not complete", () => {
  // Every status here is recognised, so this is NOT unknown — but nothing has
  // reached a terminal success, so "complete" would still be a lie.
  const overall = traceOverall([{ status: "succeeded" }, { status: "started" }]);

  assert.equal(overall.label, "in progress");
  assert.equal(overall.status, "continuous");
});

test("a partly-unknown trace is reported as partly unknown, not by its readable majority", () => {
  const overall = traceOverall([{ status: "succeeded" }, { status: "succeeded" }, { status: null }]);

  assert.equal(overall.label, "partly unknown");
  assert.equal(overall.status, "unknown");
});

// ─── Preserved honest behaviour ──────────────────────────────────────────────

test("a fully succeeded trace still earns its green complete", () => {
  const overall = traceOverall([{ status: "succeeded" }, { status: "completed" }]);

  assert.equal(overall.label, "complete", "the guard must not refuse a genuinely complete trace");
  assert.equal(overall.status, "active");
});

test("a failure anywhere outranks every other axis, including unknown", () => {
  assert.deepEqual(traceOverall([{ status: "succeeded" }, { status: "failed" }]), {
    label: "has failures",
    status: "denied",
  });
  assert.deepEqual(traceOverall([{ status: null }, { status: "rejected" }]), {
    label: "has failures",
    status: "denied",
  });
});

test("an empty trace is unknown, not complete and not a failure", () => {
  const overall = traceOverall([]);

  assert.equal(overall.label, "empty");
  assert.equal(overall.status, "unknown", "no events is no evidence — it is not a continuous/in-flight claim");
});

// ─── Per-event mapping ───────────────────────────────────────────────────────

test("eventEndorseStatus maps an absent or unrecognised status to unknown", () => {
  // The old local mapper returned "continuous" for both, painting an event the
  // console cannot read as though it were healthily in flight.
  assert.equal(eventEndorseStatus(null), "unknown");
  assert.equal(eventEndorseStatus(""), "unknown");
  assert.equal(eventEndorseStatus("some_status_the_console_has_never_seen"), "unknown");
});

test("eventEndorseStatus preserves every recognised status mapping", () => {
  assert.equal(eventEndorseStatus("completed"), "active");
  assert.equal(eventEndorseStatus("succeeded"), "active");
  assert.equal(eventEndorseStatus("failed"), "denied");
  assert.equal(eventEndorseStatus("rejected"), "denied");
  assert.equal(eventEndorseStatus("cancelled"), "revoked");
  assert.equal(eventEndorseStatus("revoked"), "revoked");
  assert.equal(eventEndorseStatus("pending"), "expiring");
  assert.equal(eventEndorseStatus("started"), "continuous");
  assert.equal(eventEndorseStatus("in_progress"), "continuous");
});
