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

test("unrecognized, empty, or missing kinds are Unclassified, never guessed", () => {
  assert.equal(traceKindLabel(["some_kind_the_console_has_never_seen"]), "Unclassified");
  assert.equal(traceKindLabel([]), "Unclassified");
  assert.equal(traceKindLabel(null), "Unclassified");
  assert.equal(traceKindLabel(undefined), "Unclassified");
  assert.equal(traceKindLabel([""]), "Unclassified");
});
