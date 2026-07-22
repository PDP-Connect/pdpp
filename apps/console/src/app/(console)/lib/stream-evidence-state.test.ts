// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { isUnexpectedStreamDeclaration, streamCountLabel } from "./stream-evidence-state.ts";

const CONTAINS_DIGIT = /\d/;

test("known count_state renders the exact count, matching the legacy binary check", () => {
  const label = streamCountLabel({ count_state: "known", record_count: 42 });
  assert.equal(label.text, "42 records");
  assert.equal(label.tone, "neutral");
});

test("known_zero renders an explicit 0, distinct from count unavailable", () => {
  const label = streamCountLabel({ count_state: "known_zero", record_count: null });
  assert.equal(label.text, "0 records");
  assert.equal(label.tone, "neutral");
});

test("unobserved never renders a fabricated count", () => {
  const label = streamCountLabel({ count_state: "unobserved", record_count: null });
  assert.equal(label.text, "count not yet observed");
  assert.doesNotMatch(label.text, CONTAINS_DIGIT);
});

test("stale renders count unavailable with a warning tone, never the stale number", () => {
  const label = streamCountLabel({ count_state: "stale", record_count: 7 });
  assert.equal(label.text, "count unavailable");
  assert.equal(label.tone, "warning");
});

test("unknown renders count unavailable with a warning tone", () => {
  const label = streamCountLabel({ count_state: "unknown", record_count: null });
  assert.equal(label.text, "count unavailable");
  assert.equal(label.tone, "warning");
});

test("a reference predating count_state falls back to the legacy null check without inventing a state", () => {
  const withCount = streamCountLabel({ count_state: undefined, record_count: 5 });
  assert.equal(withCount.text, "5 records");
  assert.equal(withCount.tone, "neutral");

  const withoutCount = streamCountLabel({ count_state: undefined, record_count: null });
  assert.equal(withoutCount.text, "count unavailable");
});

test("isUnexpectedStreamDeclaration is true only for the unexpected declaration state", () => {
  assert.equal(isUnexpectedStreamDeclaration("unexpected"), true);
  assert.equal(isUnexpectedStreamDeclaration("declared"), false);
  assert.equal(isUnexpectedStreamDeclaration("unavailable"), false);
  assert.equal(isUnexpectedStreamDeclaration(undefined), false);
});

test("the five count_state values are exactly the documented set", () => {
  const documented = ["known", "known_zero", "unobserved", "stale", "unknown"];
  for (const state of documented) {
    assert.doesNotThrow(() =>
      streamCountLabel({
        count_state: state as Parameters<typeof streamCountLabel>[0]["count_state"],
        record_count: null,
      })
    );
  }
});
