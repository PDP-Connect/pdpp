/**
 * Polyfill-mode startup manifest reconciliation.
 *
 * The reference persists connector manifests in the DB
 * (`connectors.manifest`). After shipping fixes to a first-party
 * manifest JSON, existing databases must self-heal on next startup —
 * otherwise assistant-critical streams will keep using stale schema
 * declarations (and keep breaking records pagination).
 *
 * Scope:
 *   - Only first-party manifests under
 *     `packages/polyfill-connectors/manifests/` are reconciled. Connectors
 *     that are NOT in this shipped set are left alone so user-custom
 *     manifests are never overwritten.
 *   - Comparison is a deep structural equality against the persisted
 *     manifest; any difference triggers a fresh `registerConnector()`
 *     call, which is idempotent and runs the full validation + lexical
 *     backfill path.
 *
 * Disable for tests by passing `{ enabled: false }` or setting
 * `PDPP_SKIP_MANIFEST_RECONCILE=1` in the environment.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// auth.js is still JavaScript; the imported functions are typed
// loosely below since their full signatures land with the auth.js
// migration slice. Until then we narrow the surface used here.
import { getConnectorManifest, registerConnector } from "./auth.js";

// Auth.js wires these as untyped JS functions; until that file
// migrates, we re-declare the narrow shape this module relies on so
// the reconciliation code stays type-checked end to end.
type GetConnectorManifest = (connectorId: string) => Promise<unknown>;
type RegisterConnector = (manifest: PolyfillManifest) => Promise<unknown>;

const getConnectorManifestTyped: GetConnectorManifest = getConnectorManifest as GetConnectorManifest;
const registerConnectorTyped: RegisterConnector = registerConnector as RegisterConnector;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the shipped polyfill-connectors manifests directory relative
 * to this file's location. Kept explicit so the reference doesn't
 * wander into arbitrary user directories.
 */
export function defaultPolyfillManifestsDir(): string {
  // server/polyfill-manifest-reconcile.ts → ../../packages/polyfill-connectors/manifests
  return resolve(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");
}

// Manifest JSON files are user-authored; we only require a
// `connector_id` to drive the reconciliation key. Everything else is
// passed through to registerConnector unchanged.
export interface PolyfillManifest {
  connector_id?: unknown;
  [field: string]: unknown;
}

async function readManifestJson(path: string): Promise<PolyfillManifest> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as PolyfillManifest;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      const source = v as Record<string, unknown>;
      for (const k of Object.keys(source).sort()) {
        sorted[k] = source[k];
      }
      return sorted;
    }
    return v;
  });
}

function manifestsEqual(a: unknown, b: unknown): boolean {
  if (!(a && b)) {
    return false;
  }
  return canonicalize(a) === canonicalize(b);
}

export interface ReconcileSummary {
  errors: number;
  scanned: number;
  skipped: number;
  unchanged: number;
  updated: number;
}

export interface ReconcileOptions {
  enabled?: boolean;
  log?: (line: string) => void;
  manifestsDir?: string;
}

const EMPTY_SUMMARY: ReconcileSummary = {
  scanned: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  errors: 0,
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Some I/O errors carry a `.code` (`ENOENT`, etc.) on the Error
    // object directly; surface that when present, otherwise fall back
    // to the message.
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
    return err.message;
  }
  return String(err);
}

/**
 * Reconcile persisted connector manifests against the shipped
 * first-party set. Returns a summary counter for the caller's log.
 */
export async function reconcilePolyfillManifests(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const {
    enabled = true,
    manifestsDir = defaultPolyfillManifestsDir(),
    log = () => {
      /* default no-op logger */
    },
  } = opts;
  if (!enabled) {
    return { ...EMPTY_SUMMARY };
  }
  if (process.env.PDPP_SKIP_MANIFEST_RECONCILE === "1") {
    return { ...EMPTY_SUMMARY };
  }

  // readdir's TS overload defaults the dirent buffer parameter to
  // NonSharedBuffer. We pass the encoding explicitly so the result
  // is typed as `Dirent<string>[]`, which is what the rest of this
  // function operates on (entry.name is a string).
  let entries: Dirent<string>[];
  try {
    entries = await readdir(manifestsDir, { withFileTypes: true, encoding: "utf8" });
  } catch (err) {
    log(`[manifest-reconcile] manifests dir unavailable: ${errorMessage(err)}`);
    return { ...EMPTY_SUMMARY };
  }

  const summary: ReconcileSummary = { ...EMPTY_SUMMARY };

  for (const entry of entries) {
    if (!(entry.isFile() && entry.name.endsWith(".json"))) {
      continue;
    }
    summary.scanned += 1;
    const path = join(manifestsDir, entry.name);
    let shipped: PolyfillManifest;
    try {
      shipped = await readManifestJson(path);
    } catch (err) {
      summary.errors += 1;
      log(`[manifest-reconcile] skipping malformed manifest ${entry.name}: ${errorMessage(err)}`);
      continue;
    }
    const connectorIdRaw = shipped.connector_id;
    if (typeof connectorIdRaw !== "string" || connectorIdRaw.length === 0) {
      summary.skipped += 1;
      continue;
    }
    const connectorId = connectorIdRaw;
    let persisted: unknown;
    try {
      persisted = await getConnectorManifestTyped(connectorId);
    } catch (err) {
      summary.errors += 1;
      log(`[manifest-reconcile] lookup failed for ${connectorId}: ${errorMessage(err)}`);
      continue;
    }
    if (!persisted) {
      // Connector not yet registered. Do not auto-register; that's a
      // first-run registration decision the reference leaves to
      // explicit user action (POST /connectors or the dashboard
      // bootstrap flow). Reconciliation is about repairing existing
      // DB rows, not seeding new ones.
      summary.skipped += 1;
      continue;
    }
    if (manifestsEqual(shipped, persisted)) {
      summary.unchanged += 1;
      continue;
    }
    try {
      await registerConnectorTyped(shipped);
      summary.updated += 1;
      log(`[manifest-reconcile] updated ${connectorId} from ${entry.name}`);
    } catch (err) {
      summary.errors += 1;
      log(`[manifest-reconcile] update failed for ${connectorId}: ${errorMessage(err)}`);
    }
  }
  return summary;
}
