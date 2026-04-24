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

import { createTraceContext } from '../lib/spine.ts';
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
let referenceFixtureConnectorIds = null;
let polyfillConnectorPaths = null;

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

      activeRuns.set(connectorId, {
        connector_id: connectorId,
        run_id: runId,
        trace_id: traceContext.trace_id,
        started_at: nowIso(),
      });

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
        onProgress: () => {},
      })
        .catch((err) => {
          log.error?.(`[controller] manual run failed for ${connectorId}: ${err.message}`);
        })
        .finally(() => {
          activeRuns.delete(connectorId);
        });

      return { run_id: runId, trace_id: traceContext.trace_id };
    },
    // Approval + connector inventory live in `auth.js`
    // (`listPendingApprovals`, `listConnectors`, `getConnectorManifest`).
    // Route handlers call those helpers directly; the controller does not
    // re-export them.
  };
}

/**
 * @typedef {ReturnType<typeof createController>} Controller
 */
