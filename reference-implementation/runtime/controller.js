// Runtime controller service.
//
// Owns long-lived local operator actions against the reference runtime:
//   - persisted one-per-connector schedule config (`connector_schedules` table)
//   - projections for `/_ref/schedules` reads
//   - manual `runNow(connectorId)` with per-connector active-run tracking
//     (surfaces as `POST /_ref/connectors/:connectorId/run`, including the
//     `409 run_already_active` conflict response)
//
// Full runtime orchestration (job lifecycle, connector spawn, record
// ingest, state persistence, retries) still lives in
// `runtime/index.js` / `runtime/scheduler.js`. The controller wraps, rather
// than replaces, those concerns. Approvals and the connector inventory
// come from `server/auth.js` directly; the controller does not re-export
// them.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTraceContext, emitSpineEvent } from '../lib/spine.ts';
import {
  approveOwnerDeviceAuthorization,
  getConnectorManifest,
  initiateOwnerDeviceAuthorization,
} from '../server/auth.js';
import { getDb } from '../server/db.js';
import { getSyncState } from '../server/records.js';
import { runConnector } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const REFERENCE_MANIFESTS_DIR = join(REFERENCE_IMPL_DIR, 'manifests');
const SEED_CONNECTOR_PATH = join(REFERENCE_IMPL_DIR, 'connectors', 'seed', 'index.js');
const POLYFILL_ROOT = join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors');
const POLYFILL_MANIFESTS_DIR = join(POLYFILL_ROOT, 'manifests');
const POLYFILL_CONNECTORS_DIR = join(POLYFILL_ROOT, 'connectors');

const activeRuns = new Map();
// Keyed by run_id → { connector_id, pending }
// Pending-interaction state is in-memory only. Dashboard-submitted responses
// satisfy the current live run; nothing about the submitted payload is
// persisted to `.env.local`, SQLite, or spine event payloads.
const activeRunInteractions = new Map();
let referenceFixtureConnectorIds = null;
let polyfillConnectorPaths = null;
const ABANDONED_CONTROLLER_RUN_REASON = 'controller_restarted';

function buildRunSource(connectorId) {
  return { binding_kind: 'connector', connector_id: connectorId };
}

function nowIso() {
  return new Date().toISOString();
}

function loadReferenceFixtureConnectorIds() {
  if (referenceFixtureConnectorIds) return referenceFixtureConnectorIds;
  const ids = new Set();
  for (const file of readdirSync(REFERENCE_MANIFESTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(REFERENCE_MANIFESTS_DIR, file), 'utf8'));
      if (typeof manifest?.connector_id === 'string' && manifest.connector_id.trim()) {
        ids.add(manifest.connector_id.trim());
      }
    } catch {
      // Ignore malformed local fixture manifests during runtime path discovery.
    }
  }
  referenceFixtureConnectorIds = ids;
  return ids;
}

function loadPolyfillConnectorPaths() {
  if (polyfillConnectorPaths) return polyfillConnectorPaths;
  const paths = new Map();
  if (!existsSync(POLYFILL_MANIFESTS_DIR)) {
    polyfillConnectorPaths = paths;
    return paths;
  }
  for (const file of readdirSync(POLYFILL_MANIFESTS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const connectorName = file.replace(/\.json$/, '');
    const connectorPath = [
      join(POLYFILL_CONNECTORS_DIR, connectorName, 'index.ts'),
      join(POLYFILL_CONNECTORS_DIR, connectorName, 'index.js'),
    ].find((candidatePath) => existsSync(candidatePath));
    if (!connectorPath) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, file), 'utf8'));
      if (typeof manifest?.connector_id === 'string' && manifest.connector_id.trim()) {
        paths.set(manifest.connector_id.trim(), connectorPath);
      }
    } catch {
      // Ignore malformed manifests when building the local connector-path map.
    }
  }
  polyfillConnectorPaths = paths;
  return paths;
}

export function resolveDefaultConnectorPath(connectorId) {
  if (loadReferenceFixtureConnectorIds().has(connectorId)) {
    return SEED_CONNECTOR_PATH;
  }
  return loadPolyfillConnectorPaths().get(connectorId) || null;
}

function getRuntimeProjection(connectorId) {
  const active = activeRuns.get(connectorId) || null;
  if (!active) {
    return {
      active_run_id: null,
      last_started_at: null,
      last_finished_at: null,
      last_error_code: null,
    };
  }
  return {
    active_run_id: active.run_id,
    last_started_at: active.started_at,
    last_finished_at: null,
    last_error_code: null,
  };
}

function validateScheduleInput(input) {
  const errors = [];
  const interval = Number.parseInt(String(input?.interval_seconds), 10);
  if (!Number.isInteger(interval) || interval < 1) {
    errors.push({ param: 'interval_seconds', message: 'interval_seconds must be a positive integer' });
  }
  let jitter = 0;
  if (input?.jitter_seconds !== undefined) {
    jitter = Number.parseInt(String(input.jitter_seconds), 10);
    if (!Number.isInteger(jitter) || jitter < 0) {
      errors.push({ param: 'jitter_seconds', message: 'jitter_seconds must be a non-negative integer' });
    }
  }
  let enabled = true;
  if (input?.enabled !== undefined) {
    if (input.enabled === true || input.enabled === false) {
      enabled = input.enabled;
    } else {
      errors.push({ param: 'enabled', message: 'enabled must be a boolean' });
    }
  }
  if (errors.length) {
    const err = new Error('Invalid schedule body');
    err.code = 'invalid_request';
    err.details = errors;
    throw err;
  }
  return { interval_seconds: interval, jitter_seconds: jitter, enabled };
}

function scheduleRowToApi(row, runtimeProjection = null) {
  if (!row) return null;
  return {
    object: 'schedule',
    connector_id: row.connector_id,
    interval_seconds: row.interval_seconds,
    jitter_seconds: row.jitter_seconds,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // Projections left intentionally null until runtime state wiring lands.
    next_due_at: null,
    active_run_id: runtimeProjection?.active_run_id || null,
    last_started_at: runtimeProjection?.last_started_at || null,
    last_finished_at: runtimeProjection?.last_finished_at || null,
    last_error_code: runtimeProjection?.last_error_code || null,
  };
}

/**
 * Create a new controller instance.
 *
 * @param {object} opts
 * @param {object} [opts.db]        - defaults to the shared reference DB
 * @param {object} [opts.runtime]   - shared runtime facade from runtime/index.js
 * @param {object} [opts.scheduler] - scheduler handle from runtime/scheduler.js
 * @param {object} [opts.logger]    - optional logger (defaults to console)
 */
export function createController(opts = {}) {
  const db = opts.db || getDb();
  const log = opts.logger || console;
  const resolveConnectorPath = opts.connectorPathResolver || resolveDefaultConnectorPath;
  const ownerClientId = opts.ownerClientId || 'cli_longview';
  const ownerSubjectId = opts.ownerSubjectId || 'owner_local';
  void opts.runtime;
  void opts.scheduler;

  function listPersistedActiveRuns() {
    return db.prepare(`
      SELECT connector_id, run_id, trace_id, scenario_id, started_at
      FROM controller_active_runs
      ORDER BY started_at ASC, connector_id ASC
    `).all();
  }

  function persistActiveRun(row) {
    db.prepare(`
      INSERT INTO controller_active_runs(connector_id, run_id, trace_id, scenario_id, started_at)
      VALUES(?, ?, ?, ?, ?)
      ON CONFLICT(connector_id) DO UPDATE SET
        run_id = excluded.run_id,
        trace_id = excluded.trace_id,
        scenario_id = excluded.scenario_id,
        started_at = excluded.started_at
    `).run(
      row.connector_id,
      row.run_id,
      row.trace_id,
      row.scenario_id,
      row.started_at,
    );
  }

  function clearPersistedActiveRun(connectorId, runId) {
    db.prepare(`
      DELETE FROM controller_active_runs
      WHERE connector_id = ?
        AND run_id = ?
    `).run(connectorId, runId);
  }

  function runAlreadyTerminal(runId) {
    const row = db.prepare(`
      SELECT 1
      FROM spine_events
      WHERE run_id = ?
        AND event_type IN ('run.completed', 'run.failed')
      LIMIT 1
    `).get(runId);
    return Boolean(row);
  }

  function reconcileAbandonedControllerRuns() {
    const rows = listPersistedActiveRuns();
    if (rows.length === 0) return;

    const tx = db.transaction((staleRows) => {
      for (const row of staleRows) {
        if (!runAlreadyTerminal(row.run_id)) {
          void emitSpineEvent({
            event_type: 'run.failed',
            trace_id: row.trace_id,
            scenario_id: row.scenario_id,
            actor_type: 'runtime',
            actor_id: row.connector_id,
            object_type: 'run',
            object_id: row.run_id,
            status: 'failed',
            run_id: row.run_id,
            data: {
              source: buildRunSource(row.connector_id),
              reason: ABANDONED_CONTROLLER_RUN_REASON,
              failure_reason: ABANDONED_CONTROLLER_RUN_REASON,
              message: 'Reference server restarted while a controller-managed run was still active.',
            },
          }, db);
        }
        clearPersistedActiveRun(row.connector_id, row.run_id);
      }
    });

    tx(rows);

    for (const row of rows) {
      log.warn?.(
        `[controller] reconciled abandoned controller-managed run ${row.run_id} for ${row.connector_id}`,
      );
    }
  }

  reconcileAbandonedControllerRuns();

  function getScheduleRow(connectorId) {
    return db.prepare(`
      SELECT connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
      FROM connector_schedules
      WHERE connector_id = ?
    `).get(connectorId) || null;
  }

  function currentRsUrl(override = null) {
    if (override) return override;
    if (typeof opts.rsUrl === 'string' && opts.rsUrl) return opts.rsUrl;
    if (typeof opts.runtimeContext?.rsUrl === 'string' && opts.runtimeContext.rsUrl) {
      return opts.runtimeContext.rsUrl;
    }
    return process.env.RS_URL || 'http://localhost:7663';
  }

  async function issueRuntimeOwnerToken() {
    const device = await initiateOwnerDeviceAuthorization(ownerClientId, {
      baseUrl: opts.asPublicUrl || process.env.AS_PUBLIC_URL || undefined,
    });
    const approved = await approveOwnerDeviceAuthorization(device.user_code, ownerSubjectId);
    return approved.access_token;
  }

  return {
    async listSchedules() {
      const rows = db.prepare(`
        SELECT connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at
        FROM connector_schedules
        ORDER BY connector_id ASC
      `).all();
      return rows.map((row) => scheduleRowToApi(row, getRuntimeProjection(row.connector_id)));
    },

    async getSchedule(connectorId) {
      const row = getScheduleRow(connectorId);
      return row ? scheduleRowToApi(row, getRuntimeProjection(connectorId)) : null;
    },

    async upsertSchedule(connectorId, input) {
      const now = nowIso();
      const validated = validateScheduleInput(input);
      const existing = getScheduleRow(connectorId);
      if (existing) {
        db.prepare(`
          UPDATE connector_schedules
          SET interval_seconds = ?, jitter_seconds = ?, enabled = ?, updated_at = ?
          WHERE connector_id = ?
        `).run(validated.interval_seconds, validated.jitter_seconds, validated.enabled ? 1 : 0, now, connectorId);
      } else {
        db.prepare(`
          INSERT INTO connector_schedules(connector_id, interval_seconds, jitter_seconds, enabled, created_at, updated_at)
          VALUES(?, ?, ?, ?, ?, ?)
        `).run(
          connectorId,
          validated.interval_seconds,
          validated.jitter_seconds,
          validated.enabled ? 1 : 0,
          now,
          now,
        );
      }
      const row = getScheduleRow(connectorId);
      return scheduleRowToApi(row, getRuntimeProjection(connectorId));
    },

    async setScheduleEnabled(connectorId, enabled) {
      const existing = getScheduleRow(connectorId);
      if (!existing) {
        const err = new Error(`Schedule not found for connector: ${connectorId}`);
        err.code = 'not_found';
        throw err;
      }
      db.prepare(`
        UPDATE connector_schedules
        SET enabled = ?, updated_at = ?
        WHERE connector_id = ?
      `).run(enabled ? 1 : 0, nowIso(), connectorId);
      return scheduleRowToApi(getScheduleRow(connectorId), getRuntimeProjection(connectorId));
    },

    async deleteSchedule(connectorId) {
      const existing = getScheduleRow(connectorId);
      if (!existing) return false;
      db.prepare('DELETE FROM connector_schedules WHERE connector_id = ?').run(connectorId);
      return true;
    },

    getActiveRun(connectorId) {
      return activeRuns.get(connectorId) || null;
    },

    async runNow(connectorId, options = {}) {
      const existing = activeRuns.get(connectorId);
      if (existing) {
        const err = new Error(`Connector already has an active run: ${existing.run_id}`);
        err.code = 'run_already_active';
        err.run_id = existing.run_id;
        throw err;
      }

      const manifest = options.manifest || await getConnectorManifest(connectorId);
      if (!manifest) {
        const err = new Error(`Unknown connector: ${connectorId}`);
        err.code = 'not_found';
        throw err;
      }

      const connectorPath = await Promise.resolve(resolveConnectorPath(connectorId, manifest, options));
      if (!connectorPath) {
        const err = new Error(`No runnable connector implementation is available for ${connectorId}`);
        err.code = 'not_found';
        throw err;
      }

      const syncState = await getSyncState(connectorId);
      const state = syncState?.state && Object.keys(syncState.state).length ? syncState.state : null;
      const collectionMode = state ? 'incremental' : 'full_refresh';
      const ownerToken = options.ownerToken || await issueRuntimeOwnerToken();
      const traceContext = options.traceContext || createTraceContext({ scenarioId: options.scenarioId });
      const runId = options.runId || `run_${Date.now()}`;
      const startedAt = nowIso();

      persistActiveRun({
        connector_id: connectorId,
        run_id: runId,
        trace_id: traceContext.trace_id,
        scenario_id: traceContext.scenario_id,
        started_at: startedAt,
      });

      activeRuns.set(connectorId, {
        connector_id: connectorId,
        run_id: runId,
        trace_id: traceContext.trace_id,
        started_at: startedAt,
      });

      const interactionHandler = (interaction) => brokerInteraction(runId, connectorId, interaction);

      void runConnector({
        connectorPath,
        connectorId,
        ownerToken,
        manifest,
        state,
        collectionMode,
        rsUrl: currentRsUrl(options.rsUrl),
        runId,
        traceContext,
        onInteraction: interactionHandler,
        onProgress: () => {},
      })
        .catch((err) => {
          log.error?.(`[controller] manual run failed for ${connectorId}: ${err.message}`);
        })
        .finally(() => {
          activeRuns.delete(connectorId);
          clearPersistedActiveRun(connectorId, runId);
          // Defensive: cancel any lingering pending interaction tracked for
          // this run so the dashboard-submit path doesn't resolve against a
          // stale run that already terminated via runtime timeout.
          const leftover = activeRunInteractions.get(runId);
          if (leftover) {
            activeRunInteractions.delete(runId);
            if (leftover.pending) {
              leftover.pending.resolve({
                type: 'INTERACTION_RESPONSE',
                request_id: leftover.pending.interaction_id,
                status: 'cancelled',
              });
            }
          }
        });

      return { run_id: runId, trace_id: traceContext.trace_id };
    },

    /**
     * Answer the current pending interaction for an active controller-managed
     * run. Invoked from `POST /_ref/runs/:runId/interaction`.
     *
     * Failure semantics:
     *   - not_found — no active run with this id
     *   - no_pending_interaction — active run but nothing to answer
     *   - interaction_id_mismatch — the submitted interaction_id no longer
     *     matches the current pending interaction (stale form)
     *   - invalid_status — status outside `success` / `cancelled`
     *
     * Submitted `data` is forwarded to the runtime via the resolver so the
     * runtime delivers a single INTERACTION_RESPONSE back to the connector.
     * It is never persisted here or by the runtime beyond the existing safe
     * `run.interaction_completed` metadata.
     */
    respondToInteraction(runId, { interaction_id, status, data } = {}) {
      const entry = activeRunInteractions.get(runId);
      if (!entry) {
        const err = new Error(`No active run with id: ${runId}`);
        err.code = 'not_found';
        throw err;
      }
      if (!entry.pending) {
        const err = new Error(`Active run ${runId} has no pending interaction`);
        err.code = 'no_pending_interaction';
        throw err;
      }
      if (
        typeof interaction_id !== 'string'
        || !interaction_id.trim()
        || interaction_id !== entry.pending.interaction_id
      ) {
        const err = new Error(
          `Stale interaction_id for run ${runId}: expected ${entry.pending.interaction_id}`,
        );
        err.code = 'interaction_id_mismatch';
        err.expected_interaction_id = entry.pending.interaction_id;
        throw err;
      }
      if (status !== 'success' && status !== 'cancelled') {
        const err = new Error(`Invalid interaction status: ${status}`);
        err.code = 'invalid_status';
        throw err;
      }
      const response = {
        type: 'INTERACTION_RESPONSE',
        request_id: interaction_id,
        status,
      };
      if (status === 'success' && data && typeof data === 'object' && !Array.isArray(data)) {
        response.data = data;
      }
      const pending = entry.pending;
      entry.pending = null;
      pending.resolve(response);
      return { accepted: true, status };
    },

    getPendingInteraction(runId) {
      const entry = activeRunInteractions.get(runId);
      if (!entry || !entry.pending) return null;
      return {
        run_id: runId,
        connector_id: entry.connector_id,
        interaction_id: entry.pending.interaction_id,
        kind: entry.pending.kind,
        stream: entry.pending.stream || null,
      };
    },
    // Approval + connector inventory live in `auth.js`
    // (`listPendingApprovals`, `listConnectors`, `getConnectorManifest`).
    // Route handlers call those helpers directly; the controller does not
    // re-export them.
  };
}

/**
 * Register a pending interaction for a controller-managed run and return a
 * promise that resolves to the INTERACTION_RESPONSE the runtime should
 * deliver. Exported indirectly through the controller's `runNow` handler;
 * kept at module scope because the pending-interaction state is shared with
 * the dashboard-submit path.
 */
function brokerInteraction(runId, connectorId, interaction) {
  return new Promise((resolve) => {
    const entry = activeRunInteractions.get(runId) || { connector_id: connectorId, pending: null };
    if (entry.pending) {
      // Protocol violation handled upstream: the runtime prevents a second
      // INTERACTION while one is pending. Reaching here would be a bug.
      resolve({
        type: 'INTERACTION_RESPONSE',
        request_id: interaction.request_id,
        status: 'cancelled',
      });
      return;
    }
    entry.connector_id = connectorId;
    entry.pending = {
      interaction_id: interaction.request_id,
      kind: interaction.kind,
      stream: interaction.stream || null,
      resolve,
    };
    activeRunInteractions.set(runId, entry);
  });
}

/**
 * Test-only: reset all in-memory broker state. Exposed so test harnesses can
 * keep state clean across test-file reruns without importing the module's
 * private `Map`s.
 */
export function __resetControllerInteractionStateForTests() {
  activeRunInteractions.clear();
  activeRuns.clear();
}

/**
 * @typedef {ReturnType<typeof createController>} Controller
 */
