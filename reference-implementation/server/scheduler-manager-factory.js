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

import { buildConnectionScopedRunEnvResolver } from './connection-scoped-run-env.js';
import { getConnectorManifest } from './auth.js';
import { canonicalConnectorKey } from './connector-key.js';
import { getDefaultConnectorDetailGapStore } from './stores/connector-detail-gap-store.js';
import {
  fanoutEscalationWebPush,
  fanoutPendingInteractionWebPush,
  resolveWebPushConfig,
  createWebPushSubscriptionStore,
} from './web-push-notifications.js';
import { unresolvedOwnerActionEvidenceFromSummary } from './owner-action-gate.js';
import { getSyncState, putSyncState } from './records.js';
import { getDefaultConnectorAttentionStore } from './stores/connector-attention-store.ts';
import { getConnectorAttentionProjection, getConnectorSummaryForRoute } from './ref-control.ts';
import { isHealthRelevant as isAttentionHealthRelevant } from '../runtime/attention.ts';
import { getRunTerminalEvent } from '../lib/spine.ts';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import {
  getScheduleIneligibilityReason,
  resolveDefaultConnectorPath,
} from '../runtime/controller.ts';
import { createScheduler } from '../runtime/scheduler.ts';
import { SOURCE_PRESSURE_GAP_REASONS } from '../runtime/scheduler-source-pressure-cooldown.ts';
import { getDefaultSchedulerStore } from './stores/scheduler-store.ts';

const SURFACE_UNAVAILABLE_HANDLE_STATUSES = Object.freeze([
  'run_browser_surface_queued',
  'browser_surface_probe_failed',
  'browser_surface_lost',
  'surface_failed',
]);

function projectManagedControllerTerminalRun(handle, terminalStatus, terminalEvent) {
  const terminalData = terminalEvent && terminalEvent.data && typeof terminalEvent.data === 'object'
    ? terminalEvent.data
    : {};
  return {
    run_id: handle.run_id,
    trace_id: handle.trace_id,
    status: terminalStatus,
    connector_error: terminalData.connector_error || null,
    failure_reason: terminalData.reason || null,
    known_gaps: Array.isArray(terminalData.known_gaps) ? terminalData.known_gaps : [],
    terminal_reason: terminalData.terminal_reason || null,
  };
}

function createRunManagedConnectorViaController(controller) {
  if (!controller?.browserSurfaceLeaseManager) {
    return null;
  }

  return async (connectorId, opts) => {
    if (!controller.browserSurfaceLeaseManager.isManagedConnector(connectorId)) {
      // Not a managed connector — signal launchRun to use the direct
      // runConnector path (no lease needed).
      return null;
    }
    const handle = await controller.runNow(connectorId, {
      connectorInstanceId: opts.connectorInstanceId,
      ownerToken: opts.ownerToken,
      priorityClass: opts.priorityClass,
      triggerKind: opts.triggerKind,
      rsUrl: opts.rsUrl,
      referenceBaseUrl: opts.referenceBaseUrl,
    });
    // Early-exit statuses (browser_surface_queued, surface_failed, etc.)
    // mean no run was started — return the handle as-is for the scheduler's
    // surface-unavailable skip path.
    if (handle.status && SURFACE_UNAVAILABLE_HANDLE_STATUSES.includes(handle.status)) {
      return handle;
    }
    // Run was dispatched (status "started"). Await its real terminal
    // outcome so the scheduler records the true succeeded/failed status
    // and its failure-streak / back-off machinery fires correctly.
    // controller.awaitRun waits for activeRunPromises[runId] to settle
    // (the .finally() cleanup chain), then reads the spine terminal event.
    // No deadlock risk: the run has its own wall-clock budget; a hung run
    // is the run's responsibility, matching the old runConnector await.
    const terminalStatus = await controller.awaitRun(handle.run_id);
    const terminalEvent = await getRunTerminalEvent(handle.run_id);
    return projectManagedControllerTerminalRun(handle, terminalStatus, terminalEvent);
  };
}

export function createReferenceSchedulerManager({
  controller,
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
} = {}) {
  let scheduler = null;
  let stopped = false;
  let refreshChain = Promise.resolve();

  // The SAME connection-scoped setup-material resolver the controller uses for
  // manual runs, bound to the scheduler's owner subject. Scheduled and manual
  // runs MUST resolve credentials/import bindings identically: a connection row
  // satisfies both, and a scheduled launch never falls back to process-global
  // setup material when a connection-scoped binding exists.
  const connectionScopedRunEnvResolver = buildConnectionScopedRunEnvResolver({ createConnectorInstanceStore: createConnectorInstanceStore, createConnectorInstanceCredentialStore: createConnectorInstanceCredentialStore });
  const resolveScheduledConnectionScopedRunEnv = ({ connectorId, connectorInstanceId }) =>
    connectionScopedRunEnvResolver({ connectorId, connectorInstanceId, ownerSubjectId });

  async function buildConnectors() {
    const schedules = await Promise.resolve(schedulerStore.listSchedules());
    const enabledSchedules = schedules.filter((schedule) => schedule?.enabled === true);
    const connectors = [];
    for (const schedule of enabledSchedules) {
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
        const manifest = await getConnectorManifest(connectorId);
        if (!manifest) {
          continue;
        }
        const scheduleIneligibilityReason = getScheduleIneligibilityReason(getManifestRefreshPolicy(manifest));
        if (scheduleIneligibilityReason) {
          logger?.warn?.(
            { connector_id: connectorId, reason: scheduleIneligibilityReason },
            'skipping scheduled connector because refresh policy is not background-safe',
          );
          continue;
        }
        const connectorPath = await Promise.resolve(
          connectorPathResolver(connectorId, manifest, { priorityClass: 'background' }),
        );
        if (!connectorPath) {
          logger?.warn?.(
            { connector_id: connectorId },
            'skipping scheduled connector without runnable implementation',
          );
          continue;
        }
        connectors.push({
          connectorId,
          connectorInstanceId: schedule.connector_instance_id,
          connectorPath,
          manifest,
          intervalMs: Math.max(1, schedule.interval_seconds) * 1000,
          ownerToken: await controller.issueRuntimeOwnerToken(),
        });
      } catch (err) {
        logger?.warn?.(
          { err, connector_id: schedule?.connector_id },
          'skipping scheduled connector during scheduler refresh',
        );
      }
    }
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
    scheduler = createScheduler({
      connectors,
      rsUrl: runtimeContext.rsUrl,
      referenceBaseUrl: runtimeContext.referenceBaseUrl,
      schedulerStore,
      resolveStaticSecretRunEnv: resolveScheduledConnectionScopedRunEnv,
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
      runManagedConnectorViaController: createRunManagedConnectorViaController(controller),
      // Recognize managed (browser-surface-leased) connectors so the scheduler
      // can DEFER a scheduled tick when the managed-routing seam above is not
      // wired yet (controller boot race), instead of cold-dispatching a fresh
      // headless browser that Cloudflare challenges and fails — each cold
      // failure deepening the back-off (the live wedge). Mirrors the predicate
      // controller.runNow uses to decide whether to acquire a managed surface.
      isManagedConnector: (connectorId) =>
        Boolean(controller?.browserSurfaceLeaseManager?.isManagedConnector?.(connectorId)),
      // Durable cross-path "latest successful run at" probe, read from the spine
      // run timeline so it sees EVERY success — including manual/owner
      // `controller.runNow` runs that never touch `scheduler_run_history`. Lets
      // the back-off gate clear a stale failure streak when a genuine success
      // has occurred since, so automation resumes. Returns null on no success or
      // probe error (never fabricates a success that would suppress back-off).
      getLastSuccessfulRunAt: async (connectorId) => {
        try {
          const summary = await getLatestConnectorRunSummary(connectorId, 'succeeded');
          const at = summary?.last_at ? Date.parse(summary.last_at) : Number.NaN;
          return Number.isFinite(at) ? at : null;
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            `[scheduler] last-success spine probe failed for ${connectorId}`,
          );
          return null;
        }
      },
      getState: async (connectorId, connectorInstanceId) => {
        // Read scheduler state from the connection-instance namespace by
        // construction: getSyncState keys storage off its storage-target
        // argument, and a bare connectorId string falls back to the
        // default-account instance id (the connectorInstanceId option is
        // ignored). Pass the explicit object target so each connection's
        // schedule reads its own durable state.
        const stored = await getSyncState(
          storageTargetForConnectorNamespace({ connectorId, connectorInstanceId }),
        );
        return stored?.state || null;
      },
      setState: async (connectorId, state, connectorInstanceId) => {
        await putSyncState(
          storageTargetForConnectorNamespace({ connectorId, connectorInstanceId }),
          state && typeof state === 'object' && !Array.isArray(state) ? state : {},
        );
      },
      markNeedsHuman: (connectorId, connectorInstanceId) => controller.markNeedsHuman(connectorId, { connectorInstanceId }),
      isNeedsHuman: (connectorId, connectorInstanceId) =>
        controller.isNeedsHuman(connectorId, { connectorInstanceId }) ||
        Boolean(controller.getActiveRun(connectorId, { connectorInstanceId })),
      hasUnresolvedAttention: async (connectorId, connectorInstanceId) => {
        // Durable attention projection. The in-memory `isNeedsHuman` flag
        // is process-local; this probe consults the structured
        // attention_request store so a scheduled tick after process
        // restart still recognizes unresolved owner action and does not
        // launch a doomed run. The projection is read-bounded
        // (`listOpenAttentionForConnection` clamps `limit` to 50) and
        // returns the most-recently-updated open record first.
        const projection = await getConnectorAttentionProjection(connectorId, { connectorInstanceId });
        if (projection.unreliable) {
          // Probe failure must not silently suppress launches — surface
          // the schedule as eligible so a freshness gap is preferred over
          // an invisible pause.
          return null;
        }
        const nowIso = new Date().toISOString();
        for (const record of projection.records) {
          if (!isAttentionHealthRelevant(record, nowIso)) continue;
          return { key: record.dedupe_key || record.id, reason: record.reason_code };
        }
        try {
          const routeId = connectorInstanceId || connectorId;
          const summary = await getConnectorSummaryForRoute(routeId, controller);
          const ownerAction = unresolvedOwnerActionEvidenceFromSummary(summary, routeId);
          if (ownerAction) {
            return ownerAction;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn?.(
            `[scheduler] owner-action projection failed for ${connectorId}/${connectorInstanceId || connectorId}: ${message}`,
          );
        }
        return null;
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
        const store = getDefaultConnectorDetailGapStore();
        const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
        const instanceKey = connectorInstanceId || connectorId;
        const gaps = [];
        for (const row of rows ?? []) {
          if (typeof row?.reason !== 'string' || !SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) continue;
          // `listPendingGapsForConnector` spans every instance of the connector
          // type; keep only this connection's gaps so cooldown stays per-source.
          if ((row.connector_instance_id || connectorId) !== instanceKey) continue;
          gaps.push({
            reason: row.reason,
            attemptCount: typeof row.attempt_count === 'number' ? row.attempt_count : null,
            nextAttemptAfter: typeof row.next_attempt_after === 'string' ? row.next_attempt_after : null,
            lastPressureAt:
              typeof row.last_attempt_at === 'string'
                ? row.last_attempt_at
                : typeof row.updated_at === 'string'
                  ? row.updated_at
                  : null,
          });
        }
        return gaps;
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
          const store = getDefaultConnectorDetailGapStore();
          const rows = await store.listPendingGapsForConnector(connectorId, { limit: 200 });
          const instanceKey = connectorInstanceId || connectorId;
          let count = 0;
          for (const row of rows ?? []) {
            // Exclude source-pressure reasons — they belong to Governor A (cooldown),
            // not to the recovery lane.
            if (typeof row?.reason === 'string' && SOURCE_PRESSURE_GAP_REASONS.has(row.reason)) continue;
            // Scope to this connection's instance (same guard as the pressure probe).
            if ((row.connector_instance_id || connectorId) !== instanceKey) continue;
            count += 1;
          }
          return count;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ err: message }, `[scheduler] non-pressure recovery probe failed for ${connectorId}`);
          return 0;
        }
      },
      onInteraction: async (interaction) => {
        const connectorDisplayName =
          typeof interaction?.connector_display_name === 'string' && interaction.connector_display_name.trim()
            ? interaction.connector_display_name.trim()
            : typeof interaction?.connector_id === 'string' && interaction.connector_id.trim()
              ? interaction.connector_id.trim()
              : 'Connector';
        const runId = typeof interaction?.run_id === 'string' ? interaction.run_id : null;
        if (runId) {
          try {
            await fanoutPendingInteractionWebPush({
              config: webPushConfig,
              store: webPushSubscriptionStore,
              interaction,
              connectorDisplayName,
              ownerSubjectId,
              // Scheduled interactions are immediately marked needs-human and
              // cancelled so the scheduler does not wait unattended. Notify the
              // owner, but route to the durable run context rather than a
              // transient stream that may already be closed.
              routeTo: 'run',
              runId,
              log: logger,
              // Record the durable notification outcome on the structured
              // attention row the runtime writer just upserted. The attention
              // id is the runtime writer's default `att_<runId>_<requestId>`
              // — kept deterministic so the scheduler seam (which does not
              // own the per-run writer instance) can address it. A non-default
              // factory is only used by tests, which do not flow through this
              // production push path.
              recordOutcome: async ({ state, reason }) => {
                const requestId = typeof interaction?.request_id === 'string' ? interaction.request_id : null;
                if (!requestId) return;
                const attentionStore = getDefaultConnectorAttentionStore();
                if (typeof attentionStore.recordNotificationOutcomeById !== 'function') return;
                await attentionStore.recordNotificationOutcomeById({
                  attentionId: `att_${runId}_${requestId}`,
                  outcome: state,
                  reason: reason || null,
                  now: new Date().toISOString(),
                });
              },
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger?.warn?.(`[scheduler] web push fire for run ${runId} failed: ${message}`);
          }
        }
        return {
          type: 'INTERACTION_RESPONSE',
          request_id: interaction.request_id,
          status: 'cancelled',
        };
      },
      // §10-F: push escalation on transition into human-required state.
      // Fires ONCE per streak/flag (dedup lives in the scheduler runtime maps
      // announcedBlockedClass + notifiedNeedsHumanSkips). Errors are swallowed
      // so a push delivery failure never crashes the scheduler loop.
      onHumanRequiredStateEscalation: async ({ connectorId, connectorInstanceId, reason }) => {
        let connectorDisplayName = connectorId;
        let connectionUrl = `/deployment`;
        let renderedVerdict = null;
        const routeId = connectorInstanceId || connectorId;
        try {
          const summary = await getConnectorSummaryForRoute(routeId, controller);
          if (summary) {
            connectorDisplayName = summary.display_name || summary.connector_display_name || connectorId;
            connectionUrl = `/sources/${encodeURIComponent(summary.connection_id || routeId)}`;
            renderedVerdict = summary.rendered_verdict ?? null;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn?.(
            `[scheduler] verdict projection failed for escalation ${connectorId}/${routeId}; suppressing push: ${message}`,
          );
        }
        try {
          await fanoutEscalationWebPush({
            config: webPushConfig,
            store: webPushSubscriptionStore,
            connectorDisplayName,
            ownerSubjectId,
            reason,
            connectionUrl,
            renderedVerdict,
            log: logger,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn?.(`[scheduler] §10-F escalation push failed for ${connectorId} (${reason}): ${message}`);
        }
      },
      onRunComplete: (record) => {
        logger?.info?.(
          {
            connector_id: record.connectorId,
            connector_instance_id: record.connectorInstanceId || record.connectorId,
            status: record.status,
            run_id: record.runId || null,
            trace_id: record.traceId || null,
          },
          'scheduled connector run completed',
        );
      },
    });
    scheduler.start();
    logger?.info?.({ schedules: connectors.length }, 'reference scheduler started');
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
