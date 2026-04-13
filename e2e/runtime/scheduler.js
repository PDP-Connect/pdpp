/**
 * Simple Proactive Scheduler (Experiment)
 *
 * Coordinates scheduled connector runs: picks connectors that are due
 * for collection, invokes the existing runConnector() function, manages
 * run history, and handles basic retry on failure.
 *
 * This is a runtime/orchestrator concern. It uses the Collection Profile's
 * runConnector() function as a black box and adds scheduling, retry, and
 * multi-connector coordination on top.
 *
 * The experiment tests whether orchestration creates interoperability
 * surface or stays cleanly in the runtime layer.
 *
 * Status: Experimental (reference architecture, non-normative)
 *
 * Key question: does orchestrating multiple connector runs require any
 * new wire-level contract, or is it purely a runtime concern?
 */

import { runConnector } from './index.js';

/**
 * @typedef {object} ConnectorSchedule
 * @property {string} connectorId
 * @property {string} connectorPath - Path to connector executable
 * @property {object} manifest - Connector manifest
 * @property {string} ownerToken
 * @property {number} intervalMs - How often to run (e.g., 3600000 = 1 hour)
 * @property {number} maxRetries - Max retry attempts on failure
 * @property {string} [grantAccessMode] - 'continuous' (default) or 'single_use'
 */

/**
 * @typedef {object} RunRecord
 * @property {string} connectorId
 * @property {string} status - 'succeeded' | 'failed' | 'skipped'
 * @property {number} recordsEmitted
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {string} [error]
 * @property {number} attempt
 */

/**
 * Create a scheduler that manages periodic connector runs.
 *
 * @param {object} opts
 * @param {ConnectorSchedule[]} opts.connectors - Connectors to schedule
 * @param {string} opts.rsUrl - Resource server URL
 * @param {function} opts.onInteraction - Interaction handler for all connectors
 * @param {function} opts.onRunComplete - Callback after each run
 * @param {function} opts.getState - (connectorId) => Promise<state>
 * @param {function} opts.setState - (connectorId, state) => Promise<void>
 * @returns {{ start: () => void, stop: () => void, getHistory: () => RunRecord[], getStats: () => object }}
 */
export function createScheduler(opts) {
  const {
    connectors,
    rsUrl = process.env.RS_URL || 'http://localhost:7663',
    onInteraction,
    onRunComplete = () => {},
    getState = async () => null,
    setState = async () => {},
  } = opts;

  const history = [];
  const lastRunTime = new Map(); // connectorId → timestamp
  const timers = [];
  let running = false;

  const exhaustedGrants = new Set(); // connectorIds whose single_use grants have been consumed

  async function executeRun(schedule) {
    const { connectorId, connectorPath, manifest, ownerToken, maxRetries = 2, grantAccessMode = 'continuous' } = schedule;

    // Skip if this single_use grant has already been consumed
    if (grantAccessMode === 'single_use' && exhaustedGrants.has(connectorId)) {
      const skipRecord = {
        connectorId,
        status: 'skipped',
        recordsEmitted: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: 'single_use grant already consumed',
        attempt: 0,
      };
      history.push(skipRecord);
      onRunComplete(skipRecord);
      return skipRecord;
    }

    // Don't persist state for single_use grants
    const persistState = grantAccessMode !== 'single_use';

    const state = await getState(connectorId);
    const collectionMode = state ? 'incremental' : 'full_refresh';

    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetries) {
      attempt++;
      const startedAt = new Date().toISOString();

      try {
        const result = await runConnector({
          connectorPath,
          connectorId,
          ownerToken,
          manifest,
          state,
          collectionMode,
          persistState,
          rsUrl,
          onInteraction,
          onProgress: () => {},
        });

        const record = {
          connectorId,
          status: result.status === 'succeeded' ? 'succeeded' : 'failed',
          recordsEmitted: result.records_emitted || 0,
          startedAt,
          completedAt: new Date().toISOString(),
          attempt,
        };

        history.push(record);
        lastRunTime.set(connectorId, Date.now());

        // Mark single_use grant as consumed after successful run
        if (result.status === 'succeeded' && grantAccessMode === 'single_use') {
          exhaustedGrants.add(connectorId);
        }

        if (result.status === 'succeeded' && persistState && result.state) {
          await setState(connectorId, result.state);
        }

        onRunComplete(record);
        return record;

      } catch (err) {
        lastError = err;
        if (attempt <= maxRetries) {
          // Exponential backoff: 1s, 2s, 4s...
          const backoff = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
          await new Promise(r => setTimeout(r, backoff));
        }
      }
    }

    // All retries exhausted
    const failRecord = {
      connectorId,
      status: 'failed',
      recordsEmitted: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: lastError?.message || 'unknown',
      attempt,
    };
    history.push(failRecord);
    onRunComplete(failRecord);
    return failRecord;
  }

  function start() {
    running = true;
    for (const schedule of connectors) {
      // Run immediately, then on interval
      executeRun(schedule);

      const timer = setInterval(() => {
        if (!running) return;
        const lastRun = lastRunTime.get(schedule.connectorId) || 0;
        const elapsed = Date.now() - lastRun;
        if (elapsed >= schedule.intervalMs) {
          executeRun(schedule);
        }
      }, Math.min(schedule.intervalMs, 60000)); // Check at least every minute

      timers.push(timer);
    }
  }

  function stop() {
    running = false;
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
  }

  function getHistory() { return [...history]; }

  function getStats() {
    const stats = {};
    for (const schedule of connectors) {
      const runs = history.filter(r => r.connectorId === schedule.connectorId);
      stats[schedule.connectorId] = {
        totalRuns: runs.length,
        succeeded: runs.filter(r => r.status === 'succeeded').length,
        failed: runs.filter(r => r.status === 'failed').length,
        totalRecords: runs.reduce((sum, r) => sum + r.recordsEmitted, 0),
        lastRun: runs[runs.length - 1] || null,
      };
    }
    return stats;
  }

  return { start, stop, getHistory, getStats };
}

// ─── Observations for the post-experiment memo ──────────────────────────────
//
// 1. Did this fit cleanly as runtime/reference architecture?
//    → YES. The scheduler uses runConnector() as a black box. It adds:
//      scheduling (interval-based), retry (exponential backoff), state
//      management (get/set callbacks), multi-connector coordination,
//      and history tracking. None of these affect the wire protocol.
//
// 2. Did it expose a real interoperability contract?
//    → NO. The scheduler is between the orchestrator and the local runtime.
//      Two independently-built PDPP servers would not need to agree on
//      scheduling, retry, or coordination — those are deployment choices.
//
// 3. What about single_use grant handling?
//    → The scheduler correctly sets persistState=false for single_use
//      grants. This is a Collection Profile invariant (state not persisted
//      for single_use runs) enforced in the orchestrator. The wire protocol
//      doesn't change — the runtime just doesn't call setState.
//
// 4. What would make orchestration need spec treatment?
//    → If multiple PDPP servers needed to coordinate collection across a
//      shared connector pool (distributed scheduling), that would need a
//      coordination protocol. But PDPP personal servers are per-user —
//      there's no shared pool. Orchestration stays local.
//
// 5. What is NOT in this experiment that a production orchestrator needs?
//    → Credential management, run locking (prevent concurrent runs of same
//      connector), grant lifecycle awareness (stop scheduling when grant
//      expires/revoked), observability (metrics, logging), and connector
//      update management. All runtime concerns.
