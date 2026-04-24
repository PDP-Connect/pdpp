/**
 * Polyfill-mode startup manifest reconciliation.
 *
 * The reference persists connector manifests in the DB (`connectors.manifest`).
 * After shipping fixes to a first-party manifest JSON, existing databases must
 * self-heal on next startup — otherwise assistant-critical streams will keep
 * using stale schema declarations (and keep breaking records pagination).
 *
 * Scope:
 *   - Only first-party manifests under
 *     `packages/polyfill-connectors/manifests/` are reconciled. Connectors
 *     that are NOT in this shipped set are left alone so user-custom manifests
 *     are never overwritten.
 *   - Comparison is a deep structural equality against the persisted manifest;
 *     any difference triggers a fresh `registerConnector()` call, which is
 *     idempotent and runs the full validation + lexical backfill path.
 *
 * Disable for tests by passing `{ enabled: false }` or setting
 * `PDPP_SKIP_MANIFEST_RECONCILE=1` in the environment.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConnectorManifest, registerConnector } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the shipped polyfill-connectors manifests directory relative to
 * this file's location. Kept explicit so the reference doesn't wander into
 * arbitrary user directories.
 */
export function defaultPolyfillManifestsDir() {
  // server/polyfill-manifest-reconcile.js → ../../packages/polyfill-connectors/manifests
  return resolve(__dirname, '..', '..', 'packages', 'polyfill-connectors', 'manifests');
}

async function readManifestJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function canonicalize(value) {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

function manifestsEqual(a, b) {
  if (!a || !b) return false;
  return canonicalize(a) === canonicalize(b);
}

/**
 * Reconcile persisted connector manifests against the shipped first-party
 * set. Returns a summary counter for the caller's log.
 */
export async function reconcilePolyfillManifests(opts = {}) {
  const { enabled = true, manifestsDir = defaultPolyfillManifestsDir(), log = () => {} } = opts;
  if (!enabled) return { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
  if (process.env.PDPP_SKIP_MANIFEST_RECONCILE === '1') {
    return { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
  }

  let entries;
  try {
    entries = await readdir(manifestsDir, { withFileTypes: true });
  } catch (err) {
    log(`[manifest-reconcile] manifests dir unavailable: ${err.code || err.message}`);
    return { scanned: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0 };
  }

  let scanned = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let errors = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    scanned += 1;
    const path = join(manifestsDir, entry.name);
    let shipped;
    try {
      shipped = await readManifestJson(path);
    } catch (err) {
      errors += 1;
      log(`[manifest-reconcile] skipping malformed manifest ${entry.name}: ${err.message}`);
      continue;
    }
    const connectorId = shipped?.connector_id;
    if (!connectorId) {
      skipped += 1;
      continue;
    }
    let persisted;
    try {
      persisted = await getConnectorManifest(connectorId);
    } catch (err) {
      errors += 1;
      log(`[manifest-reconcile] lookup failed for ${connectorId}: ${err.message}`);
      continue;
    }
    if (!persisted) {
      // Connector not yet registered. Do not auto-register; that's a first-run
      // registration decision the reference leaves to explicit user action
      // (POST /connectors or the dashboard bootstrap flow). Reconciliation is
      // about repairing existing DB rows, not seeding new ones.
      skipped += 1;
      continue;
    }
    if (manifestsEqual(shipped, persisted)) {
      unchanged += 1;
      continue;
    }
    try {
      await registerConnector(shipped);
      updated += 1;
      log(`[manifest-reconcile] updated ${connectorId} from ${entry.name}`);
    } catch (err) {
      errors += 1;
      log(`[manifest-reconcile] update failed for ${connectorId}: ${err.message}`);
    }
  }
  return { scanned, updated, unchanged, skipped, errors };
}
