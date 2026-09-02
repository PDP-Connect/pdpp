// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A terminal coverage gap describes data that a future run cannot backfill. It
 * does not prove that the source cannot collect at all. These cases use the
 * same producer as `/sources`: health projection -> rendered verdict.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ComputeConnectionHealthInput,
  type ConnectionRefreshEvidence,
  computeConnectionHealth,
} from "../runtime/connection-health.ts";
import { type StreamRollup, synthesizeRenderedVerdict } from "../runtime/rendered-verdict.ts";

const OBSERVED_AT = "2026-08-27T12:00:00.000Z";
const SUCCESS_TODAY = "2026-08-27T03:12:56.000Z";
const SUCCESS_YESTERDAY = "2026-08-26T03:12:56.000Z";

const SCHEDULED_REFRESH: ConnectionRefreshEvidence = {
  backgroundSafe: true,
  interactionPosture: "none",
  recommendedMode: "automatic",
};

function input(overrides: Partial<ComputeConnectionHealthInput> = {}): ComputeConnectionHealthInput {
  return {
    activity: { active: false },
    attention: null,
    backoff: null,
    coverage: { axis: "terminal_gap" },
    freshness: { axis: "fresh" },
    observedAt: OBSERVED_AT,
    outbox: { axis: "idle" },
    projection: { unreliableSources: [] },
    refresh: SCHEDULED_REFRESH,
    run: { hasDegradingGaps: true, lastSuccessAt: SUCCESS_TODAY, latestStatus: "succeeded", reasonCode: null },
    schedule: { enabled: true },
    ...overrides,
  };
}

function terminalStream(stream_id: string): StreamRollup {
  return {
    attention_open: false,
    collected: null,
    considered: null,
    coverage: "terminal_gap",
    gap_retryable: false,
    priority: "required",
    stream_id,
  };
}

function verdictFor(connection: ComputeConnectionHealthInput, stream_id: string) {
  return synthesizeRenderedVerdict(
    computeConnectionHealth(connection),
    [terminalStream(stream_id)],
    SCHEDULED_REFRESH,
    true,
    {
      last_refreshed_at: connection.run?.lastSuccessAt ?? null,
      mode: "scheduled",
      observed_at: OBSERVED_AT,
      records_committed_last_run: null,
      retained_records: 1,
    }
  );
}

test("Gmail shape: a same-day successful terminal gap stays missing data when the health state is unknown", () => {
  const verdict = verdictFor(
    input({ projection: { unreliableSources: ["terminal_facts_historical"] } }),
    "attachments"
  );

  assert.equal(verdict.pill.tone, "amber");
  assert.equal(verdict.pill.label, "Missing data");
  assert.equal(verdict.forward_statement, "Latest collection completed with known coverage gaps.");
});

test("Jellyfin shape: a same-day success survives a later terminal failure as missing data, not unable to collect", () => {
  const verdict = verdictFor(
    input({
      freshness: { axis: "stale" },
      run: {
        hasDegradingGaps: true,
        lastSuccessAt: SUCCESS_TODAY,
        latestStatus: "failed",
        reasonCode: "runtime_error",
      },
    }),
    "items"
  );

  assert.equal(verdict.pill.tone, "amber");
  assert.equal(verdict.pill.label, "Missing data");
  assert.equal(verdict.forward_statement, "Latest collection completed with known coverage gaps.");
});

test("a source without a same-day successful run remains blocked for a terminal gap", () => {
  const verdict = verdictFor(
    input({
      run: {
        hasDegradingGaps: true,
        lastSuccessAt: SUCCESS_YESTERDAY,
        latestStatus: "failed",
        reasonCode: "runtime_error",
      },
    }),
    "items"
  );

  assert.equal(verdict.pill.tone, "red");
  assert.equal(verdict.pill.label, "Can't collect");
  assert.equal(verdict.forward_statement, "Some data from this source can't be collected.");
});
