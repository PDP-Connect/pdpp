// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTerminalKnownGap,
  isOwnerRecoverableKnownGap,
  isRetryableKnownGap,
} from "../server/connector-gap-classification.ts";
import type { ConnectorRunSummary } from "../server/ref-control.ts";

test("assistance timeout gaps are owner/session-recoverable, not maintainer-code terminal gaps", () => {
  const gap = {
    kind: "run_failed",
    reason: "assistance_timed_out",
    recovery_hint: { action: "unknown", retryable: false },
    severity: "actionable",
  };

  const run: ConnectorRunSummary = {
    collection_facts: null,
    event_count: 0,
    failure_reason: null,
    finished_at: null,
    first_at: "2026-01-01T00:00:00.000Z",
    known_gaps: [gap],
    last_at: "2026-01-01T00:00:00.000Z",
    recovery_only: false,
    run_id: "run-1",
    started_at: "2026-01-01T00:00:00.000Z",
    status: "failed",
    terminal_reason: null,
  };

  assert.equal(isOwnerRecoverableKnownGap(gap), true);
  assert.equal(isRetryableKnownGap(gap), true);
  assert.equal(hasTerminalKnownGap(run), false);
});
