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
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readOptions } from "../../src/connector-options.ts";
import { type CollectContext, nowIso, type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { resourceSet } from "../../src/scope-filters.ts";
import {
  buildCanvasRecord,
  buildChannelCanvasIndex,
  buildChannelMembershipRecord,
  buildChannelRecord,
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

// Default timeout accommodates long-lived workspaces (10+ years) where a
// first-run archive of DMs + history can run 6-20h depending on file count
// and Slack rate-limit bursts. The cost of a too-high default is only "late
// failure signal" — slackdump will normally finish or error out well before
// this. Override via `SLACKDUMP_TIMEOUT_MS` env var.
export function runSlackdump(
  args: string[],
  {
    env,
    timeoutMs = Number(process.env.SLACKDUMP_TIMEOUT_MS) || 24 * 60 * 60 * 1000,
  }: { env: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<SlackdumpRunResult> {
  return new Promise((resolve, reject) => {
    const bin = resolveSlackdumpBin();
    const child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const t = setTimeout(() => {
      child.kill();
      reject(new Error("slackdump_timeout"));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`slackdump_exit_${code}: ${stderr.slice(0, 400) || stdout.slice(0, 400)}`));
      }
    });
    child.on("error", (e) => {
      clearTimeout(t);
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
  archivePath: string
): { resumeTarget: string | null; priorArchive: string | undefined } {
  // STATE is stream-keyed per Collection Profile: state is returned as
  // { <stream>: <cursor>, ... }. We write `archive_dir` into the messages
  // stream's cursor, so reads must qualify by that stream.
  const messagesState = state.messages as MessagesState | undefined;
  const legacyArchiveDir = (state as Record<string, unknown>).archive_dir as string | undefined;
  const priorArchive = messagesState?.archive_dir || legacyArchiveDir; // fallback for pre-fix state
  const discoveredArchive = existsSync(archivePath) ? archivePath : null;
  const resumeTarget = priorArchive && existsSync(priorArchive) ? priorArchive : discoveredArchive;
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
    await runSlackdump(args, { env: childEnv });
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
  await runSlackdump(args, { env: childEnv });
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
  maxMessageTs: string | null;
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
 *   - This function does not dedupe — dedup happens in `loadMessageRows`
 *     at the sqlite layer via `MAX(CHUNK_ID) GROUP BY (CHANNEL_ID, TS)`.
 *     Passing the same row twice emits twice on purpose.
 *   - `deps.emittedAt` is the pinned emit-time; `parseMessageRow` uses
 *     nowIso() only as a fallback when the row's TS is unparseable,
 *     which threads into the record's `sent_at` (distinct from
 *     `emitted_at`, which the runtime stamps on the RECORD envelope).
 */
export async function emitMessagesPass(
  deps: MessagesPassDeps,
  rows: readonly MessageRow[],
  priorTs: string | null
): Promise<MessagesPassResult> {
  if (priorTs) {
    deps.progress(`incremental: filtering messages newer than ${priorTs} (${rows.length} to process)`, {
      stream: "messages",
    });
  }

  const wantMessages = deps.requested.has("messages");
  const wantReactions = deps.requested.has("reactions");
  const wantMsgAttachments = deps.requested.has("message_attachments");

  let maxMessageTs: string | null = null;
  for (const r of rows) {
    const parsed = parseMessageRow(r, nowIso());
    const ts = parsed.ts;
    // Track the max ts seen in this run for the post-loop STATE emit.
    // Slack ts is a fixed-shape "seconds.micros" string; string compare
    // matches numeric order because both halves are zero-padded by Slack.
    if (ts && (maxMessageTs === null || ts > maxMessageTs)) {
      maxMessageTs = ts;
    }
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
  return { maxMessageTs };
}

// ─── Per-stream helpers ────────────────────────────────────────────────

/**
 * Shared deps bag for every per-stream helper. Mirrors gmail/usaa EmitDeps —
 * bundle the few things every stream needs so helper signatures stay 2 args.
 */
interface StreamDeps {
  db: DatabaseSync;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emittedAt: string;
  progress: CollectContext["progress"];
  requested: CollectContext["requested"];
}

async function runWorkspaceStream(deps: StreamDeps): Promise<void> {
  const rows = safeAll<WorkspaceRow>(
    deps.db,
    "SELECT ID, TEAM, TEAM_ID, USERNAME, USER_ID, URL, ENTERPRISE_ID, DATA FROM WORKSPACE"
  );
  for (const r of rows) {
    await deps.emitRecord("workspace", buildWorkspaceRecord(r, deps.emittedAt));
  }
}

async function runChannelsStream(deps: StreamDeps): Promise<void> {
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
  for (const r of rows) {
    await deps.emitRecord("channels", buildChannelRecord(r));
  }
}

async function runChannelMembershipsStream(deps: StreamDeps): Promise<void> {
  const rows = safeAll<ChannelUserRow>(
    deps.db,
    `
    SELECT DISTINCT CHANNEL_ID, USER_ID FROM CHANNEL_USER
  `
  );
  for (const r of rows) {
    await deps.emitRecord("channel_memberships", buildChannelMembershipRecord(r, deps.emittedAt));
  }
}

async function runUsersStream(deps: StreamDeps): Promise<void> {
  const rows = safeAll<UserRow>(
    deps.db,
    `
    SELECT u.ID AS id, u.USERNAME AS username, u.DATA AS data
    FROM S_USER u
    JOIN (SELECT ID, MAX(CHUNK_ID) AS mx FROM S_USER GROUP BY ID) m
      ON m.ID = u.ID AND m.mx = u.CHUNK_ID
  `
  );
  for (const r of rows) {
    await deps.emitRecord("users", buildUserRecord(r));
  }
}

/**
 * Load message rows from slackdump's sqlite, deduping by (CHANNEL_ID, TS)
 * on latest CHUNK_ID and optionally filtering incrementally on ts>priorTs.
 */
function loadMessageRows(db: DatabaseSync, priorTs: string | null): MessageRow[] {
  const tsParam = priorTs ? [priorTs] : [];
  const tsClause = priorTs ? "WHERE m.TS > ?" : "";
  // Slackdump can store the same (CHANNEL_ID, TS) message across multiple
  // CHUNK_IDs (e.g. from channel enumeration + subsequent thread fetch).
  // Pick the latest chunk's row per (CHANNEL_ID, TS) to avoid duplicate
  // RECORDs on the wire.
  const stmt = db.prepare(`
    SELECT m.CHANNEL_ID, m.TS, m.THREAD_TS, m.IS_PARENT, m.TXT, m.NUM_FILES, m.DATA
    FROM MESSAGE m
    JOIN (
      SELECT CHANNEL_ID, TS, MAX(CHUNK_ID) AS mx
      FROM MESSAGE
      GROUP BY CHANNEL_ID, TS
    ) latest ON latest.CHANNEL_ID = m.CHANNEL_ID AND latest.TS = m.TS AND latest.mx = m.CHUNK_ID
    ${tsClause}
  `);
  // node:sqlite stmt.all(...) returns Record<string, SQLOutputValue>[].
  // Our typed shape is a subset (we SELECT named columns); rebuild each
  // row explicitly to narrow SQLOutputValue into our column shape. Cheap:
  // 7 fields per row, and the runtime has already produced the row.
  return stmt.all(...tsParam).map((raw) => ({
    CHANNEL_ID: raw.CHANNEL_ID as string,
    TS: raw.TS as string,
    THREAD_TS: (raw.THREAD_TS as string | null) ?? null,
    IS_PARENT: (raw.IS_PARENT as number | null) ?? null,
    TXT: (raw.TXT as string | null) ?? null,
    NUM_FILES: (raw.NUM_FILES as number | null) ?? null,
    DATA: raw.DATA as Uint8Array | string | null,
  }));
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
function runMessagesUnifiedPass(deps: StreamDeps, priorTs: string | null): Promise<{ maxMessageTs: string | null }> {
  // Slack message TS strings collate lexically the same way they order
  // chronologically (fixed-width integer-dot-decimal), so string > works.
  const rows = loadMessageRows(deps.db, priorTs);
  return emitMessagesPass(deps, rows, priorTs);
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
  for (const r of rows) {
    await deps.emitRecord("files", buildFileRecord(r));
  }
}

async function runCanvasesStream(deps: StreamDeps): Promise<void> {
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
  committedMaxTs: string | null;
  emit: CollectContext["emit"];
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
 * - other mutable_state streams (channels, users, files, canvases):
 *   low cardinality, we full-sync each run; the cursor is just a freshness
 *   marker for visibility.
 */
function emitStateCheckpoints(deps: StateEmitDeps): void {
  deps.emit({
    type: "STATE",
    stream: "messages",
    cursor: {
      last_ts: deps.committedMaxTs,
      archive_dir: deps.archivePath,
      fetched_at: nowIso(),
    },
  });
  for (const stream of ["channels", "users", "files", "canvases", "workspace"]) {
    if (deps.requested.has(stream)) {
      deps.emit({
        type: "STATE",
        stream,
        cursor: { synced_at: nowIso() },
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
async function runRequestedStreams(deps: StreamDeps, state: CollectContext["state"]): Promise<string | null> {
  if (deps.requested.has("workspace")) {
    await runWorkspaceStream(deps);
  }
  if (deps.requested.has("channels")) {
    await runChannelsStream(deps);
  }
  if (deps.requested.has("channel_memberships")) {
    await runChannelMembershipsStream(deps);
  }
  if (deps.requested.has("users")) {
    await runUsersStream(deps);
  }
  // Messages, reactions, message_attachments share one pass for efficiency.
  let maxMessageTs: string | null = null;
  if (deps.requested.has("messages") || deps.requested.has("reactions") || deps.requested.has("message_attachments")) {
    const messagesState = state.messages as MessagesState | undefined;
    const priorTs = messagesState?.last_ts || null;
    const result = await runMessagesUnifiedPass(deps, priorTs);
    maxMessageTs = result.maxMessageTs;
  }
  if (deps.requested.has("files")) {
    await runFilesStream(deps);
  }
  if (deps.requested.has("canvases")) {
    await runCanvasesStream(deps);
  }
  return maxMessageTs;
}

// ─── Entry ─────────────────────────────────────────────────────────────

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/slack/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "slack",
    retryablePattern: /ECONN|timeout/i,
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

      const messagesScope = requested.get("messages");
      const { archivePath, dumpDir, sqlitePath } = resolveArchivePaths(workspace);
      await mkdir(dumpDir, { recursive: true });

      const { resumeTarget, priorArchive } = pickResumeTarget(state, archivePath);
      const useResume = Boolean(resumeTarget);

      // Map time_range from messages stream scope into -time-from / -time-to.
      const { timeFrom, timeTo } = extractMessageTimeRange(
        messagesScope?.time_range as { from?: string | null; to?: string | null } | undefined
      );

      const childEnv = buildChildEnv(token, cookie);
      const msgResFilter = resFilters.get("messages");
      const positionalChannels: string[] = [...(msgResFilter ? [...msgResFilter] : []), ...opts.CHANNEL_ALLOWLIST];

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
      const deps: StreamDeps = {
        db,
        emitRecord: ctx.emitRecord,
        emittedAt: ctx.emittedAt,
        progress,
        requested,
      };
      const maxMessageTs = await runRequestedStreams(deps, state);

      emitUnavailableStreams(requested, emit);

      const messagesState = state.messages as MessagesState | undefined;
      const priorMaxTs = messagesState?.last_ts || null;
      const committedMaxTs = selectCommittedMaxTs(priorMaxTs, maxMessageTs);
      emitStateCheckpoints({
        archivePath,
        committedMaxTs,
        emit,
        requested,
      });
    },
  });
}
