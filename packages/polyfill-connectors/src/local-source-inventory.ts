// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
    { store: "derived_messages", stream: "messages" },
    { store: "derived_attachments", stream: "attachments" },
    { store: "derived_memory_notes", stream: "memory_notes" },
    { store: "skills", stream: "skills" },
    { store: "commands", stream: "slash_commands" },
    { store: "file_history", stream: "file_history" },
    { store: "context_mode", stream: null },
    { store: "cache", stream: "cache_inventory" },
    { store: "backups", stream: "backup_inventory" },
    { store: "config", stream: "config_inventory" },
    { store: "auth", stream: null },
  ],
  codex: [
    { store: "sessions", stream: "sessions" },
    { store: "state_db", stream: "sessions" },
    { store: "derived_messages", stream: "messages" },
    { store: "derived_function_calls", stream: "function_calls" },
    { store: "rules", stream: "rules" },
    { store: "prompts", stream: "prompts" },
    { store: "skills", stream: "skills" },
    { store: "history", stream: "history" },
    { store: "session_index", stream: "session_index" },
    { store: "shell_snapshots", stream: "shell_snapshots" },
    { store: "memories", stream: null },
    { store: "context_mode", stream: null },
    { store: "config", stream: "config_inventory" },
    { store: "cache", stream: "cache_inventory" },
    { store: "auth", stream: null },
  ],
  google_takeout: [
    { store: "location_history", stream: "location_history" },
    { store: "youtube_watch_history", stream: "youtube_watch_history" },
    { store: "search_history", stream: "search_history" },
    { store: "photos", stream: "photos" },
  ],
  apple_photos: [{ store: "export_dir", stream: "photos" }],
  google_messages: [{ store: "gmcli_archive", stream: "messages" }],
} as const;

type LocalCoverageStoreNamesByConnector = {
  readonly [K in keyof typeof LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR]: readonly string[];
};

/** Compatibility store-name view of the exact descriptor authority. */
export const LOCAL_COVERAGE_STORES_BY_CONNECTOR = Object.entries(LOCAL_COVERAGE_STORE_DESCRIPTORS_BY_CONNECTOR).reduce<
  Record<string, readonly string[]>
>((acc, [connector, stores]) => {
  acc[connector] = stores.map((store) => store.store);
  return acc;
}, {}) as LocalCoverageStoreNamesByConnector;

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

/**
 * Every manifest stream the server proof reader (`deriveLocalCoverageAxis`,
 * via `parseCoverageDiagnosticsStateSnapshot`) must be able to prove complete
 * needs at least one descriptor mapped to it, or that stream is structurally
 * uncappable regardless of what the connector's emitter actually collects —
 * exactly the drift this authority table exists to make detectable instead of
 * silent (see the table's own doc comment above). A required stream missing a
 * descriptor is reported so a connector-package-owned conformance test can
 * fail on it without either package reaching into the other's internals.
 */
export function localCoverageStreamsMissingDescriptors(
  connectorId: string,
  requiredStreams: readonly string[]
): readonly string[] {
  const descriptors = expectedLocalCoverageStoreDescriptors(connectorId);
  const declaredStreams = new Set((descriptors ?? []).map((descriptor) => descriptor.stream).filter(Boolean));
  return requiredStreams.filter((stream) => !declaredStreams.has(stream)).sort();
}

/**
 * Every filesystem-scanned {@link KnownLocalStore} the connector declares must
 * be a member of the authoritative descriptor set, with no duplicates. This is
 * intentionally a SUBSET check, not exact-equality: the descriptor authority
 * also carries additive derived-store entries (e.g. `derived_messages`) for
 * streams parsed out of another store's already-scanned source rather than
 * their own top-level `KnownLocalStore` -- see `buildDerivedCoverageRecord`.
 * Those have no filesystem-scanned counterpart to compare against here; the
 * descriptor authority's coverage of every manifest-required stream (derived
 * or not) is instead pinned by each connector's manifest-conformance test.
 */
function assertExpectedLocalCoverageStores(tool: string, stores: readonly KnownLocalStore[]): void {
  const expectedDescriptors = expectedLocalCoverageStoreDescriptors(tool);
  if (!expectedDescriptors) {
    return;
  }
  const actual = stores.map((store) => `${store.store}\u0000${store.stream ?? ""}`).sort();
  const expectedSet = new Set(expectedDescriptors.map((store) => `${store.store}\u0000${store.stream ?? ""}`));
  if (new Set(actual).size !== actual.length || actual.some((store) => !expectedSet.has(store))) {
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
  /**
   * `"unaccounted"` alongside the closed {@link CoverageStatus} set: reserved
   * (see `COLLECTOR_COVERAGE_STATUSES` in collector-runner.ts) for a
   * connector-derived coverage record that could not classify a discovered
   * store — e.g. a rollout scan that failed before it could examine
   * anything. Never returned by `coverageStatus()`'s static classification.
   */
  status: CoverageStatus | "unaccounted";
  store: string;
  stream: string | null;
}

export interface SafeCoverageDiagnosticStore {
  /**
   * Boundary this store's coverage was measured under, carried through the
   * durable snapshot so the read side can tell coverage-of-a-declared-region
   * from coverage-of-everything. Absent for a snapshot written before the scope
   * contract, which is a different claim from `unscoped` and must stay
   * distinguishable.
   */
  readonly collection_scope?: string;
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
  return coverage.map((record) => {
    const { status, store, stream } = record;
    // Preserve the measured boundary alongside the store triple. It is a
    // declared bound, never payload, so it does not widen the safe surface this
    // builder exists to enforce -- and dropping it here is precisely what left
    // the read side blind to the fingerprint the records already carried.
    const scope = (record as { collection_scope?: unknown }).collection_scope;
    return typeof scope === "string" && scope.trim()
      ? { collection_scope: scope.trim(), status, store, stream }
      : { status, store, stream };
  });
}

/**
 * Human-readable `reason` for a derived coverage_diagnostics record — one
 * whose stream has no dedicated top-level `KnownLocalStore` entry because it
 * is parsed out of the same on-disk source as another, already-scanned
 * stream (e.g. Claude Code's `messages`/`attachments`/`memory_notes` and
 * Codex's `messages`/`function_calls`, both derived from the same session
 * transcripts their connector also scans for `sessions`).
 *
 * `incompleteReason` lets a connector supply its own scan-outcome detail
 * (e.g. "rollout enumeration failed: unreadable" vs "...: parse_error") for
 * the `!scanComplete` case; the generic fallback is used when omitted.
 */
export function describeDerivedCoverageReason(input: {
  emitted: number;
  examined: number;
  incompleteReason?: string | undefined;
  label: string;
  scanComplete: boolean;
}): string {
  if (!input.scanComplete) {
    return input.incompleteReason ?? "enumeration did not complete";
  }
  if (input.examined === 0) {
    return "enumeration complete, 0 examined";
  }
  if (input.emitted > 0) {
    return `${input.emitted} ${input.label} records emitted`;
  }
  return `enumeration complete, ${input.examined} examined (${input.emitted} emitted)`;
}

/**
 * A derived `coverage_diagnostics` {@link CoverageRecord} for one stream that
 * is parsed out of another stream's already-scanned source rather than its
 * own `KnownLocalStore` entry, so it would otherwise never earn a coverage
 * row and would silently vanish from `collection_facts`/`fullyAccounted`
 * despite emitting real records (see collector-runner.ts's
 * `buildTerminalCollectionFacts`/`summarizeCollectorCompleteness`, which only
 * ever see streams with at least one coverage row).
 *
 * On the canonical coverage-status vocabulary ({@link CoverageStatus} |
 * `"unaccounted"`): a scan that completed — even examining zero records — is
 * `collected` (the `reason` carries the zero/positive detail); a scan that
 * never ran to completion is `unaccounted`, since the connector cannot
 * classify what it never got to examine.
 *
 * This is pure mechanical policy shared across connectors. Enumeration,
 * `label` wording, counting, and mapping a connector's own scan-outcome type
 * onto `scanComplete`/`incompleteReason` all stay connector-specific. The
 * store id and record id are NOT connector-specific inputs -- see
 * {@link selectLocalCoverageDerivedDescriptor}: the authority table selects
 * them, so an emitter cannot report a derived stream under a store id the
 * table doesn't declare.
 */
export function buildDerivedCoverageRecord(input: {
  connectorId: string;
  emitted: number;
  examined: number;
  incompleteReason?: string | undefined;
  label: string;
  scanComplete: boolean;
  scopeFingerprint?: string;
  stream: string;
}): CoverageRecord {
  const descriptor = selectLocalCoverageDerivedDescriptor(input.connectorId, input.stream);
  const status: CoverageStatus | "unaccounted" = input.scanComplete ? "collected" : "unaccounted";
  return {
    id: `coverage:${descriptor.store}`,
    store: descriptor.store,
    stream: input.stream,
    status,
    reason: describeDerivedCoverageReason({
      emitted: input.emitted,
      examined: input.examined,
      incompleteReason: input.incompleteReason,
      label: input.label,
      scanComplete: input.scanComplete,
    }),
    ...(input.scopeFingerprint ? { collection_scope: input.scopeFingerprint } : {}),
  };
}

/**
 * Resolve the ONE descriptor the authority table declares for a derived
 * stream -- the structural link that makes it impossible for a connector's
 * `emitDerivedCoverage` to report a store id the table doesn't know about.
 * Throws (fails loud, at the point the drift would happen) when the
 * connector has no authoritative inventory, when no descriptor maps to this
 * stream, or when more than one does (ambiguous -- e.g. `codex`'s `sessions`
 * stream is deliberately mapped by two static stores, `sessions` and
 * `state_db`, so a derived-stream caller for `sessions` would be an error,
 * not a silent pick).
 */
export function selectLocalCoverageDerivedDescriptor(
  connectorId: string,
  stream: string
): LocalCoverageStoreDescriptor {
  const descriptors = expectedLocalCoverageStoreDescriptors(connectorId);
  if (!descriptors) {
    throw new Error(`${connectorId} has no authoritative local coverage inventory`);
  }
  const matches = descriptors.filter((descriptor) => descriptor.stream === stream);
  const [match] = matches;
  if (matches.length !== 1 || !match) {
    throw new Error(
      `${connectorId}: expected exactly one descriptor for derived stream '${stream}', found ${matches.length}`
    );
  }
  return match;
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
/**
 * The same triple plus the optional measured boundary. Both shapes are accepted
 * so a snapshot written before the scope contract still parses as proof rather
 * than failing closed as malformed -- an old snapshot is honestly
 * boundary-unknown, not corrupt.
 */
const COVERAGE_DIAGNOSTICS_STATE_ENTRY_KEYS_WITH_SCOPE = ["collection_scope", "status", "store", "stream"] as const;

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function isValidCoverageDiagnosticsFetchedAt(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function parseCoverageDiagnosticStateEntry(rawEntry: unknown): {
  readonly collection_scope?: string;
  readonly status: CoverageStatus | "unaccounted";
  readonly store: string;
  readonly stream: unknown;
} | null {
  if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
    return null;
  }
  const entry = rawEntry as Record<string, unknown>;
  if (
    !(
      hasExactKeys(entry, COVERAGE_DIAGNOSTICS_STATE_ENTRY_KEYS) ||
      hasExactKeys(entry, COVERAGE_DIAGNOSTICS_STATE_ENTRY_KEYS_WITH_SCOPE)
    )
  ) {
    return null;
  }
  const store = typeof entry.store === "string" && entry.store ? entry.store : null;
  const { status } = entry;
  if (
    !store ||
    (typeof entry.stream !== "string" && entry.stream !== null) ||
    typeof status !== "string" ||
    !SAFE_COVERAGE_DIAGNOSTIC_STATUSES.has(status as CoverageStatus)
  ) {
    return null;
  }
  // Only a non-empty string survives: a malformed or blank boundary reads as
  // NO recorded boundary rather than as an empty one, so it cannot be mistaken
  // for a measured full pass.
  const scope = entry.collection_scope;
  const collectionScope = typeof scope === "string" && scope.trim() ? scope.trim() : null;
  return {
    ...(collectionScope ? { collection_scope: collectionScope } : {}),
    store,
    stream: entry.stream,
    status: status as CoverageStatus | "unaccounted",
  };
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
    return { ...empty, malformed: state !== null && state !== undefined };
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
  const { stores } = rawState;

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
    rows.push({
      ...(entry.collection_scope ? { collection_scope: entry.collection_scope } : {}),
      store,
      stream: expectedEntry.stream,
      status,
    });
  }

  const missingStores = expected
    .filter((entry) => !seenStores.has(entry.store))
    .map((entry) => entry.store)
    .sort();
  const hasCommittedSnapshot =
    !malformed && duplicateStores.length === 0 && unexpectedStores.length === 0 && missingStores.length === 0;
  return {
    duplicateStores: duplicateStores.sort((a, b) => {
      if (a < b) {
        return -1;
      }
      return a > b ? 1 : 0;
    }),
    hasAuthoritativeInventory,
    hasCommittedSnapshot,
    malformed,
    missingStores,
    rows: rows.sort((left, right) => left.store.localeCompare(right.store)),
    unexpectedStores: unexpectedStores.sort((a, b) => {
      if (a < b) {
        return -1;
      }
      return a > b ? 1 : 0;
    }),
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
  stores: readonly KnownLocalStore[],
  /**
   * Fingerprint of the boundary this run enumerated under, stamped onto every
   * coverage record.
   *
   * It rides on the RECORDS rather than a side channel because the records are
   * the coverage evidence: they commit together in the same ingest batch, so a
   * crash between steps can never pair one run's coverage rows with another
   * run's boundary, and there is no second store to fall out of sync. A reader
   * takes the fingerprint from the same rows it is already reading -- one read,
   * no extra query, identical on both backends.
   */
  collectionScope?: string | null
): Promise<InventoryPlan> {
  assertExpectedLocalCoverageStores(tool, stores);
  const recordsByStream = new Map<string, InventoryRecord[]>();
  const coverage: CoverageRecord[] = [];

  const storesWithMeta = await Promise.all(
    stores.map(async (store) => ({
      pathMeta: await statKind(join(sourceHome, store.relativePath)),
      store,
    }))
  );

  for (const { pathMeta, store } of storesWithMeta) {
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
      // The boundary this row was measured under, committed WITH the row.
      ...(collectionScope ? { collection_scope: collectionScope } : {}),
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
 *  `reference-implementation/scripts/compact-record-history.ts`. */
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
