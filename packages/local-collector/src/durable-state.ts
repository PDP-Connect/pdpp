// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
// biome-ignore lint/correctness/noUnresolvedImports: Biome's Node module registry does not yet recognize node:sqlite; Node and tsc resolve the built-in module.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const SQLITE_HEADER = "SQLite format 3\u0000";
const MAX_LEGACY_ENTRIES_PER_ROOT = 64;
const LEGACY_SQLITE_FILE_PATTERN = /(?:\.sqlite|\.db|\.json)$/;
const LEGACY_MIGRATION_FILE_PATTERN = /\.migration-[^/]+\.tmp$/;
const DEFAULT_QUEUE_FILE_NAME = "collector-runner-queue.sqlite";

export interface CollectorStatePathInput {
  /** Test hook that simulates a legacy collector write after canonical installation. */
  afterMigrationInstall?: (() => void) | undefined;
  /** Test hook that simulates a crash after the legacy retirement fence commits. */
  afterRetirementFence?: (() => void) | undefined;
  /** Test hook that simulates a legacy collector write after the first snapshot. */
  beforeMigrationReconcile?: (() => void) | undefined;
  /** A queue path supplied by an operator or profile. */
  configuredPath?: string | null | undefined;
  /** Whether `configuredPath` came from an explicit queue configuration. */
  configuredPathIsExplicit?: boolean | undefined;
  connectorId?: string | null | undefined;
  /** Additional bounded legacy roots, primarily for deterministic tests. */
  legacyRoots?: readonly string[] | undefined;
  /** Injectable module URL used to locate the old package-relative store. */
  moduleUrl?: string | URL | undefined;
  /** The source identity that must remain isolated from other lanes. */
  sourceInstanceId?: string | null | undefined;
  /** Injectable platform state root for deterministic tests. */
  stateRoot?: string | undefined;
}

export class CollectorStateResolutionError extends Error {
  readonly code: "legacy_state_ambiguous" | "legacy_state_unreadable" | "legacy_state_migration_failed";

  constructor(code: CollectorStateResolutionError["code"], message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "CollectorStateResolutionError";
    this.code = code;
  }
}

/**
 * Resolve the platform's per-user state root. This intentionally has no cwd or
 * module-path input: package lifecycle must not change where durable work is
 * stored.
 */
export function defaultCollectorStateRoot(
  input: { env?: Readonly<Record<string, string | undefined>>; home?: string; platform?: NodeJS.Platform } = {}
): string {
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();
  const platform = input.platform ?? process.platform;
  const xdgStateHome = env.XDG_STATE_HOME?.trim();
  if (xdgStateHome && isAbsolute(xdgStateHome) && platform !== "win32" && platform !== "darwin") {
    return xdgStateHome;
  }
  if (platform === "win32") {
    return env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support");
  }
  return join(home, ".local", "state");
}

/** Directory used by the canonical local-collector durable outbox. */
export function collectorStateDirectory(stateRoot = defaultCollectorStateRoot()): string {
  return join(stateRoot, "pdpp", "collectors");
}

/**
 * Compute the canonical source-aware path without touching the filesystem.
 * Source ids are encoded as one filename segment, so a connector cannot escape
 * the state directory even if a future server emits a separator.
 */
export function canonicalCollectorQueuePath(input: {
  connectorId?: string | null | undefined;
  sourceInstanceId?: string | null | undefined;
  stateRoot?: string | undefined;
}): string {
  const directory = collectorStateDirectory(input.stateRoot);
  const sourceInstanceId = input.sourceInstanceId?.trim();
  const connectorId = input.connectorId?.trim();
  if (!sourceInstanceId) {
    return join(directory, DEFAULT_QUEUE_FILE_NAME);
  }
  const sourceSegment = safeStatePathSegment(sourceInstanceId);
  const fileName = connectorId
    ? `${safeStatePathSegment(connectorId)}.${sourceSegment}.sqlite`
    : `collector-runner-queue.${sourceSegment}.sqlite`;
  return join(directory, fileName);
}

/**
 * Resolve the local collector's durable outbox path.
 *
 * Explicit paths are returned before any default lookup. For an unconfigured
 * source-aware default, the resolver first uses the canonical user-state path,
 * then looks through a small set of known legacy roots. A stable legacy store
 * is used in place; a package-local legacy store is reconciled into a
 * consistent SQLite snapshot, retires the migrated source in the old
 * database, and installs the snapshot at the canonical path. Old pathnames
 * are never removed.
 */
export function resolveCollectorQueuePath(input: CollectorStatePathInput = {}): string {
  const { configuredPath, configuredPathIsExplicit } = input;
  const isExplicit = configuredPathIsExplicit ?? Boolean(configuredPath?.trim());
  if (isExplicit && typeof configuredPath === "string") {
    return configuredPath;
  }

  const stateRoot = input.stateRoot ?? defaultCollectorStateRoot();
  const stateDirectory = collectorStateDirectory(stateRoot);
  const historicalStableDirectory =
    input.stateRoot === undefined && process.platform !== "win32"
      ? join(homedir(), ".local", "state", "pdpp", "collectors")
      : undefined;
  const canonicalPath = canonicalCollectorQueuePath({
    connectorId: input.connectorId,
    sourceInstanceId: input.sourceInstanceId,
    stateRoot,
  });
  const sourceInstanceId = input.sourceInstanceId?.trim();
  if (!sourceInstanceId) {
    return canonicalPath;
  }

  if (existsSync(canonicalPath)) {
    // A fully installed canonical copy is authoritative. If it is an empty
    // database while another legacy store has rows, fail closed rather than
    // turning an interrupted/manual initialization into silent data loss.
    if (containsSourceRows(canonicalPath, sourceInstanceId)) {
      return canonicalPath;
    }
    const legacyMatches = findMatchingLegacyStores({
      canonicalPath,
      roots: legacyRoots({
        extraRoots: input.legacyRoots,
        historicalStableDirectory,
        packageDataRoot: packageDataRoot(input.moduleUrl),
        stateDirectory,
        stateRoot,
      }),
      sourceInstanceId,
    });
    if (legacyMatches.length > 0) {
      throw ambiguousLegacyState(canonicalPath, legacyMatches, sourceInstanceId);
    }
    return canonicalPath;
  }

  const matches = findMatchingLegacyStores({
    canonicalPath,
    roots: legacyRoots({
      extraRoots: input.legacyRoots,
      historicalStableDirectory,
      packageDataRoot: packageDataRoot(input.moduleUrl),
      stateDirectory,
      stateRoot,
    }),
    sourceInstanceId,
  });
  if (matches.length === 0) {
    return canonicalPath;
  }
  if (matches.length > 1) {
    throw ambiguousLegacyState(canonicalPath, matches, sourceInstanceId);
  }

  const [legacyPath] = matches;
  if (!legacyPath) {
    return canonicalPath;
  }
  if (isWithin(stateDirectory, legacyPath)) {
    return legacyPath;
  }
  return migrateLegacyStore(
    legacyPath,
    canonicalPath,
    sourceInstanceId,
    input.beforeMigrationReconcile,
    input.afterMigrationInstall,
    input.afterRetirementFence
  );
}

function legacyRoots(input: {
  extraRoots?: readonly string[] | undefined;
  historicalStableDirectory?: string | undefined;
  packageDataRoot: string;
  stateDirectory: string;
  stateRoot: string;
}): string[] {
  return deduplicatePaths([
    input.stateDirectory,
    ...(input.historicalStableDirectory ? [input.historicalStableDirectory] : []),
    join(input.stateRoot, "pdpp"),
    input.packageDataRoot,
    ...(input.extraRoots ?? []),
  ]);
}

function packageDataRoot(moduleUrl?: string | URL): string {
  const resolvedModuleUrl = moduleUrl ?? import.meta.url;
  const modulePath =
    typeof resolvedModuleUrl === "string" && !resolvedModuleUrl.startsWith("file:")
      ? resolvedModuleUrl
      : fileURLToPath(resolvedModuleUrl);
  // The built module is dist/local-collector/src/durable-state.js and the old
  // package-relative queue lived at dist/local-collector/.pdpp-data.
  return join(dirname(dirname(modulePath)), ".pdpp-data");
}

function findMatchingLegacyStores(input: {
  canonicalPath: string;
  roots: readonly string[];
  sourceInstanceId: string;
}): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const root of input.roots) {
    for (const candidate of candidateFiles(root)) {
      if (candidate === input.canonicalPath || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      if (!isSqliteDatabase(candidate)) {
        continue;
      }
      if (containsSourceRows(candidate, input.sourceInstanceId)) {
        matches.push(candidate);
      }
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

function candidateFiles(root: string): string[] {
  let entries: Array<{ isFile: () => boolean; name: string }>;
  try {
    entries = readdirSync(root, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not inspect the local collector state directory ${root}`,
      { cause: error }
    );
  }

  const candidates = entries
    .filter((entry) => entry.isFile() && LEGACY_SQLITE_FILE_PATTERN.test(entry.name))
    .map((entry) => join(root, entry.name))
    .filter((path) => !LEGACY_MIGRATION_FILE_PATTERN.test(path))
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length > MAX_LEGACY_ENTRIES_PER_ROOT) {
    throw new CollectorStateResolutionError(
      "legacy_state_ambiguous",
      `legacy local collector state discovery exceeded its ${MAX_LEGACY_ENTRIES_PER_ROOT}-file bound in ${root}; pass --queue explicitly`
    );
  }
  return candidates;
}

function isSqliteDatabase(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const header = Buffer.alloc(SQLITE_HEADER.length);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length && header.toString("utf8") === SQLITE_HEADER;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not read legacy state candidate ${path}`,
      {
        cause: error,
      }
    );
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** Read only the indexed source identity; payload JSON is never selected. */
function containsSourceRows(path: string, sourceInstanceId: string): boolean {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    const table = db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'local_device_outbox'")
      .get();
    if (!table) {
      return false;
    }
    return Boolean(
      db
        .prepare("SELECT 1 AS present FROM local_device_outbox WHERE source_instance_id = ? LIMIT 1")
        .get(sourceInstanceId)
    );
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_unreadable",
      `could not inspect legacy local collector state candidate ${path}`,
      { cause: error }
    );
  } finally {
    db?.close();
  }
}

function migrateLegacyStore(
  legacyPath: string,
  canonicalPath: string,
  sourceInstanceId: string,
  beforeReconcile?: (() => void) | undefined,
  afterInstall?: (() => void) | undefined,
  afterRetirementFence?: (() => void) | undefined
): string {
  mkdirSync(dirname(canonicalPath), { mode: 0o700, recursive: true });
  const temporaryPath = `${canonicalPath}.migration-${process.pid}-${randomUUID()}.tmp`;
  const lockPath = `${canonicalPath}.handoff.lock`;
  let lockAcquired = false;
  let source: DatabaseSync | undefined;
  try {
    ensureSameFilesystem(legacyPath, canonicalPath);
    acquireMigrationLock(lockPath);
    lockAcquired = true;
    source = new DatabaseSync(legacyPath, { readOnly: true });
    source.exec("PRAGMA busy_timeout = 5000");
    const escapedPath = temporaryPath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedPath}'`);
    source.close();
    source = undefined;
    if (process.platform !== "win32") {
      chmodSync(temporaryPath, 0o600);
    }

    beforeReconcile?.();
    reconcileLegacyWrites(legacyPath, temporaryPath, canonicalPath, sourceInstanceId);

    const snapshotFd = openSync(temporaryPath, "r");
    try {
      fsyncSync(snapshotFd);
    } finally {
      closeSync(snapshotFd);
    }

    afterRetirementFence?.();
    installSnapshot(temporaryPath, canonicalPath, sourceInstanceId);
    afterInstall?.();
    if (lockAcquired) {
      releaseMigrationLock(lockPath);
    }
    rmSync(temporaryPath, { force: true });
    return canonicalPath;
  } catch (error) {
    source?.close();
    rmSync(temporaryPath, { force: true });
    if (lockAcquired) {
      releaseMigrationLock(lockPath);
    }
    if (error instanceof CollectorStateResolutionError) {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: CollectorStateResolutionError forwards the cause through its custom constructor.
    throw new CollectorStateResolutionError(
      "legacy_state_migration_failed",
      `could not migrate the unique legacy local collector store for source '${sourceInstanceId}'; the original store was retained and --queue can select it explicitly`,
      { cause: error }
    );
  }
}

/**
 * Fence the still-running legacy collector while reconciling writes that
 * landed after VACUUM INTO's snapshot. BEGIN IMMEDIATE waits for any current
 * writer, then prevents another writer until the rows are copied and a
 * trigger-enforced retirement fence is committed in the legacy database.
 * The canonical pathname is a separate complete snapshot; it never aliases
 * the legacy WAL main file or its path-derived sidecars.
 */
function reconcileLegacyWrites(
  legacyPath: string,
  temporaryPath: string,
  canonicalPath: string,
  sourceInstanceId: string
): void {
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(legacyPath);
    source.exec("PRAGMA busy_timeout = 5000");
    source.exec("BEGIN IMMEDIATE");
    const escapedPath = temporaryPath.replaceAll("'", "''");
    source.exec(`ATTACH DATABASE '${escapedPath}' AS migrated`);
    // VACUUM INTO can carry an earlier retirement fence into the snapshot
    // during crash recovery. The fence belongs only to the legacy pathname;
    // copying it to the canonical authority would retire the new writer too.
    source.exec(`
      DROP TRIGGER IF EXISTS migrated.pdpp_retire_outbox_insert;
      DROP TRIGGER IF EXISTS migrated.pdpp_retire_outbox_update;
      DROP TRIGGER IF EXISTS migrated.pdpp_retire_outbox_delete;
      DROP TABLE IF EXISTS migrated.pdpp_legacy_retirements;
    `);
    source.exec(`
      INSERT OR IGNORE INTO migrated.local_device_outbox (
        id, source_instance_id, kind, status, payload_json, body_hash,
        attempt_count, next_attempt_at, lease_holder, lease_epoch,
        lease_until, last_error, acknowledged_at, created_at, updated_at
      )
      SELECT id, source_instance_id, kind, status, payload_json, body_hash,
             attempt_count, next_attempt_at, lease_holder, lease_epoch,
             lease_until, last_error, acknowledged_at, created_at, updated_at
        FROM main.local_device_outbox
       WHERE source_instance_id = '${sourceInstanceId.replaceAll("'", "''")}'
    `);
    const hasObservedStreamTable = source
      .prepare(
        "SELECT 1 AS present FROM migrated.sqlite_master WHERE type = 'table' AND name = 'local_device_observed_stream'"
      )
      .get();
    if (hasObservedStreamTable) {
      source.exec(`
        INSERT OR IGNORE INTO migrated.local_device_observed_stream (outbox_id, source_instance_id, stream)
        SELECT outbox_id, source_instance_id, stream
          FROM main.local_device_observed_stream
         WHERE source_instance_id = '${sourceInstanceId.replaceAll("'", "''")}'
      `);
    }
    installRetirementFence(source, sourceInstanceId, canonicalPath);
    source.exec("COMMIT");
    source.exec("DETACH DATABASE migrated");
  } catch (error) {
    try {
      source?.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  } finally {
    source?.close();
  }
}

function acquireMigrationLock(path: string): void {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${process.pid}\n`, undefined, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
    let ownerPid: number | undefined;
    try {
      ownerPid = Number(readFileSync(path, { encoding: "utf8" }).trim());
    } catch (lockReadError) {
      throw new Error(`legacy state handoff is already in progress: ${path}`, { cause: lockReadError });
    }
    if (Number.isInteger(ownerPid) && ownerPid > 0) {
      try {
        process.kill(ownerPid, 0);
      } catch (probeError) {
        if (isNodeError(probeError) && probeError.code === "ESRCH") {
          rmSync(path, { force: true });
          acquireMigrationLock(path);
          return;
        }
      }
    }
    throw new Error(`legacy state handoff is already in progress: ${path}`, { cause: error });
  }
}

function releaseMigrationLock(path: string): void {
  rmSync(path, { force: true });
}

function installSnapshot(temporaryPath: string, canonicalPath: string, sourceInstanceId: string): void {
  if (existsSync(canonicalPath)) {
    if (!containsSourceRows(canonicalPath, sourceInstanceId)) {
      throw new Error("a concurrent canonical state file does not contain the requested source");
    }
    return;
  }
  renameSync(temporaryPath, canonicalPath);
  if (process.platform !== "win32") {
    chmodSync(canonicalPath, 0o600);
  }
  const canonicalFd = openSync(canonicalPath, "r");
  try {
    fsyncSync(canonicalFd);
  } finally {
    closeSync(canonicalFd);
  }
  const directoryFd = openSync(dirname(canonicalPath), "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

function ensureSameFilesystem(legacyPath: string, canonicalPath: string): void {
  const legacyDevice = statSync(dirname(legacyPath)).dev;
  const canonicalDevice = statSync(dirname(canonicalPath)).dev;
  if (legacyDevice !== canonicalDevice) {
    throw new Error("legacy state handoff crosses filesystems; refusing a non-atomic migration");
  }
}

function installRetirementFence(source: DatabaseSync, sourceInstanceId: string, canonicalPath: string): void {
  const sourceLiteral = sqlStringLiteral(sourceInstanceId);
  const canonicalLiteral = sqlStringLiteral(canonicalPath);
  source.exec(`
    CREATE TABLE IF NOT EXISTS pdpp_legacy_retirements (
      source_instance_id TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL,
      retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_insert
      BEFORE INSERT ON local_device_outbox
      WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = NEW.source_instance_id)
      BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_update
      BEFORE UPDATE ON local_device_outbox
      WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = OLD.source_instance_id OR source_instance_id = NEW.source_instance_id)
      BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    CREATE TRIGGER IF NOT EXISTS pdpp_retire_outbox_delete
      BEFORE DELETE ON local_device_outbox
      WHEN EXISTS (SELECT 1 FROM pdpp_legacy_retirements WHERE source_instance_id = OLD.source_instance_id)
      BEGIN SELECT RAISE(ABORT, 'legacy collector state retired; use canonical path'); END;
    INSERT INTO pdpp_legacy_retirements (source_instance_id, canonical_path)
      VALUES (${sourceLiteral}, ${canonicalLiteral})
      ON CONFLICT(source_instance_id) DO UPDATE SET canonical_path = excluded.canonical_path;
  `);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ambiguousLegacyState(
  canonicalPath: string,
  matches: readonly string[],
  sourceInstanceId: string
): CollectorStateResolutionError {
  return new CollectorStateResolutionError(
    "legacy_state_ambiguous",
    `ambiguous local collector state for source '${sourceInstanceId}': ${matches.length} nonempty legacy stores match; pass --queue explicitly. Canonical path is ${canonicalPath}`
  );
}

function safeStatePathSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function deduplicatePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim() !== ""))];
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || !(relativePath.startsWith("..") || isAbsolute(relativePath));
}

function isNotFoundError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
