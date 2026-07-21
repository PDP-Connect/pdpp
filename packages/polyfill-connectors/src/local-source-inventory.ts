import { createHash } from "node:crypto";
import { type Dirent, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecordData } from "./connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "./fingerprint-cursor.ts";

export type SourceClassification = "collect" | "collect_redacted" | "inventory_only" | "exclude" | "defer";
export type CoverageStatus = "collected" | "inventory_only" | "excluded" | "deferred" | "missing" | "unsupported";

export interface KnownLocalStore {
  classification: SourceClassification;
  reason: string;
  relativePath: string;
  store: string;
  stream: string | null;
}

export interface InventoryRecord extends RecordData {
  classification: "inventory_only" | "defer";
  id: string;
  mtime_epoch: number | null;
  path_hash: string;
  reason: string;
  relative_path: string;
  size_bytes: number | null;
  store: string;
  type: "directory" | "file" | "missing" | "other";
}

export interface CoverageRecord extends RecordData {
  id: string;
  reason: string;
  status: CoverageStatus;
  store: string;
  stream: string | null;
}

export interface InventoryPlan {
  coverage: CoverageRecord[];
  recordsByStream: Map<string, InventoryRecord[]>;
}

function pathHash(tool: string, relativePath: string): string {
  return createHash("sha256").update(`${tool}:${relativePath}`).digest("hex");
}

function inventoryEntryType(st: { isDirectory: () => boolean; isFile: () => boolean }): InventoryRecord["type"] {
  if (st.isDirectory()) {
    return "directory";
  }
  if (st.isFile()) {
    return "file";
  }
  return "other";
}

function coverageStatus(classification: SourceClassification, exists: boolean): CoverageStatus {
  if (!exists) {
    return "missing";
  }
  if (classification === "collect") {
    return "collected";
  }
  if (classification === "inventory_only") {
    return "inventory_only";
  }
  if (classification === "exclude") {
    return "excluded";
  }
  if (classification === "defer" || classification === "collect_redacted") {
    return "deferred";
  }
  return "unsupported";
}

async function statKind(path: string): Promise<{
  exists: boolean;
  mtimeEpoch: number | null;
  sizeBytes: number | null;
  type: InventoryRecord["type"];
}> {
  try {
    const st = await stat(path);
    return {
      exists: true,
      mtimeEpoch: Math.floor(st.mtimeMs / 1000),
      sizeBytes: st.isFile() ? st.size : null,
      type: inventoryEntryType(st),
    };
  } catch {
    return { exists: false, mtimeEpoch: null, sizeBytes: null, type: "missing" };
  }
}

export async function buildLocalSourceInventory(
  tool: string,
  sourceHome: string,
  stores: readonly KnownLocalStore[]
): Promise<InventoryPlan> {
  const recordsByStream = new Map<string, InventoryRecord[]>();
  const coverage: CoverageRecord[] = [];

  for (const store of stores) {
    const fullPath = join(sourceHome, store.relativePath);
    const pathMeta = await statKind(fullPath);
    const status = coverageStatus(store.classification, pathMeta.exists);
    coverage.push({
      // Stable key: upsert on re-run replaces the prior record rather than
      // accumulating one row per distinct status. The server's
      // listLocalCoverageDiagnostics deduplications by store — a changing
      // key would let a stale row shadow the current one in alphabetical order.
      id: `coverage:${store.store}`,
      store: store.store,
      stream: store.stream,
      status,
      reason: store.reason,
    });

    if (
      !(pathMeta.exists && store.stream) ||
      (store.classification !== "inventory_only" && store.classification !== "defer")
    ) {
      continue;
    }
    const records = recordsByStream.get(store.stream) ?? [];
    records.push({
      id: `${store.store}:${pathHash(tool, store.relativePath)}`,
      store: store.store,
      relative_path: store.relativePath,
      path_hash: pathHash(tool, store.relativePath),
      type: pathMeta.type,
      size_bytes: pathMeta.sizeBytes,
      mtime_epoch: pathMeta.mtimeEpoch,
      classification: store.classification,
      reason: store.reason,
    });
    recordsByStream.set(store.stream, records);
  }

  return { coverage, recordsByStream };
}

export async function listDirectoryInventory(input: {
  reason: string;
  relativeRoot: string;
  sourceHome: string;
  store: string;
  stream: string;
  tool: string;
}): Promise<InventoryRecord[]> {
  const root = join(input.sourceHome, input.relativeRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: InventoryRecord[] = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith(".")) {
      continue;
    }
    const rel = `${input.relativeRoot}/${ent.name}`;
    const full = join(root, ent.name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    records.push({
      id: `${input.store}:${pathHash(input.tool, rel)}`,
      store: input.store,
      relative_path: rel,
      path_hash: pathHash(input.tool, rel),
      type: inventoryEntryType(st),
      size_bytes: st.isFile() ? st.size : null,
      mtime_epoch: Math.floor(st.mtimeMs / 1000),
      classification: "inventory_only",
      reason: input.reason,
    });
  }
  return records;
}

// ─── Inventory-record churn gate ──────────────────────────────────────────
//
// An `inventory_only` record exists to answer the local-agent-collector
// completeness contract: "this known store exists, here is its path, type,
// privacy classification, and reason." Its meaningful version transition is a
// change in that inventory meaning — the store appearing/disappearing, a file
// becoming a directory, a path-hash moving, or the classification/reason
// changing. The `mtime_epoch` and `size_bytes` fields are incidental file-stat
// metadata: every normal tool write touches the underlying file or directory
// and ticks the mtime (and, for files, the size), which re-versions an
// otherwise-unchanged metadata record on every run. That is the same class of
// run-clock churn the `fetched_at`-excluding fingerprint gates already stop on
// the API/browser connectors — the volatile freshness signal (does the store
// exist? when did the collector last look?) is already carried by the sibling
// `coverage_diagnostics` stream and the per-stream STATE `fetched_at`, not by
// re-versioning the inventory record itself.
//
// These two keys are excluded from the change-detection fingerprint so a pure
// mtime/size tick is a no-op emit, while a real inventory transition (type,
// path, classification, reason) still re-emits. The fields stay in the record
// body for point-in-time inspection; only version churn is suppressed.

/** Payload keys excluded from inventory-record change detection. Incidental
 *  file-stat metadata that moves on every tool write without changing the
 *  store's inventory meaning. Mirrored by the compaction policy in
 *  `reference-implementation/scripts/compact-record-history.mjs`. */
export const INVENTORY_FINGERPRINT_EXCLUDE_KEYS = ["mtime_epoch", "size_bytes"] as const;

/** Open a fingerprint cursor for an inventory stream, seeded from the prior
 *  STATE cursor. Excludes the incidental `mtime_epoch`/`size_bytes` file-stat
 *  fields so an unchanged store does not re-version on every run. Inventory
 *  enumeration is a full scan of the known stores under the source home, so
 *  callers SHOULD `pruneStale()` before serializing STATE: a store that
 *  disappears must drop out of the cursor so its re-appearance re-emits. */
export function openInventoryFingerprintCursor(priorState: unknown): FingerprintCursor {
  return openFingerprintCursor(priorState, {
    excludeFromFingerprint: INVENTORY_FINGERPRINT_EXCLUDE_KEYS,
  });
}
