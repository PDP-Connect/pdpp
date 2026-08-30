// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the "no active browser assistance" stream-page state
 * machine: `selectNoAssistanceStreamState` decides resolved vs. ended
 * (terminal failure — the page must show a definite state here, never spin
 * forever) vs. running, and `resolveNoAssistanceEndedTerminalStatus` picks
 * the specific ended reason. `page.tsx` only reaches these once
 * `getCurrentBrowserSurfaceAssistance` has already gone null for the run
 * (see `run-assistance.test.ts` for the challenge-resolved transition that
 * gets the page here in the first place).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveNoAssistanceEndedTerminalStatus, selectNoAssistanceStreamState } from "./stream-state.ts";

test("a completed terminal_status resolves regardless of runHandleStatus", () => {
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "active", terminalStatus: "completed" }), "resolved");
});

test("a completed runHandleStatus resolves when terminal_status is still null (not yet caught up)", () => {
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "completed", terminalStatus: null }), "resolved");
});

for (const terminalStatus of ["failed", "cancelled", "abandoned"] as const) {
  test(`a ${terminalStatus} terminal_status ends the run — never an infinite spinner`, () => {
    assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "active", terminalStatus }), "ended");
  });
}

for (const runHandleStatus of [
  "failed",
  "cancelled",
  "abandoned",
  "deferred",
  "expired",
  "released",
  "surface_failed",
] as const) {
  test(`a ${runHandleStatus} runHandleStatus ends the run when terminal_status hasn't caught up yet`, () => {
    assert.equal(selectNoAssistanceStreamState({ runHandleStatus, terminalStatus: null }), "ended");
  });
}

test("an active run with no terminal signal keeps running (the page keeps polling)", () => {
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "active", terminalStatus: null }), "running");
});

test("a null runHandleStatus with no terminal_status keeps running (status not loaded yet)", () => {
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: null, terminalStatus: null }), "running");
});

test("terminal_status takes precedence over a stale/contradictory runHandleStatus", () => {
  // Regression guard: if the timeline's terminal event already says
  // "completed" but the separately-fetched run-status read raced and still
  // reports "failed", the page must not flip to a destructive-looking
  // RunEndedSurface for a run that actually succeeded.
  assert.equal(selectNoAssistanceStreamState({ runHandleStatus: "failed", terminalStatus: "completed" }), "resolved");
});

test("resolveNoAssistanceEndedTerminalStatus prefers the explicit terminal_status reason", () => {
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "active", terminalStatus: "cancelled" }),
    "cancelled"
  );
});

test("resolveNoAssistanceEndedTerminalStatus falls back to runHandleStatus when terminal_status hasn't caught up", () => {
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "deferred", terminalStatus: null }),
    "deferred"
  );
});

test("resolveNoAssistanceEndedTerminalStatus defaults to 'failed' for statuses with no dedicated ended label (e.g. surface_failed)", () => {
  assert.equal(
    resolveNoAssistanceEndedTerminalStatus({ runHandleStatus: "surface_failed", terminalStatus: null }),
    "failed"
  );
});
