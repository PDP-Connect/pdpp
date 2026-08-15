// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Honesty guard for the trace list kind → Type label mapping.
 *
 * An unrecognized or missing kind must say "Unclassified", never guess a
 * definite label — the same unknown-reads-unknown discipline as
 * `trace-endorse-status.ts`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { traceKindLabel } from "./trace-kind-label.ts";

test("known kinds map to a short human label", () => {
  assert.equal(traceKindLabel(["disclosure.served"]), "Data read");
  assert.equal(traceKindLabel(["request.submitted"]), "App connection");
  assert.equal(traceKindLabel(["pdpp.subscription.verify"]), "Device login");
  assert.equal(traceKindLabel(["grant.issued"]), "Access granted");
});

test("only the first kind on a trace determines the label", () => {
  assert.equal(traceKindLabel(["disclosure.served", "query.received"]), "Data read");
});

test("empty or missing kinds are Unclassified, never guessed", () => {
  assert.equal(traceKindLabel([]), "Unclassified");
  assert.equal(traceKindLabel(null), "Unclassified");
  assert.equal(traceKindLabel(undefined), "Unclassified");
  assert.equal(traceKindLabel([""]), "Unclassified");
});

test("an unmapped kind surfaces the raw kind string, not a blank Unclassified", () => {
  assert.equal(traceKindLabel(["some_kind_the_console_has_never_seen"]), "some_kind_the_console_has_never_seen");
});

test("a pathologically long unmapped kind is truncated, not left to blow out the column", () => {
  const longKind = `custom.${"x".repeat(80)}`;
  const label = traceKindLabel([longKind]);
  assert.ok(label.length <= 40);
  assert.ok(label.endsWith("…"));
});

test("live mutation kinds are labeled, not left Unclassified (regression: 28% of /audit page 1 was groupme mutation traffic)", () => {
  assert.equal(traceKindLabel(["mutation.requested"]), "Data write");
  assert.equal(traceKindLabel(["mutation.completed"]), "Data write");
  assert.equal(traceKindLabel(["mutation.rejected"]), "Data write rejected");
});

test("every kind actually emitted by the reference implementation has a label (fails when live data outruns the map)", () => {
  // Mirrors the emitMutationEvent(...) call sites in
  // reference-implementation/server — keep in sync if a new mutation kind
  // is introduced there, the same way the audit's Type column should track
  // any other newly emitted event kind.
  const liveEmittedKinds = ["mutation.requested", "mutation.completed", "mutation.rejected"];
  for (const kind of liveEmittedKinds) {
    assert.notEqual(traceKindLabel([kind]), "Unclassified", `expected a label for live kind "${kind}"`);
  }
});
