#!/usr/bin/env node
/**
 * PDPP Slack Connector (v0.3.0) — subprocess-wraps slackdump + reads its SQLite output.
 *
 * v0.3 adds a `canvases` stream (derived from FILE MODE='quip' rows joined
 * with each channel's canvas metadata) and declares four additional streams
 * (`stars`, `user_groups`, `reminders`, `dm_read_states`) that are P1 Layer-2
 * gaps but are NOT realizable from a slackdump archive today:
 *
 *   - stars: slackdump defines CHUNK type 8 STARRED_ITEMS but archive mode
 *     never emits chunks of that type (stars.list requires an API call
 *     slackdump doesn't run for archive workflows).
 *   - user_groups: requires usergroups.list; slackdump archive does not call it.
 *   - reminders: requires reminders.list; slackdump archive does not call it.
 *   - dm_read_states: conversations.info last_read/unread_count_display is
 *     stripped from archived channel DATA blobs.
 *
 * These four streams emit SKIP_RESULT at runtime with reason "slackdump does
 * not archive this". They are declared in the manifest so Layer-2 consumers
 * can plan around them and so an API-layer fallback (future) can fill them
 * without a manifest change.
 *
 * Slackdump is AGPL-3.0; we spawn it as a subprocess (arms-length) rather
 * than importing it as a Go library. PDPP's codebase is not covered by the
 * copyleft under FSF's own "mere aggregation" interpretation.
 *
 * Install: `go install github.com/rusq/slackdump/v4/cmd/slackdump@latest` or
 * download from https://github.com/rusq/slackdump/releases. Put on PATH or
 * set SLACKDUMP_BIN.
 *
 * Credentials (from env or INTERACTION kind=credentials):
 *   SLACK_WORKSPACE  subdomain (e.g. "myteam" from myteam.slack.com)
 *   SLACK_TOKEN      xoxc-... (from the browser app's JS bootstrap data)
 *   SLACK_COOKIE     d cookie value
 *
 * Options (read via src/connector-options.js; env today, manifest-declared
 * once connector-configuration-open-question.md resolves):
 *   SLACK_LOOKBACK_DAYS       (int, default 7)
 *   SLACK_CHANNEL_ALLOWLIST   (csv of channel IDs — maps to slackdump positional args)
 *   SLACK_CHANNEL_TYPES       (csv: public,private,im,mpim — default all four)
 *   SLACK_MEMBER_ONLY         (bool, default true — -member-only flag)
 *   SLACK_SKIP_FILES          (bool, default true)
 *
 * PDPP scope mapping:
 *   scope.streams[].time_range.from → slackdump -time-from
 *   scope.streams[].time_range.to   → slackdump -time-to
 *   scope.streams[].resources       → slackdump positional channel IDs
 *   state.archive_dir                → slackdump resume target (incremental)
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOptions } from "../../src/connector-options.ts";
import {
  buildDetailCoverageMessage,
  type CollectContext,
  type EmittedMessage,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import {
  buildCanvasRecord,
  buildChannelCanvasIndex,
  buildChannelMembershipRecord,
  buildChannelRecord,
  buildChannelStatsRecord,
  buildFileRecord,
  buildMessageAttachmentRecords,
  buildMessageRecord,
  buildReactionRecords,
  buildUserRecord,
  buildWorkspaceRecord,
  extractMessageTimeRange,
  parseMessageRow,
  selectCommittedMaxTs,
  toSlackTime,
  WORKSPACE_LIST_ARROW,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  CanvasRow,
  ChannelRow,
  ChannelUserRow,
  FileRow,
  MessageRow,
  MessagesState,
  SlackdumpRunResult,
  UserRow,
  WorkspaceRow,
} from "./types.ts";

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function resolveSlackdumpBin(): string {
  return process.env.SLACKDUMP_BIN || "slackdump";
}

export function formatSlackdumpMissingError(bin: string): string {
  return [
    `slackdump binary not found: ${bin}`,
    "Install slackdump and either put it on PATH or set SLACKDUMP_BIN to its absolute path.",
    "Docker: the stock reference image does not bundle AGPL-3.0 slackdump; build a derived image that installs it or mount the binary into the container and set SLACKDUMP_BIN to that in-container path.",
  ].join(" ");
}

// safeAll: typed SQL wrapper. Rows returned as unknown[] → caller casts.
function safeAll<T>(db: DatabaseSync, sql: string): T[] {
  try {
    return db.prepare(sql).all() as T[];
  } catch {
    return [];
  }
}

const SOURCE_PARTITION_MISSING_REASON = "source_partition_missing";
const MAX_MISSING_CHANNEL_IDS_IN_DIAGNOSTIC = 100;

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k === "string" && k && typeof v === "string" && v) {
      out[k] = v;
    }
  }
  return out;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((v): v is string => typeof v === "string" && v.length > 0))].sort();
}

function readPriorObservedChannelIds(messagesState: MessagesState | undefined): string[] {
  return [
    ...new Set([
      ...normalizeStringArray(messagesState?.observed_channel_ids),
      ...Object.keys(normalizeStringRecord(messagesState?.channel_last_ts)),
    ]),
  ].sort();
}

function currentArchiveChannelIds(db: DatabaseSync): string[] {
  const channels = safeAll<{ id: string }>(
    db,
    `
    SELECT DISTINCT ID AS id
    FROM CHANNEL
    WHERE ID IS NOT NULL AND ID != ''
  `
  ).map((r) => r.id);
  const messageChannels = safeAll<{ id: string }>(
    db,
    `
    SELECT DISTINCT CHANNEL_ID AS id
    FROM MESSAGE
    WHERE CHANNEL_ID IS NOT NULL AND CHANNEL_ID != ''
  `
  ).map((r) => r.id);
  return [...new Set([...channels, ...messageChannels])].sort();
}

function missingPreviouslyObservedChannelIds(
  priorObservedChannelIds: readonly string[],
  currentChannelIds: readonly string[]
): string[] {
  const current = new Set(currentChannelIds);
  return priorObservedChannelIds.filter((id) => !current.has(id)).sort();
}

async function emitMissingChannelDiagnostic(
  emit: CollectContext["emit"],
  missingChannelIds: readonly string[]
): Promise<void> {
  if (missingChannelIds.length === 0) {
    return;
  }
  const visibleIds = missingChannelIds.slice(0, MAX_MISSING_CHANNEL_IDS_IN_DIAGNOSTIC);
  await emit({
    type: "SKIP_RESULT",
    stream: "messages",
    reason: SOURCE_PARTITION_MISSING_REASON,
    message:
      missingChannelIds.length === 1
        ? `Slack archive is missing previously observed channel ${visibleIds[0]}; message coverage is partial.`
        : `Slack archive is missing ${String(missingChannelIds.length)} previously observed channels; message coverage is partial.`,
    diagnostics: {
      missing_channel_ids: visibleIds,
      missing_count: missingChannelIds.length,
      truncated: visibleIds.length < missingChannelIds.length,
    },
    recovery_hint: {
      action: "retry_by_runtime",
      retryable: true,
    },
  });
}

function selectCommittedChannelLastTs(
  priorChannelLastTs: Record<string, string>,
  runChannelMaxTs: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = { ...priorChannelLastTs };
  for (const [channelId, ts] of Object.entries(runChannelMaxTs)) {
    if (!out[channelId] || ts > out[channelId]) {
      out[channelId] = ts;
    }
  }
  return out;
}

async function emitMessageRecordScopedByChannel(deps: {
  channelIds: ReadonlySet<string>;
  emitRecord: CollectContext["emitRecord"];
  record: RecordData;
}): Promise<void> {
  if (
    deps.record.id == null ||
    typeof deps.record.channel_id !== "string" ||
    !deps.channelIds.has(deps.record.channel_id)
  ) {
    return;
  }
  await deps.emitRecord("messages", deps.record, { skipResourceFilter: true });
}

interface SlackdumpProgressSnapshot {
  archiveBytes: number;
  channels: number | null;
  maxChunkId: number | null;
  messages: number | null;
}

function existingFileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function countSqliteRows(db: DatabaseSync, sql: string): number | null {
  const [row] = safeAll<{ value: number }>(db, sql);
  const value = row?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readSlackdumpProgressSnapshot(sqlitePath: string): SlackdumpProgressSnapshot | null {
  const archiveBytes =
    existingFileSize(sqlitePath) + existingFileSize(`${sqlitePath}-wal`) + existingFileSize(`${sqlitePath}-shm`);
  if (archiveBytes === 0) {
    return null;
  }

  let messages: number | null = null;
  let channels: number | null = null;
  let maxChunkId: number | null = null;
  try {
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    try {
      messages = countSqliteRows(db, "SELECT COUNT(*) AS value FROM MESSAGE");
      channels = countSqliteRows(db, "SELECT COUNT(*) AS value FROM CHANNEL");
      maxChunkId = countSqliteRows(
        db,
        `
        SELECT MAX(value) AS value
        FROM (
          SELECT MAX(CHUNK_ID) AS value FROM MESSAGE
          UNION ALL
          SELECT MAX(CHUNK_ID) AS value FROM CHANNEL
        )
        `
      );
    } finally {
      db.close();
    }
  } catch {
    // The archive may be temporarily locked or mid-creation while slackdump is
    // writing. File growth is still a valid no-progress signal.
  }

  return { archiveBytes, channels, maxChunkId, messages };
}

function slackdumpProgressChanged(
  previous: SlackdumpProgressSnapshot | null,
  current: SlackdumpProgressSnapshot | null
): boolean {
  if (!current) {
    return false;
  }
  if (!previous) {
    return true;
  }
  return (
    current.archiveBytes !== previous.archiveBytes ||
    current.channels !== previous.channels ||
    current.maxChunkId !== previous.maxChunkId ||
    current.messages !== previous.messages
  );
}

function formatSlackdumpProgress(label: string, snapshot: SlackdumpProgressSnapshot): string {
  const facts = [
    `archive_bytes=${snapshot.archiveBytes}`,
    snapshot.messages == null ? null : `messages=${snapshot.messages}`,
    snapshot.channels == null ? null : `channels=${snapshot.channels}`,
    snapshot.maxChunkId == null ? null : `max_chunk=${snapshot.maxChunkId}`,
  ].filter(Boolean);
  return `Slack slackdump ${label} progress: ${facts.join(" ")}`;
}

// Default timeout accommodates long-lived workspaces (10+ years) where a
// first-run archive of DMs + history can run 6-20h depending on file count
// and Slack rate-limit bursts. The cost of a too-high default is only "late
// failure signal" — slackdump will normally finish or error out well before
// this. Override via `SLACKDUMP_TIMEOUT_MS` env var.
export function runSlackdump(
  args: string[],
  {
    env,
    progress,
    progressIntervalMs = Number(process.env.SLACKDUMP_PROGRESS_INTERVAL_MS) || 60_000,
    progressLabel = args[0] ?? "run",
    sqlitePath,
    timeoutMs = Number(process.env.SLACKDUMP_TIMEOUT_MS) || 24 * 60 * 60 * 1000,
  }: {
    env: NodeJS.ProcessEnv;
    progress?: CollectContext["progress"];
    progressIntervalMs?: number;
    progressLabel?: string;
    sqlitePath?: string;
    timeoutMs?: number;
  }
): Promise<SlackdumpRunResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveSlackdumpBin();
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let lastProgressSnapshot: SlackdumpProgressSnapshot | null = sqlitePath
      ? readSlackdumpProgressSnapshot(sqlitePath)
      : null;
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const progressTimer =
      progress && sqlitePath && Number.isFinite(progressIntervalMs) && progressIntervalMs > 0
        ? setInterval(() => {
            const snapshot = readSlackdumpProgressSnapshot(sqlitePath);
            if (!slackdumpProgressChanged(lastProgressSnapshot, snapshot)) {
              return;
            }
            lastProgressSnapshot = snapshot;
            if (!snapshot) {
              return;
            }
            progress(formatSlackdumpProgress(progressLabel, snapshot), {
              ...(snapshot.messages == null ? {} : { count: snapshot.messages }),
              stream: "messages",
            }).catch(() => undefined);
          }, progressIntervalMs)
        : null;
    progressTimer?.unref?.();
    const t = setTimeout(() => {
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      child.kill();
      reject(new Error("slackdump_timeout"));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`slackdump_exit_${code}: ${stderr.slice(0, 400) || stdout.slice(0, 400)}`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(t);
      if (progressTimer) {
        clearInterval(progressTimer);
      }
      if (isErrnoException(e) && e.code === "ENOENT") {
        reject(new Error(formatSlackdumpMissingError(bin)));
        return;
      }
      reject(e);
    });
  });
}

/**
 * Ensure slackdump has the workspace credentials cached. Idempotent — running
 * `workspace new` with the same token is a no-op if the workspace already
 * exists.
 */
async function ensureWorkspaceCached({
  token,
  cookie,
  env,
}: {
  token: string;
  cookie: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  try {
    const { stdout } = await runSlackdump(["workspace", "list"], {
      env,
      timeoutMs: 10_000,
    });
    if (WORKSPACE_LIST_ARROW.test(stdout)) {
      return;
    }
  } catch {
    /* fall through to register */
  }
  await runSlackdump(["workspace", "new", "-token", token, "-cookie", cookie, "-no-encryption"], {
    env,
    timeoutMs: 30_000,
  });
}

// ─── Option parsing / credentials ──────────────────────────────────────

interface SlackCredentials {
  cookie: string;
  token: string;
  workspace: string;
}

interface SlackOpts {
  CHANNEL_ALLOWLIST: string[];
  CHANNEL_TYPES: string[];
  LOOKBACK_DAYS: number;
  MEMBER_ONLY: boolean;
  SKIP_FILES: boolean;
}

export const SLACK_RETRYABLE_FAILURE_RE = /ECONN|ETIMEDOUT|timeout|slackdump_exit_6/i;

function extractCredentials(credentials: Record<string, string>): SlackCredentials {
  const workspace = credentials.SLACK_WORKSPACE;
  const token = credentials.SLACK_TOKEN;
  const cookie = credentials.SLACK_COOKIE;
  if (!(workspace && token && cookie)) {
    throw new Error("slack_credentials_missing");
  }
  return { workspace, token, cookie };
}

function readSlackOptions(): SlackOpts {
  const parsed = readOptions(
    // readOptions reads from START.connector_options today; scope+state here
    // is preserved for the forward-compatible migration path documented on
    // the function.
    null,
    {
      envPrefix: "SLACK_",
      fields: {
        LOOKBACK_DAYS: { parse: "int", default: 7 },
        CHANNEL_ALLOWLIST: { parse: "csv", default: [] },
        CHANNEL_TYPES: {
          parse: "csv",
          default: ["public", "private", "im", "mpim"],
        },
        MEMBER_ONLY: { parse: "bool", default: true },
        SKIP_FILES: { parse: "bool", default: true },
      },
    }
  ) as Record<string, unknown>;
  return {
    LOOKBACK_DAYS: parsed.LOOKBACK_DAYS as number,
    CHANNEL_ALLOWLIST: parsed.CHANNEL_ALLOWLIST as string[],
    CHANNEL_TYPES: parsed.CHANNEL_TYPES as string[],
    MEMBER_ONLY: parsed.MEMBER_ONLY as boolean,
    SKIP_FILES: parsed.SKIP_FILES as boolean,
  };
}

/**
 * Build a slackdump child env, pruning SLACK_WORKSPACE / SLACK_TOKEN /
 * SLACK_COOKIE from the parent env (they were extracted from `credentials`).
 * IMPORTANT: we do NOT pass SLACK_WORKSPACE to slackdump — slackdump names
 * its cached workspaces by auto-detection (usually "default"), and setting
 * SLACK_WORKSPACE to the subdomain makes slackdump look for a cached
 * workspace with that literal name and fail.
 */
function buildChildEnv(token: string, cookie: string): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {
    SLACK_TOKEN: token,
    SLACK_COOKIE: cookie,
  };
  for (const [k, v] of Object.entries(process.env)) {
    if (k !== "SLACK_WORKSPACE" && k !== "SLACK_TOKEN" && k !== "SLACK_COOKIE") {
      childEnv[k] = v;
    }
  }
  return childEnv;
}

// ─── Slackdump invocation ──────────────────────────────────────────────

interface ArchivePaths {
  archivePath: string;
  dumpDir: string;
  sqlitePath: string;
}

function resolveArchivePaths(workspace: string): ArchivePaths {
  const dumpDir = join(homedir(), ".pdpp/slackdump", workspace);
  const archivePath = join(dumpDir, "archive");
  // default DB name under the archive dir
  const sqlitePath = join(archivePath, "slackdump.sqlite");
  return { dumpDir, archivePath, sqlitePath };
}

function resolveScopedArchivePaths(base: ArchivePaths, positionalChannels: readonly string[]): ArchivePaths {
  if (positionalChannels.length === 0) {
    return base;
  }
  const normalized = [...new Set(positionalChannels)].sort();
  const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 12);
  const archivePath = join(base.dumpDir, "archive-scoped", digest);
  return {
    dumpDir: base.dumpDir,
    archivePath,
    sqlitePath: join(archivePath, "slackdump.sqlite"),
  };
}

interface SelectedScopedArchive {
  channelIds: readonly string[];
  paths: ArchivePaths;
}

function listExistingScopedArchivePaths(base: ArchivePaths): ArchivePaths[] {
  const scopedRoot = join(base.dumpDir, "archive-scoped");
  if (!existsSync(scopedRoot)) {
    return [];
  }
  return readdirSync(scopedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const archivePath = join(scopedRoot, entry.name);
      return {
        archivePath,
        dumpDir: base.dumpDir,
        sqlitePath: join(archivePath, "slackdump.sqlite"),
      };
    })
    .filter((paths) => existsSync(paths.sqlitePath))
    .sort((a, b) => a.archivePath.localeCompare(b.archivePath));
}

function readArchiveChannelIds(sqlitePath: string): string[] {
  if (!existsSync(sqlitePath)) {
    return [];
  }
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    return currentArchiveChannelIds(db);
  } finally {
    db.close();
  }
}

function selectScopedArchivesForChannels(base: ArchivePaths, channelIds: readonly string[]): SelectedScopedArchive[] {
  const remaining = new Set(channelIds);
  if (remaining.size === 0) {
    return [];
  }
  const candidates = listExistingScopedArchivePaths(base)
    .map((paths) => ({
      channelIds: readArchiveChannelIds(paths.sqlitePath).filter((id) => remaining.has(id)),
      paths,
    }))
    .filter((candidate) => candidate.channelIds.length > 0)
    .sort(
      (a, b) => b.channelIds.length - a.channelIds.length || a.paths.archivePath.localeCompare(b.paths.archivePath)
    );

  const selected: SelectedScopedArchive[] = [];
  for (const candidate of candidates) {
    const covers = candidate.channelIds.filter((id) => remaining.has(id));
    if (covers.length === 0) {
      continue;
    }
    selected.push({ channelIds: covers.sort(), paths: candidate.paths });
    for (const id of covers) {
      remaining.delete(id);
    }
    if (remaining.size === 0) {
      break;
    }
  }
  return selected;
}

function unionStrings(...values: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(values.flat())].sort();
}

function mergeMessagesPassResults(left: MessagesPassResult, right: MessagesPassResult): MessagesPassResult {
  return {
    channelMaxTs: selectCommittedChannelLastTs(left.channelMaxTs, right.channelMaxTs),
    maxMessageTs: selectMaxSlackTs(left.maxMessageTs, right.maxMessageTs),
  };
}

interface ArchiveRuntimeDeps {
  childEnv: NodeJS.ProcessEnv;
  cookie: string;
  opts: SlackOpts;
  progress: CollectContext["progress"];
  timeFrom: string | null;
  timeTo: string | null;
  token: string;
}

interface MessageSourceCacheReconciliation {
  currentChannelIds: string[];
  missingChannelIds: string[];
  scopedArchives: SelectedScopedArchive[];
}

async function refreshScopedArchive(archive: SelectedScopedArchive, deps: ArchiveRuntimeDeps): Promise<void> {
  const { childEnv, cookie, opts, progress, timeFrom, timeTo, token } = deps;
  const useResume = existsSync(archive.paths.archivePath);
  try {
    await ensureArchiveOnDisk({
      archivePath: archive.paths.archivePath,
      childEnv,
      cookie,
      opts,
      positionalChannels: [...archive.channelIds],
      priorArchive: undefined,
      progress,
      resumeTarget: useResume ? archive.paths.archivePath : null,
      sqlitePath: archive.paths.sqlitePath,
      timeFrom,
      timeTo,
      token,
      useResume,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress(`Slack: scoped archive refresh failed for ${String(archive.channelIds.length)} channel(s): ${message}`, {
      stream: "messages",
    });
  }
}

async function repairMissingScopedArchive(
  baseArchivePaths: ArchivePaths,
  missingChannelIds: readonly string[],
  deps: ArchiveRuntimeDeps
): Promise<SelectedScopedArchive | null> {
  const { childEnv, cookie, opts, progress, timeFrom, timeTo, token } = deps;
  const repairPaths = resolveScopedArchivePaths(baseArchivePaths, missingChannelIds);
  const useResume = existsSync(repairPaths.archivePath);
  try {
    await ensureArchiveOnDisk({
      archivePath: repairPaths.archivePath,
      childEnv,
      cookie,
      opts,
      positionalChannels: [...missingChannelIds],
      priorArchive: undefined,
      progress,
      resumeTarget: useResume ? repairPaths.archivePath : null,
      sqlitePath: repairPaths.sqlitePath,
      timeFrom,
      timeTo,
      token,
      useResume,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progress(
      `Slack: scoped archive auto-reconcile failed for ${String(missingChannelIds.length)} channel(s): ${message}`,
      {
        stream: "messages",
      }
    );
    return null;
  }

  const repairedChannelIds = readArchiveChannelIds(repairPaths.sqlitePath).filter((id) =>
    missingChannelIds.includes(id)
  );
  return repairedChannelIds.length > 0 ? { channelIds: repairedChannelIds, paths: repairPaths } : null;
}

async function reconcileMessageSourceCache(deps: {
  archiveRuntime: ArchiveRuntimeDeps;
  baseArchivePaths: ArchivePaths;
  baseChannelIds: readonly string[];
  isUnscopedMessageBoundary: boolean;
  messageFamilyRequested: boolean;
  priorObservedChannelIds: readonly string[];
}): Promise<MessageSourceCacheReconciliation> {
  const {
    archiveRuntime,
    baseArchivePaths,
    baseChannelIds,
    isUnscopedMessageBoundary,
    messageFamilyRequested,
    priorObservedChannelIds,
  } = deps;
  if (!(messageFamilyRequested && isUnscopedMessageBoundary)) {
    return { currentChannelIds: [...baseChannelIds], missingChannelIds: [], scopedArchives: [] };
  }

  // Source-cache auto-reconciliation: if an unscoped run proves that a
  // previously observed channel is absent from the main workspace archive,
  // refresh an isolated scoped archive for the missing partition and include
  // that archive in this run's message pass. Existing scoped archives count as
  // part of the source cache, so the normal hourly run can heal cache topology
  // without asking the owner to reconnect credentials.
  const baseMissingChannelIds = missingPreviouslyObservedChannelIds(priorObservedChannelIds, baseChannelIds);
  const scopedArchives = selectScopedArchivesForChannels(baseArchivePaths, baseMissingChannelIds);
  for (const archive of scopedArchives) {
    await refreshScopedArchive(archive, archiveRuntime);
  }

  let scopedChannelIds = unionStrings(...scopedArchives.map((archive) => archive.channelIds));
  let currentChannelIds = unionStrings(baseChannelIds, scopedChannelIds);
  let missingChannelIds = missingPreviouslyObservedChannelIds(priorObservedChannelIds, currentChannelIds);

  if (missingChannelIds.length > 0) {
    const repaired = await repairMissingScopedArchive(baseArchivePaths, missingChannelIds, archiveRuntime);
    if (repaired) {
      scopedArchives.push(repaired);
      scopedChannelIds = unionStrings(scopedChannelIds, repaired.channelIds);
      currentChannelIds = unionStrings(baseChannelIds, scopedChannelIds);
      missingChannelIds = missingPreviouslyObservedChannelIds(priorObservedChannelIds, currentChannelIds);
    }
  }

  return { currentChannelIds, missingChannelIds, scopedArchives };
}

function messageFamilyRequestedOnly(requested: CollectContext["requested"]): CollectContext["requested"] {
  return new Map(
    [...requested].filter(([stream]) => ["message_attachments", "messages", "reactions"].includes(stream))
  ) as CollectContext["requested"];
}

async function mergeScopedMessageArchivePasses(deps: {
  messageResult: MessagesPassResult;
  scopedArchives: readonly SelectedScopedArchive[];
  state: CollectContext["state"];
  streamDeps: StreamDeps;
}): Promise<MessagesPassResult> {
  let merged = deps.messageResult;
  const requested = messageFamilyRequestedOnly(deps.streamDeps.requested);
  for (const archive of deps.scopedArchives) {
    if (!existsSync(archive.paths.sqlitePath)) {
      continue;
    }
    const scopedDb = new DatabaseSync(archive.paths.sqlitePath, { readOnly: true });
    try {
      merged = mergeMessagesPassResults(
        merged,
        await runRequestedStreams({ ...deps.streamDeps, db: scopedDb, requested }, deps.state, {
          allowLegacyMessageCursorFallback: false,
          ignoreMessageChannelCursors: false,
        })
      );
    } finally {
      scopedDb.close();
    }
  }
  return merged;
}

/**
 * Incremental via slackdump resume, full via archive.
 * Resume path: (a) explicit state.archive_dir from a prior successful run,
 * or (b) an archive directory already exists on disk from a timed-out or
 * crashed prior run. Resuming salvages partial progress — slackdump picks
 * up from the last recorded chunk for each channel, so a previously-timed-
 * out 1.1 GB archive turns into "finish the rest" rather than "restart".
 */
function pickResumeTarget(
  state: CollectContext["state"],
  archivePath: string,
  { allowStateArchive = true }: { allowStateArchive?: boolean } = {}
): { resumeTarget: string | null; priorArchive: string | undefined } {
  // STATE is stream-keyed per Collection Profile: state is returned as
  // { <stream>: <cursor>, ... }. We write `archive_dir` into the messages
  // stream's cursor, so reads must qualify by that stream.
  const messagesState = state.messages as MessagesState | undefined;
  const legacyArchiveDir = (state as Record<string, unknown>).archive_dir as string | undefined;
  const priorArchive = messagesState?.archive_dir || legacyArchiveDir; // fallback for pre-fix state
  const discoveredArchive = existsSync(archivePath) ? archivePath : null;
  const resumeTarget = allowStateArchive && priorArchive && existsSync(priorArchive) ? priorArchive : discoveredArchive;
  return { resumeTarget, priorArchive };
}

interface ArchiveArgsInput {
  apiConfigPath: string;
  archivePath: string;
  opts: SlackOpts;
  positionalChannels: string[];
  timeFrom: string | null;
  timeTo: string | null;
}

function buildArchiveArgs(input: ArchiveArgsInput): string[] {
  const { apiConfigPath, archivePath, opts, positionalChannels, timeFrom, timeTo } = input;
  const args = ["archive", "-y", "-no-encryption", "-api-config", apiConfigPath, "-o", archivePath];
  const tf = toSlackTime(timeFrom);
  const tt = toSlackTime(timeTo);
  if (tf) {
    args.push("-time-from", tf);
  }
  if (tt) {
    args.push("-time-to", tt);
  }
  if (opts.MEMBER_ONLY) {
    args.push("-member-only");
  }
  if (opts.SKIP_FILES) {
    args.push("-files=false");
  }
  // NOTE: CHANNEL_TYPES maps to `list channels -chan-types`; archive has
  // no equivalent flag. We filter post-fetch via channel.is_im/is_mpim/etc.
  args.push(...positionalChannels);
  return args;
}

interface RunArchiveDeps {
  apiConfigPath: string;
  archivePath: string;
  childEnv: NodeJS.ProcessEnv;
  opts: SlackOpts;
  positionalChannels: string[];
  priorArchive: string | undefined;
  progress: CollectContext["progress"];
  resumeTarget: string | null;
  sqlitePath: string;
  timeFrom: string | null;
  timeTo: string | null;
  useResume: boolean;
}

async function runArchiveOrResume(deps: RunArchiveDeps): Promise<void> {
  const { childEnv, apiConfigPath, archivePath, opts, priorArchive, progress, resumeTarget, useResume } = deps;
  progress(
    useResume
      ? `Resuming slackdump at ${resumeTarget}${priorArchive ? "" : " (discovered on disk)"}`
      : `Running slackdump archive → ${archivePath}`
  );
  if (useResume && resumeTarget) {
    // `resume` does not accept `-y` (unlike `archive`): passing it aborts
    // with "flag provided but not defined".
    // `-lookback` uses ISO 8601 duration syntax (e.g. "p1w", "p30d"), not
    // Go's `72h` — slackdump parses it with its own `p`-prefixed parser.
    const args = [
      "resume",
      "-no-encryption",
      "-api-config",
      apiConfigPath,
      "-lookback",
      `p${opts.LOOKBACK_DAYS}d`,
      resumeTarget,
    ];
    await runSlackdump(args, {
      env: childEnv,
      progress,
      progressLabel: "resume",
      sqlitePath: deps.sqlitePath,
    });
    return;
  }
  const args = buildArchiveArgs({
    apiConfigPath,
    archivePath,
    opts,
    positionalChannels: deps.positionalChannels,
    timeFrom: deps.timeFrom,
    timeTo: deps.timeTo,
  });
  await runSlackdump(args, {
    env: childEnv,
    progress,
    progressLabel: "archive",
    sqlitePath: deps.sqlitePath,
  });
}

// ─── Cross-stream messages pass (sqlite-free, testable) ───────────────

/**
 * Subset of the per-stream dependency bag that the unified messages pass
 * actually needs. The sqlite-bound helpers in this file extend this with a
 * `db: DatabaseSync` field; tests can satisfy this narrower interface
 * without opening a DB. Mirrors the gmail/chase/usaa EmitDeps shape.
 */
export interface MessagesPassDeps {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emittedAt: string;
  progress: CollectContext["progress"];
  requested: CollectContext["requested"];
}

export interface MessagesPassResult {
  channelMaxTs: Record<string, string>;
  maxMessageTs: string | null;
}

function selectMaxSlackTs(current: string | null, candidate: string | null): string | null {
  if (!candidate) {
    return current;
  }
  if (!current || candidate > current) {
    return candidate;
  }
  return current;
}

function recordChannelMaxTs(channelMaxTs: Record<string, string>, channelId: string, ts: string | null): void {
  if (!ts) {
    return;
  }
  const current = channelMaxTs[channelId];
  if (!current || ts > current) {
    channelMaxTs[channelId] = ts;
  }
}

/**
 * Single-pass co-traversal of pre-loaded MESSAGE rows, emitting into
 * messages, reactions, and message_attachments streams as requested.
 * Tracks maxMessageTs across every row for the post-loop STATE checkpoint.
 *
 * Contract pinned by integration.test.ts:
 *   - Per row, the `messages` record emits BEFORE its reactions and
 *     attachments (parent-before-children within the row).
 *   - Scope gating is per-stream: disabling one of the three does not
 *     suppress the other two — they share the pass but not the guard.
 *   - When all three are disabled, the loop still runs (rows are iterated)
 *     but emits nothing; maxMessageTs still advances so the STATE
 *     checkpoint is accurate. This is the current pre-decomposition
 *     behavior: the caller guards entry to this function on
 *     `requested.has("messages" | "reactions" | "message_attachments")`,
 *     so in practice an all-disabled call is a harmless no-op.
 *   - A message with no reactions / no attachments still emits its
 *     messages record; enrichment is additive, not gating.
 *   - This function does not dedupe — dedup happens in `iterateMessageRows`
 *     at the sqlite layer via `MAX(CHUNK_ID) GROUP BY (CHANNEL_ID, TS)`.
 *     Passing the same row twice emits twice on purpose.
 *   - `deps.emittedAt` is the pinned emit-time; `parseMessageRow` uses
 *     nowIso() only as a fallback when the row's TS is unparseable,
 *     which threads into the record's `sent_at` (distinct from
 *     `emitted_at`, which the runtime stamps on the RECORD envelope).
 */
export async function emitMessagesPass(
  deps: MessagesPassDeps,
  rows: Iterable<MessageRow>,
  priorTs: string | null
): Promise<MessagesPassResult> {
  if (priorTs) {
    // Row count is intentionally omitted: rows is now a streamed iterator
    // (see iterateMessageRows) so the total is unknown without materializing
    // the whole MESSAGE table, which is exactly the heap pressure this pass
    // avoids. The "incremental"/priorTs signal callers wire to the UI is
    // unchanged.
    deps.progress(`incremental: filtering messages newer than ${priorTs}`, {
      stream: "messages",
    });
  }

  const wantMessages = deps.requested.has("messages");
  const wantReactions = deps.requested.has("reactions");
  const wantMsgAttachments = deps.requested.has("message_attachments");

  const channelMaxTs: Record<string, string> = {};
  let maxMessageTs: string | null = null;
  for (const r of rows) {
    const parsed = parseMessageRow(r, nowIso());
    const ts = parsed.ts;
    // Track the max ts seen in this run for the post-loop STATE emit.
    // Slack ts is a fixed-shape "seconds.micros" string; string compare
    // matches numeric order because both halves are zero-padded by Slack.
    maxMessageTs = selectMaxSlackTs(maxMessageTs, ts);
    recordChannelMaxTs(channelMaxTs, r.CHANNEL_ID, ts);
    if (wantMessages) {
      await deps.emitRecord("messages", buildMessageRecord(parsed));
    }
    if (wantReactions) {
      for (const rec of buildReactionRecords(parsed)) {
        await deps.emitRecord("reactions", rec);
      }
    }
    if (wantMsgAttachments) {
      for (const rec of buildMessageAttachmentRecords(parsed)) {
        await deps.emitRecord("message_attachments", rec);
      }
    }
  }
  return { channelMaxTs, maxMessageTs };
}

// ─── Per-stream helpers ────────────────────────────────────────────────

/**
 * Shared deps bag for every per-stream helper. Mirrors gmail/usaa EmitDeps —
 * bundle the few things every stream needs so helper signatures stay 2 args.
 *
 * `fingerprintCursors` carry the per-record semantic fingerprints across
 * runs for the workspace/users/files streams via the shared
 * `openFingerprintCursor` primitive. Without them, slackdump's
 * archive-rebuild churn produces a fresh RECORD per (record, run) pair
 * even when source state hasn't moved. One cursor per fingerprinted
 * stream; cursors for streams not requested this run carry forward
 * untouched (their `pruneStale` is never called).
 */
export interface StreamDeps {
  db: DatabaseSync;
  /**
   * Protocol-message side-channel (non-RECORD). Used today only to declare a
   * list stream's enumerated `considered` denominator via a self-coverage
   * DETAIL_COVERAGE (see `declareListConsidered`). Narrowed to the single
   * message kind this connector emits through it so a future RECORD emit can't
   * accidentally route here instead of `emitRecord`.
   */
  emit: (msg: Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }>) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emittedAt: string;
  fingerprintCursors: Map<string, FingerprintCursor>;
  progress: CollectContext["progress"];
  requested: CollectContext["requested"];
}

/**
 * Declare a list stream's enumerated `considered` denominator for the
 * per-stream Collection Report (OpenSpec
 * `define-connector-progress-evidence-contract`, task 4.2). Mirrors the GitHub
 * list-stream mechanism (task 4.1): a stream with no detail-hydration phase
 * emits a DETAIL_COVERAGE for itself (`state_stream === stream`) with EMPTY
 * `required_keys`/`hydrated_keys` and an explicit `considered` count. Empty key
 * arrays mean the runtime's pre-commit coverage gate has nothing to mark
 * missing (the committed STATE still commits); the only signal carried is the
 * denominator the terminal collection-fact block reads.
 *
 * Honesty contract (identical to GitHub's): `considered` is the number of items
 * the run actually enumerated from the source within its boundary — measured at
 * the enumeration site, NEVER the count it chose to emit. When the run emitted
 * every enumerated item the stream reads `complete`; when a weighed item was not
 * emitted (e.g. a record dropped by shape validation) `collected < considered`
 * reads an honest `partial`.
 *
 * A fingerprint-suppressed full-sync stream re-enumerates its whole boundary
 * every run and suppresses the records it determined to be unchanged, so
 * `collected` is a churn-reduced subset, not a coverage count. Such a stream
 * still has an objective coverage numerator — the items it accounted for: emitted
 * plus suppressed-because-unchanged — and declares it as the optional `covered`
 * count (task 4.4). When `covered` is supplied the projection compares
 * `considered` against `covered` instead of `collected`, so a steady-state run
 * reads `complete` rather than a false `partial`; a row weighed but dropped is in
 * neither `collected` nor `covered`, so a real shortfall still reads `partial`.
 * A stream that cannot know its full inventory for the run — incrementally
 * windowed past an unknowable boundary, or derived per-parent — MUST NOT call
 * this; it leaves `considered` unknown rather than fabricating a denominator.
 */
async function declareListConsidered(
  deps: StreamDeps,
  stream: string,
  considered: number,
  covered?: number
): Promise<void> {
  if (!Number.isInteger(considered) || considered < 0) {
    return;
  }
  await deps.emit(
    buildDetailCoverageMessage({
      stream,
      stateStream: stream,
      requiredKeys: [],
      hydratedKeys: [],
      considered,
      ...(typeof covered === "number" && Number.isInteger(covered) && covered >= 0 ? { covered } : {}),
    })
  );
}

/**
 * Streams that use the per-record fingerprint cursor. Workspace + users +
 * files were re-emitting on every slackdump pass even when source state
 * hadn't moved — see record-version-churn-data-quality-report.md
 * (31k+ versions/key on workspace, 250 versions/key on users, bimodal on
 * files). Channels, canvases, messages, reactions and message_attachments
 * are intentionally NOT on this list:
 *   - channels: low cardinality, low version count today; out of scope
 *     for this batch.
 *   - canvases: tied to channel index; low cardinality.
 *   - messages/reactions/message_attachments: already incremental via
 *     last_ts cursor.
 *
 * `channel_memberships` WAS deferred here on the assumption that its churn
 * was not load-bearing. Live retained-history later contradicted that: its
 * record body is `{id, channel_id, user_id, fetched_at}`, so the per-run
 * `fetched_at` forced a brand-new version of every membership on every run,
 * and it grew into the single largest churn stream by absolute history
 * volume (tens of thousands of `record_changes` rows for a membership set
 * that barely moves). It is the exact `fetched_at`-volatility class already
 * fixed for `workspace`, so it now joins the fingerprinted set with the same
 * `fetched_at` exclusion. A membership only re-emits when it actually
 * appears or disappears.
 */
export const FINGERPRINTED_STREAMS = ["workspace", "users", "files", "channel_memberships", "channels"] as const;
type FingerprintedStream = (typeof FINGERPRINTED_STREAMS)[number];

/**
 * Per-stream emitted-record fields that participate in the emitted shape
 * but must NOT participate in change detection — typically run-clock
 * fields like `fetched_at` whose value is "when this run happened",
 * not "when the source row changed". Without exclusion, the fingerprint
 * would never match across runs even when the source has not moved.
 *
 *   workspace: fetched_at advances on every run by design.
 *   users / files: no run-clock fields, fingerprint covers the whole record.
 *   channel_memberships: fetched_at is the run clock; the only other fields
 *     (id, channel_id, user_id) are the membership identity itself, so
 *     excluding fetched_at means the fingerprint moves only when a
 *     membership is added or removed.
 */
export const FINGERPRINT_EXCLUDE: Record<FingerprintedStream, readonly string[]> = {
  workspace: ["fetched_at"],
  users: [],
  files: [],
  channel_memberships: ["fetched_at"],
  channels: [],
};

/**
 * Per-stream fingerprint gate. Computes the record's fingerprint against
 * the prior cursor (with `FINGERPRINT_EXCLUDE[stream]` removed from the
 * input) and emits only when the fingerprint moved or there is no prior.
 * Records whose fingerprint matches the prior one do NOT emit — that
 * suppression is the load-bearing line for the workspace/users/files
 * churn fix.
 *
 * Records without an id pass through unconditionally (they cannot be
 * fingerprinted; the cursor leaves its state alone).
 */
export async function emitWithFingerprint(
  deps: StreamDeps,
  stream: FingerprintedStream,
  record: RecordData
): Promise<boolean> {
  const cursor = deps.fingerprintCursors.get(stream);
  if (!cursor) {
    // Programmer error: the collect() bootstrap opens a cursor for every
    // fingerprinted stream regardless of whether it was requested, so this
    // branch shouldn't fire. Fall back to a raw emit rather than throw.
    await deps.emitRecord(stream, record);
    return true;
  }
  if (!cursor.shouldEmit(record)) {
    // Suppressed because the record was unchanged since the prior run. The item
    // is still COVERED — the run accounted for it and confirmed it needs no new
    // version — so the caller counts it toward the `covered` numerator even
    // though no RECORD was emitted. This is the line that lets a steady-state
    // full-sync run read `complete` instead of a false `partial`.
    return false;
  }
  await deps.emitRecord(stream, record);
  return true;
}

/**
 * Run a fingerprinted full-sync stream over `rows`, building one record per row
 * and routing it through {@link emitWithFingerprint}. Returns the objective
 * coverage counts the Collection Report needs: `considered` is the enumerated row
 * count (the full source boundary the run weighed) and `covered` is the number of
 * rows the run accounted for — emitted plus suppressed-because-unchanged. They are
 * counted independently: a row dropped before reaching the emit helper (a future
 * malformed-row `continue`) raises `considered` without raising `covered`, so the
 * shortfall reads an honest `partial` rather than being assumed complete.
 */
async function runFingerprintedFullSync<Row>(
  deps: StreamDeps,
  stream: FingerprintedStream,
  rows: readonly Row[],
  buildRecord: (row: Row) => RecordData
): Promise<{ considered: number; covered: number }> {
  let covered = 0;
  for (const r of rows) {
    // Every row that reaches the emit helper is covered (emitted or
    // suppressed-unchanged); `emitWithFingerprint` never drops an enumerated row.
    await emitWithFingerprint(deps, stream, buildRecord(r));
    covered += 1;
  }
  return { considered: rows.length, covered };
}

async function runWorkspaceStream(deps: StreamDeps): Promise<void> {
  const rows = safeAll<WorkspaceRow>(
    deps.db,
    "SELECT ID, TEAM, TEAM_ID, USERNAME, USER_ID, URL, ENTERPRISE_ID, DATA FROM WORKSPACE"
  );
  const { considered, covered } = await runFingerprintedFullSync(deps, "workspace", rows, (r) =>
    buildWorkspaceRecord(r, deps.emittedAt)
  );
  await declareListConsidered(deps, "workspace", considered, covered);
}

export async function runChannelsStream(deps: StreamDeps): Promise<void> {
  // Dedupe across chunks; keep the latest (max CHUNK_ID) snapshot per ID.
  const rows = safeAll<ChannelRow>(
    deps.db,
    `
    SELECT c.ID AS id, c.NAME AS name, c.DATA AS data
    FROM CHANNEL c
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM CHANNEL GROUP BY ID) m
      ON m.ID = c.ID AND m.mx = c.CHUNK_ID
  `
  );
  const observedOn = deps.emittedAt.slice(0, 10);
  const wantsChannels = deps.requested.has("channels");
  let channelsCovered = 0;
  for (const r of rows) {
    if (wantsChannels) {
      // Entity record: fingerprinted so unchanged structural fields don't re-emit.
      // Every enumerated channel row is accounted for (emitted or
      // suppressed-unchanged), so it counts toward the `covered` numerator.
      const entityRec = buildChannelRecord(r);
      await emitWithFingerprint(deps, "channels", entityRec);
      channelsCovered += 1;
    }
    // Stats record: append-keyed observation (one per channel per day).
    if (deps.requested.has("channel_stats")) {
      await deps.emitRecord("channel_stats", buildChannelStatsRecord(r, observedOn));
    }
  }
  // `channels` is a fingerprint-suppressed full-sync stream: it re-enumerates the
  // whole channel inventory every run and suppresses unchanged rows. Declaring
  // `considered = rows.length` with `covered = channelsCovered` lets a
  // steady-state run read `complete` instead of a false `partial`. `channel_stats`
  // is append-keyed (one observation per channel per day), not an inventory, so it
  // declares no denominator. The denominators are measured at the query site,
  // never aliased to the emitted count.
  if (wantsChannels) {
    await declareListConsidered(deps, "channels", rows.length, channelsCovered);
  }
}

async function runChannelMembershipsStream(deps: StreamDeps): Promise<void> {
  const rows = safeAll<ChannelUserRow>(
    deps.db,
    `
    SELECT DISTINCT CHANNEL_ID, USER_ID FROM CHANNEL_USER
  `
  );
  const { considered, covered } = await runFingerprintedFullSync(deps, "channel_memberships", rows, (r) =>
    buildChannelMembershipRecord(r, deps.emittedAt)
  );
  await declareListConsidered(deps, "channel_memberships", considered, covered);
}

export async function runUsersStream(deps: StreamDeps): Promise<void> {
  const rows = safeAll<UserRow>(
    deps.db,
    `
    SELECT u.ID AS id, u.USERNAME AS username, u.DATA AS data
    FROM S_USER u
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM S_USER GROUP BY ID) m
      ON m.ID = u.ID AND m.mx = u.CHUNK_ID
  `
  );
  const { considered, covered } = await runFingerprintedFullSync(deps, "users", rows, buildUserRecord);
  await declareListConsidered(deps, "users", considered, covered);
}

/**
 * Stream message rows from slackdump's sqlite, deduping by (CHANNEL_ID, TS)
 * on latest CHUNK_ID and optionally filtering incrementally on ts>priorTs.
 *
 * The MESSAGE table is the only slackdump table that grows unbounded with
 * workspace history (10+ year workspaces, DMs + channel history). Iterating
 * row-by-row (`.iterate()`) keeps process memory bounded by a single row
 * rather than the whole materialized result set; this mirrors the codex
 * collector's `queryThreadsRows` shape. The bounded lookup tables
 * (S_USER, FILE, CHANNEL, WORKSPACE) keep `.all()` via `safeAll`: their
 * cardinality is members/files/channels, not message volume.
 */
interface MessageCursorThresholds {
  channelLastTs: Record<string, string>;
  legacyLastTs: string | null;
}

function buildMessageRowsQuery(thresholds: MessageCursorThresholds): { params: string[]; sql: string } {
  const channelThresholds = Object.entries(thresholds.channelLastTs)
    .filter(([channelId, ts]) => channelId.length > 0 && ts.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const params: string[] = [];
  const thresholdCte =
    channelThresholds.length > 0
      ? `,
    thresholds(channel_id, last_ts) AS (
      VALUES ${channelThresholds
        .map(([channelId, ts]) => {
          params.push(channelId, ts);
          return "(?, ?)";
        })
        .join(", ")}
    )`
      : "";
  const thresholdJoin = channelThresholds.length > 0 ? "LEFT JOIN thresholds t ON t.channel_id = m.CHANNEL_ID" : "";
  let whereClause = "";
  if (channelThresholds.length > 0 && thresholds.legacyLastTs) {
    whereClause = "WHERE m.TS > COALESCE(t.last_ts, ?)";
    params.push(thresholds.legacyLastTs);
  } else if (channelThresholds.length > 0) {
    whereClause = "WHERE t.last_ts IS NULL OR m.TS > t.last_ts";
  } else if (thresholds.legacyLastTs) {
    whereClause = "WHERE m.TS > ?";
    params.push(thresholds.legacyLastTs);
  }

  return {
    params,
    sql: `
    WITH latest AS (
      SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) AS mx
      FROM MESSAGE
      GROUP BY CHANNEL_ID, TS
    )${thresholdCte}
    SELECT m.CHANNEL_ID, m.TS, m.THREAD_TS, m.IS_PARENT, m.TXT, m.NUM_FILES, m.DATA
    FROM MESSAGE m
    JOIN latest ON latest.CHANNEL_ID = m.CHANNEL_ID AND latest.TS = m.TS AND latest.mx = m.CHUNK_ID
    ${thresholdJoin}
    ${whereClause}
  `,
  };
}

function* iterateMessageRows(db: DatabaseSync, thresholds: MessageCursorThresholds): Iterable<MessageRow> {
  const { sql, params } = buildMessageRowsQuery(thresholds);
  // Slackdump can store the same (CHANNEL_ID, TS) message across multiple
  // CHUNK_IDs (e.g. from channel enumeration + subsequent thread fetch).
  // Pick the latest chunk's row per (CHANNEL_ID, TS) to avoid duplicate
  // RECORDs on the wire.
  const stmt = db.prepare(sql);
  // node:sqlite stmt.iterate(...) yields Record<string, SQLOutputValue> one
  // row at a time. Our typed shape is a subset (we SELECT named columns);
  // rebuild each row explicitly to narrow SQLOutputValue into our column
  // shape. Cheap: 7 fields per row, and the runtime has already produced
  // the row.
  for (const raw of stmt.iterate(...params)) {
    yield {
      CHANNEL_ID: raw.CHANNEL_ID as string,
      TS: raw.TS as string,
      THREAD_TS: (raw.THREAD_TS as string | null) ?? null,
      IS_PARENT: (raw.IS_PARENT as number | null) ?? null,
      TXT: (raw.TXT as string | null) ?? null,
      NUM_FILES: (raw.NUM_FILES as number | null) ?? null,
      DATA: raw.DATA as Uint8Array | string | null,
    };
  }
}

/**
 * Single-pass co-traversal of the MESSAGE table emitting into messages,
 * reactions, and message_attachments streams as requested. Advances
 * maxMessageTs across every row for the post-loop STATE checkpoint.
 *
 * KNOWN LIMITATION: filtering by ts > prior_ts misses thread replies that
 * arrive on old parents (parent ts from 2022, new reply in 2026). See
 * cursor-finality-and-gap-awareness-open-question.md.
 *
 * The loop body (pure over MessageRow[]) is exported as
 * `emitMessagesPass` from this file so integration.test.ts can drive
 * it without opening sqlite.
 */
function runMessagesUnifiedPass(deps: StreamDeps, thresholds: MessageCursorThresholds): Promise<MessagesPassResult> {
  // Slack message TS strings collate lexically the same way they order
  // chronologically (fixed-width integer-dot-decimal), so string > works.
  // iterateMessageRows is a lazy generator: emitMessagesPass pulls one row
  // at a time, so the unbounded MESSAGE table never lands in heap at once.
  const rows = iterateMessageRows(deps.db, thresholds);
  return emitMessagesPass(deps, rows, thresholds.legacyLastTs);
}

function messageProgressLabel(channelCursorCount: number, priorTs: string | null): string {
  if (channelCursorCount > 0) {
    return `Slack: emitting messages from ${String(channelCursorCount)} channel cursor(s)`;
  }
  if (priorTs) {
    return `Slack: emitting messages newer than ${priorTs}`;
  }
  return "Slack: emitting all messages (full pass)";
}

async function runFilesStream(deps: StreamDeps): Promise<void> {
  // Exclude quip/canvas files from the generic `files` stream — they are
  // first-class records in the `canvases` stream (v0.3). Other file modes
  // (hosted, snippet, external, tombstone) still flow here.
  const rows = safeAll<FileRow>(
    deps.db,
    `
    SELECT f.ID AS id, f.FILENAME AS filename, f.URL AS url, f.MODE AS mode, f.DATA AS data
    FROM FILE f
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM FILE GROUP BY ID) m
      ON m.ID = f.ID AND m.mx = f.CHUNK_ID
    WHERE f.MODE != 'quip'
  `
  );
  const { considered, covered } = await runFingerprintedFullSync(deps, "files", rows, buildFileRecord);
  await declareListConsidered(deps, "files", considered, covered);
}

export async function runCanvasesStream(deps: StreamDeps): Promise<void> {
  // Canvases are stored as FILE rows with MODE='quip' (mimetype
  // application/vnd.slack-docs). A single canvas can appear multiple times
  // across CHUNK_IDs (channel share + thread shares); dedupe on file ID by
  // picking the latest chunk. We also look up the owning channel's
  // properties.canvas blob to surface is_empty / quip_thread_id, which sit
  // on the channel record rather than the file record.
  //
  // The archive does NOT include canvas BODY content — only metadata and
  // an authenticated files.slack.com URL. `content_markdown` is therefore
  // always null here; if/when slackdump or an API-layer fallback fetches
  // the body, this field is where it belongs.
  const canvasRows = safeAll<CanvasRow>(
    deps.db,
    `
    SELECT f.ID AS id, f.FILENAME AS filename, f.URL AS url, f.CHANNEL_ID AS channel_id,
           f.MESSAGE_ID AS message_id, f.DATA AS data
    FROM FILE f
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM FILE GROUP BY ID) m
      ON m.ID = f.ID AND m.mx = f.CHUNK_ID
    WHERE f.MODE = 'quip'
  `
  );
  const chanRows = safeAll<ChannelRow>(
    deps.db,
    `
    SELECT c.ID AS id, c.DATA AS data
    FROM CHANNEL c
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM CHANNEL GROUP BY ID) m
      ON m.ID = c.ID AND m.mx = c.CHUNK_ID
  `
  );
  const channelCanvasIndex = buildChannelCanvasIndex(chanRows);
  for (const r of canvasRows) {
    await deps.emitRecord("canvases", buildCanvasRecord(r, channelCanvasIndex));
  }
  // `canvases` is the one Slack stream where `considered` is objectively
  // honest: it full-syncs every run (NOT fingerprint-suppressed, unlike
  // workspace/users/files/channels/channel_memberships), and every enumerated
  // `canvasRows` row is emitted unconditionally — so `collected` equals the
  // enumerated quip-file inventory, never a churn-reduced subset. Declaring
  // `canvasRows.length` (the deduped MODE='quip' count read at the query site)
  // as `considered` lets the report read a real `complete` when every canvas
  // emitted, and an honest `partial` if a canvas was weighed but dropped (e.g.
  // by record-shape validation). The denominator is measured here, never
  // aliased to the emitted count.
  await declareListConsidered(deps, "canvases", canvasRows.length);
}

export const UNAVAILABLE_STREAMS: ReadonlyArray<{ name: string; reason: string }> = [
  {
    name: "stars",
    reason: "slackdump does not archive starred/saved items (stars.list is not called in archive mode)",
  },
  {
    name: "user_groups",
    reason: "slackdump does not archive user groups (usergroups.list is not called in archive mode)",
  },
  {
    name: "reminders",
    reason: "slackdump does not archive reminders (reminders.list is not called in archive mode)",
  },
  {
    name: "dm_read_states",
    reason: "slackdump archive strips last_read / unread_count_display from channel data",
  },
];

/**
 * Streams declared in the manifest for Layer-2 completeness but NOT
 * realizable from a slackdump archive today. If a caller requests them we
 * emit SKIP_RESULT so the run completes cleanly without spoofing empty data.
 */
function emitUnavailableStreams(requested: CollectContext["requested"], emit: CollectContext["emit"]): void {
  for (const s of UNAVAILABLE_STREAMS) {
    if (requested.has(s.name)) {
      emit({
        type: "SKIP_RESULT",
        stream: s.name,
        reason: "not_available",
        message: s.reason,
      });
    }
  }
}

interface StateEmitDeps {
  archivePath: string;
  channelLastTs: Record<string, string>;
  committedMaxTs: string | null;
  emit: CollectContext["emit"];
  fingerprintCursors: Map<string, FingerprintCursor>;
  observedChannelIds: readonly string[];
  requested: CollectContext["requested"];
}

/**
 * Per-stream STATE checkpoints. Per Collection Profile spec, STATE is emitted
 * per stream with a cursor object opaque to the runtime but interpreted by
 * this connector on the next run.
 *
 * - messages: `last_ts` is the max Slack ts seen this run. `archive_dir`
 *   moves onto the messages cursor so `-resume` continues to work; it's
 *   workspace-global but messages is the canonical stream for slackdump
 *   state on the PDPP side.
 * - workspace / users / files / channel_memberships: persist the per-record
 *   fingerprint map alongside the freshness marker so the next run can skip
 *   emitting records whose semantic shape hasn't moved (see
 *   emitWithFingerprint). A legacy cursor (no `fingerprints` key) is
 *   tolerated on the read side; the first post-deploy run rebuilds the map.
 * - other mutable_state streams (channels, canvases):
 *   low cardinality, we full-sync each run; the cursor is just a freshness
 *   marker for visibility.
 */
function emitStateCheckpoints(deps: StateEmitDeps): void {
  deps.emit({
    type: "STATE",
    stream: "messages",
    cursor: {
      last_ts: deps.committedMaxTs,
      channel_last_ts: deps.channelLastTs,
      observed_channel_ids: [...deps.observedChannelIds].sort(),
      archive_dir: deps.archivePath,
      fetched_at: nowIso(),
    },
  });
  for (const stream of [
    "channels",
    "channel_stats",
    "channel_memberships",
    "users",
    "files",
    "canvases",
    "workspace",
  ]) {
    if (deps.requested.has(stream)) {
      const cursor: Record<string, unknown> = { synced_at: nowIso() };
      const fingerprintCursor = deps.fingerprintCursors.get(stream);
      if (fingerprintCursor && fingerprintCursor.size() > 0) {
        cursor.fingerprints = fingerprintCursor.toState();
      }
      deps.emit({
        type: "STATE",
        stream,
        cursor,
      });
    }
  }
}

interface EnsureArchiveDeps {
  archivePath: string;
  childEnv: NodeJS.ProcessEnv;
  cookie: string;
  opts: SlackOpts;
  positionalChannels: string[];
  priorArchive: string | undefined;
  progress: CollectContext["progress"];
  resumeTarget: string | null;
  sqlitePath: string;
  timeFrom: string | null;
  timeTo: string | null;
  token: string;
  useResume: boolean;
}

/**
 * Drive slackdump (or skip it on PDPP_SLACK_SKIP_SLACKDUMP=1) and assert the
 * sqlite archive is present afterwards. Any slackdump failure is wrapped in
 * "slackdump failed: …" for the caller.
 *
 * Escape hatch: when the on-disk archive is valid but slackdump keeps failing
 * (e.g. Slack 500 errors on a specific channel, exit 6 loops), set
 * PDPP_SLACK_SKIP_SLACKDUMP=1 to ingest whatever's already on disk without
 * touching the network. This salvages a partial archive into PDPP records
 * instead of leaving the data stranded.
 */
async function ensureArchiveOnDisk(deps: EnsureArchiveDeps): Promise<void> {
  const { archivePath, sqlitePath, progress, childEnv, token, cookie } = deps;
  const skipSlackdump = process.env.PDPP_SLACK_SKIP_SLACKDUMP === "1";
  try {
    if (skipSlackdump) {
      progress(`Skipping slackdump refresh (PDPP_SLACK_SKIP_SLACKDUMP=1); reading existing archive at ${archivePath}`);
      if (!existsSync(sqlitePath)) {
        throw new Error(`PDPP_SLACK_SKIP_SLACKDUMP=1 but no archive found at ${sqlitePath}`);
      }
    } else {
      progress(`Ensuring slackdump workspace is cached (SLACKDUMP_BIN=${process.env.SLACKDUMP_BIN || "<unset>"})`);
      await ensureWorkspaceCached({ token, cookie, env: childEnv });
      // WHY we ship an API-limits config: slackdump's defaults set tier_3 /
      // tier_4 retries to 3, which exhausts quickly on bot-heavy channels
      // (thousands of threads × even a low rate of 500 Internal Server Errors
      // from Slack = process aborts with exit 6). Bumping those retries to 20
      // aligns them with tier_2 (rate-limit retries), letting the same
      // exponential-backoff policy ride out server-side hiccups. See
      // config/slackdump-api-config.toml.
      const apiConfigPath = new URL("../../config/slackdump-api-config.toml", import.meta.url).pathname;
      await runArchiveOrResume({
        apiConfigPath,
        archivePath,
        childEnv,
        opts: deps.opts,
        positionalChannels: deps.positionalChannels,
        priorArchive: deps.priorArchive,
        progress,
        resumeTarget: deps.resumeTarget,
        sqlitePath: deps.sqlitePath,
        timeFrom: deps.timeFrom,
        timeTo: deps.timeTo,
        useResume: deps.useResume,
      });
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    throw new Error(`slackdump failed: ${m}`);
  }
  if (!existsSync(sqlitePath)) {
    throw new Error(`slackdump output not found at ${sqlitePath}`);
  }
}

/**
 * Run every requested record stream against the open sqlite DB in emit
 * order. Returns the max message TS for the post-loop STATE checkpoint.
 */
async function runRequestedStreams(
  deps: StreamDeps,
  state: CollectContext["state"],
  options: { allowLegacyMessageCursorFallback?: boolean; ignoreMessageChannelCursors?: boolean } = {}
): Promise<MessagesPassResult> {
  if (deps.requested.has("workspace")) {
    deps.progress("Slack: emitting workspace record", { stream: "workspace" });
    await runWorkspaceStream(deps);
  }
  if (deps.requested.has("channels") || deps.requested.has("channel_stats")) {
    deps.progress("Slack: emitting channels", { stream: "channels" });
    await runChannelsStream(deps);
  }
  if (deps.requested.has("channel_memberships")) {
    deps.progress("Slack: emitting channel memberships", { stream: "channel_memberships" });
    await runChannelMembershipsStream(deps);
  }
  if (deps.requested.has("users")) {
    deps.progress("Slack: emitting users", { stream: "users" });
    await runUsersStream(deps);
  }
  // Messages, reactions, message_attachments share one pass for efficiency.
  let result: MessagesPassResult = { channelMaxTs: {}, maxMessageTs: null };
  if (deps.requested.has("messages") || deps.requested.has("reactions") || deps.requested.has("message_attachments")) {
    const messagesState = state.messages as MessagesState | undefined;
    const priorTs = options.allowLegacyMessageCursorFallback === false ? null : (messagesState?.last_ts ?? null);
    const channelLastTs = options.ignoreMessageChannelCursors
      ? {}
      : normalizeStringRecord(messagesState?.channel_last_ts);
    deps.progress(messageProgressLabel(Object.keys(channelLastTs).length, priorTs), { stream: "messages" });
    result = await runMessagesUnifiedPass(deps, { channelLastTs, legacyLastTs: priorTs });
  }
  if (deps.requested.has("files")) {
    deps.progress("Slack: emitting files", { stream: "files" });
    await runFilesStream(deps);
  }
  if (deps.requested.has("canvases")) {
    deps.progress("Slack: emitting canvases", { stream: "canvases" });
    await runCanvasesStream(deps);
  }
  return result;
}

// ─── Entry ─────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/slack/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "slack",
    retryablePattern: SLACK_RETRYABLE_FAILURE_RE,
    timeRangeField: "sent_at",
    validateRecord,
    auth: {
      kind: "env",
      required: ["SLACK_WORKSPACE", "SLACK_TOKEN", "SLACK_COOKIE"],
    },
    async collect(ctx: CollectContext): Promise<void> {
      const { state, requested, credentials, emit, progress } = ctx;

      const { workspace, token, cookie } = extractCredentials(credentials);
      const opts = readSlackOptions();

      // Resource filters (pre-fetch: pass as positional args; post-fetch: enforce too)
      const resFilters = new Map<string, ReadonlySet<string> | null>();
      for (const [n, r] of requested) {
        resFilters.set(n, resourceSet(r));
      }

      const childEnv = buildChildEnv(token, cookie);
      const msgResFilter = resFilters.get("messages");
      const positionalChannels: string[] = [...(msgResFilter ? [...msgResFilter] : []), ...opts.CHANNEL_ALLOWLIST];
      const messageFamilyRequested =
        requested.has("messages") || requested.has("reactions") || requested.has("message_attachments");
      const isUnscopedMessageBoundary = positionalChannels.length === 0;
      const messagesScope = requested.get("messages");
      const baseArchivePaths = resolveArchivePaths(workspace);
      const { dumpDir } = baseArchivePaths;
      const { archivePath, sqlitePath } = resolveScopedArchivePaths(baseArchivePaths, positionalChannels);
      await mkdir(dumpDir, { recursive: true });

      const { resumeTarget, priorArchive } = pickResumeTarget(state, archivePath, {
        allowStateArchive: isUnscopedMessageBoundary,
      });
      const useResume = Boolean(resumeTarget);

      // Map time_range from messages stream scope into -time-from / -time-to.
      const { timeFrom, timeTo } = extractMessageTimeRange(
        messagesScope?.time_range as { from?: string | null; to?: string | null } | undefined
      );

      await ensureArchiveOnDisk({
        archivePath,
        childEnv,
        cookie,
        opts,
        positionalChannels,
        priorArchive,
        progress,
        resumeTarget,
        sqlitePath,
        timeFrom,
        timeTo,
        token,
        useResume,
      });

      const db = new DatabaseSync(sqlitePath, { readOnly: true });
      // One per-record fingerprint cursor per fingerprinted stream. The
      // primitive seeds itself from the prior cursor so a record we skip
      // this run carries its fingerprint forward into the next STATE
      // write — without that, a single skipped record would drop from
      // STATE on the next write and re-emit on the run after.
      const fingerprintCursors = new Map<string, FingerprintCursor>();
      for (const stream of FINGERPRINTED_STREAMS) {
        fingerprintCursors.set(
          stream,
          openFingerprintCursor(state[stream], {
            excludeFromFingerprint: FINGERPRINT_EXCLUDE[stream],
          })
        );
      }
      const deps: StreamDeps = {
        db,
        // Narrow the ctx.emit union to the single message kind StreamDeps.emit
        // accepts (DETAIL_COVERAGE). runConnector's emit accepts the full
        // EmittedMessage union, so this is a contravariant widening at the call
        // boundary, not a coercion of message shape.
        emit: (msg) => emit(msg),
        emitRecord: (stream, data) =>
          stream === "messages" && msgResFilter
            ? emitMessageRecordScopedByChannel({
                channelIds: msgResFilter,
                emitRecord: ctx.emitRecord,
                record: data,
              })
            : ctx.emitRecord(stream, data),
        emittedAt: ctx.emittedAt,
        fingerprintCursors,
        progress,
        requested,
      };
      const messagesState = state.messages as MessagesState | undefined;
      const priorChannelLastTs = normalizeStringRecord(messagesState?.channel_last_ts);
      const priorObservedChannelIds = readPriorObservedChannelIds(messagesState);
      const baseChannelIds = currentArchiveChannelIds(db);
      const reconciledSourceCache = await reconcileMessageSourceCache({
        archiveRuntime: { childEnv, cookie, opts, progress, timeFrom, timeTo, token },
        baseArchivePaths,
        baseChannelIds,
        isUnscopedMessageBoundary,
        messageFamilyRequested,
        priorObservedChannelIds,
      });

      if (reconciledSourceCache.missingChannelIds.length > 0) {
        await emitMissingChannelDiagnostic(emit, reconciledSourceCache.missingChannelIds);
      }

      let messageResult = await runRequestedStreams(deps, state, {
        allowLegacyMessageCursorFallback: isUnscopedMessageBoundary,
        ignoreMessageChannelCursors: Boolean(msgResFilter && msgResFilter.size > 0),
      });
      if (messageFamilyRequested && isUnscopedMessageBoundary && reconciledSourceCache.scopedArchives.length > 0) {
        messageResult = await mergeScopedMessageArchivePasses({
          messageResult,
          scopedArchives: reconciledSourceCache.scopedArchives,
          state,
          streamDeps: deps,
        });
      }

      emitUnavailableStreams(requested, emit);

      // Drop fingerprint entries for IDs that disappeared from the source
      // since the prior run on streams we actually requested. Streams the
      // caller did not exercise keep their full carry-forward — an
      // unrequested stream's cursor must not be silently wiped.
      for (const stream of FINGERPRINTED_STREAMS) {
        if (requested.has(stream)) {
          fingerprintCursors.get(stream)?.pruneStale();
        }
      }

      const priorMaxTs = messagesState?.last_ts || null;
      const committedMaxTs = selectCommittedMaxTs(priorMaxTs, messageResult.maxMessageTs);
      const committedChannelLastTs = selectCommittedChannelLastTs(priorChannelLastTs, messageResult.channelMaxTs);
      const observedChannelIds =
        messageFamilyRequested && isUnscopedMessageBoundary
          ? [
              ...new Set([...reconciledSourceCache.currentChannelIds, ...reconciledSourceCache.missingChannelIds]),
            ].sort()
          : priorObservedChannelIds;
      const stateArchivePath = isUnscopedMessageBoundary ? archivePath : (messagesState?.archive_dir ?? archivePath);
      emitStateCheckpoints({
        archivePath: stateArchivePath,
        channelLastTs: committedChannelLastTs,
        committedMaxTs,
        emit,
        fingerprintCursors,
        observedChannelIds,
        requested,
      });
    },
  });
}
