// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reference scheduler lifecycle factory.
 *
 * Concept: builds, starts, stops, and refreshes the connector scheduler from
 * injected dependencies.
 *
 * Invariant: owns the scheduler lifecycle; receives controller, logger,
 * runtimeContext, store factories, and projection helpers via DI; no
 * startServer-internal reach-back (no import from index.js).
 */

import { getRunTerminalEvent } from "../lib/spine.ts";
import { isHealthRelevant as isAttentionHealthRelevant } from "../runtime/attention.ts";
import type { ConnectorEnvironmentPolicy } from "../runtime/connector-child-environment.ts";
import { getScheduleIneligibilityReason, resolveDefaultConnectorPath } from "../runtime/controller.ts";
import { hasForwardEvidenceDebt } from "../runtime/recovery-decision.ts";
import type {
  ConnectorError,
  ConnectorSchedule,
  Scheduler,
  SchedulerManifest,
  SchedulerOptions,
  TerminalReason,
  UnresolvedAttentionEvidence,
} from "../runtime/scheduler.ts";
import { createScheduler } from "../runtime/scheduler.ts";
import { SOURCE_PRESSURE_GAP_REASONS } from "../runtime/scheduler-source-pressure-cooldown.ts";
import { getConnectorManifest } from "./auth.ts";
import { buildConnectionScopedRunEnvResolver } from "./connection-scoped-run-env.ts";
import { canonicalConnectorKey } from "./connector-key.ts";
import { getConnectorSummaryEvidence, reconcileDirtyConnectorSummaryEvidence } from "./connector-summary-read-model.ts";
import { unresolvedOwnerActionEvidenceFromSummary } from "./owner-action-gate.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "./owner-auth.ts";
import { getSyncState, putSyncState } from "./records.ts";
import { getConnectorAttentionProjection, getConnectorSummaryForRoute } from "./ref-control.ts";
import { getDefaultConnectorAttentionStore } from "./stores/connector-attention-store.ts";
import { getDefaultConnectorDetailGapStore } from "./stores/connector-detail-gap-store.ts";
import { getDefaultSchedulerStore } from "./stores/scheduler-store.ts";
import type { StaticSecretCredentialStore } from "./stores/static-secret-run-credentials.ts";
import {
  createWebPushSubscriptionStore,
  fanoutEscalationWebPush,
  fanoutPendingInteractionWebPush,
  resolveWebPushConfig,
} from "./web-push-notifications.ts";

const SURFACE_UNAVAILABLE_HANDLE_STATUSES = Object.freeze([
  "run_browser_surface_queued",
  "browser_surface_probe_failed",
  "browser_surface_lost",
  "surface_failed",
]);

interface Logger {
  error: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface Controller {
  awaitRun: (runId: string) => Promise<string>;
  browserSurfaceLeaseManager?: {
    isManagedConnector: (connectorId: string) => boolean;
  };
  getActiveRun: (connectorId: string, options: { connectorInstanceId: string }) => unknown;
  isNeedsHuman: (connectorId: string, options: { connectorInstanceId: string }) => boolean;
  issueRuntimeOwnerToken: () => Promise<string>;
  markNeedsHuman: (connectorId: string, options: { connectorInstanceId: string }) => void;
  runNow: (
    connectorId: string,
    options: {
      connectorInstanceId: string;
      ownerToken: string;
      priorityClass: "background";
      triggerKind: "scheduled";
      rsUrl?: string;
      referenceBaseUrl?: string | null;
    }
  ) => Promise<ManagedRunHandle>;
}

interface ManagedRunHandle {
  readonly connector_error?: Record<string, unknown> | null;
  readonly failure_reason?: string | null;
  readonly known_gaps?: readonly Record<string, unknown>[] | null;
  readonly run_id: string;
  readonly status: string;
  readonly terminal_reason?: string | null;
  readonly trace_id: string;
}

interface TerminalEvent {
  readonly data?: unknown;
}

interface ConnectorInstanceStore {
  get: (connectorInstanceId: string) => Promise<{ sourceBinding?: unknown } | null>;
}

type ConnectorInstanceCredentialStore = StaticSecretCredentialStore;

interface GapStore {
  listPendingGapsForConnector: (connectorId: string, options: { limit: number }) => Promise<readonly GapRow[]>;
}

interface GapRow {
  readonly attempt_count?: unknown;
  readonly connector_instance_id?: unknown;
  readonly last_attempt_at?: unknown;
  readonly next_attempt_after?: unknown;
  readonly reason?: unknown;
  readonly updated_at?: unknown;
}

interface Interaction {
  readonly connector_display_name?: unknown;
  readonly connector_id?: unknown;
  readonly request_id?: unknown;
  readonly run_id?: unknown;
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === "[object Object]";
}

interface SchedulerManagerOptions {
  readonly connectorEnvironmentPolicy?: ConnectorEnvironmentPolicy;
  readonly connectorPathResolver: ConnectorPathResolver;
  readonly controller: Controller;
  readonly createConnectorInstanceCredentialStore: () => ConnectorInstanceCredentialStore;
  readonly createConnectorInstanceStore: () => ConnectorInstanceStore;
  readonly getLatestConnectorRunSummary: (
    connectorId: string,
    status: string
  ) => Promise<{ last_at?: string | null } | null>;
  readonly getManifestRefreshPolicy: (
    manifest: SchedulerManifest
  ) => Parameters<typeof getScheduleIneligibilityReason>[0];
  readonly logger: Logger;
  readonly ownerSubjectId: string;
  readonly runtimeContext: { rsUrl: string; referenceBaseUrl: string | null };
  readonly schedulerStore: NonNullable<SchedulerOptions["schedulerStore"]> & {
    listSchedules: () => Promise<readonly ScheduleRow[]> | readonly ScheduleRow[];
  };
  readonly storageTargetForConnectorNamespace: (namespace: { connectorId: string; connectorInstanceId?: string }) => {
    connector_id: string;
    connector_instance_id?: string;
  };
  readonly webPushConfig: ReturnType<typeof resolveWebPushConfig>;
  readonly webPushSubscriptionStore: ReturnType<typeof createWebPushSubscriptionStore>;
}

interface ScheduleRow {
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly enabled: boolean;
  readonly interval_seconds: number;
}

interface PressureGap {
  readonly attemptCount: number | null;
  readonly lastPressureAt: string | null;
  readonly nextAttemptAfter: string | null;
  readonly reason: string;
}

function lastPressureAt(row: GapRow): string | null {
  if (typeof row.last_attempt_at === "string") {
    return row.last_attempt_at;
  }
  if (typeof row.updated_at === "string") {
    return row.updated_at;
  }
  return null;
}

function mapPressureGaps(rows: readonly GapRow[], instanceKey: string): PressureGap[] {
  const gaps: PressureGap[] = [];
  for (const row of rows) {
    if (typeof row.reason !== "string" || !SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) {
      continue;
    }
    if ((row.connector_instance_id || instanceKey) !== instanceKey) {
      continue;
    }
    gaps.push({
      attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : null,
      lastPressureAt: lastPressureAt(row),
      nextAttemptAfter: typeof row.next_attempt_after === "string" ? row.next_attempt_after : null,
      reason: row.reason,
    });
  }
  return gaps;
}

function countNonPressureGaps(rows: readonly GapRow[], instanceKey: string): number {
  let count = 0;
  for (const row of rows) {
    if (typeof row.reason === "string" && SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) {
      continue;
    }
    if ((row.connector_instance_id || instanceKey) !== instanceKey) {
      continue;
    }
    count += 1;
  }
  return count;
}

function relevantAttentionRecord(records: readonly Parameters<typeof isAttentionHealthRelevant>[0][], nowIso: string) {
  for (const record of records) {
    if (isAttentionHealthRelevant(record, nowIso)) {
      return { key: record.dedupe_key || record.id, reason: record.reason_code ?? null };
    }
  }
  return null;
}

function interactionDisplayName(interaction: Interaction): string {
  if (typeof interaction.connector_display_name === "string" && interaction.connector_display_name.trim()) {
    return interaction.connector_display_name.trim();
  }
  if (typeof interaction.connector_id === "string" && interaction.connector_id.trim()) {
    return interaction.connector_id.trim();
  }
  return "Connector";
}

async function resolveOwnerActionEvidence(
  connectorId: string,
  connectorInstanceId: string | undefined,
  controller: Controller,
  logger: Logger
): Promise<UnresolvedAttentionEvidence | null> {
  const routeId = connectorInstanceId || connectorId;
  try {
    const summary = await getConnectorSummaryForRoute(
      routeId,
      controller as unknown as Parameters<typeof getConnectorSummaryForRoute>[1]
    );
    return unresolvedOwnerActionEvidenceFromSummary(
      summary as Parameters<typeof unresolvedOwnerActionEvidenceFromSummary>[0],
      routeId
    ) as UnresolvedAttentionEvidence | null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[scheduler] owner-action projection failed for ${connectorId}/${routeId}: ${message}`);
    return null;
  }
}

interface EscalationProjection {
  readonly connectionUrl: string;
  readonly connectorDisplayName: string;
  readonly renderedVerdict: object | null;
}

async function projectEscalation(
  connectorId: string,
  connectorInstanceId: string,
  controller: Controller,
  logger: Logger
): Promise<EscalationProjection> {
  const routeId = connectorInstanceId || connectorId;
  try {
    const summary = await getConnectorSummaryForRoute(
      routeId,
      controller as unknown as Parameters<typeof getConnectorSummaryForRoute>[1]
    );
    if (summary) {
      return {
        connectionUrl: `/sources/${encodeURIComponent(summary.connection_id || routeId)}`,
        connectorDisplayName: summary.display_name || summary.connector_display_name || connectorId,
        renderedVerdict:
          summary.rendered_verdict && typeof summary.rendered_verdict === "object" ? summary.rendered_verdict : null,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[scheduler] verdict projection failed for escalation ${connectorId}/${routeId}; suppressing push: ${message}`
    );
  }
  return { connectionUrl: "/deployment", connectorDisplayName: connectorId, renderedVerdict: null };
}

type ConnectorPathResolver = (
  connectorId: string,
  manifest: SchedulerManifest,
  options?: { priorityClass: "background" }
) => string | null | Promise<string | null>;

function projectManagedControllerTerminalRun(
  handle: ManagedRunHandle,
  terminalStatus: string,
  terminalEvent: TerminalEvent | null
) {
  const terminalData =
    terminalEvent?.data && typeof terminalEvent.data === "object"
      ? (terminalEvent.data as Record<string, unknown>)
      : {};
  const connectorError =
    terminalData.connector_error && typeof terminalData.connector_error === "object"
      ? (terminalData.connector_error as ConnectorError)
      : null;
  const failureReason = typeof terminalData.reason === "string" ? terminalData.reason : null;
  const knownGaps = Array.isArray(terminalData.known_gaps)
    ? terminalData.known_gaps.filter((gap): gap is Record<string, unknown> => Boolean(gap && typeof gap === "object"))
    : [];
  const terminalReason =
    typeof terminalData.terminal_reason === "string" ? (terminalData.terminal_reason as TerminalReason) : null;
  return {
    connector_error: connectorError,
    failure_reason: failureReason,
    known_gaps: knownGaps,
    run_id: handle.run_id,
    status: terminalStatus,
    terminal_reason: terminalReason,
    trace_id: handle.trace_id,
  };
}

function createRunManagedConnectorViaController(
  controller: Controller
): SchedulerOptions["runManagedConnectorViaController"] {
  const leaseManager = controller.browserSurfaceLeaseManager;
  if (!leaseManager) {
    return null;
  }

  return async (connectorId, opts) => {
    if (!leaseManager.isManagedConnector(connectorId)) {
      // Not a managed connector — signal launchRun to use the direct
      // runConnector path (no lease needed).
      return null;
    }
    const handle = await controller.runNow(connectorId, {
      connectorInstanceId: opts.connectorInstanceId,
      ownerToken: opts.ownerToken,
      priorityClass: opts.priorityClass,
      triggerKind: opts.triggerKind,
      ...(opts.rsUrl === undefined ? {} : { rsUrl: opts.rsUrl }),
      ...(opts.referenceBaseUrl === undefined ? {} : { referenceBaseUrl: opts.referenceBaseUrl }),
    });
    // Early-exit statuses (browser_surface_queued, surface_failed, etc.)
    // mean no run was started — return the handle as-is for the scheduler's
    // surface-unavailable skip path.
    if (handle.status && SURFACE_UNAVAILABLE_HANDLE_STATUSES.includes(handle.status)) {
      return handle as Awaited<ReturnType<NonNullable<SchedulerOptions["runManagedConnectorViaController"]>>>;
    }
    // Run was dispatched (status "started"). Await its real terminal
    // outcome so the scheduler records the true succeeded/failed status
    // and its failure-streak / back-off machinery fires correctly.
    // controller.awaitRun waits for activeRunPromises[runId] to settle
    // (the .finally() cleanup chain), then reads the spine terminal event.
    // No deadlock risk: the run has its own wall-clock budget; a hung run
    // is the run's responsibility, matching the old runConnector await.
    const terminalStatus = await controller.awaitRun(handle.run_id);
    const terminalEvent = (await getRunTerminalEvent(handle.run_id)) as TerminalEvent | null;
    return projectManagedControllerTerminalRun(handle, terminalStatus, terminalEvent);
  };
}

export function createReferenceSchedulerManager({
  controller,
  connectorEnvironmentPolicy,
  logger,
  runtimeContext,
  schedulerStore = getDefaultSchedulerStore(),
  connectorPathResolver = resolveDefaultConnectorPath,
  ownerSubjectId = OWNER_AUTH_DEFAULT_SUBJECT_ID,
  webPushConfig = resolveWebPushConfig(),
  webPushSubscriptionStore = createWebPushSubscriptionStore(),
  // DI: index.js helpers used by the factory that also live elsewhere in index.js
  createConnectorInstanceStore,
  createConnectorInstanceCredentialStore,
  storageTargetForConnectorNamespace,
  getLatestConnectorRunSummary,
  getManifestRefreshPolicy,
}: SchedulerManagerOptions) {
  let scheduler: Scheduler | null = null;
  let stopped = false;
  let refreshChain = Promise.resolve();

  // The SAME connection-scoped setup-material resolver the controller uses for
  // manual runs, bound to the scheduler's owner subject. Scheduled and manual
  // runs MUST resolve credentials/import bindings identically: a connection row
  // satisfies both, and a scheduled launch never falls back to process-global
  // setup material when a connection-scoped binding exists.
  const connectionScopedRunEnvResolver = buildConnectionScopedRunEnvResolver({
    createConnectorInstanceCredentialStore,
    createConnectorInstanceStore,
  });
  const resolveScheduledConnectionScopedRunEnv = ({
    connectorId,
    connectorInstanceId,
  }: {
    connectorId: string;
    connectorInstanceId: string;
  }) => connectionScopedRunEnvResolver({ connectorId, connectorInstanceId, ownerSubjectId });

  async function buildConnectors() {
    const schedules = await Promise.resolve(schedulerStore.listSchedules());
    const enabledSchedules = schedules.filter((schedule) => schedule?.enabled === true);
    const connectors = await enabledSchedules.reduce(async (connectorsPromise, schedule) => {
      const builtConnectors = await connectorsPromise;
      const connector = await (async (): Promise<ConnectorSchedule | null> => {
        try {
          // Canonicalize at the autonomous-scheduler boundary. A legacy /
          // migration `connector_schedules` row can carry a URL-shaped or
          // legacy-alias `connector_id`: the controller's `upsertSchedule`
          // canonicalizes on write, but rows seeded before that slice (or by a
          // non-controller path) do not. Forwarding it verbatim makes the
          // scheduler emit the spine run source / actor_id and persist
          // run-history + last-run rows under the non-canonical id, mismatching
          // the canonical key the read/admission paths key on. Normalize once
          // here, mirroring the established `canonicalConnectorKey(x) ?? x`
          // pattern (see index.js:1236, 1310). The manifest still resolves via
          // alias fallback, so eligible connectors still run.
          const connectorId = canonicalConnectorKey(schedule.connector_id) ?? schedule.connector_id;
          const manifest = (await getConnectorManifest(connectorId)) as SchedulerManifest | null;
          if (!manifest) {
            return null;
          }
          const scheduleIneligibilityReason = getScheduleIneligibilityReason(getManifestRefreshPolicy(manifest));
          if (scheduleIneligibilityReason) {
            logger.warn(
              { connector_id: connectorId, reason: scheduleIneligibilityReason },
              "skipping scheduled connector because refresh policy is not background-safe"
            );
            return null;
          }
          const connectorPath = await Promise.resolve(
            connectorPathResolver(connectorId, manifest, { priorityClass: "background" })
          );
          if (!connectorPath) {
            logger.warn({ connector_id: connectorId }, "skipping scheduled connector without runnable implementation");
            return null;
          }
          return {
            connectorId,
            connectorInstanceId: schedule.connector_instance_id,
            connectorPath,
            intervalMs: Math.max(1, schedule.interval_seconds) * 1000,
            manifest,
            ownerToken: await controller.issueRuntimeOwnerToken(),
          };
        } catch (err) {
          logger.warn(
            { connector_id: schedule?.connector_id, err },
            "skipping scheduled connector during scheduler refresh"
          );
          return null;
        }
      })();
      if (connector) {
        builtConnectors.push(connector);
      }
      return builtConnectors;
    }, Promise.resolve<ConnectorSchedule[]>([]));
    return connectors;
  }

  async function restart() {
    if (stopped) {
      return;
    }
    scheduler?.stop();
    scheduler = null;
    const connectors = await buildConnectors();
    if (stopped || connectors.length === 0) {
      return;
    }
    const managedRunner = createRunManagedConnectorViaController(controller);
    scheduler = createScheduler({
      connectors,
      ...(connectorEnvironmentPolicy?.approvedBindings.length
        ? { approvedEnvironmentBindings: connectorEnvironmentPolicy.approvedBindings }
        : {}),
      ...(connectorEnvironmentPolicy?.approvedProxyConnectorIds.length
        ? { approvedProxyConnectorIds: connectorEnvironmentPolicy.approvedProxyConnectorIds }
        : {}),
      referenceBaseUrl: runtimeContext.referenceBaseUrl,
      resolveStaticSecretRunEnv: resolveScheduledConnectionScopedRunEnv,
      rsUrl: runtimeContext.rsUrl,
      schedulerStore,
      // Route managed-connector scheduled runs through controller.runNow so
      // they acquire the neko browser-surface lease (warm persistent profile,
      // cf_clearance cookie present) instead of launching a fresh headless
      // Chromium with an empty profile that Cloudflare challenges 100%.
      //
      // The callback returns null for non-managed connectors so launchRun
      // falls through to the existing runConnector path unchanged.
      //
      // Lease release is inherited via runNow's own .finally() →
      // finalizeRunCleanup → releaseBrowserSurfaceLeaseAfterRun chain.
      // No separate release is added here (double-release risk).
      //
      // controller_active_runs mutual exclusion: validateRunNowPreconditions
      // throws run_already_active when a run is already in-flight; the
      // scheduler's own runtime.activeRuns guard prevents double-dispatch
      // from within the scheduler.
      ...(managedRunner === undefined ? {} : { runManagedConnectorViaController: managedRunner }),
      getForwardEvidenceDebt: async (connectorId, connectorInstanceId, scheduleIntervalMs) => {
        // Forward-evidence-debt bound for recovery-first selection
        // (fix-pre-provenance-terminal-generation-semantics): bounds the
        // otherwise-unbounded recovery-first priority so an existing
        // non-pressure recovery backlog can never starve forward (fact-
        // carrying) collection indefinitely.
        //
        // Reconciles just this one connection (the same scoped, cheap repair
        // every other single-connection read uses) so the debt predicate
        // reads a genuinely current evidence row, then passes the WHOLE row
        // through — the predicate itself derives the newest per-stream
        // `evidence_as_of` from `stream_latest_facts`, never the
        // observation-timestamp `terminal_facts.as_of`.
        //
        // Fail-CLOSED to `false` (no debt) on error: a false positive would
        // divert every failing tick to forward collection instead of
        // draining recovery, which is a strictly worse failure mode than
        // occasionally missing one debt-bounded forward run.
        try {
          const instanceId = connectorInstanceId || connectorId;
          await reconcileDirtyConnectorSummaryEvidence([instanceId]);
          const evidence = await getConnectorSummaryEvidence(instanceId);
          return hasForwardEvidenceDebt(evidence, Date.now(), scheduleIntervalMs);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, `[scheduler] forward-evidence-debt probe failed for ${connectorId}`);
          return false;
        }
      },
      // Durable cross-path "latest successful run at" probe, read from the spine
      // run timeline so it sees EVERY success — including manual/owner
      // `controller.runNow` runs, which write a `run_history` row via the
      // generalized run.started/terminal writer (server/stores/
      // run-history-writer.ts) but are NOT `scheduler_managed` and so stay
      // invisible to `listRunHistory`'s cadence/backoff callers. Lets
      // the back-off gate clear a stale failure streak when a genuine success
      // has occurred since, so automation resumes. Returns null on no success or
      // probe error (never fabricates a success that would suppress back-off).
      getLastSuccessfulRunAt: async (connectorId) => {
        try {
          const summary = await getLatestConnectorRunSummary(connectorId, "succeeded");
          const at = summary?.last_at ? Date.parse(summary.last_at) : Number.NaN;
          return Number.isFinite(at) ? at : null;
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            `[scheduler] last-success spine probe failed for ${connectorId}`
          );
          return null;
        }
      },
      getNonPressureRecoverableCount: async (connectorId, connectorInstanceId) => {
        // Durable non-pressure recovery probe for the cross-run eligibility split
        // (SLVP-ideal §4.3). Counts pending detail gaps for this connector instance
        // whose reason is NOT in SOURCE_PRESSURE_GAP_REASONS (i.e. run_cap_deferred,
        // retry_exhausted, temporary_unavailable, null, etc.). A non-zero count
        // allows a recovery-only launch while a source-pressure cooldown is active —
        // draining non-congested work without touching the forward walk.
        //
        // Uses the same `listPendingGapsForConnector` read as the pressure probe so
        // both probes share a single bounded scan. Instance scoping mirrors the
        // pressure probe: `listPendingGapsForConnector` spans every instance of the
        // connector type; the `connector_instance_id` filter keeps cooldown
        // per-source.
        //
        // Fail-CLOSED to 0 on error: unlike the pressure probe (which fails open so
        // an unreadable store cannot silently pause a schedule), a false positive here
        // would launch a recovery run INTO an active cooldown window. When unsure
        // whether recovery work exists, do not bypass the cooldown — the next clean
        // tick recovers it.
        try {
          const store = getDefaultConnectorDetailGapStore() as unknown as GapStore;
          const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
          const instanceKey = connectorInstanceId || connectorId;
          return countNonPressureGaps(rows, instanceKey);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, `[scheduler] non-pressure recovery probe failed for ${connectorId}`);
          return 0;
        }
      },
      getSourcePressureGaps: async (connectorId, connectorInstanceId) => {
        // Durable source-pressure projection for the cross-run cooldown. Reads
        // pending detail gaps from `connector_detail_gaps`, keeps only the
        // account/source-pressure reasons (ChatGPT `upstream_pressure` /
        // `rate_limited`), and maps them to the lane-agnostic shape the
        // scheduler cooldown consumes. The read is bounded and reason-filtered;
        // it never returns record bodies, locators, or secrets — only the
        // reason, recovery-attempt count, and an optional next-attempt floor.
        //
        // A probe failure is surfaced as "no pressure" (empty list) so an
        // unreadable gap store cannot silently pause a schedule — same
        // fail-open stance as the attention probe above.
        const store = getDefaultConnectorDetailGapStore() as unknown as GapStore;
        const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
        const instanceKey = connectorInstanceId || connectorId;
        return mapPressureGaps(rows, instanceKey);
      },
      getState: async (connectorId, connectorInstanceId) => {
        // Read scheduler state from the connection-instance namespace by
        // construction: getSyncState keys storage off its storage-target
        // argument, and a bare connectorId string falls back to the
        // default-account instance id (the connectorInstanceId option is
        // ignored). Pass the explicit object target so each connection's
        // schedule reads its own durable state.
        const stored = await getSyncState(
          storageTargetForConnectorNamespace({
            connectorId,
            ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
          })
        );
        const { state } = stored;
        return state;
      },
      hasUnresolvedAttention: async (connectorId, connectorInstanceId) => {
        // Durable attention projection. The in-memory `isNeedsHuman` flag
        // is process-local; this probe consults the structured
        // attention_request store so a scheduled tick after process
        // restart still recognizes unresolved owner action and does not
        // launch a doomed run. The projection is read-bounded
        // (`listOpenAttentionForConnection` clamps `limit` to 50) and
        // returns the most-recently-updated open record first.
        const projection = await getConnectorAttentionProjection(
          connectorId,
          connectorInstanceId === undefined ? {} : { connectorInstanceId }
        );
        if (projection.unreliable) {
          // Probe failure must not silently suppress launches — surface
          // the schedule as eligible so a freshness gap is preferred over
          // an invisible pause.
          return null;
        }
        const recordEvidence = relevantAttentionRecord(projection.records, new Date().toISOString());
        if (recordEvidence) {
          return recordEvidence;
        }
        return resolveOwnerActionEvidence(connectorId, connectorInstanceId, controller, logger);
      },
      // Recognize managed (browser-surface-leased) connectors so the scheduler
      // can DEFER a scheduled tick when the managed-routing seam above is not
      // wired yet (controller boot race), instead of cold-dispatching a fresh
      // headless browser that Cloudflare challenges and fails — each cold
      // failure deepening the back-off (the live wedge). Mirrors the predicate
      // controller.runNow uses to decide whether to acquire a managed surface.
      isManagedConnector: (connectorId) =>
        Boolean(controller.browserSurfaceLeaseManager?.isManagedConnector(connectorId)),
      isNeedsHuman: (connectorId, connectorInstanceId) =>
        controller.isNeedsHuman(connectorId, { connectorInstanceId: connectorInstanceId ?? connectorId }) ||
        Boolean(controller.getActiveRun(connectorId, { connectorInstanceId: connectorInstanceId ?? connectorId })),
      markNeedsHuman: (connectorId, connectorInstanceId) =>
        controller.markNeedsHuman(connectorId, { connectorInstanceId: connectorInstanceId ?? connectorId }),
      // §10-F: push escalation on transition into human-required state.
      // Fires ONCE per streak/flag (dedup lives in the scheduler runtime maps
      // announcedBlockedClass + notifiedNeedsHumanSkips). Errors are swallowed
      // so a push delivery failure never crashes the scheduler loop.
      onHumanRequiredStateEscalation: async ({ connectorId, connectorInstanceId, reason }) => {
        const projection = await projectEscalation(connectorId, connectorInstanceId, controller, logger);
        try {
          await fanoutEscalationWebPush({
            config: webPushConfig,
            connectionUrl: projection.connectionUrl,
            connectorDisplayName: projection.connectorDisplayName,
            log: logger,
            ownerSubjectId,
            reason,
            renderedVerdict: projection.renderedVerdict,
            store: webPushSubscriptionStore,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`[scheduler] §10-F escalation push failed for ${connectorId} (${reason}): ${message}`);
        }
      },
      onInteraction: async (interaction: unknown) => {
        const interactionRecord: Interaction = isRecord(interaction) ? interaction : {};
        const connectorDisplayName = interactionDisplayName(interactionRecord);
        const runId = typeof interactionRecord.run_id === "string" ? interactionRecord.run_id : null;
        if (runId) {
          try {
            await fanoutPendingInteractionWebPush({
              config: webPushConfig,
              connectorDisplayName,
              interaction: interactionRecord,
              log: logger,
              ownerSubjectId,
              // Record the durable notification outcome on the structured
              // attention row the runtime writer just upserted. The attention
              // id is the runtime writer's default `att_<runId>_<requestId>`
              // — kept deterministic so the scheduler seam (which does not
              // own the per-run writer instance) can address it. A non-default
              // factory is only used by tests, which do not flow through this
              // production push path.
              recordOutcome: async ({ state, reason }: { state: string; reason?: string | null }) => {
                const requestId =
                  typeof interactionRecord.request_id === "string" ? interactionRecord.request_id : null;
                if (!requestId) {
                  return;
                }
                const attentionStore = getDefaultConnectorAttentionStore();
                if (typeof attentionStore.recordNotificationOutcomeById !== "function") {
                  return;
                }
                await attentionStore.recordNotificationOutcomeById({
                  attentionId: `att_${runId}_${requestId}`,
                  now: new Date().toISOString(),
                  outcome: state,
                  reason: reason || null,
                });
              },
              // Scheduled interactions are immediately marked needs-human and
              // cancelled so the scheduler does not wait unattended. Notify the
              // owner, but route to the durable run context rather than a
              // transient stream that may already be closed.
              routeTo: "run",
              runId,
              store: webPushSubscriptionStore,
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn(`[scheduler] web push fire for run ${runId} failed: ${message}`);
          }
        }
        return {
          request_id: interactionRecord.request_id,
          status: "cancelled",
          type: "INTERACTION_RESPONSE",
        };
      },
      onRunComplete: (record) => {
        logger.info(
          {
            connector_id: record.connectorId,
            connector_instance_id: record.connectorInstanceId || record.connectorId,
            run_id: record.runId || null,
            status: record.status,
            trace_id: record.traceId || null,
          },
          "scheduled connector run completed"
        );
      },
      setState: async (connectorId, state, connectorInstanceId) => {
        await putSyncState(
          storageTargetForConnectorNamespace({
            connectorId,
            ...(connectorInstanceId === undefined ? {} : { connectorInstanceId }),
          }),
          isRecord(state) ? state : {}
        );
      },
    });
    scheduler.start();
    logger.info({ schedules: connectors.length }, "reference scheduler started");
  }

  function refresh() {
    refreshChain = refreshChain.then(restart, restart);
    return refreshChain;
  }

  function stop() {
    stopped = true;
    scheduler?.stop();
    scheduler = null;
  }

  return { refresh, start: refresh, stop };
}
