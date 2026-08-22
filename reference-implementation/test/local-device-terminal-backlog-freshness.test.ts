// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  hasTerminalOnlyOutboxBacklog,
  type LocalDeviceProgress,
  localDeviceFreshnessHeartbeatAt,
} from "../server/ref-control.ts";

// A local-device source whose outbox holds ONLY dead-lettered rows still has a
// live collector: a dead letter has exhausted its retries and will never drain
// on its own, so it is a settled fact about lost records, not evidence that
// collection stopped.
//
// Observed in production (peregrine Claude Code, 2026-08-22): outbox
// total 10001 / succeeded 10000 / pending 0 / retrying 0 / dead_letter 1 /
// backlog_open 1, heartbeat 10.5 minutes old, 18,453 ingest batches all
// accepted with zero rejections. That single terminal row forced heartbeat
// `blocked` -> outbox `stalled`, which disqualified the freshness heartbeat and
// rendered a 2,511,513-record source as RED "can't collect - freshness has not
// been measured yet".
//
// These tests pin the carve-out AND its limits: live work, a stale heartbeat,
// an unknown count, or a non-dead-letter cause must all stay conservative.
// Pure — no DB.

const NOW = "2026-08-22T03:00:00.000Z";
const FRESH_HEARTBEAT = "2026-08-22T02:49:30.000Z"; // 10.5 min old, matches prod
const STALE_HEARTBEAT = "2026-08-22T02:00:00.000Z"; // 60 min old, past the 30 min policy
const GENERATION = 12;

/** The exact production shape: one terminal row, nothing live. */
function terminalOnlyCounts(overrides: Record<string, unknown> = {}) {
  return { backlog_open: 1, dead_letter: 1, leased: 0, pending: 0, retrying: 0, stale_leases: 0, ...overrides };
}

function progress(overrides: Partial<LocalDeviceProgress> = {}): LocalDeviceProgress {
  return {
    last_heartbeat_at: FRESH_HEARTBEAT,
    last_heartbeat_status: "blocked",
    last_ingest_at: FRESH_HEARTBEAT,
    manifest_generation: GENERATION,
    outbox_counts: terminalOnlyCounts(),
    records_pending: 0,
    source_count: 1,
    ...overrides,
  };
}

const STALLED_DEAD_LETTER = { axis: "stalled", cause: "dead_letter_backlog" } as const;

test("terminal-only backlog: a fresh blocked heartbeat with only dead letters still proves freshness", () => {
  assert.equal(
    localDeviceFreshnessHeartbeatAt(progress(), STALLED_DEAD_LETTER, GENERATION, NOW),
    FRESH_HEARTBEAT,
    "one permanently-rejected record must not make a live collector's freshness unmeasurable"
  );
});

test("terminal-only backlog: live pending work keeps the stall load-bearing", () => {
  // peregrine Codex's real shape: 2 records still pending. Nothing is settled
  // here, so this must NOT be greened.
  assert.equal(
    localDeviceFreshnessHeartbeatAt(
      progress({ outbox_counts: terminalOnlyCounts({ dead_letter: 0, pending: 2 }), records_pending: 2 }),
      STALLED_DEAD_LETTER,
      GENERATION,
      NOW
    ),
    null
  );
});

test("terminal-only backlog: a retrying row is live work, not a terminal backlog", () => {
  assert.equal(
    localDeviceFreshnessHeartbeatAt(
      progress({ outbox_counts: terminalOnlyCounts({ retrying: 1 }) }),
      STALLED_DEAD_LETTER,
      GENERATION,
      NOW
    ),
    null
  );
});

test("terminal-only backlog: a stale heartbeat is never greened", () => {
  // `classifyBlockedHeartbeat` returns `dead_letter_backlog` BEFORE it consults
  // heartbeat age, so without an explicit staleness guard this carve-out would
  // green a collector that died months ago.
  assert.equal(
    localDeviceFreshnessHeartbeatAt(
      progress({ last_heartbeat_at: STALE_HEARTBEAT }),
      STALLED_DEAD_LETTER,
      GENERATION,
      NOW
    ),
    null
  );
});

test("terminal-only backlog: a non-dead-letter stall stays stalled", () => {
  // `state_read_failed` means the server cannot read the collector's state at
  // all. That is not a settled fact about lost records.
  assert.equal(
    localDeviceFreshnessHeartbeatAt(
      progress({ outbox_counts: terminalOnlyCounts({ dead_letter: 0 }) }),
      { axis: "stalled", cause: "state_read_failed" },
      GENERATION,
      NOW
    ),
    null
  );
});

test("terminal-only backlog: a manifest-generation mismatch still disqualifies", () => {
  assert.equal(localDeviceFreshnessHeartbeatAt(progress(), STALLED_DEAD_LETTER, GENERATION + 1, NOW), null);
});

test("hasTerminalOnlyOutboxBacklog requires positive dead-letter evidence and zero live work", () => {
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts(), "dead_letter_backlog"), true);
  // Absence of evidence is never a terminal backlog.
  assert.equal(hasTerminalOnlyOutboxBacklog(null, "dead_letter_backlog"), false);
  assert.equal(hasTerminalOnlyOutboxBacklog({}, "dead_letter_backlog"), false);
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts({ dead_letter: 0 }), "dead_letter_backlog"), false);
  // Any live work disqualifies, one field at a time.
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts({ pending: 1 }), "dead_letter_backlog"), false);
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts({ retrying: 1 }), "dead_letter_backlog"), false);
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts({ leased: 1 }), "dead_letter_backlog"), false);
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts({ stale_leases: 1 }), "dead_letter_backlog"), false);
  // Cause must match.
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts(), "state_read_failed"), false);
  assert.equal(hasTerminalOnlyOutboxBacklog(terminalOnlyCounts(), null), false);
});

test("pre-existing idle/active freshness paths are unchanged", () => {
  assert.equal(
    localDeviceFreshnessHeartbeatAt(
      progress({ last_heartbeat_status: "healthy", outbox_counts: null }),
      { axis: "idle" },
      GENERATION,
      NOW
    ),
    FRESH_HEARTBEAT
  );
  assert.equal(
    localDeviceFreshnessHeartbeatAt(
      progress({ last_heartbeat_status: "starting", outbox_counts: null, records_pending: 5 }),
      { axis: "active" },
      GENERATION,
      NOW
    ),
    FRESH_HEARTBEAT
  );
});
