// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "@pdpp/connector-protocol/connector-runtime-protocol";

/**
 * `SKIP_RESULT.boundary_claim` type contract.
 *
 * GroupMe emits `boundary_claim: "provider_history_boundary"` on its
 * history-boundary SKIP_RESULT (connectors/groupme/index.ts) mapping onto the
 * closed vocabulary `RuntimeSkipBoundaryClaim` that
 * reference-implementation/server/ref-control.ts validates against before
 * persisting into `known_gaps`. The vendored `@pdpp/connector-protocol`
 * package's `EmittedMessage` SKIP_RESULT variant must mirror that same closed
 * literal — not widen to `string` — so an unrecognized claim is a `tsc`
 * error at the connector, not a value that type-checks and is silently
 * dropped only at runtime.
 *
 * Two enforcement layers are proven here:
 *   1. COMPILE-TIME (the primary mechanism): the real, shipped GroupMe value
 *      assigns cleanly; an unrecognized literal does not. The
 *      `@ts-expect-error` below is the executable proof — if the field is
 *      ever widened back to `string`, the suppression becomes unused and
 *      `tsc --noEmit` fails.
 *   2. This file's own `node:test` run is a no-op assertion; the contract
 *      lives entirely in whether the file type-checks.
 */

type SkipResult = Extract<EmittedMessage, { type: "SKIP_RESULT" }>;

test("the shipped GroupMe boundary_claim value satisfies the vendored SKIP_RESULT type", () => {
  const msg: SkipResult = {
    type: "SKIP_RESULT",
    stream: "group_messages",
    reason: "history_ended_before_provider_count",
    message: "GroupMe's history ran out before reaching its own message total.",
    boundary_claim: "provider_history_boundary",
  };

  assert.equal(msg.boundary_claim, "provider_history_boundary");
});

test("an unrecognized boundary_claim literal fails to compile", () => {
  const msg: SkipResult = {
    type: "SKIP_RESULT",
    stream: "group_messages",
    reason: "history_ended_before_provider_count",
    message: "unused",
    // @ts-expect-error — "not_a_real_claim" is outside the closed vocabulary;
    // only "provider_history_boundary" is assignable.
    boundary_claim: "not_a_real_claim",
  };

  assert.ok(msg);
});

test("boundary_claim remains optional — SKIP_RESULT with no claim still satisfies the type", () => {
  const msg: SkipResult = {
    type: "SKIP_RESULT",
    stream: "group_messages",
    reason: "stream_collection_failed",
    message: "unused",
  };

  assert.equal(msg.boundary_claim, undefined);
});
