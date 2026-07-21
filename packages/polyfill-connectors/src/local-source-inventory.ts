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

export interface LocalCoverageStoreDescriptor {
  readonly store: string;
  readonly stream: string | null;
}

/**
 * The fixed local inventories are an authority shared by emitters and the
 * server proof reader. Keep identifiers here, separate from connector-specific
 * path/reason metadata, so a partial durable diagnostic set is detectable.
 */
export const LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR = {
  claude_code: [
    { store: "projects", stream: "sessions" },
    { store: "skills", stream: "skills" },
    { store: "commands", stream: "slash_commands" },
    { store: "file_history", stream: "file_history" },
    { store: "context_mode", stream: null },
    { store: "cache", stream: "cache_inventory" },
    { store: "backups", stream: "backup_inventory" },
    { store: "config", stream: "config_inventory" },
    { store: "debug", stream: "debug_artifacts" },
    { store: "downloads", stream: "downloads" },
    { store: "auth", stream: null },
  ],
  codex: [
    { store: "sessions", stream: "sessions" },
    { store: "state_db", stream: "sessions" },
    { store: "rules", stream: "rules" },
    { store: "prompts", stream: "prompts" },
    { store: "skills", stream: "skills" },
    { store: "history", stream: "history" },
    { store: "session_index", stream: "session_index" },
    { store: "shell_snapshots", stream: "shell_snapshots" },
    { store: "memories", stream: null },
    { store: "context_mode", stream: null },
    { store: "logs", stream: "logs" },
    { store: "config", stream: "config_inventory" },
    { store: "cache", stream: "cache_inventory" },
    { store: "auth", stream: null },
  ],
} as const;

/** Compatibility store-name view of the exact descriptor authority. */
export const LOCAL_COVERAGE_STORES_BY_CONNECTOR = Object.fromEntries(
  Object.entries(LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR).map(([connector, stores]) => [
    connector,
    stores.map((store) => store.store),
  ])
) as unknown as {
  readonly [K in keyof typeof LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR]: readonly string[];
};

export type LocalCoverageConnector = keyof typeof LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR;

function normalizeLocalCoverageConnector(connectorId: string): string {
  if (connectorId === "claude-code" || connectorId.endsWith("/claude-code")) {
    return "claude_code";
  }
  if (connectorId === "codex" || connectorId.endsWith("/codex")) {
    return "codex";
  }
  return connectorId;
}

export function expectedLocalCoverageStores(connectorId: string): readonly string[] | null {
  const normalized = normalizeLocalCoverageConnector(connectorId);
  return normalized in LOCAL_COVERAGE_STORES_BY_CONNECTOR
    ? LOCAL_COVERAGE_STORES_BY_CONNECTOR[normalized as LocalCoverageConnector]
    : null;
}

export function expectedLocalCoverageStoreDescriptors(
  connectorId: string
): readonly LocalCoverageStoreDescriptor[] | null {
  const normalized = normalizeLocalCoverageConnector(connectorId);
  return normalized in LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR
    ? LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR[normalized as LocalCoverageConnector]
    : null;
}

function assertExpectedLocalCoverageStores(tool: string, stores: readonly KnownLocalStore[]): void {
  const expected = expectedLocalCoverageStores(tool);
  if (!expected) {
    return;
  }
  const actual = stores.map((store) => `${store.store}\u0000${store.stream ?? ""}`).sort();
  const expectedDescriptors = expectedLocalCoverageStoreDescriptors(tool);
  const expectedSorted = expectedDescriptors
    ? expectedDescriptors.map((store) => `${store.store}\u0000${store.stream ?? ""}`).sort()
    : [];
  if (
    actual.length !== expectedSorted.length ||
    actual.some((store, index) => store !== expectedSorted[index]) ||
    new Set(actual).size !== actual.length
  ) {
    throw new Error(`${tool} local coverage declaration diverges from its authoritative expected-store set`);
  }
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

export interface SafeCoverageDiagnosticStore {
  readonly status: CoverageStatus | "unaccounted";
  readonly store: string;
  readonly stream: string | null;
}

/**
 * Construct the only durable positive local-coverage proof. It deliberately
 * strips record ids and reason/path-derived metadata at the producer boundary.
 */
export function buildCoverageDiagnosticsStateSnapshot(
  coverage: readonly CoverageRecord[]
): readonly SafeCoverageDiagnosticStore[] {
  return coverage.map(({ status, store, stream }) => ({ status, store, stream }));
}

export interface ParsedCoverageDiagnosticsStateSnapshot {
  readonly duplicateStores: readonly string[];
  readonly hasAuthoritativeInventory: boolean;
  readonly hasCommittedSnapshot: boolean;
  readonly malformed: boolean;
  readonly missingStores: readonly string[];
  readonly rows: readonly SafeCoverageDiagnosticStore[];
  readonly unexpectedStores: readonly string[];
}

const SAFE_COVERAGE_DIAGNOSTIC_STATUSES = new Set<CoverageStatus | "unaccounted">([
  "collected",
  "inventory_only",
  "excluded",
  "deferred",
  "missing",
  "unsupported",
  "unaccounted",
]);

const COVERAGE_DIAGNOSTICS_STATE_KEYS = ["fetched_at", "stores"] as const;
const COVERAGE_DIAGNOSTICS_STATE_ENTRY_KEYS = ["status", "store", "stream"] as const;

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function isValidCoverageDiagnosticsFetchedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function parseCoverageDiagnosticStateEntry(rawEntry: unknown): {
  readonly status: CoverageStatus | "unaccounted";
  readonly store: string;
  readonly stream: unknown;
} | null {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }
  const entry = rawEntry as Record<string, unknown>;
  if (!hasExactKeys(entry, COVERAGE_DIAGNOSTICS_STATE_ENTRY_KEYS)) {
    return null;
  }
  const store = typeof entry.store === "string" && entry.store ? entry.store : null;
  const status = entry.status;
  if (
    !store ||
    (typeof entry.stream !== "string" && entry.stream !== null) ||
    typeof status !== "string" ||
    !SAFE_COVERAGE_DIAGNOSTIC_STATUSES.has(status as CoverageStatus)
  ) {
    return null;
  }
  return { store, stream: entry.stream, status: status as CoverageStatus | "unaccounted" };
}

/**
 * Parse the committed coverage STATE at its trust boundary. Only the current
 * `{ fetched_at, stores }` schema and its exact safe store triples are proof;
 * legacy, private, and future-shaped state fails closed as malformed.
 */
export function parseCoverageDiagnosticsStateSnapshot(
  connectorId: string,
  state: unknown
): ParsedCoverageDiagnosticsStateSnapshot {
  const expected = expectedLocalCoverageStoreDescriptors(connectorId);
  const hasAuthoritativeInventory = expected !== null;
  const empty = {
    duplicateStores: [] as string[],
    hasAuthoritativeInventory,
    hasCommittedSnapshot: false,
    malformed: false,
    missingStores: expected ? expected.map((entry) => entry.store).sort() : [],
    rows: [] as SafeCoverageDiagnosticStore[],
    unexpectedStores: [] as string[],
  };
  if (!(expected && state) || typeof state !== "object" || Array.isArray(state)) {
    return { ...empty, malformed: state != null };
  }

  const rawState = state as Record<string, unknown>;
  if (
    !(
      hasExactKeys(rawState, COVERAGE_DIAGNOSTICS_STATE_KEYS) &&
      isValidCoverageDiagnosticsFetchedAt(rawState.fetched_at) &&
      Array.isArray(rawState.stores)
    )
  ) {
    return { ...empty, malformed: true };
  }
  const stores = rawState.stores;

  const expectedByStore = new Map(expected.map((entry) => [entry.store, entry]));
  const rows: SafeCoverageDiagnosticStore[] = [];
  const seenStores = new Set<string>();
  const duplicateStores: string[] = [];
  const unexpectedStores: string[] = [];
  let malformed = stores.length === 0;

  for (const rawEntry of stores) {
    const entry = parseCoverageDiagnosticStateEntry(rawEntry);
    if (!entry) {
      malformed = true;
      continue;
    }
    const { store, status } = entry;
    if (seenStores.has(store)) {
      duplicateStores.push(store);
      continue;
    }
    seenStores.add(store);
    const expectedEntry = expectedByStore.get(store);
    if (!expectedEntry) {
      unexpectedStores.push(store);
      continue;
    }
    if (entry.stream !== expectedEntry.stream) {
      malformed = true;
      continue;
    }
    rows.push({ store, stream: expectedEntry.stream, status });
  }

  const missingStores = expected
    .filter((entry) => !seenStores.has(entry.store))
    .map((entry) => entry.store)
    .sort();
  const hasCommittedSnapshot =
    !malformed && duplicateStores.length === 0 && unexpectedStores.length === 0 && missingStores.length === 0;
  return {
    duplicateStores: duplicateStores.sort(),
    hasAuthoritativeInventory,
    hasCommittedSnapshot,
    malformed,
    missingStores,
    rows: rows.sort((left, right) => left.store.localeCompare(right.store)),
    unexpectedStores: unexpectedStores.sort(),
  };
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
  assertExpectedLocalCoverageStores(tool, stores);
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
