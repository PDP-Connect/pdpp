#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Hermetic guard for the UAT verifier's recency predicate
// (scripts/uat-verify-recency.mjs).
//
// `uat-verify.mjs` itself runs against a deployed instance (docker exec +
// authenticated HTTP), so it is not testable in-process. Its time-window
// predicate is pure SQL, though, and that is where the defect lived — so these
// cases run the real predicate against a real in-memory SQLite, with rows at
// controlled offsets from `now`. No docker, no network, no fixture DB.
//
// The discriminator: `run_history.started_at` is ISO-8601 with a 'T'
// separator, while `datetime('now', ...)` renders a space. A lexicographic
// `>` therefore counts EVERY same-UTC-day row as "within the last hour",
// however old it is. The `SAME UTC DAY` cases below are the ones that fail
// under the old predicate and pass under `withinLastHours`.

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { withinLastHours } from "./uat-verify-recency.mjs";

// The exact expression the verifier used before the fix.
const NAIVE_PREDICATE = "started_at > datetime('now','-1 hour')";

/** ISO-8601 (with 'T' and 'Z'), the format the runtime actually writes. */
function isoAgo(db, modifier) {
  return db.prepare(`select strftime('%Y-%m-%dT%H:%M:%fZ','now',?) v`).get(modifier).v;
}

/** ISO instant at a fixed clock time on the CURRENT UTC date. */
function isoTodayAt(db, clock) {
  return db.prepare(`select strftime('%Y-%m-%d','now') || 'T' || ? || '.000Z' v`).get(clock).v;
}

function seed(rows) {
  const db = new DatabaseSync(":memory:");
  db.exec("create table run_history (connector_id text, started_at text)");
  const insert = db.prepare("insert into run_history values (?, ?)");
  for (const [connectorId, startedAt] of rows(db)) {
    insert.run(connectorId, startedAt);
  }
  return db;
}

function matches(db, predicate) {
  return db
    .prepare(`select connector_id from run_history where ${predicate} order by connector_id`)
    .all()
    .map((r) => r.connector_id);
}

test("recency: a same-UTC-day row hours outside the window is EXCLUDED", () => {
  // The live defect. Jellyfin's flagged skips were 13.4h and 14.5h old and its
  // five most recent runs had all succeeded, yet the verifier reported an
  // active self-poisoning loop. Pinned at 00:00:01Z so the row is always the
  // same UTC date as `now` while being far outside a 1-hour window.
  const db = seed((d) => [["jellyfin", isoTodayAt(d, "00:00:01")]]);
  const hoursAgo = db
    .prepare("select round((julianday('now') - julianday(started_at)) * 24, 2) h from run_history")
    .get().h;

  if (hoursAgo <= 1) {
    // Only true when the suite runs within an hour of UTC midnight, where the
    // row is legitimately recent and cannot discriminate. Skip rather than
    // assert a false expectation.
    return;
  }

  assert.deepEqual(
    matches(db, withinLastHours("started_at")),
    [],
    `a row ${hoursAgo}h old must not count as within the last hour`
  );
  assert.deepEqual(
    matches(db, NAIVE_PREDICATE),
    ["jellyfin"],
    "regression witness: the naive lexicographic compare wrongly counts this same-day row as recent"
  );
});

test("recency: a genuinely recent row is still INCLUDED", () => {
  // The control that keeps the fix honest — a real live loop must still FAIL
  // the verifier. Without this, `where 0` would pass the case above.
  const db = seed((d) => [["jellyfin", isoAgo(d, "-5 minutes")]]);
  assert.deepEqual(
    matches(db, withinLastHours("started_at")),
    ["jellyfin"],
    "a 5-minute-old row is genuinely within the last hour and must still be reported"
  );
});

test("recency: rows from earlier days stay EXCLUDED", () => {
  // These were already excluded before the fix (lexicographic compare happens
  // to be correct across date boundaries); pinned so a future rewrite of the
  // predicate cannot widen the window in the other direction.
  const db = seed((d) => [
    ["yesterday", isoAgo(d, "-25 hours")],
    ["last-week", isoAgo(d, "-7 days")],
  ]);
  assert.deepEqual(matches(db, withinLastHours("started_at")), []);
});

test("recency: boundary rows on either side of the window are classified correctly", () => {
  const db = seed((d) => [
    ["just-inside", isoAgo(d, "-59 minutes")],
    ["just-outside", isoAgo(d, "-61 minutes")],
  ]);
  assert.deepEqual(matches(db, withinLastHours("started_at")), ["just-inside"]);
});

test("recency: the window size is honored for non-default spans", () => {
  const db = seed((d) => [
    ["three-hours", isoAgo(d, "-3 hours")],
    ["nine-hours", isoAgo(d, "-9 hours")],
  ]);
  assert.deepEqual(matches(db, withinLastHours("started_at", 6)), ["three-hours"]);
});

test("recency: the predicate also parses SQLite-format (space-separated) timestamps", () => {
  // `julianday()` handles both shapes, so the helper stays correct if a future
  // writer stores `datetime()`-formatted values instead of ISO strings.
  const db = seed((d) => [
    ["sqlite-recent", d.prepare("select datetime('now','-5 minutes') v").get().v],
    ["sqlite-old", d.prepare("select datetime('now','-5 hours') v").get().v],
  ]);
  assert.deepEqual(matches(db, withinLastHours("started_at")), ["sqlite-recent"]);
});
