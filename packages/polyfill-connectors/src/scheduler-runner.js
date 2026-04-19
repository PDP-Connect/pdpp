/**
 * Polyfill scheduler runner.
 *
 * Wraps reference-implementation/runtime/scheduler.js with:
 *   - ntfy notifications on INTERACTION and on run failures
 *   - inbox integration (INTERACTION → parkInteraction → wait)
 *   - per-connector interval + jitter
 *   - persistent state via RS /v1/state/{connector_id}
 */

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { issueOwnerToken, registerManifest, readManifest, getConnectorPaths } from './orchestrator.js';
import { notifyInboxItem, notifyOvernightSummary } from './ntfy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..', '..', '..', 'reference-implementation');

const DEFAULT_INTERVALS = {
  ynab:   4 * 60 * 60 * 1000,  // 4h
  gmail:  30 * 60 * 1000,       // 30m
  chatgpt: 6 * 60 * 60 * 1000,  // 6h
  usaa:   4 * 60 * 60 * 1000,   // 4h
  amazon: 12 * 60 * 60 * 1000,  // 12h
};

function jitter(ms) {
  const pct = 0.25; // ±25%
  const delta = (Math.random() * 2 - 1) * ms * pct;
  return Math.max(1000, Math.round(ms + delta));
}

export async function startPolyfillScheduler({ asUrl, rsUrl, connectors, subjectId = 'the owner', inboxHandler }) {
  const { createScheduler } = await import(join(REFERENCE_IMPL_DIR, 'runtime/scheduler.js'));
  const { loadSyncState } = await import(join(REFERENCE_IMPL_DIR, 'runtime/index.js'));

  // Register all requested manifests first
  const schedules = [];
  const ownerToken = await issueOwnerToken(asUrl, subjectId);
  for (const name of connectors) {
    const manifest = readManifest(name);
    const { connectorPath } = getConnectorPaths(name);
    try {
      await registerManifest(asUrl, manifest);
    } catch (err) {
      console.error(`[scheduler] failed to register ${name}: ${err.message}`);
      continue;
    }
    schedules.push({
      connectorId: manifest.connector_id,
      connectorPath,
      manifest,
      ownerToken,
      intervalMs: jitter(DEFAULT_INTERVALS[name] || 60 * 60 * 1000),
      maxRetries: 2,
      grantAccessMode: 'continuous',
    });
  }

  const scheduler = createScheduler({
    connectors: schedules,
    rsUrl,
    onInteraction: async (msg) => {
      // Forward to inbox (parks until responded or timeout). The inboxHandler
      // is expected to return an INTERACTION_RESPONSE-shaped object.
      const itemId = await inboxHandler.park(msg);
      await notifyInboxItem({
        kind: msg.kind,
        connector_id: msg.connectorId || 'unknown',
        message: msg.message,
      });
      return inboxHandler.waitFor(itemId);
    },
    onRunComplete: (record) => {
      console.error(`[scheduler] run ${record.connectorId} status=${record.status} records=${record.recordsEmitted}`);
    },
    getState: async (connectorId) => {
      try {
        return await loadSyncState({ connectorId, ownerToken, rsUrl });
      } catch {
        return null;
      }
    },
    setState: async () => {
      // Scheduler-side no-op: runConnector with persistState=true already
      // handles state via /v1/state/{connector_id}. This hook is retained for
      // symmetry but isn't needed.
    },
  });

  scheduler.start();
  return {
    scheduler,
    stop: () => scheduler.stop(),
    async summarize() {
      const stats = scheduler.getStats();
      const counts = {};
      const failures = [];
      for (const [cid, s] of Object.entries(stats)) {
        counts[cid] = `${s.succeeded}/${s.totalRuns} succeeded, ${s.totalRecords} records`;
        if (s.lastRun?.status === 'failed') {
          failures.push(`${cid}: ${s.lastRun.error || 'unknown'}`);
        }
      }
      return { counts, failures, ok: failures.length === 0 };
    },
    async notifySummary() {
      const sum = await this.summarize();
      await notifyOvernightSummary(sum);
      return sum;
    },
  };
}
