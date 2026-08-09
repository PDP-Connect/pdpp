// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Presented health for a device source instance, derived from heartbeat AGE
// against a declared lease — not from the last observed status alone.
//
// A last status with no age attached is not current health. Device collectors
// are one-shot by design (docs/reference/local-collector.md, "Durable Services
// And Timers"): each invocation drains the outbox, records health, and exits.
// There is no timer, so a collector emits only a handful of lifecycle
// heartbeats per invocation and nothing at all between invocations. Nothing
// rewrites `last_heartbeat_status` when the process dies — a collector killed
// mid-run (its terminal closed, the host rebooted) leaves `starting` in the
// column permanently, and a reader that trusts the column renders that dead
// process as starting-up-right-now forever.
//
// The runtime already applies this reasoning on the outbox axis
// (`deriveOutboxAxisFromHeartbeat`, which degrades a stale `starting` to
// `stalled`). This module carries the same policy to the presented health of a
// source instance, so the two cannot disagree about whether a check-in is
// still current.
//
// Scope: presentation only. Persisting a supervisor/install so the collector
// keeps checking in is separate lifecycle work and is deliberately not
// attempted here.

/**
 * How long a heartbeat is treated as speaking for the collector's current
 * state. Past this, the last observed status is reported as `stale` and no
 * longer rendered verbatim.
 *
 * Set to the outbox axis's stale-heartbeat window
 * (`OUTBOX_STALE_HEARTBEAT_THRESHOLD_MS`, 30 minutes) rather than an
 * independent number. The two answer the same question — "is this check-in
 * still evidence of a live collector?" — and a source instance presented as
 * healthy while its own outbox axis reads `stalled` is exactly the
 * contradiction this derivation exists to prevent. Deliberately generous
 * relative to a single collector invocation so a long drain is never
 * misreported as death; the cost of being generous is a bounded delay before
 * a dead collector is called stale, which beats the unbounded lie.
 */
export const HEARTBEAT_LEASE_MS = 30 * 60 * 1000;

/**
 * Presented health. `stale` and `unknown` are derivations, never values a
 * collector reports:
 *  - `stale`   — a heartbeat exists but is older than the lease. What the
 *                collector last said is retained on `lastObservedStatus` as
 *                evidence, but it no longer describes the present.
 *  - `unknown` — no heartbeat, or one whose timestamp will not parse. There
 *                is no evidence either way; say so rather than guessing.
 * Otherwise the collector's own status is within lease and passes through.
 */
export type PresentedHeartbeatHealth =
  | "blocked"
  | "healthy"
  | "retrying"
  | "stale"
  | "starting"
  | "stopped"
  | "unknown";

export interface HeartbeatPresentation {
  /** Age of the heartbeat in ms, or null when there is nothing to measure. */
  readonly ageMs: number | null;
  /** The status the collector last reported. Retained past the lease as evidence. */
  readonly lastObservedStatus: string | null;
  /** The lease this was judged against, so a reader can see the policy applied. */
  readonly leaseMs: number;
  /** What to present. Never a stale status verbatim. */
  readonly status: PresentedHeartbeatHealth;
}

/**
 * Derive presented health from a heartbeat's age against the lease.
 *
 * `now` is injected rather than read from the clock so callers project a whole
 * response against one instant, and so the policy is testable at its boundary.
 */
export function presentHeartbeatHealth({
  lastHeartbeatAt,
  lastHeartbeatStatus,
  leaseMs = HEARTBEAT_LEASE_MS,
  nowIso,
}: {
  lastHeartbeatAt: string | null | undefined;
  lastHeartbeatStatus: string | null | undefined;
  leaseMs?: number;
  nowIso: string;
}): HeartbeatPresentation {
  const lastObservedStatus = lastHeartbeatStatus ?? null;
  const age = heartbeatAgeMs(lastHeartbeatAt, nowIso);
  if (age === null) {
    // No heartbeat, or an unparseable one. A status with no age behind it
    // cannot be presented as current, however confident it sounds.
    return { ageMs: null, lastObservedStatus, leaseMs, status: "unknown" };
  }
  if (age > leaseMs) {
    return { ageMs: age, lastObservedStatus, leaseMs, status: "stale" };
  }
  return { ageMs: age, lastObservedStatus, leaseMs, status: withinLeaseStatus(lastObservedStatus) };
}

/**
 * A fresh heartbeat still has to carry a status the runtime recognizes. An
 * unrecognized or absent one is `unknown` — the column is untyped TEXT in both
 * backends, so a value outside the protocol enum can reach a reader.
 */
function withinLeaseStatus(value: string | null): PresentedHeartbeatHealth {
  switch (value) {
    case "blocked":
    case "healthy":
    case "retrying":
    case "starting":
    case "stopped":
      return value;
    default:
      return "unknown";
  }
}

/** Null when either side is absent or unparseable, so callers cannot read a NaN age as fresh. */
function heartbeatAgeMs(iso: string | null | undefined, nowIso: string): number | null {
  if (!iso) {
    return null;
  }
  const observed = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!(Number.isFinite(observed) && Number.isFinite(now))) {
    return null;
  }
  return now - observed;
}
