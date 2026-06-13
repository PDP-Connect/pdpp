/**
 * Syncs view-model — the pure mapping from real reference data to the
 * Recordroom "Syncs" surface (the reskin of the Runs route).
 *
 * The canonical design (docs/design/ink-carbon/project/recordroom/rr-syncs.jsx)
 * shows three regions:
 *   1. a health stat band (streams on schedule / need-your-hand),
 *   2. failure CARDS for connections in a non-healthy state, and
 *   3. per-connection sync GROUPS, each a table of per-stream "sync rows"
 *      (stream · cadence · Rhythm sparkline · last result · next).
 *
 * This module is the single source of truth for how the three real contracts
 * — `RunSummary` (the runs feed), `RefConnectorSummary.connection_health` /
 * `.schedule` (per-connection health + cadence), and `RefSchedule` — collapse
 * into that view-model. It is JSX-free and free of `Date.now()` so it stays
 * deterministically unit-testable.
 *
 * The hardest correctness requirement lives here: a connection that the source
 * is throttling (a self-resolving source-pressure cooldown) must read as
 * "cooling off, will retry, your data is fine" with a WAIT affordance — NEVER a
 * false "reconnect / log in again" prompt. We do NOT invent that copy: every
 * failure card binds to {@link deriveFailureSummary}, whose `cooling_off` and
 * `blocked` branches already apply the `isSourcePressureCooldown` guard. By
 * deferring to it the honesty of the copy is guaranteed by the same pure
 * function the connection-detail surface uses.
 */

import { deriveFailureSummary, type FailureSummary } from "../lib/connection-evidence.ts";
import type { RefConnectorSummary, RefSchedule, RunSummary } from "../lib/ref-client.ts";

// ─── Rhythm tick type (mirrors the kit's RhythmTick) ──────────────────────────
//
// Imported structurally rather than from the component module so this pure
// model never pulls a `.tsx` (and therefore React/CSS) into a node test.
export type SyncRhythmTick = "ok" | "fail";

/** A connection's effective health, reduced to the binary the group dot needs. */
export type SyncGroupHealth = "ok" | "failing";

/** One stream's row inside a sync group. */
export interface SyncRow {
  /** Deep link to browse this stream's records for this connection. */
  browseHref: string;
  /** Human cadence phrase, e.g. "every 15 min" / "daily" / "manual". */
  cadence: string;
  /** Last-result delta phrase, e.g. "+38 records" / "no change" / "sync failed". */
  delta: string;
  /** Duration phrase for the last run, e.g. "6 s", or null when unknown. */
  duration: string | null;
  /** True when the last run for this stream failed (held cursor). */
  failed: boolean;
  /** When the last run for this stream's connection happened (ISO), or null. */
  lastAt: string | null;
  /** Next-due phrase or ISO; "held" when the connection is paused/holding. */
  next: string;
  /** Next-due ISO timestamp when one is scheduled, else null. */
  nextAt: string | null;
  /** True when nothing changed on the last run — gets the quiet, reassuring tone. */
  quiet: boolean;
  /** Recent run outcomes oldest→newest, for the Rhythm sparkline. */
  rhythm: SyncRhythmTick[];
  /** Stream name (the record stream this row tracks). */
  stream: string;
}

/** One connection's group of sync rows. */
export interface SyncGroup {
  /** Durable connection identity (`connection_id`). */
  connectionId: string;
  /** Connector key, for the browse link. */
  connectorId: string;
  /** Reduced health driving the group dot. */
  health: SyncGroupHealth;
  /** Connection display name. */
  name: string;
  /** The per-stream rows. */
  streams: SyncRow[];
}

/**
 * A failure card. `summary` is the verbatim {@link FailureSummary} from
 * `deriveFailureSummary` (the honest, source-pressure-guarded copy). The card
 * is a panel with an action, NOT a row — the canonical design treats a failure
 * as a thing the owner can act on, not an item in a list.
 */
export interface FailureCard {
  /** Durable connection identity. */
  connectionId: string;
  /** Connector key, for the reconnect deep link. */
  connectorId: string;
  /** Connection display name (the card title prefix). */
  name: string;
  /** The honest, pre-derived failure summary (prose + cta + trigger label). */
  summary: FailureSummary;
}

/** The health stat band at the top of the Syncs view. */
export interface HealthBand {
  /** True when every connection is healthy or self-handling — show the all-clear note. */
  allClear: boolean;
  /** Count of connections that need an owner's hand (genuine reconnect/attention). */
  needYourHand: number;
  /** Count of streams whose connection is healthy / on schedule. */
  onSchedule: number;
}

/** The whole Syncs view-model. */
export interface SyncsViewModel {
  band: HealthBand;
  failureCards: FailureCard[];
  groups: SyncGroup[];
}

const HEALTHY_RUN_STATUSES = new Set(["succeeded", "success", "completed", "succeeded_with_gaps"]);
const FAILED_RUN_STATUSES = new Set(["failed", "rejected", "cancelled", "error"]);
const RECENT_RUN_LIMIT = 7;

/**
 * Reduce a run status to a Rhythm tick. Partial (`succeeded_with_gaps`) counts
 * as `ok` — the gap fills on the next run and existing records are valid, so it
 * is not a failure tick. Non-terminal runs are skipped by the caller.
 */
function runTick(status: string): SyncRhythmTick {
  if (FAILED_RUN_STATUSES.has(status)) {
    return "fail";
  }
  return "ok";
}

function isTerminalRunStatus(status: string): boolean {
  return HEALTHY_RUN_STATUSES.has(status) || status === "failed" || status === "rejected" || status === "cancelled";
}

/** Stable connector key for a run, used to bucket runs under a connection. */
function runConnectorKey(run: RunSummary): string | null {
  return run.connector_id ?? run.source?.id ?? null;
}

/**
 * Build the Rhythm ticks for a connection from its recent terminal runs,
 * oldest→newest, capped at {@link RECENT_RUN_LIMIT}. Non-terminal runs are
 * skipped so the sparkline reflects settled outcomes only.
 */
export function deriveConnectionRhythm(runs: readonly RunSummary[]): SyncRhythmTick[] {
  const terminal = runs.filter((r) => isTerminalRunStatus(r.status));
  // `runs` arrive newest-first from the feed; reverse to oldest-first and cap.
  const recent = terminal.slice(0, RECENT_RUN_LIMIT).reverse();
  return recent.map((r) => runTick(r.status));
}

/** Group runs by connector key, preserving newest-first order within a key. */
function groupRunsByConnector(runs: readonly RunSummary[]): Map<string, RunSummary[]> {
  const byKey = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const key = runConnectorKey(run);
    if (!key) {
      continue;
    }
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(run);
    } else {
      byKey.set(key, [run]);
    }
  }
  return byKey;
}

/**
 * A connection's health is "ok" unless `deriveFailureSummary` produced a card
 * for it — i.e. unless its state warrants the "What's wrong/missing?" surface.
 * A self-resolving source-pressure cooldown DOES produce a (wait-copy) card, so
 * it reads as failing-needs-no-hand: the dot is amber but the band does not
 * count it under "need your hand" (see {@link buildHealthBand}).
 */
function connectionHealth(summary: FailureSummary | null): SyncGroupHealth {
  return summary ? "failing" : "ok";
}

/**
 * Humanize a schedule into a short cadence phrase for a sync row.
 * Mirrors the canonical mock's "every 15 min" / "daily" / "manual" voice.
 */
export function describeCadence(schedule: RefSchedule | null | undefined): string {
  if (!schedule) {
    return "on demand";
  }
  if (schedule.effective_mode === "paused" || !schedule.enabled) {
    return "paused";
  }
  if (schedule.effective_mode === "manual") {
    return "manual";
  }
  const seconds = schedule.interval_seconds;
  if (!seconds || seconds <= 0) {
    return "automatic";
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return `every ${minutes} min`;
  }
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return hours === 1 ? "hourly" : `every ${hours} h`;
  }
  const days = Math.round(seconds / 86_400);
  if (days === 1) {
    return "daily";
  }
  if (days === 7) {
    return "weekly";
  }
  if (days >= 360 && days <= 370) {
    return "yearly";
  }
  return `every ${days} d`;
}

/** Format an event-count delta into a row phrase. */
export function describeDelta(input: { failed: boolean; eventCount: number | null }): string {
  if (input.failed) {
    return "sync failed";
  }
  const count = input.eventCount;
  if (count == null) {
    return "no recent run";
  }
  if (count <= 0) {
    return "no change";
  }
  return `+${count.toLocaleString()} record${count === 1 ? "" : "s"}`;
}

/**
 * Format a duration between two ISO timestamps as a short phrase ("6 s",
 * "2 m 4 s"), or null when either bound is missing/unparseable.
 */
export function describeDuration(firstAt: string | null, lastAt: string | null): string | null {
  if (!(firstAt && lastAt)) {
    return null;
  }
  const start = Date.parse(firstAt);
  const end = Date.parse(lastAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return null;
  }
  const totalSeconds = Math.round((end - start) / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} m` : `${minutes} m ${seconds} s`;
}

/** Build the deep link to browse one stream's records for a connection. */
export function browseStreamHref(connectionId: string, stream: string): string {
  const params = new URLSearchParams({ connection: connectionId, stream });
  return `/dashboard/explore?${params.toString()}`;
}

/** Pick the connection-level "next" phrase from the schedule. */
function describeNext(input: { schedule: RefSchedule | null | undefined; failing: boolean }): {
  next: string;
  nextAt: string | null;
} {
  if (input.failing) {
    // A failing/holding connection has no honest forward "next" — the cursor is
    // held until it resumes. The canonical mock shows "held" here.
    const backoffAt = input.schedule?.scheduler_backoff?.next_run_at ?? null;
    if (backoffAt) {
      return { next: backoffAt, nextAt: backoffAt };
    }
    return { next: "held", nextAt: null };
  }
  const dueAt = input.schedule?.next_due_at ?? null;
  if (dueAt) {
    return { next: dueAt, nextAt: dueAt };
  }
  if (input.schedule?.effective_mode === "manual") {
    return { next: "on demand", nextAt: null };
  }
  return { next: "—", nextAt: null };
}

/**
 * Build the per-connection sync rows. Each declared stream becomes one row; the
 * last-run facts (delta, duration, when, fail) come from the connection's most
 * recent run, and the Rhythm comes from its recent run history. Streams are a
 * per-instance list, so all rows in a group share the connection-level run
 * facts (the reference does not yet emit per-stream run outcomes; we are honest
 * about that by deriving the row from the connection's last run, not inventing
 * per-stream numbers).
 */
function buildSyncRows(input: {
  connector: RefConnectorSummary;
  connectionRuns: readonly RunSummary[];
  failing: boolean;
}): SyncRow[] {
  const { connector, connectionRuns, failing } = input;
  const schedule = connector.schedule;
  const cadence = describeCadence(schedule);
  const rhythm = deriveConnectionRhythm(connectionRuns);
  const lastRun = connectionRuns.find((r) => isTerminalRunStatus(r.status)) ?? connectionRuns[0] ?? null;
  const lastFailed = failing || (lastRun ? FAILED_RUN_STATUSES.has(lastRun.status) : false);
  const eventCount = lastRun ? lastRun.event_count : null;
  const delta = describeDelta({ failed: lastFailed, eventCount });
  const duration = describeDuration(lastRun?.first_at ?? null, lastRun?.last_at ?? null);
  const lastAt = lastRun?.last_at ?? null;
  const { next, nextAt } = describeNext({ schedule, failing });
  const quiet = !lastFailed && eventCount != null && eventCount <= 0;

  const streams = connector.streams.length > 0 ? connector.streams : [connector.connector_id];
  return streams.map(
    (stream): SyncRow => ({
      stream,
      cadence,
      rhythm,
      delta: lastFailed ? "sync failed" : delta,
      lastAt,
      duration,
      next,
      nextAt,
      quiet,
      failed: lastFailed,
      browseHref: browseStreamHref(connector.connection_id, stream),
    })
  );
}

/**
 * Build the health stat band. "On schedule" counts streams under healthy
 * connections. "Need your hand" counts ONLY connections whose failure card
 * carries an owner-action CTA (`reconnect`) — a source-pressure cooldown's
 * `wait` card is the system handling itself, so it is NOT a hand-needed count.
 * This keeps the band honest: a throttled connection does not inflate the
 * "needs you" number or trigger an all-clear=false alarm by itself.
 */
function buildHealthBand(input: { groups: SyncGroup[]; failureCards: FailureCard[] }): HealthBand {
  const onSchedule = input.groups.filter((g) => g.health === "ok").reduce((sum, g) => sum + g.streams.length, 0);
  const needYourHand = input.failureCards.filter((c) => c.summary.cta === "reconnect").length;
  return {
    onSchedule,
    needYourHand,
    allClear: needYourHand === 0,
  };
}

/**
 * Build the entire Syncs view-model from the three real contracts.
 *
 * @param connectors per-connection summaries (`_ref/connectors`), the source of
 *   health + schedule + stream list. The list defines which connections render.
 * @param runs the runs feed (`_ref/runs`), newest-first, used for Rhythm ticks
 *   and the last-result delta/when per connection.
 */
export function buildSyncsViewModel(input: {
  connectors: readonly RefConnectorSummary[];
  runs: readonly RunSummary[];
}): SyncsViewModel {
  const runsByConnector = groupRunsByConnector(input.runs);
  const groups: SyncGroup[] = [];
  const failureCards: FailureCard[] = [];

  for (const connector of input.connectors) {
    // Revoked connections are not active syncs; skip them from the live surface.
    if (connector.revoked_at) {
      continue;
    }
    const summary = deriveFailureSummary(connector.connection_health);
    const failing = connectionHealth(summary) === "failing";
    const connectionRuns =
      runsByConnector.get(connector.connector_id) ??
      (connector.connector_instance_id ? runsByConnector.get(connector.connector_instance_id) : undefined) ??
      [];

    if (summary) {
      failureCards.push({
        name: connector.display_name,
        connectionId: connector.connection_id,
        connectorId: connector.connector_id,
        summary,
      });
    }

    groups.push({
      name: connector.display_name,
      connectionId: connector.connection_id,
      connectorId: connector.connector_id,
      health: failing ? "failing" : "ok",
      streams: buildSyncRows({ connector, connectionRuns, failing }),
    });
  }

  const band = buildHealthBand({ groups, failureCards });
  return { band, failureCards, groups };
}
