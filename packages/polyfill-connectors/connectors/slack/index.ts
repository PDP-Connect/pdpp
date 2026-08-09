#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Slack Connector (v0.6.0) — subprocess-wraps slackdump + reads its SQLite output.
 *
 * v0.3 added a `canvases` stream (derived from FILE MODE='quip' rows joined
 * with each channel's canvas metadata). v0.6 adds direct Slack Web API
 * calls (see `slack-api.ts`) for four streams slackdump's archive mode
 * cannot produce:
 *
 *   - stars: `stars.list` — slackdump defines CHUNK type 8 STARRED_ITEMS but
 *     archive mode never emits chunks of that type.
 *   - user_groups: `usergroups.list` — not called in archive mode.
 *   - reminders: `reminders.list` — not called in archive mode.
 *   - dm_read_states: `conversations.info` — archived channel DATA blobs
 *     strip `last_read`/`unread_count_display`.
 *
 * All four are reachable with the SAME session credential (`SLACK_TOKEN`
 * xoxc token + `SLACK_COOKIE` `d` cookie) already captured for slackdump —
 * "slackdump's CLI doesn't call this" was never a source-availability
 * claim. See openspec/changes/complete-slack-bundled-connector-coverage
 * for the evidence trail.
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
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describeConnectorArtifactRoot, resolveConnectorArtifactDir } from "../../src/connector-artifact-root.ts";
import { readOptions } from "../../src/connector-options.ts";
import {
  buildDetailCoverageMessage,
  buildDetailGap,
  type CollectContext,
  type DetailGapMessage,
  type DetailGapStartEntry,
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
  buildDmReadStateRecord,
  buildFileRecord,
  buildMessageAttachmentRecords,
  buildMessageRecord,
  buildReactionRecords,
  buildReminderRecord,
  buildStarRecord,
  buildUserGroupRecord,
  buildUserRecord,
  buildWorkspaceRecord,
  extractMessageTimeRange,
  parseBlob,
  parseMessageRow,
  selectCommittedMaxTs,
  toSlackTime,
  WORKSPACE_LIST_ARROW,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import {
  fetchAllReminders,
  fetchAllStars,
  fetchAllUserGroups,
  fetchDmReadStates,
  SLACK_API_RETRYABLE_FAILURE_RE,
} from "./slack-api.ts";
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
const OPTIONAL_STREAM_FAILED_REASON = "optional_stream_failed";
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
    // biome-ignore lint/suspicious/noEqualsToNull: check for both null and undefined
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

// True only when both reads succeeded (non-null) and disagree — a genuine
// observed change. A transition into or out of null is a FAILED read
// (readSlackdumpProgressSnapshot's try/catch falls back to null when the
// archive is locked/mid-write — see its comment), not evidence of anything;
// counting it as "changed" would report progress from a read failure alone,
// with nothing on disk having actually happened.
function countAdvanced(previous: number | null, current: number | null): boolean {
  return previous !== null && current !== null && previous !== current;
}

export function slackdumpProgressChanged(
  previous: SlackdumpProgressSnapshot | null,
  current: SlackdumpProgressSnapshot | null
): boolean {
  if (!current) {
    return false;
  }
  if (!previous) {
    return true;
  }
  // Reverted an archiveBytes-only simplification: in SQLite WAL mode, a
  // checkpoint can fold the WAL back into the main file and reuse its
  // allocation, so combined main+WAL+SHM byte size can stay flat across real,
  // committed writes (confirmed directly: two committed inserts, combined
  // size unchanged both times). archiveBytes alone can therefore silently
  // miss real progress and let the scheduler's progress-driven watchdog time
  // out a healthy long-running dump. Row/chunk counts, read from a fresh
  // read-only connection, correctly observe checkpointed writes that byte
  // size misses — checking all four signals is the safe behavior, not a
  // race-prone one.
  //
  // archiveBytes is a plain file stat, never null, so it's compared directly.
  // The three SQLite-read counts use countAdvanced instead of !==, because a
  // failed read (locked/mid-write archive) falls back to null and must not
  // be conflated with a real change — only two successful, differing reads
  // count as progress.
  return (
    current.archiveBytes !== previous.archiveBytes ||
    countAdvanced(previous.channels, current.channels) ||
    countAdvanced(previous.maxChunkId, current.maxChunkId) ||
    countAdvanced(previous.messages, current.messages)
  );
}

function formatSlackdumpProgress(label: string, snapshot: SlackdumpProgressSnapshot): string {
  const facts = [
    `archive_bytes=${snapshot.archiveBytes}`,
    snapshot.messages === null ? null : `messages=${snapshot.messages}`,
    snapshot.channels === null ? null : `channels=${snapshot.channels}`,
    snapshot.maxChunkId === null ? null : `max_chunk=${snapshot.maxChunkId}`,
  ].filter(Boolean);
  return `Slack slackdump ${label} progress: ${facts.join(" ")}`;
}

function redactSlackdumpOutput(output: string, env: NodeJS.ProcessEnv): string {
  let redacted = output;
  for (const secret of [env.SLACK_TOKEN, env.SLACK_COOKIE]) {
    if (secret) {
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    }
  }
  // Keep diagnostics safe even if a child prints only a token-shaped value or
  // wraps the known credential before the exact replacement above can match.
  return redacted.replace(/xox[a-z]-[^\s"'`]+/giu, "[REDACTED]");
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
              ...(snapshot.messages === null ? {} : { count: snapshot.messages }),
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
        const detail = redactSlackdumpOutput(`${stderr}\n${stdout}`, env).slice(0, 400);
        reject(new Error(`slackdump_exit_${code}${detail ? `: ${detail}` : ""}`));
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
  RECLAIM_UPLOADS: boolean;
  SKIP_FILES: boolean;
}

export const SLACK_RETRYABLE_FAILURE_RE = /ECONN|ETIMEDOUT|timeout|slackdump_exit_6|slack_rate_limited/i;

const SLACKDUMP_CLIENT_TOKEN_PREFIX = "xoxc-";
const SLACKDUMP_D_COOKIE_PREFIX = "xoxd-";
const SLACK_WORKSPACE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
// Slackdump's value path preserves URL-safe percent escapes and QueryEscapes
// raw unsafe cookie characters. Keep provider values opaque here: only enforce
// the documented xoxc/xoxd prefixes, transport-safe control characters, and a
// bounded input size.
const SLACKDUMP_CREDENTIAL_MAX_LENGTH = 4096;
const INVALID_PERCENT_ESCAPE_RE = /%(?![0-9a-f]{2})/iu;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function normalizeSlackOpaqueValue(raw: string, prefix: string | null, invalidCode: string): string {
  const value = raw.trim();
  if (
    !value ||
    (prefix !== null && !value.startsWith(prefix)) ||
    value.length > SLACKDUMP_CREDENTIAL_MAX_LENGTH ||
    hasControlCharacter(value)
  ) {
    throw new Error(invalidCode);
  }
  return value;
}

export function normalizeSlackWorkspace(raw: string): string {
  const workspace = raw.trim().toLowerCase();
  if (!SLACK_WORKSPACE_RE.test(workspace)) {
    throw new Error("slack_workspace_invalid");
  }
  return workspace;
}

export function normalizeSlackToken(raw: string): string {
  return normalizeSlackOpaqueValue(raw, SLACKDUMP_CLIENT_TOKEN_PREFIX, "slack_token_invalid");
}

export function normalizeSlackCookie(raw: string): string {
  let cookie = raw.trim();
  if (cookie.startsWith("d=")) {
    cookie = cookie.slice(2).trim();
  }
  const normalized = normalizeSlackOpaqueValue(cookie, SLACKDUMP_D_COOKIE_PREFIX, "slack_cookie_invalid");
  if (INVALID_PERCENT_ESCAPE_RE.test(normalized)) {
    throw new Error("slack_cookie_invalid");
  }
  return normalized;
}

export function extractSlackCredentials(credentials: Record<string, string>): SlackCredentials {
  const rawWorkspace = typeof credentials.SLACK_WORKSPACE === "string" ? credentials.SLACK_WORKSPACE : "";
  const rawToken = typeof credentials.SLACK_TOKEN === "string" ? credentials.SLACK_TOKEN : "";
  const rawCookie = typeof credentials.SLACK_COOKIE === "string" ? credentials.SLACK_COOKIE : "";
  if (!(rawWorkspace.trim() && rawToken.trim() && rawCookie.trim())) {
    throw new Error("slack_credentials_missing");
  }
  return {
    workspace: normalizeSlackWorkspace(rawWorkspace),
    token: normalizeSlackToken(rawToken),
    cookie: normalizeSlackCookie(rawCookie),
  };
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
        RECLAIM_UPLOADS: { parse: "bool", default: false },
      },
    }
  ) as Record<string, unknown>;
  return {
    LOOKBACK_DAYS: parsed.LOOKBACK_DAYS as number,
    CHANNEL_ALLOWLIST: parsed.CHANNEL_ALLOWLIST as string[],
    CHANNEL_TYPES: parsed.CHANNEL_TYPES as string[],
    MEMBER_ONLY: parsed.MEMBER_ONLY as boolean,
    SKIP_FILES: parsed.SKIP_FILES as boolean,
    RECLAIM_UPLOADS: parsed.RECLAIM_UPLOADS as boolean,
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
  /** One-line disclosure of where the archive root came from; logged once per run. */
  rootDisclosure: string;
  sqlitePath: string;
}

// The archive is the connector's most expensive durable artifact: slackdump
// resumes against it, so losing it forces a full multi-GB re-dump. It used to
// live at `homedir()/.pdpp/slackdump`, which the documented single-volume
// deployment does NOT persist — every container replacement restarted the sync
// from zero. It now sits under the shared deployment-owned artifact root
// (src/connector-artifact-root.ts), which lands inside /var/lib/pdpp on Core.
function resolveArchivePaths(workspace: string): ArchivePaths {
  const resolved = resolveConnectorArtifactDir("slack", [workspace]);
  const archivePath = join(resolved.root, "archive");
  // default DB name under the archive dir
  const sqlitePath = join(archivePath, "slackdump.sqlite");
  return {
    dumpDir: resolved.root,
    archivePath,
    sqlitePath,
    rootDisclosure: describeConnectorArtifactRoot(resolved),
  };
}

// slackdump downloads file-attachment bytes into `<archive>/__uploads/` (only
// when files are enabled — SLACK_SKIP_FILES defaults true, so steady-state runs
// don't grow it). The connector never reads these bytes: file/attachment
// streams emit metadata only, and PDPP has no blob copy. See the reclaim
// escape hatch below.
function resolveUploadsDir(archivePath: string): string {
  return join(archivePath, "__uploads");
}

// Sum a directory's byte size with a bounded recursive walk. Best-effort:
// unreadable entries are skipped (returns what it could measure). Used only for
// observability and reclaim reporting, never on a hot path.
function directorySizeBytes(dir: string): number {
  let total = 0;
  let stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else {
        total += existingFileSize(full);
      }
    }
  }
  stack = [];
  return total;
}

// One-way reclaim of the `__uploads/` residue for a workspace archive. Only
// called from the connector's onDurableCommit hook, i.e. AFTER the runtime
// acknowledged durable ingest of this run's records. It removes ONLY the
// `__uploads/` directory — never `slackdump.sqlite` or its -wal/-shm sidecars,
// which are slackdump's resume state. Returns the reclaimed byte count.
//
// CAVEAT (documented, intentional): PDPP holds no copy of these bytes, and
// slackdump will NOT re-download them (its resume file-dedup is DB-only, keyed
// on the still-present FILE row), so this is unrecoverable. It is opt-in
// (SLACK_RECLAIM_UPLOADS=1) precisely because it is lossy.
export async function reclaimUploads(archivePath: string): Promise<number> {
  const uploadsDir = resolveUploadsDir(archivePath);
  if (!existsSync(uploadsDir)) {
    return 0;
  }
  const reclaimedBytes = directorySizeBytes(uploadsDir);
  await rm(uploadsDir, { recursive: true, force: true });
  return reclaimedBytes;
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
    rootDisclosure: base.rootDisclosure,
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
        rootDisclosure: base.rootDisclosure,
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
  // Every scoped-archive path this run created or read via
  // repairMissingScopedArchive, INCLUDING a successful repair that recovered
  // no matching channel (and so is absent from `scopedArchives`). Reclaim
  // must cover this set too — the archive's __uploads/ residue exists
  // regardless of whether the repair helped this run's message pass.
  reclaimedRepairArchivePaths: string[];
  // Updated `scoped_archive_resumed_at` map (archive path -> ISO timestamp of
  // the last actual, SUCCESSFULLY COMPLETED `resume` invocation) to commit
  // into STATE. Only an archive whose resume this run actually finished
  // without error advances its timestamp; throttled-and-skipped archives
  // keep their existing (possibly absent) timestamp UNCHANGED, and a failed
  // attempt keeps its existing timestamp UNCHANGED too — a failure is owed
  // work, not completed work, and must never be recorded as if it were.
  scopedArchiveResumedAt: Record<string, string>;
  scopedArchives: SelectedScopedArchive[];
}

// `resume -lookback pNd` cannot discover a message older than `now - N days`
// no matter how often it runs — the window is fixed by the flag, not by
// invocation frequency. So re-invoking it more often than once per lookback
// period cannot recover any data a less-frequent invocation would miss; the
// deferred backlog inside the window is caught in a single call once the
// throttle elapses. This is what makes throttling lossless rather than a
// heuristic guess: it is a direct consequence of slackdump's own documented
// `-lookback` semantics, not a wall-clock timeout on the connector's own
// patience.
function archiveDueForResume(lastResumedAtIso: string | undefined, lookbackDays: number, nowIsoValue: string): boolean {
  if (!lastResumedAtIso) {
    return true;
  }
  const last = Date.parse(lastResumedAtIso);
  const now = Date.parse(nowIsoValue);
  if (!(Number.isFinite(last) && Number.isFinite(now))) {
    return true;
  }
  const elapsedMs = now - last;
  const lookbackMs = lookbackDays * 24 * 60 * 60 * 1000;
  return elapsedMs >= lookbackMs;
}

// One-time upgrade compatibility: `base_archive_resumed_at` did not exist
// before this throttle shipped, so a connection whose base archive already
// completed a real resume under the OLD code has no entry for it — and
// `archiveDueForResume` treats "no entry" as "due", which replays the entire
// base archive on the very first post-upgrade run (the live defect this
// function exists to close). Deriving a synthetic timestamp is only safe
// when prior STATE proves an ACTUAL completed base-archive resume, not mere
// archive presence: `emitStateCheckpoints` (and its pre-this-change
// predecessor) writes `last_ts`/`channel_last_ts` into `messages` STATE only
// after a run reaches its normal durable-commit path — a failed or
// interrupted run commits no STATE at all (see
// "a failed base archive resume remains owed and retries successfully on
// the next run"), so an on-disk archive with no such committed fact is
// exactly the interrupted/failed case this must NOT treat as done. Requiring
// `priorArchive === archivePath` additionally ties the proof to the base
// archive's own resolved identity, not a stale or differently-scoped path.
// The derived value is `nowIso` (this run counts as the fact-finding run
// itself, not a backdated resume) so the very next scheduled run is
// immediately throttled, while a genuine resume is still due again after one
// full lookback window from here — the same lossless cadence a real resume
// timestamp would produce, applied one run later than an already-migrated
// connection would see it.
function deriveMigratedBaseArchiveResumedAt(deps: {
  archivePath: string;
  isUnscopedMessageBoundary: boolean;
  messagesState: MessagesState | undefined;
  nowIso: string;
  priorArchive: string | undefined;
}): string | undefined {
  const { archivePath, isUnscopedMessageBoundary, messagesState, nowIso: nowIsoValue, priorArchive } = deps;
  if (!isUnscopedMessageBoundary) {
    return;
  }
  if (priorArchive !== archivePath) {
    return;
  }
  const provenPriorSuccess = Boolean(
    messagesState?.last_ts || Object.keys(normalizeStringRecord(messagesState?.channel_last_ts)).length > 0
  );
  return provenPriorSuccess ? nowIsoValue : undefined;
}

// A failed resume must surface as durable, governor-paced recovery evidence
// — not as a connector-local suppression window meant only for genuinely
// completed work. `record_key` is the archive path itself: stable across
// runs (so repeated failures upsert the SAME durable gap row, per the
// runtime's `(stream, record_key)` conflict key, rather than spamming one
// per run) and unique per scoped archive (the unit the resume subprocess
// actually operates on). `reason: "temporary_unavailable"` mirrors Gmail's
// attachment-hydration gap: the failure bucket mixes transient
// network/subprocess errors with no exhaustion signal, so retrying next
// eligible run is the honest, non-destructive default — it does NOT arm the
// cross-run source-pressure cooldown (only `rate_limited`/`upstream_pressure`
// do), so an unrelated recoverable stream's pacing is never affected by a
// stuck scoped archive.
function buildScopedArchiveResumeGap(archivePath: string, message: string): DetailGapMessage {
  return buildDetailGap({
    stream: "messages",
    recordKey: archivePath,
    reason: "temporary_unavailable",
    locator: {
      kind: "slack.scoped_archive_resume",
      archive_path: archivePath,
    },
    error: { class: "scoped_archive_resume_failed", message },
  });
}

// Emitted once a previously-gapped archive resumes successfully, so the
// governor's durable gap row is closed rather than left `pending` forever
// after the underlying problem has actually cleared. Matches by the same
// `(stream, record_key)` identity the gap was opened with; `ctx.detailGaps`
// (this connector instance's currently-pending gaps, supplied on START) is
// the read side of that identity — no separate connector-local bookkeeping
// needed.
function findPendingScopedArchiveResumeGap(
  detailGaps: readonly DetailGapStartEntry[],
  archivePath: string
): DetailGapStartEntry | undefined {
  return detailGaps.find(
    (gap) => gap.stream === "messages" && gap.status === "pending" && String(gap.record_key ?? "") === archivePath
  );
}

// Distinct facts, never conflated: a throttled unit was never attempted; a
// failed unit was attempted but did NOT durably complete; only "resumed"
// means the subprocess actually finished without error. Only "resumed" may
// ever advance `scoped_archive_resumed_at` — a failed attempt is real work
// that did not pay off and must stay owed, not silently treated as done for
// a full lookback window (that conflation was the live-REVISE defect this
// type exists to make structurally impossible).
type RefreshScopedArchiveOutcome = { kind: "failed"; message: string } | { kind: "resumed" } | { kind: "throttled" };

interface RefreshScopedArchiveResult {
  outcome: RefreshScopedArchiveOutcome;
}

async function refreshScopedArchive(
  archive: SelectedScopedArchive,
  deps: ArchiveRuntimeDeps,
  options: { dueForResume: boolean }
): Promise<RefreshScopedArchiveResult> {
  const { childEnv, cookie, opts, progress, timeFrom, timeTo, token } = deps;
  if (!options.dueForResume) {
    progress(
      `Slack: scoped archive at ${archive.paths.archivePath} not due for resume yet ` +
        `(last resumed within lookback=p${String(opts.LOOKBACK_DAYS)}d) — reading existing data, skipping subprocess`,
      { stream: "messages" }
    );
    return { outcome: { kind: "throttled" } };
  }
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
    // Do NOT stamp scoped_archive_resumed_at on this path: the attempt did
    // not durably complete, so this archive is still owed a resume. Retry
    // pacing for the failure itself belongs to the existing DETAIL_GAP /
    // recovery-governor path (see the caller), not a connector-local
    // suppression window meant only for genuinely-completed work.
    return { outcome: { kind: "failed", message } };
  }
  return { outcome: { kind: "resumed" } };
}

interface ScopedArchiveRepairResult {
  // The repair-target archive path — always known (resolveScopedArchivePaths
  // is a pure digest of missingChannelIds), independent of whether the
  // attempt succeeded. This is the SAME `record_key`/reclaim identity a
  // refresh-path archive uses: repeated failed repair attempts for the same
  // missing-channel set upsert one durable gap row, not one per run, exactly
  // like an existing-archive refresh failure.
  archivePath: string;
  // The refresh path's own outcome vocabulary — "resumed" here means
  // "ensureArchiveOnDisk completed for this repair attempt," never a
  // conflation with a successful CHANNEL recovery (see `selected`, which is
  // the separate, repair-specific fact). Unifies the failed/resumed
  // distinction (and its typed-gap/timestamp handling) across both the
  // existing-archive-refresh and new-repair-attempt call sites through the
  // same `applyScopedArchiveRefreshOutcome` helper — one invariant, one
  // enforcement point, not two independently-maintained copies.
  outcome: RefreshScopedArchiveOutcome;
  // Non-null only when the repair recovered at least one of the requested
  // missing channel IDs — the shape the message-family merge pass needs.
  // Independent of `outcome`: a "resumed" repair can still recover zero
  // channels (see the empty-repair-archive test), which is why reclaim
  // coverage (task 7.1) reads `archivePath`, not `selected`.
  selected: SelectedScopedArchive | null;
}

async function repairMissingScopedArchive(
  baseArchivePaths: ArchivePaths,
  missingChannelIds: readonly string[],
  deps: ArchiveRuntimeDeps
): Promise<ScopedArchiveRepairResult> {
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
    // ensureArchiveOnDisk threw: nothing durable was created/read this run
    // (or a pre-existing archive from a prior run is left as-is, already
    // covered by its own prior reclaim registration). `selected: null` keeps
    // this failed attempt out of the message-pass merge and the caller's
    // `scoped_archive_resumed_at` advance; `outcome: "failed"` is what
    // routes this into the SAME typed-gap path a refresh failure uses.
    return { archivePath: repairPaths.archivePath, outcome: { kind: "failed", message }, selected: null };
  }

  const repairedChannelIds = readArchiveChannelIds(repairPaths.sqlitePath).filter((id) =>
    missingChannelIds.includes(id)
  );
  return {
    archivePath: repairPaths.archivePath,
    outcome: { kind: "resumed" },
    selected: repairedChannelIds.length > 0 ? { channelIds: repairedChannelIds, paths: repairPaths } : null,
  };
}

/**
 * Apply one scoped archive's refresh outcome: advance (or deliberately do
 * NOT advance) `scoped_archive_resumed_at`, and emit the matching typed
 * protocol evidence — DETAIL_GAP_RECOVERED closing out a prior failure on
 * success, or a fresh DETAIL_GAP on failure. Returns the human-readable
 * outcome label for the per-unit progress line. Extracted out of
 * `reconcileMessageSourceCache`'s loop so each outcome branch reads as one
 * flat case, not a nested conditional.
 */
async function applyScopedArchiveRefreshOutcome(
  outcome: RefreshScopedArchiveOutcome,
  ctx: {
    archivePath: string;
    detailGaps: readonly DetailGapStartEntry[];
    emit: CollectContext["emit"];
    nowIso: string;
    scopedArchiveResumedAt: Record<string, string>;
  }
): Promise<string> {
  const { archivePath, detailGaps, emit, nowIso: nowIsoValue, scopedArchiveResumedAt } = ctx;
  if (outcome.kind === "throttled") {
    return "throttled, not owed";
  }
  if (outcome.kind === "failed") {
    // The attempt did not durably complete — this is owed work, not
    // completed work. Never stamp scoped_archive_resumed_at here (that
    // would silently suppress retries for a full lookback window despite
    // nothing having actually succeeded). Instead, surface a typed,
    // durable, governor-paced recovery fact: the SAME (stream, record_key)
    // identity upserts on repeat failures rather than spamming a new row
    // per run, and the runtime's own recovery/quarantine machinery — not
    // connector-local suppression — owns how and when this gets retried.
    await emit(buildScopedArchiveResumeGap(archivePath, outcome.message));
    return "failed, gap recorded";
  }
  // outcome.kind === "resumed": only a genuinely completed resume may
  // advance the throttle timestamp — this is the exact fact a failure must
  // NOT produce.
  scopedArchiveResumedAt[archivePath] = nowIsoValue;
  // Close out any durable gap this archive previously opened: the problem
  // has cleared, so the governor's pending row must not sit open forever
  // after a later success.
  const pendingGap = findPendingScopedArchiveResumeGap(detailGaps, archivePath);
  if (pendingGap) {
    await emit({
      type: "DETAIL_GAP_RECOVERED",
      reference_only: true,
      gap_id: pendingGap.gap_id,
      record_key: archivePath,
      stream: "messages",
    });
  }
  return "resumed";
}

async function reconcileMessageSourceCache(deps: {
  archiveRuntime: ArchiveRuntimeDeps;
  baseArchivePaths: ArchivePaths;
  baseChannelIds: readonly string[];
  detailGaps: readonly DetailGapStartEntry[];
  emit: CollectContext["emit"];
  isUnscopedMessageBoundary: boolean;
  messageFamilyRequested: boolean;
  nowIso: string;
  priorObservedChannelIds: readonly string[];
  priorScopedArchiveResumedAt: Record<string, string>;
}): Promise<MessageSourceCacheReconciliation> {
  const {
    archiveRuntime,
    baseArchivePaths,
    baseChannelIds,
    detailGaps,
    emit,
    isUnscopedMessageBoundary,
    messageFamilyRequested,
    nowIso: nowIsoValue,
    priorObservedChannelIds,
    priorScopedArchiveResumedAt,
  } = deps;
  if (!(messageFamilyRequested && isUnscopedMessageBoundary)) {
    return {
      currentChannelIds: [...baseChannelIds],
      missingChannelIds: [],
      scopedArchives: [],
      reclaimedRepairArchivePaths: [],
      scopedArchiveResumedAt: priorScopedArchiveResumedAt,
    };
  }

  // Source-cache auto-reconciliation: if an unscoped run proves that a
  // previously observed channel is absent from the main workspace archive,
  // refresh an isolated scoped archive for the missing partition and include
  // that archive in this run's message pass. Existing scoped archives count as
  // part of the source cache, so the normal hourly run can heal cache topology
  // without asking the owner to reconnect credentials.
  //
  // Finite by construction, not by a wall-clock cap: `baseMissingChannelIds`
  // and `selectScopedArchivesForChannels`'s result are both computed ONCE,
  // up front, from this run's already-fixed `priorObservedChannelIds` (a
  // committed STATE array) and `baseChannelIds` (this run's own archive scan)
  // — a plain array difference, not a query that can grow mid-run. The loop
  // below iterates that fixed list exactly once per entry (no re-selection,
  // no re-scan), and the optional single repair attempt after it runs at most
  // once more. The repair-unit count is therefore known before any subprocess
  // runs, and each unit's own Slack-API-side scope is bounded by
  // `SLACK_LOOKBACK_DAYS` (passed to slackdump as `-lookback p<N>d`) — the
  // actual finite bound on backlog a single `resume` call can touch. Reported
  // as progress before/after each unit so this bound is a legible number in
  // run evidence, not just elapsed time.
  const baseMissingChannelIds = missingPreviouslyObservedChannelIds(priorObservedChannelIds, baseChannelIds);
  const scopedArchives = selectScopedArchivesForChannels(baseArchivePaths, baseMissingChannelIds);
  // Channels selectScopedArchivesForChannels could NOT cover from an existing
  // scoped archive: exactly the set that determines (before any subprocess
  // runs) whether the single repair attempt below will fire. Computed the
  // same way selectScopedArchivesForChannels computes its own `remaining`, so
  // this count is exact, not a heuristic.
  const uncoveredAfterSelection = baseMissingChannelIds.filter(
    (id) => !scopedArchives.some((archive) => archive.channelIds.includes(id))
  );
  const willAttemptRepair = uncoveredAfterSelection.length > 0;
  const repairUnitCount = scopedArchives.length + (willAttemptRepair ? 1 : 0);
  const lookbackDays = archiveRuntime.opts.LOOKBACK_DAYS;
  const lookbackWindow = `p${lookbackDays}d`;
  const dueForResumeCount = scopedArchives.filter((archive) =>
    archiveDueForResume(priorScopedArchiveResumedAt[archive.paths.archivePath], lookbackDays, nowIsoValue)
  ).length;
  archiveRuntime.progress(
    `Slack: scoped-archive-reconcile selected ${String(repairUnitCount)} repair unit(s) ` +
      `(${String(scopedArchives.length)} existing scoped archive(s), ${String(dueForResumeCount)} due for resume + ` +
      `${String(scopedArchives.length - dueForResumeCount)} throttled (not yet due) + ` +
      `${String(willAttemptRepair ? 1 : 0)} new-repair attempt(s) for ` +
      `${String(uncoveredAfterSelection.length)} uncovered channel(s)), ` +
      `each bounded to lookback=${lookbackWindow}`,
    { stream: "messages" }
  );
  let completedRepairUnits = 0;
  const scopedArchiveResumedAt = { ...priorScopedArchiveResumedAt };
  for (const archive of scopedArchives) {
    const dueForResume = archiveDueForResume(
      scopedArchiveResumedAt[archive.paths.archivePath],
      lookbackDays,
      nowIsoValue
    );
    const result = await refreshScopedArchive(archive, archiveRuntime, { dueForResume });
    const outcomeLabel = await applyScopedArchiveRefreshOutcome(result.outcome, {
      archivePath: archive.paths.archivePath,
      detailGaps,
      emit,
      nowIso: nowIsoValue,
      scopedArchiveResumedAt,
    });
    completedRepairUnits += 1;
    archiveRuntime.progress(
      `Slack: scoped-archive-reconcile completed ${String(completedRepairUnits)}/${String(repairUnitCount)} repair unit(s) ` +
        `(${outcomeLabel})`,
      { stream: "messages" }
    );
  }

  let scopedChannelIds = unionStrings(...scopedArchives.map((archive) => archive.channelIds));
  let currentChannelIds = unionStrings(baseChannelIds, scopedChannelIds);
  let missingChannelIds = missingPreviouslyObservedChannelIds(priorObservedChannelIds, currentChannelIds);
  const reclaimedRepairArchivePaths: string[] = [];

  if (missingChannelIds.length > 0) {
    const repair = await repairMissingScopedArchive(baseArchivePaths, missingChannelIds, archiveRuntime);
    // Same outcome type, same enforcement point as the existing-archive
    // refresh loop above: one invariant (only "resumed" advances the
    // timestamp; only "failed" emits a DETAIL_GAP; a later "resumed" closes
    // out any pending gap via DETAIL_GAP_RECOVERED), not two independently
    // maintained copies that could drift out of sync with each other.
    const outcomeLabel = await applyScopedArchiveRefreshOutcome(repair.outcome, {
      archivePath: repair.archivePath,
      detailGaps,
      emit,
      nowIso: nowIsoValue,
      scopedArchiveResumedAt,
    });
    completedRepairUnits += 1;
    archiveRuntime.progress(
      `Slack: scoped-archive-reconcile completed ${String(completedRepairUnits)}/${String(repairUnitCount)} repair unit(s) ` +
        `(${outcomeLabel})`,
      { stream: "messages" }
    );
    // A successful repair (outcome "resumed" — ensureArchiveOnDisk did not
    // throw) created/read durable bytes at repair.archivePath regardless of
    // whether a matching channel was recovered — that archive's __uploads/
    // must still be reclaimable. A FAILED attempt must NOT be reclaimed:
    // ensureArchiveOnDisk can leave partial files on disk before throwing,
    // and there is no durable-commit receipt for a failed attempt (task 7.1's
    // "failed-before-durable runs delete nothing" invariant — preserved here
    // by gating on the outcome, not on `archivePath` truthiness, since
    // `archivePath` is now always non-null regardless of success/failure).
    if (repair.outcome.kind === "resumed") {
      reclaimedRepairArchivePaths.push(repair.archivePath);
    }
    if (repair.selected) {
      scopedArchives.push(repair.selected);
      scopedChannelIds = unionStrings(scopedChannelIds, repair.selected.channelIds);
      currentChannelIds = unionStrings(baseChannelIds, scopedChannelIds);
      missingChannelIds = missingPreviouslyObservedChannelIds(priorObservedChannelIds, currentChannelIds);
    }
  }

  archiveRuntime.progress(
    `Slack: scoped-archive-reconcile finished: ${String(completedRepairUnits)}/${String(repairUnitCount)} repair unit(s) completed, 0 remaining`,
    { stream: "messages" }
  );

  return { currentChannelIds, missingChannelIds, scopedArchives, reclaimedRepairArchivePaths, scopedArchiveResumedAt };
}

function messageFamilyRequestedOnly(requested: CollectContext["requested"]): CollectContext["requested"] {
  return new Map(
    [...requested].filter(([stream]) => ["message_attachments", "messages", "reactions"].includes(stream))
  ) as CollectContext["requested"];
}

async function mergeScopedMessageArchivePasses(deps: {
  credentials: SlackCredentials;
  emit: CollectContext["emit"];
  messageResult: MessagesPassResult;
  scopedArchives: readonly SelectedScopedArchive[];
  state: CollectContext["state"];
  streamDeps: StreamDeps;
}): Promise<MessagesPassResult> {
  let merged = deps.messageResult;
  // Message-family only: this pass merges scoped-archive resume results for
  // messages/reactions/message_attachments. stars/user_groups/reminders/
  // dm_read_states are never in this filtered `requested` set, so
  // `deps.credentials`/`deps.emit` are threaded for type consistency but
  // unused here.
  const requested = messageFamilyRequestedOnly(deps.streamDeps.requested);
  for (const archive of deps.scopedArchives) {
    if (!existsSync(archive.paths.sqlitePath)) {
      continue;
    }
    const scopedDb = new DatabaseSync(archive.paths.sqlitePath, { readOnly: true });
    try {
      merged = mergeMessagesPassResults(
        merged,
        await runRequestedStreams(
          { ...deps.streamDeps, db: scopedDb, requested },
          deps.state,
          deps.credentials,
          deps.emit,
          {
            allowLegacyMessageCursorFallback: false,
            ignoreMessageChannelCursors: false,
          }
        )
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
    const { ts } = parsed;
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

export function buildMessageRowsQuery(thresholds: MessageCursorThresholds): { params: string[]; sql: string } {
  const channelThresholds = Object.entries(thresholds.channelLastTs)
    .filter(([channelId, ts]) => channelId.length > 0 && ts.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  const params: string[] = [];
  const thresholdCte =
    channelThresholds.length > 0
      ? `thresholds(channel_id, last_ts) AS (
      VALUES ${channelThresholds
        .map(([channelId, ts]) => {
          params.push(channelId, ts);
          return "(?, ?)";
        })
        .join(", ")}
    )`
      : "";
  // The cursor predicate is pushed INTO the `latest` dedup CTE (not applied in
  // an outer WHERE after the aggregation). The archive's MESSAGE table grows
  // unbounded and has no (CHANNEL_ID, TS) index, so a `GROUP BY CHANNEL_ID, TS`
  // over the whole table is a full scan + sort on every run — the dominant
  // cost that made steady-state runs grow with archive size while only ~200
  // rows were new. Filtering by TS before the GROUP BY restricts the
  // aggregation to rows newer than the committed cursor.
  //
  // This is emit-identical to filtering after aggregation: any (CHANNEL_ID, TS)
  // we emit has TS > threshold, so every chunk sharing that (CHANNEL_ID, TS)
  // also has TS > threshold and survives the filter — the MAX(CHUNK_ID) pick is
  // unchanged. Pairs at/below the threshold are dropped by both shapes. The
  // no-cursor first run has no predicate and keeps the full aggregation.
  const dedupJoin = channelThresholds.length > 0 ? "LEFT JOIN thresholds t ON t.channel_id = m.CHANNEL_ID" : "";
  let dedupWhere = "";
  if (channelThresholds.length > 0 && thresholds.legacyLastTs) {
    dedupWhere = "WHERE m.TS > COALESCE(t.last_ts, ?)";
    params.push(thresholds.legacyLastTs);
  } else if (channelThresholds.length > 0) {
    dedupWhere = "WHERE t.last_ts IS NULL OR m.TS > t.last_ts";
  } else if (thresholds.legacyLastTs) {
    dedupWhere = "WHERE m.TS > ?";
    params.push(thresholds.legacyLastTs);
  }

  return {
    params,
    sql: `
    WITH ${thresholdCte ? `${thresholdCte},` : ""}
    latest AS (
      SELECT m.CHANNEL_ID, m.TS, MAX(m.CHUNK_ID) AS mx
      FROM MESSAGE m
      ${dedupJoin}
      ${dedupWhere}
      GROUP BY m.CHANNEL_ID, m.TS
    )
    SELECT m.CHANNEL_ID, m.TS, m.THREAD_TS, m.IS_PARENT, m.TXT, m.NUM_FILES, m.DATA
    FROM MESSAGE m
    JOIN latest ON latest.CHANNEL_ID = m.CHANNEL_ID AND latest.TS = m.TS AND latest.mx = m.CHUNK_ID
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

/**
 * `stars`, `user_groups`, `reminders`, `dm_read_states` are not producible
 * from the slackdump archive (see `slack-api.ts` header). They collect via
 * direct Slack Web API calls using the same session credential the
 * connector already captured for slackdump.
 */
export async function runStarsStream(deps: StreamDeps, token: string, cookie: string): Promise<void> {
  const items = await fetchAllStars(token, cookie);
  for (const item of items) {
    await deps.emitRecord("stars", buildStarRecord(item));
  }
  await declareListConsidered(deps, "stars", items.length);
}

export async function runUserGroupsStream(deps: StreamDeps, token: string, cookie: string): Promise<void> {
  const groups = await fetchAllUserGroups(token, cookie);
  for (const g of groups) {
    await deps.emitRecord("user_groups", buildUserGroupRecord(g));
  }
  await declareListConsidered(deps, "user_groups", groups.length);
}

export async function runRemindersStream(deps: StreamDeps, token: string, cookie: string): Promise<void> {
  const reminders = await fetchAllReminders(token, cookie);
  for (const r of reminders) {
    await deps.emitRecord("reminders", buildReminderRecord(r));
  }
  await declareListConsidered(deps, "reminders", reminders.length);
}

/**
 * DM/MPIM channel IDs from this run's slackdump archive. Read directly
 * (not reused from `runChannelsStream`'s pass) so `dm_read_states` does not
 * depend on `channels` also being requested this run.
 */
function currentDmMpimChannelIds(db: DatabaseSync): string[] {
  const rows = safeAll<ChannelRow>(
    db,
    `
    SELECT c.ID AS id, c.DATA AS data
    FROM CHANNEL c
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM CHANNEL GROUP BY ID) m
      ON m.ID = c.ID AND m.mx = c.CHUNK_ID
  `
  );
  const ids: string[] = [];
  for (const r of rows) {
    const d = parseBlob(r.data);
    if (d.is_im || d.is_mpim) {
      ids.push(r.id);
    }
  }
  return ids.sort((a, b) => a.localeCompare(b));
}

/**
 * Scoped to `is_im`/`is_mpim` channel IDs — NOT the full channel inventory.
 * `conversations.info` is a per-channel call (Tier 3), and read-state is
 * specifically a DM/MPIM concept; sweeping every public/private channel
 * would multiply calls with no stream-relevant payoff. See design.md
 * Decision 3.
 */
export async function runDmReadStatesStream(deps: StreamDeps, token: string, cookie: string): Promise<void> {
  const dmChannelIds = currentDmMpimChannelIds(deps.db);
  const states = await fetchDmReadStates(token, cookie, dmChannelIds);
  for (const state of states) {
    await deps.emitRecord("dm_read_states", buildDmReadStateRecord(state, deps.emittedAt));
  }
  await declareListConsidered(deps, "dm_read_states", states.length);
}

interface StateEmitDeps {
  archivePath: string;
  baseArchiveResumedAt: Record<string, string>;
  channelLastTs: Record<string, string>;
  committedMaxTs: string | null;
  emit: CollectContext["emit"];
  fingerprintCursors: Map<string, FingerprintCursor>;
  observedChannelIds: readonly string[];
  requested: CollectContext["requested"];
  scopedArchiveResumedAt: Record<string, string>;
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
      base_archive_resumed_at: deps.baseArchiveResumedAt,
      scoped_archive_resumed_at: deps.scopedArchiveResumedAt,
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
    "stars",
    "user_groups",
    "reminders",
    "dm_read_states",
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
    throw new Error(`slackdump failed: ${m}`, { cause: e });
  }
  if (!existsSync(sqlitePath)) {
    throw new Error(`slackdump output not found at ${sqlitePath}`);
  }
}

/**
 * Refresh the normal workspace archive only when its own successful-resume
 * fact is due. Scoped archives deliberately do not enter this decision: they
 * have separate paths and their own reconciliation lifecycle.
 */
async function refreshBaseArchiveIfDue(
  deps: EnsureArchiveDeps & {
    isUnscopedMessageBoundary: boolean;
    lastResumedAt: string | undefined;
    nowIso: string;
  }
): Promise<boolean> {
  const baseResumeDue =
    !(deps.isUnscopedMessageBoundary && deps.useResume) ||
    archiveDueForResume(deps.lastResumedAt, deps.opts.LOOKBACK_DAYS, deps.nowIso);
  if (baseResumeDue) {
    await timedPhase(deps.progress, "slackdump-subprocess", () => ensureArchiveOnDisk(deps));
    return deps.isUnscopedMessageBoundary && deps.useResume;
  }
  deps.progress(
    `Slack: base archive at ${deps.archivePath} not due for resume yet ` +
      `(last resumed within lookback=p${String(deps.opts.LOOKBACK_DAYS)}d) — reading existing data, skipping subprocess`,
    { stream: "messages" }
  );
  return false;
}

/**
 * `stars`, `user_groups`, `reminders`, `dm_read_states` are declared
 * `required: false` in the manifest (they are supplementary streams a
 * direct Slack Web API call collects on top of the slackdump archive, not
 * part of the connector's core value). A thrown error from one of these
 * four must not propagate to `collect()`'s caller — `connector-runtime.ts`
 * has exactly one top-level catch (`run().catch(...)`), and anything that
 * reaches it fails the ENTIRE run, including the required streams that
 * already succeeded and committed earlier in this same pass. Catching here
 * and reporting a SKIP_RESULT keeps that failure stream-scoped: the run
 * still completes and the gap is visible in the Collection Report instead
 * of taking down messages/channels/files/etc. with it.
 *
 * Requiredness is a manifest-only concept — `StreamScope`/START never
 * threads a `required` bit into the connector subprocess (only
 * `reference-implementation/`'s post-run health rollup reads the
 * manifest's `required` field) — so this wrapper is intentionally
 * connector-local rather than a `connector-runtime.ts` primitive.
 */
export async function runOptionalStream(
  emit: CollectContext["emit"],
  stream: string,
  run: () => Promise<void>
): Promise<void> {
  try {
    await run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await emit({
      type: "SKIP_RESULT",
      stream,
      reason: OPTIONAL_STREAM_FAILED_REASON,
      message: `Slack: ${stream} failed and was skipped (optional stream): ${message}`,
      recovery_hint: { action: "retry_by_runtime", retryable: SLACK_API_RETRYABLE_FAILURE_RE.test(message) },
    });
  }
}

/**
 * Run every requested record stream against the open sqlite DB in emit
 * order. Returns the max message TS for the post-loop STATE checkpoint.
 */
async function runRequestedStreams(
  deps: StreamDeps,
  state: CollectContext["state"],
  credentials: SlackCredentials,
  emit: CollectContext["emit"],
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
  if (deps.requested.has("stars")) {
    deps.progress("Slack: emitting stars", { stream: "stars" });
    await runOptionalStream(emit, "stars", () => runStarsStream(deps, credentials.token, credentials.cookie));
  }
  if (deps.requested.has("user_groups")) {
    deps.progress("Slack: emitting user groups", { stream: "user_groups" });
    await runOptionalStream(emit, "user_groups", () =>
      runUserGroupsStream(deps, credentials.token, credentials.cookie)
    );
  }
  if (deps.requested.has("reminders")) {
    deps.progress("Slack: emitting reminders", { stream: "reminders" });
    await runOptionalStream(emit, "reminders", () => runRemindersStream(deps, credentials.token, credentials.cookie));
  }
  if (deps.requested.has("dm_read_states")) {
    deps.progress("Slack: emitting DM read states", { stream: "dm_read_states" });
    await runOptionalStream(emit, "dm_read_states", () =>
      runDmReadStatesStream(deps, credentials.token, credentials.cookie)
    );
  }
  return result;
}

// ─── Phase timing observability ────────────────────────────────────────

type ProgressFn = CollectContext["progress"];

// Time an awaited phase and report its duration via `progress`. This splits
// the run into measurable phases (slackdump subprocess, archive open, read+
// emit) so the "run time scales with new data, not archive size" claim is a
// number in run evidence, not an assumption — the diagnosis the archive-cost
// investigation needed. `now()` uses Date.now via an injected clock so tests
// stay deterministic.
async function timedPhase<T>(progress: ProgressFn, phase: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    progress(`Slack phase timing: ${phase} took ${Date.now() - started}ms`);
  }
}

// End-of-run archive size snapshot: the sqlite (+ sidecars) byte size and the
// `__uploads/` residue presence/size. Makes the steady-state disk bound
// observable and shows whether reclaim would free anything.
function reportArchiveSizeSnapshot(progress: ProgressFn, sqlitePath: string, archivePath: string): void {
  const sqliteBytes =
    existingFileSize(sqlitePath) + existingFileSize(`${sqlitePath}-wal`) + existingFileSize(`${sqlitePath}-shm`);
  const uploadsDir = resolveUploadsDir(archivePath);
  const uploadsBytes = existsSync(uploadsDir) ? directorySizeBytes(uploadsDir) : 0;
  progress(
    `Slack archive size: sqlite=${sqliteBytes}B uploads=${uploadsBytes}B (uploads are attachment bytes the connector does not ingest)`
  );
}

// ─── Entry ─────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/slack/index.ts`).
if (isMainModule(import.meta.url)) {
  // Set by collect() when SLACK_RECLAIM_UPLOADS=1, consumed by onDurableCommit
  // AFTER the runtime acknowledges durable ingest. Carrying it via a closure
  // keeps the reclaim commit-gated (post-ack) without threading run state
  // through the runtime protocol. Lists every archive this run actually read
  // (the base/scoped archive plus any reconciled scoped archives) so reclaim
  // is not silently confined to one path while other archives' __uploads/
  // residue survives untouched.
  let reclaimPlan: readonly string[] | null = null;

  runConnector({
    name: "slack",
    retryablePattern: SLACK_RETRYABLE_FAILURE_RE,
    timeRangeField: "sent_at",
    validateRecord,
    auth: {
      kind: "env",
      required: ["SLACK_WORKSPACE", "SLACK_TOKEN", "SLACK_COOKIE"],
    },
    // Runs only on a successful run, after durable ingest ack, before exit.
    // MUST NOT call `progress`/`emit` — the runtime has already consumed this
    // run's DONE and torn down its message loop; any further stdout JSONL
    // (including PROGRESS) fails the ALREADY-SUCCEEDED run as
    // connector_protocol_violation ("Connector emitted PROGRESS after DONE").
    // Report via the stderr-only `log` the runtime hands in instead.
    async onDurableCommit(log): Promise<void> {
      if (!reclaimPlan || reclaimPlan.length === 0) {
        return;
      }
      for (const archivePath of reclaimPlan) {
        const reclaimedBytes = await reclaimUploads(archivePath);
        log(
          `Slack reclaim: removed __uploads/ at ${archivePath} after durable commit, reclaimed ${reclaimedBytes}B ` +
            "(one-way: PDPP holds no copy; slackdump will not re-download these files)"
        );
      }
    },
    async collect(ctx: CollectContext): Promise<void> {
      const { state, requested, credentials, emit, progress } = ctx;

      const { workspace, token, cookie } = extractSlackCredentials(credentials);
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
      // State the archive root before any work: on the local-development
      // fallback this is the run log's only warning that the archive is not
      // on a deployment-managed volume.
      progress(baseArchivePaths.rootDisclosure);
      const { archivePath, sqlitePath } = resolveScopedArchivePaths(baseArchivePaths, positionalChannels);
      await mkdir(dumpDir, { recursive: true });

      const { resumeTarget, priorArchive } = pickResumeTarget(state, archivePath, {
        allowStateArchive: isUnscopedMessageBoundary,
      });
      const useResume = Boolean(resumeTarget);
      const messagesState = state.messages as MessagesState | undefined;
      const priorBaseArchiveResumedAt = normalizeStringRecord(messagesState?.base_archive_resumed_at);
      const baseArchiveResumedAt = { ...priorBaseArchiveResumedAt };
      // Upgrade compatibility: a connection whose base archive already
      // completed a real resume BEFORE this throttle shipped has no
      // `base_archive_resumed_at` entry yet. Without this, the absent entry
      // reads as "due" and the first post-upgrade run replays the entire
      // base archive once more — the exact live defect this closes. Only
      // fires when prior STATE proves a genuinely completed base-archive
      // run (never from archive presence alone, which an interrupted/failed
      // run leaves behind too) and never overrides an existing real fact.
      const migratedBaseArchiveResumedAt =
        priorBaseArchiveResumedAt[archivePath] === undefined
          ? deriveMigratedBaseArchiveResumedAt({
              archivePath,
              isUnscopedMessageBoundary,
              messagesState,
              nowIso: ctx.emittedAt,
              priorArchive,
            })
          : undefined;
      if (migratedBaseArchiveResumedAt) {
        baseArchiveResumedAt[archivePath] = migratedBaseArchiveResumedAt;
        progress(
          `Slack: base archive at ${archivePath} has no base_archive_resumed_at fact yet but prior STATE proves ` +
            "a completed resume before this throttle shipped — seeding the throttle from this run instead of " +
            "replaying the archive",
          { stream: "messages" }
        );
      }
      // Map time_range from messages stream scope into -time-from / -time-to.
      const { timeFrom, timeTo } = extractMessageTimeRange(
        messagesScope?.time_range as { from?: string | null; to?: string | null } | undefined
      );

      const baseResumeCompleted = await refreshBaseArchiveIfDue({
        archivePath,
        childEnv,
        cookie,
        isUnscopedMessageBoundary,
        lastResumedAt: migratedBaseArchiveResumedAt ?? priorBaseArchiveResumedAt[archivePath],
        nowIso: ctx.emittedAt,
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
      // This reaches durable STATE only if the entire run commits. A failed
      // resume, or a later failed run, therefore remains owed and retryable.
      if (baseResumeCompleted) {
        baseArchiveResumedAt[archivePath] = ctx.emittedAt;
      }

      const db = await timedPhase(progress, "archive-open", () =>
        Promise.resolve(new DatabaseSync(sqlitePath, { readOnly: true }))
      );
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
      const priorChannelLastTs = normalizeStringRecord(messagesState?.channel_last_ts);
      const priorObservedChannelIds = readPriorObservedChannelIds(messagesState);
      const priorScopedArchiveResumedAt = normalizeStringRecord(messagesState?.scoped_archive_resumed_at);
      const baseChannelIds = currentArchiveChannelIds(db);
      // Each missing-channel partition drives its own slackdump `resume`
      // subprocess (real Slack API backlog catch-up per channel, gated by
      // Slack's own rate limits) — cost that was previously invisible: it
      // runs between the `slackdump-subprocess` and `read-and-emit` phases
      // but was not itself timed, so it silently inflated total run wall-
      // clock outside every reported phase. Each scoped archive is further
      // throttled to at most one actual resume per SLACK_LOOKBACK_DAYS (see
      // archiveDueForResume) so a permanently-missing-but-actively-
      // growing channel's archive doesn't get a full resync every run.
      const reconciledSourceCache = await timedPhase(progress, "scoped-archive-reconcile", () =>
        reconcileMessageSourceCache({
          archiveRuntime: { childEnv, cookie, opts, progress, timeFrom, timeTo, token },
          baseArchivePaths,
          baseChannelIds,
          detailGaps: ctx.detailGaps,
          emit,
          isUnscopedMessageBoundary,
          messageFamilyRequested,
          nowIso: ctx.emittedAt,
          priorObservedChannelIds,
          priorScopedArchiveResumedAt,
        })
      );

      if (reconciledSourceCache.missingChannelIds.length > 0) {
        await emitMissingChannelDiagnostic(emit, reconciledSourceCache.missingChannelIds);
      }

      // Register the opt-in __uploads reclaim once every archive this run
      // actually read is known: the base/scoped archive, every scoped archive
      // reconcileMessageSourceCache refreshed or repaired AND folded into the
      // message pass, plus any repair attempt that successfully created/read
      // an archive but recovered no matching channel (reclaimedRepairArchivePaths
      // — deduped against scopedArchives since a successful, channel-matching
      // repair appears in both). Without the last set, a successful-but-empty
      // repair's __uploads/ residue would be silently excluded forever even
      // though this run genuinely created/read that archive. The actual
      // deletion happens in onDurableCommit (post durable-ingest ack), never
      // here — so nothing is deleted ahead of a commit receipt.
      reclaimPlan = opts.RECLAIM_UPLOADS
        ? [
            ...new Set([
              archivePath,
              ...reconciledSourceCache.scopedArchives.map((archive) => archive.paths.archivePath),
              ...reconciledSourceCache.reclaimedRepairArchivePaths,
            ]),
          ]
        : null;

      let messageResult = await timedPhase(progress, "read-and-emit", () =>
        runRequestedStreams(deps, state, { workspace, token, cookie }, emit, {
          allowLegacyMessageCursorFallback: isUnscopedMessageBoundary,
          ignoreMessageChannelCursors: Boolean(msgResFilter && msgResFilter.size > 0),
        })
      );
      if (messageFamilyRequested && isUnscopedMessageBoundary && reconciledSourceCache.scopedArchives.length > 0) {
        messageResult = await mergeScopedMessageArchivePasses({
          credentials: { workspace, token, cookie },
          emit,
          messageResult,
          scopedArchives: reconciledSourceCache.scopedArchives,
          state,
          streamDeps: deps,
        });
      }

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
        baseArchiveResumedAt,
        channelLastTs: committedChannelLastTs,
        committedMaxTs,
        emit,
        fingerprintCursors,
        observedChannelIds,
        requested,
        scopedArchiveResumedAt: reconciledSourceCache.scopedArchiveResumedAt,
      });

      // End-of-run size snapshot: makes the steady-state disk bound and any
      // reclaimable residue visible in run evidence.
      db.close();
      reportArchiveSizeSnapshot(progress, sqlitePath, archivePath);
    },
  });
}
