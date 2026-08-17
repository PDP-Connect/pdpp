// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Presented heartbeat health must come from heartbeat AGE against the declared
 * lease, not from the last observed status alone.
 *
 * Reported by the owner from the live UAT deployment, 2026-08-08: a source
 * instance carried `last_heartbeat_status = 'starting'` with a null
 * `last_error_json` for 38+ hours and rendered as healthy and actively
 * starting. The collector is one-shot by design
 * (docs/reference/local-collector.md, "Durable Services And Timers") — it
 * emits a few lifecycle heartbeats per invocation and exits — so when a
 * hand-run collector was killed with its terminal, nothing ever rewrote the
 * column. The last status was real; it was just 38 hours out of date, and
 * age was the only thing that could reveal that.
 *
 * The rules pinned here:
 *   1. Beyond the lease, present `stale` — never the stale status verbatim.
 *   2. The last observed status is retained as evidence, not as the answer.
 *   3. No heartbeat (or an unparseable one) is `unknown`, never healthy.
 *   4. The lease is a declared constant reported alongside the verdict.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS } from "../server/connector-outbox-axis.ts";
import { HEARTBEAT_LEASE_MS, presentHeartbeatHealth } from "../server/heartbeat-lease.ts";

const NOW = "2026-08-08T12:00:00.000Z";

/** The exact live shape: a one-shot collector killed mid-`starting`, 38h ago. */
const KILLED_38_HOURS_AGO = "2026-08-06T22:00:00.000Z";

test("a 'starting' heartbeat older than the lease presents as stale, not as starting", () => {
  const presented = presentHeartbeatHealth({
    lastHeartbeatAt: KILLED_38_HOURS_AGO,
    lastHeartbeatStatus: "starting",
    nowIso: NOW,
  });

  assert.equal(presented.status, "stale", "a dead process's last 'starting' is not current health");
  assert.notEqual(presented.status, "starting", "the stale status must never be presented verbatim");
});

test("the last observed status survives as evidence alongside the stale verdict", () => {
  const presented = presentHeartbeatHealth({
    lastHeartbeatAt: KILLED_38_HOURS_AGO,
    lastHeartbeatStatus: "starting",
    nowIso: NOW,
  });

  assert.equal(presented.lastObservedStatus, "starting", "what the collector last said is still worth showing");
  assert.equal(presented.ageMs, 38 * 60 * 60 * 1000, "and the age that disqualified it is reported");
  assert.equal(presented.leaseMs, HEARTBEAT_LEASE_MS, "against the declared lease");
});

test("a heartbeat within the lease passes the collector's own status through", () => {
  for (const status of ["blocked", "healthy", "retrying", "starting", "stopped"]) {
    const presented = presentHeartbeatHealth({
      lastHeartbeatAt: "2026-08-08T11:59:00.000Z",
      lastHeartbeatStatus: status,
      nowIso: NOW,
    });
    assert.equal(presented.status, status, `a fresh '${status}' is still '${status}'`);
  }
});

test("the lease boundary is inclusive: exactly at the lease is still current, one ms past is stale", () => {
  const atBoundary = new Date(Date.parse(NOW) - HEARTBEAT_LEASE_MS).toISOString();
  const oneMsPast = new Date(Date.parse(NOW) - HEARTBEAT_LEASE_MS - 1).toISOString();

  assert.equal(
    presentHeartbeatHealth({ lastHeartbeatAt: atBoundary, lastHeartbeatStatus: "healthy", nowIso: NOW }).status,
    "healthy"
  );
  assert.equal(
    presentHeartbeatHealth({ lastHeartbeatAt: oneMsPast, lastHeartbeatStatus: "healthy", nowIso: NOW }).status,
    "stale"
  );
});

test("no heartbeat, or an unparseable one, is unknown rather than healthy", () => {
  for (const lastHeartbeatAt of [null, undefined, "", "not-a-timestamp"]) {
    const presented = presentHeartbeatHealth({
      lastHeartbeatAt,
      // A status with no age behind it must not carry the verdict on its own.
      lastHeartbeatStatus: "healthy",
      nowIso: NOW,
    });
    assert.equal(presented.status, "unknown", `absent/unparseable timestamp ${JSON.stringify(lastHeartbeatAt)}`);
    assert.equal(presented.ageMs, null, "and reports no age rather than a NaN one");
  }
});

test("a fresh heartbeat carrying a status outside the protocol enum is unknown", () => {
  // The column is untyped TEXT in both backends, so an off-enum value can
  // reach a reader. Presenting it verbatim would leak an unvalidated string
  // into a health surface.
  const presented = presentHeartbeatHealth({
    lastHeartbeatAt: "2026-08-08T11:59:00.000Z",
    lastHeartbeatStatus: "ok",
    nowIso: NOW,
  });

  assert.equal(presented.status, "unknown");
  assert.equal(presented.lastObservedStatus, "ok", "but the raw value is still retained as evidence");
});

test("the lease matches the outbox axis's stale-heartbeat window", () => {
  // Both answer "is this check-in still evidence of a live collector?". If
  // they diverge, a source instance can present as healthy while its own
  // outbox axis reads stalled.
  assert.equal(HEARTBEAT_LEASE_MS, OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS);
});
