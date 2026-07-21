#!/usr/bin/env node

/**
 * PDPP Claude Code Connector (v0.2.0)
 *
 * Parses ~/.claude/projects/<encoded-project-path>/*.jsonl — Claude Code's
 * on-disk session transcripts. No auth required; runs against local files.
 *
 * Streams:
 *   sessions        — one record per session (derived from grouping jsonl lines by sessionId)
 *   messages        — user prompts + assistant responses (top-level *.jsonl + <sessionId>/subagents/*.jsonl)
 *   attachments     — hook outputs, tool uses, file snapshots, permission-mode changes,
 *                     and tool-results/*.txt blobs (event_type: "tool_result_file")
 *   memory_notes    — project-scoped memory notes under ~/.claude/projects/<project>/memory/*.md
 *   skills          — user-authored skills under ~/.claude/skills/<skill>/SKILL.md
 *   slash_commands  — user-authored slash commands under ~/.claude/commands/*.md
 *
 * Incremental via independent local-JSONL cursors. Each cursor commits an LF
 * byte boundary plus a full committed-prefix SHA-256; session aggregation and
 * child record emission stay separate so summaries can backfill without
 * re-emitting unchanged messages and attachments.
 *
 * Honors CLAUDE_CODE_PROJECTS_DIR override; defaults to ~/.claude/projects.
 * Skills/commands live under ~/.claude (overridable via CLAUDE_CODE_HOME).
 */

import { createReadStream, type Dirent, type Stats, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createFileReader } from "node:readline";
import { readBoundedFilePreview } from "../../src/bounded-file-preview.ts";
import { type CollectContext, type RecordData, runConnector, type StreamScope } from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { canonicalJson } from "../../src/local-device-envelope.ts";
import {
  isLocalJsonlPhysicalCursorV1,
  type LocalJsonlScanResult,
  scanLocalJsonl,
} from "../../src/local-jsonl-cursor.ts";
import {
  buildCoverageDiagnosticsStateSnapshot,
  buildLocalSourceInventory,
  type KnownLocalStore,
  listDirectoryInventory,
  openInventoryFingerprintCursor,
} from "../../src/local-source-inventory.ts";
import { safeTextPreview } from "../../src/safe-text-preview.ts";
import {
  ATTACHMENT_PREVIEW_CHARS,
  applyProjectDirScope,
  BYTES_PER_MB,
  buildMemoryNoteRecord,
  buildSkillRecord,
  buildSlashCommandRecord,
  extractContent,
  LINE_PROGRESS_INTERVAL,
  MESSAGE_CONTENT_PREVIEW_CHARS,
  makeEmptySessionAccumulator,
  mergeSessionObservations,
  parseCsvEnv,
  parseFrontmatter,
  SESSION_DIR_PREFIX_RE,
  TOOL_RESULT_PREVIEW_CHARS,
  textPreview,
  widenSessionTimeRange,
} from "./parsers.ts";
import { validateRecord } from "./schemas.ts";
import type {
  ClaudeChildFileCursorV1,
  ClaudeCodeState,
  ClaudeSessionFileCursorV1,
  JsonlObject,
  JsonlObservations,
  SessionAccumulator,
} from "./types.ts";

export type { JsonlObservations } from "./types.ts";

const nowIso = (): string => new Date().toISOString();
const MD_FILE_RE = /\.md$/i;

export const CLAUDE_CODE_KNOWN_LOCAL_STORES: KnownLocalStore[] = [
  {
    store: "projects",
    relativePath: "projects",
    stream: "sessions",
    classification: "collect",
    reason: "declared transcript source",
  },
  {
    store: "skills",
    relativePath: "skills",
    stream: "skills",
    classification: "collect",
    reason: "declared user-authored skills source",
  },
  {
    store: "commands",
    relativePath: "commands",
    stream: "slash_commands",
    classification: "collect",
    reason: "declared user-authored slash commands source",
  },
  {
    store: "file_history",
    relativePath: "file-history",
    stream: "file_history",
    classification: "inventory_only",
    reason: "metadata-only until payload contract is approved",
  },
  {
    store: "context_mode",
    relativePath: "context-mode",
    stream: null,
    classification: "inventory_only",
    reason: "user-specific local convention; diagnostics only, not a general Claude Code stream",
  },
  {
    store: "cache",
    relativePath: "cache",
    stream: "cache_inventory",
    classification: "inventory_only",
    reason: "raw cache payloads may contain sensitive tool output",
  },
  {
    store: "backups",
    relativePath: "backups",
    stream: "backup_inventory",
    classification: "inventory_only",
    reason: "backup payloads require owner review before collection",
  },
  {
    store: "config",
    relativePath: "settings.json",
    stream: "config_inventory",
    classification: "inventory_only",
    reason: "configuration is inventoried without payload content",
  },
  {
    store: "debug",
    relativePath: "debug",
    stream: "debug_artifacts",
    classification: "defer",
    reason: "debug payloads require deterministic redaction before collection",
  },
  {
    store: "downloads",
    relativePath: "downloads",
    stream: "downloads",
    classification: "defer",
    reason: "download payloads require owner approval before collection",
  },
  {
    store: "auth",
    relativePath: "auth.json",
    stream: null,
    classification: "exclude",
    reason: "auth-adjacent credential material is never emitted",
  },
];

async function* iterJsonlLines(path: string): AsyncGenerator<JsonlObject> {
  const r = createFileReader({
    input: createReadStream(path, { encoding: "utf8" }),
    terminal: false,
  });
  for await (const line of r) {
    if (!line.trim()) {
      continue;
    }
    try {
      yield JSON.parse(line) as JsonlObject;
    } catch {
      /* skip malformed */
    }
  }
}

// ─── Per-file parse observations ────────────────────────────────────────

/** Running observations from a single JSONL file's lines. The session id
 *  tracks the current line unless a forced id is supplied for subagent files.
 *  Metadata is first-non-null within the file; timestamps widen to cover the
 *  full observed file span. */
export function makeJsonlObservations(forcedSessionId: string | null): JsonlObservations {
  return {
    sessionId: forcedSessionId || null,
    firstTimestamp: null,
    lastTimestamp: null,
    messageCount: 0,
    cwd: null,
    gitBranch: null,
    userType: null,
    entrypoint: null,
    version: null,
  };
}

/**
 * Fold one JSONL object into running observations. Pure, no emit. Top-level
 * agent JSONL files can contain lines for more than one session, so the
 * session id intentionally follows the current line unless a `forcedSessionId`
 * is set. Other metadata fields follow first-non-null semantics; timestamps
 * widen the observed [first, last] range.
 */
export function observeJsonlFields(obj: JsonlObject, obs: JsonlObservations, forcedSessionId: string | null): void {
  if (obj.sessionId && !forcedSessionId) {
    obs.sessionId = obj.sessionId;
  }
  if (obj.cwd && !obs.cwd) {
    obs.cwd = obj.cwd;
  }
  if (obj.gitBranch && !obs.gitBranch) {
    obs.gitBranch = obj.gitBranch;
  }
  if (obj.userType && !obs.userType) {
    obs.userType = obj.userType;
  }
  if (obj.entrypoint && !obs.entrypoint) {
    obs.entrypoint = obj.entrypoint;
  }
  if (obj.version && !obs.version) {
    obs.version = obj.version;
  }
  if (obj.timestamp) {
    if (!obs.firstTimestamp || obj.timestamp < obs.firstTimestamp) {
      obs.firstTimestamp = obj.timestamp;
    }
    if (!obs.lastTimestamp || obj.timestamp > obs.lastTimestamp) {
      obs.lastTimestamp = obj.timestamp;
    }
  }
}

function updateSessionAccumulatorFromCurrentLine(
  sessionAccumulators: Map<string, SessionAccumulator>,
  projectDir: string,
  obs: JsonlObservations,
  obj: JsonlObject,
  messageCountDelta: number
): void {
  if (!obs.sessionId) {
    return;
  }
  updateSessionAccumulator(sessionAccumulators, projectDir, {
    ...obs,
    firstTimestamp: obj.timestamp ?? null,
    lastTimestamp: obj.timestamp ?? null,
    messageCount: messageCountDelta,
  });
}

// ─── Type predicates ────────────────────────────────────────────────────

export function isMessageType(type: string | undefined): boolean {
  return type === "user" || type === "assistant";
}

export function isAttachmentType(type: string | undefined): boolean {
  return (
    type === "attachment" || type === "file-history-snapshot" || type === "permission-mode" || type === "last-prompt"
  );
}

// ─── Per-line record builders (pure) ────────────────────────────────────

export function buildMessageRecord(obj: JsonlObject, sessionId: string, uuid: string): RecordData {
  return {
    id: uuid,
    session_id: sessionId,
    parent_uuid: obj.parentUuid ?? null,
    role: obj.type ?? null,
    type: obj.type ?? null,
    content: textPreview(extractContent(obj.message || obj), MESSAGE_CONTENT_PREVIEW_CHARS),
    timestamp: obj.timestamp || null,
    is_sidechain: obj.isSidechain ?? null,
    user_type: obj.userType ?? null,
    agent_id: obj.agentId ?? null,
  };
}

export function buildAttachmentRecord(obj: JsonlObject, sessionId: string, uuid: string): RecordData {
  const att = obj.attachment || {};
  const content = extractContent(att) || extractContent(obj);
  const previewResult = safeTextPreview(content, ATTACHMENT_PREVIEW_CHARS);
  return {
    id: uuid,
    session_id: sessionId,
    parent_uuid: obj.parentUuid ?? null,
    event_type: obj.type ?? null,
    hook_name: att.hookName || null,
    tool_use_id: att.toolUseID || null,
    content_preview: previewResult.preview,
    content_binary_reason: previewResult.kind === "binary" ? previewResult.reason : null,
    content_bytes: null,
    timestamp: obj.timestamp || null,
  };
}

// ─── Per-line dispatcher ────────────────────────────────────────────────

/** Injected deps threaded through every per-line emit helper. Mirrors the
 *  codex/gmail pattern: one stable bag so parseJsonlFile becomes pure
 *  orchestration and the helper is individually testable. */
export interface LineEmitDeps {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, StreamScope>;
}

export interface ProcessJsonlLineArgs {
  /**
   * When `true`, update `obs` (including `obs.messageCount`) but do not
   * emit message/attachment records. Used by the parent-first two-pass
   * orchestration: pass 1 builds session accumulators silently, pass 2
   * emits messages/attachments after sessions have landed.
   */
  buildOnly?: boolean;
  deps: LineEmitDeps;
  obj: JsonlObject;
  obs: JsonlObservations;
}

/**
 * Dispatch one JSONL line. The caller is expected to have already folded
 * the object into `obs` via `observeJsonlFields` so `obs.sessionId` is
 * pinned before this runs.
 *
 * Invariants:
 *   - No session id yet (malformed rollout order) → no emits.
 *   - message types ("user", "assistant") → bump `obs.messageCount`
 *     unconditionally, emit only if the `messages` stream is requested.
 *   - attachment types (attachment, file-history-snapshot,
 *     permission-mode, last-prompt) → emit only if the `attachments`
 *     stream is requested.
 *   - Any other type → silent no-op (metadata-only lines like the
 *     `summary` header).
 *   - No uuid → no record (uuid is the emitted record id).
 */
export async function processJsonlLine({ buildOnly, deps, obj, obs }: ProcessJsonlLineArgs): Promise<void> {
  const sessionId = obs.sessionId;
  if (!sessionId) {
    return;
  }
  const uuid = obj.uuid;
  const type = obj.type;

  if (isMessageType(type)) {
    obs.messageCount++;
    if (!buildOnly && deps.requested.has("messages") && uuid) {
      await deps.emitRecord("messages", buildMessageRecord(obj, sessionId, uuid));
    }
    return;
  }

  if (!buildOnly && isAttachmentType(type) && deps.requested.has("attachments") && uuid) {
    await deps.emitRecord("attachments", buildAttachmentRecord(obj, sessionId, uuid));
  }
}

// ─── Sessions pass (I/O-free) ───────────────────────────────────────────

export interface EmitSessionsFromAccumulatorsArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
}

/**
 * I/O-free sessions emitter: given a fully-built accumulator map, emit
 * one `sessions` record per accumulator.
 *
 * Invariants:
 *   - Gated by `requested.has("sessions")` — no emit when off.
 *   - One record per session id; accumulator-map order is preserved so
 *     downstream sees sessions in insertion order (per-JS-Map semantics).
 *   - The record is a shallow copy — mutating the accumulator after this
 *     returns must not mutate the emitted record.
 */
export async function emitSessionsFromAccumulators({
  emitRecord,
  requested,
  sessionAccumulators,
}: EmitSessionsFromAccumulatorsArgs): Promise<void> {
  if (!requested.has("sessions")) {
    return;
  }
  for (const session of sessionAccumulators.values()) {
    await emitRecord("sessions", { ...session });
  }
}

// ─── Tool-results (attachments) ─────────────────────────────────────────

interface WalkToolResultsArgs {
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  newMtimes: Record<string, number>;
  projectDir: string;
  requested: Map<string, StreamScope>;
  sessionDir: string;
  sessionId: string;
}

export interface EmitToolResultFileArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  full: string;
  projectDir: string;
  sessionId: string;
  st: Stats;
  toolResultsDir: string;
}

export async function emitToolResultFile(args: EmitToolResultFileArgs): Promise<void> {
  // Tool-result blobs are machine-generated and unbounded (a single large
  // command output can be hundreds of MB). The durable record keeps only a
  // short preview plus the byte length (already known from `st.size`), so we
  // read just a bounded head prefix instead of the whole file — keeping memory
  // flat on huge sessions. A forbidden byte past the window cannot reach the
  // preview anyway, so prefix-only screening is honest for this lossy field.
  const bounded = await readBoundedFilePreview(args.full);
  if (bounded === null) {
    return;
  }
  const rel = args.full.slice(args.toolResultsDir.length + 1);
  const previewResult = safeTextPreview(bounded.buffer, TOOL_RESULT_PREVIEW_CHARS);
  await args.emitRecord("attachments", {
    id: `tool_result_file:${args.projectDir}/${args.sessionId}/${rel}`,
    session_id: args.sessionId,
    parent_uuid: null,
    event_type: "tool_result_file",
    hook_name: null,
    tool_use_id: null,
    content_preview: previewResult.preview,
    content_binary_reason: previewResult.kind === "binary" ? previewResult.reason : null,
    content_bytes: args.st.size,
    timestamp: new Date(args.st.mtimeMs).toISOString(),
  });
}

interface ProcessToolResultArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  full: string;
  newMtimes: Record<string, number>;
  projectDir: string;
  requested: Map<string, StreamScope>;
  sessionId: string;
  toolResultsDir: string;
}

async function processToolResultEntry(ent: Dirent, args: ProcessToolResultArgs): Promise<void> {
  if (!(ent.isFile() || ent.isSymbolicLink())) {
    return;
  }
  let st: Stats;
  try {
    st = statSync(args.full);
  } catch {
    return;
  }
  const mtime = st.mtimeMs;
  if (args.fileMtimes[args.full] === mtime) {
    args.newMtimes[args.full] = mtime;
    return;
  }
  args.newMtimes[args.full] = mtime;
  if (!args.requested.has("attachments")) {
    return;
  }
  await emitToolResultFile({
    emitRecord: args.emitRecord,
    full: args.full,
    toolResultsDir: args.toolResultsDir,
    projectDir: args.projectDir,
    sessionId: args.sessionId,
    st,
  });
}

async function walkToolResults(args: WalkToolResultsArgs): Promise<void> {
  const { sessionDir, sessionId, projectDir, requested, emitRecord, fileMtimes, newMtimes } = args;
  const toolResultsDir = join(sessionDir, "tool-results");
  try {
    await readdir(toolResultsDir);
  } catch {
    return;
  }
  const walk = async (dir: string): Promise<void> => {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of items) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
        continue;
      }
      await processToolResultEntry(ent, {
        full,
        toolResultsDir,
        projectDir,
        sessionId,
        requested,
        emitRecord,
        fileMtimes,
        newMtimes,
      });
    }
  };
  await walk(toolResultsDir);
}

// ─── Recursive file walking ─────────────────────────────────────────────

async function readFilesRecursively(
  rootDir: string,
  predicate: (ent: Dirent) => boolean
): Promise<Array<{ fullPath: string; relPath: string }>> {
  const out: Array<{ fullPath: string; relPath: string }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (ent.name.startsWith(".")) {
        continue;
      }
      const relPath = prefix ? `${prefix}/${ent.name}` : ent.name;
      const fullPath = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (predicate(ent)) {
        out.push({ fullPath, relPath });
      }
    }
  };
  await walk(rootDir, "");
  return out;
}

// ─── JSONL-file parsing ─────────────────────────────────────────────────

function updateSessionAccumulator(
  sessionAccumulators: Map<string, SessionAccumulator>,
  projectDir: string,
  obs: JsonlObservations
): void {
  const sessionId = obs.sessionId;
  if (!sessionId) {
    return;
  }
  const acc = sessionAccumulators.get(sessionId) ?? makeEmptySessionAccumulator(sessionId, projectDir);
  mergeSessionObservations(acc, {
    cwd: obs.cwd,
    entrypoint: obs.entrypoint,
    gitBranch: obs.gitBranch,
    userType: obs.userType,
    version: obs.version,
  });
  widenSessionTimeRange(acc, obs.firstTimestamp, obs.lastTimestamp);
  acc.message_count += obs.messageCount;
  sessionAccumulators.set(sessionId, acc);
}

interface ParseJsonlFileArgs {
  /** When true, line-level message/attachment emits are suppressed.
   *  Used by the parent-first two-pass orchestration — pass 1 scans
   *  to populate accumulators silently; pass 2 replays the scan to
   *  emit the per-line records after sessions have landed. */
  buildOnly: boolean;
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  forcedSessionId: string | null;
  path: string;
  projectDir: string;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
}

async function parseJsonlFile(args: ParseJsonlFileArgs): Promise<string | null> {
  const { buildOnly, path, projectDir, requested, emit, emitRecord, sessionAccumulators, forcedSessionId } = args;
  const obs: JsonlObservations = makeJsonlObservations(forcedSessionId);
  let lineCount = 0;

  for await (const obj of iterJsonlLines(path)) {
    lineCount++;
    if (!buildOnly && lineCount % LINE_PROGRESS_INTERVAL === 0) {
      await emit({
        type: "PROGRESS",
        message: `Claude Code phase=emit pass=emit lines_parsed=${lineCount}`,
      });
    }
    const messageCountBeforeLine = obs.messageCount;
    observeJsonlFields(obj, obs, forcedSessionId);
    await processJsonlLine({ buildOnly, deps: { emitRecord, requested }, obj, obs });
    if (buildOnly) {
      updateSessionAccumulatorFromCurrentLine(
        sessionAccumulators,
        projectDir,
        obs,
        obj,
        obs.messageCount - messageCountBeforeLine
      );
    }
  }
  return obs.sessionId;
}

// ─── Skills + slash commands ────────────────────────────────────────────

interface EmitSkillsArgs {
  claudeHome: string;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
}

function markFileMtimeAndShouldSkip(
  fileMtimes: Record<string, number>,
  newMtimes: Record<string, number>,
  path: string,
  mtime: number
): boolean {
  newMtimes[path] = mtime;
  return fileMtimes[path] === mtime;
}

async function readBoundedUtf8(path: string): Promise<string | null> {
  const preview = await readBoundedFilePreview(path);
  return preview?.buffer.toString("utf8") ?? null;
}

async function emitSkills({ claudeHome, requested, emitRecord, fileMtimes, newMtimes }: EmitSkillsArgs): Promise<void> {
  if (!requested.has("skills")) {
    return;
  }
  const skillsDir = join(claudeHome, "skills");
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!(ent.isDirectory() || ent.isSymbolicLink())) {
      continue;
    }
    if (ent.name.startsWith(".")) {
      continue;
    }
    const skillPath = join(skillsDir, ent.name, "SKILL.md");
    let st: ReturnType<typeof statSync>;
    let raw: string | null;
    try {
      st = statSync(skillPath);
    } catch {
      continue;
    }
    if (markFileMtimeAndShouldSkip(fileMtimes, newMtimes, skillPath, st.mtimeMs)) {
      continue;
    }
    try {
      raw = await readBoundedUtf8(skillPath);
    } catch {
      continue;
    }
    if (raw === null) {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    await emitRecord(
      "skills",
      buildSkillRecord({ name: ent.name, frontmatter, body, path: skillPath, mtimeMs: st.mtimeMs })
    );
  }
}

interface ProcessSlashCommandArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  full: string;
  name: string;
  newMtimes: Record<string, number>;
  prefix: string;
}

async function processSlashCommandFile(args: ProcessSlashCommandArgs): Promise<void> {
  if (!args.name.endsWith(".md")) {
    return;
  }
  let st: ReturnType<typeof statSync>;
  let raw: string | null;
  try {
    st = statSync(args.full);
  } catch {
    return;
  }
  if (markFileMtimeAndShouldSkip(args.fileMtimes, args.newMtimes, args.full, st.mtimeMs)) {
    return;
  }
  try {
    raw = await readBoundedUtf8(args.full);
  } catch {
    return;
  }
  if (raw === null) {
    return;
  }
  const { frontmatter, body } = parseFrontmatter(raw);
  const base = basename(args.name, ".md");
  const idPath = args.prefix ? `${args.prefix}/${base}` : base;
  await args.emitRecord(
    "slash_commands",
    buildSlashCommandRecord({ idPath, base, frontmatter, body, path: args.full, mtimeMs: st.mtimeMs })
  );
}

async function emitSlashCommands({
  claudeHome,
  requested,
  emitRecord,
  fileMtimes,
  newMtimes,
}: EmitSkillsArgs): Promise<void> {
  if (!requested.has("slash_commands")) {
    return;
  }
  const commandsDir = join(claudeHome, "commands");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items: Dirent[];
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of items) {
      if (ent.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, prefix ? `${prefix}/${ent.name}` : ent.name);
        continue;
      }
      if (!(ent.isFile() || ent.isSymbolicLink())) {
        continue;
      }
      await processSlashCommandFile({ full, name: ent.name, prefix, emitRecord, fileMtimes, newMtimes });
    }
  };
  await walk(commandsDir, "");
}

// ─── Project memory notes ───────────────────────────────────────────────

interface EmitProjectMemoryNotesArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  newMtimes: Record<string, number>;
  projectDir: string;
  projectPath: string;
  requested: Map<string, StreamScope>;
}

async function emitProjectMemoryNotes({
  emitRecord,
  fileMtimes,
  newMtimes,
  projectDir,
  projectPath,
  requested,
}: EmitProjectMemoryNotesArgs): Promise<void> {
  if (!requested.has("memory_notes")) {
    return;
  }
  const memoryDir = join(projectPath, "memory");
  const files = await readFilesRecursively(
    memoryDir,
    (ent) => (ent.isFile() || ent.isSymbolicLink()) && MD_FILE_RE.test(ent.name)
  );
  for (const { fullPath, relPath } of files) {
    let st: ReturnType<typeof statSync>;
    let raw: string | null;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    if (markFileMtimeAndShouldSkip(fileMtimes, newMtimes, fullPath, st.mtimeMs)) {
      continue;
    }
    try {
      raw = await readBoundedUtf8(fullPath);
    } catch {
      continue;
    }
    if (raw === null) {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    await emitRecord(
      "memory_notes",
      buildMemoryNoteRecord({ projectDir, relPath, frontmatter, body, path: fullPath, mtimeMs: st.mtimeMs })
    );
  }
}

// ─── Projects directory scan ────────────────────────────────────────────

export interface ScanProjectDirsArgs {
  baseDir: string;
  /** Threaded through to parseJsonlFile/processJsonlLine so pass 1 is
   *  silent (accumulator-only) and pass 2 emits messages/attachments. */
  buildOnly: boolean;
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  memoryNoteMtimes?: Record<string, number>;
  newMemoryNoteMtimes?: Record<string, number>;
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
  /** Use the established memory/tool-result walkers without re-reading JSONL. */
  skipJsonl?: boolean;
}

interface ProcessJsonlFileArgs {
  args: ScanProjectDirsArgs;
  forcedSessionId: string | null;
  path: string;
  projectDir: string;
}

async function processJsonlFile({ args, forcedSessionId, path, projectDir }: ProcessJsonlFileArgs): Promise<void> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  const mtime = st.mtimeMs;
  if (args.fileMtimes[path] === mtime) {
    args.newMtimes[path] = mtime;
    return;
  }
  await args.emit({
    type: "PROGRESS",
    message: `Claude Code phase=${args.buildOnly ? "index" : "emit"} pass=${
      args.buildOnly ? "index" : "emit"
    } file_size_mb=${(st.size / BYTES_PER_MB).toFixed(1)}`,
  });
  await parseJsonlFile({
    buildOnly: args.buildOnly,
    emit: args.emit,
    emitRecord: args.emitRecord,
    forcedSessionId,
    path,
    projectDir,
    requested: args.requested,
    sessionAccumulators: args.sessionAccumulators,
  });
  args.newMtimes[path] = mtime;
}

async function processTopLevelJsonl(
  entries: Dirent[],
  projectPath: string,
  projectDir: string,
  args: ScanProjectDirsArgs
): Promise<void> {
  const topJsonl = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl")).map((e) => e.name);
  for (const f of topJsonl) {
    await processJsonlFile({
      args,
      forcedSessionId: null,
      path: join(projectPath, f),
      projectDir,
    });
  }
}

async function readSubagentFiles(subagentsDir: string): Promise<string[]> {
  const files = await readFilesRecursively(
    subagentsDir,
    (ent) => (ent.isFile() || ent.isSymbolicLink()) && ent.name.endsWith(".jsonl")
  );
  return files.map((file) => file.relPath);
}

async function processSessionDir(
  sessEnt: Dirent,
  projectPath: string,
  projectDir: string,
  args: ScanProjectDirsArgs
): Promise<void> {
  const sessionId = sessEnt.name;
  const sessionDir = join(projectPath, sessionId);

  if (!args.skipJsonl) {
    // subagents/*.jsonl → parse as messages belonging to this session.
    const subagentsDir = join(sessionDir, "subagents");
    const subFiles = await readSubagentFiles(subagentsDir);
    for (const f of subFiles) {
      await processJsonlFile({
        args,
        forcedSessionId: sessionId,
        path: join(subagentsDir, f),
        projectDir,
      });
    }
  }

  // tool-results/*.txt → attachments with event_type=tool_result_file.
  await walkToolResults({
    sessionDir,
    sessionId,
    projectDir,
    requested: args.requested,
    emit: args.emit,
    emitRecord: args.emitRecord,
    fileMtimes: args.fileMtimes,
    newMtimes: args.newMtimes,
  });
}

async function scanProjectDir(projectDir: string, args: ScanProjectDirsArgs): Promise<void> {
  const projectPath = join(args.baseDir, projectDir);
  let entries: Dirent[];
  try {
    entries = await readdir(projectPath, { withFileTypes: true });
  } catch {
    return;
  }
  if (args.buildOnly) {
    await emitProjectMemoryNotes({
      projectDir,
      projectPath,
      requested: args.requested,
      emitRecord: args.emitRecord,
      fileMtimes: args.memoryNoteMtimes ?? {},
      newMtimes: args.newMemoryNoteMtimes ?? {},
    });
  }
  if (!args.skipJsonl) {
    await processTopLevelJsonl(entries, projectPath, projectDir, args);
  }

  const sessionDirs = entries.filter((e) => e.isDirectory() && SESSION_DIR_PREFIX_RE.test(e.name));
  for (const sessEnt of sessionDirs) {
    await processSessionDir(sessEnt, projectPath, projectDir, args);
  }
}

async function listProjectDirs(baseDir: string, emit: CollectContext["emit"]): Promise<string[] | null> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(baseDir)).filter((name) => !name.startsWith("."));
  } catch {
    await emit({
      type: "SKIP_RESULT",
      stream: "sessions",
      reason: "claude_dir_not_found",
      message: "Claude Code projects directory not readable",
    });
    return null;
  }
  // Optional scoping — comma-separated substrings; a dir is included if any match.
  const include = parseCsvEnv(process.env.CLAUDE_CODE_PROJECT_INCLUDE);
  const exclude = parseCsvEnv(process.env.CLAUDE_CODE_PROJECT_EXCLUDE);
  return applyProjectDirScope(projectDirs, include, exclude);
}

export async function scanProjectDirs(args: ScanProjectDirsArgs): Promise<void> {
  const projectDirs = await listProjectDirs(args.baseDir, args.emit);
  if (projectDirs === null) {
    return;
  }
  const totalProjectDirs = projectDirs.length;
  await args.emit({
    type: "PROGRESS",
    message: `Claude Code phase=index pass=index total_project_dirs=${totalProjectDirs}`,
  });
  for (const projectDir of projectDirs) {
    await scanProjectDir(projectDir, args);
  }
}

// ─── Rich local-JSONL collection ────────────────────────────────────────

interface ClaudeJsonlSource {
  forcedSessionId: string | null;
  path: string;
  projectDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringOrNull(value: unknown): string | null | undefined {
  return value === null || typeof value === "string" ? value : undefined;
}

function readJsonlObservations(value: unknown): JsonlObservations | undefined {
  if (!isRecord(value)) {
    return;
  }
  const sessionId = readStringOrNull(value.sessionId);
  const firstTimestamp = readStringOrNull(value.firstTimestamp);
  const lastTimestamp = readStringOrNull(value.lastTimestamp);
  const cwd = readStringOrNull(value.cwd);
  const gitBranch = readStringOrNull(value.gitBranch);
  const userType = readStringOrNull(value.userType);
  const entrypoint = readStringOrNull(value.entrypoint);
  const version = readStringOrNull(value.version);
  if (
    sessionId === undefined ||
    firstTimestamp === undefined ||
    lastTimestamp === undefined ||
    cwd === undefined ||
    gitBranch === undefined ||
    userType === undefined ||
    entrypoint === undefined ||
    version === undefined ||
    typeof value.messageCount !== "number" ||
    !Number.isSafeInteger(value.messageCount) ||
    value.messageCount < 0
  ) {
    return;
  }
  return {
    cwd,
    entrypoint,
    firstTimestamp,
    gitBranch,
    lastTimestamp,
    messageCount: value.messageCount,
    sessionId,
    userType,
    version,
  };
}

function readSessionAccumulator(value: unknown): SessionAccumulator | undefined {
  if (!isRecord(value)) {
    return;
  }
  const textFields = [
    "cwd",
    "entrypoint",
    "git_branch",
    "id",
    "last_event_at",
    "project_path",
    "started_at",
    "user_type",
    "version",
  ];
  if (
    textFields.some((field) => readStringOrNull(value[field]) === undefined) ||
    typeof value.id !== "string" ||
    typeof value.project_path !== "string" ||
    typeof value.message_count !== "number" ||
    !Number.isSafeInteger(value.message_count) ||
    value.message_count < 0
  ) {
    return;
  }
  return {
    cwd: value.cwd as string | null,
    entrypoint: value.entrypoint as string | null,
    git_branch: value.git_branch as string | null,
    id: value.id,
    last_event_at: value.last_event_at as string | null,
    message_count: value.message_count,
    project_path: value.project_path,
    started_at: value.started_at as string | null,
    user_type: value.user_type as string | null,
    version: value.version as string | null,
  };
}

function readChildFileCursors(value: unknown): Record<string, ClaudeChildFileCursorV1> {
  if (!isRecord(value)) {
    return {};
  }
  const out: Record<string, ClaudeChildFileCursorV1> = {};
  for (const [path, cursor] of Object.entries(value)) {
    if (
      isRecord(cursor) &&
      isLocalJsonlPhysicalCursorV1(cursor) &&
      readStringOrNull(cursor.current_session_id) !== undefined
    ) {
      out[path] = { ...cursor, current_session_id: cursor.current_session_id as string | null };
    }
  }
  return out;
}

function readSessionFileCursors(value: unknown): {
  cursors: Record<string, ClaudeSessionFileCursorV1>;
  valid: boolean;
} {
  if (!isRecord(value)) {
    return { cursors: {}, valid: false };
  }
  const out: Record<string, ClaudeSessionFileCursorV1> = {};
  for (const [path, cursor] of Object.entries(value)) {
    const observation = isRecord(cursor) ? readJsonlObservations(cursor.observation) : undefined;
    if (!(isRecord(cursor) && isLocalJsonlPhysicalCursorV1(cursor) && observation)) {
      return { cursors: {}, valid: false };
    }
    out[path] = { ...cursor, observation };
  }
  return { cursors: out, valid: true };
}

function readSessionAggregates(value: unknown): { aggregates: Record<string, SessionAccumulator>; valid: boolean } {
  if (!isRecord(value)) {
    return { aggregates: {}, valid: false };
  }
  const out: Record<string, SessionAccumulator> = {};
  for (const [id, aggregate] of Object.entries(value)) {
    const parsed = readSessionAccumulator(aggregate);
    if (!(parsed && parsed.id === id)) {
      return { aggregates: {}, valid: false };
    }
    out[id] = parsed;
  }
  return { aggregates: out, valid: true };
}

function cloneObservations(observation: JsonlObservations, forcedSessionId: string | null): JsonlObservations {
  return { ...observation, sessionId: forcedSessionId ?? observation.sessionId };
}

function parseJsonlLine(line: Buffer): JsonlObject | null {
  const text = line.toString("utf8");
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as JsonlObject;
  } catch {
    return null;
  }
}

interface LocalJsonlTelemetry {
  appendFiles: number;
  cursorStateBytes: number;
  fastSkipFiles: number;
  prefixBytesHashed: number;
  rebuildFiles: number;
  sessionRebuildAll: number;
  tailBytesParsed: number;
  transcriptRecordsEmitted: number;
  verifiedNoopFiles: number;
}

function makeLocalJsonlTelemetry(): LocalJsonlTelemetry {
  return {
    appendFiles: 0,
    cursorStateBytes: 0,
    fastSkipFiles: 0,
    prefixBytesHashed: 0,
    rebuildFiles: 0,
    sessionRebuildAll: 0,
    tailBytesParsed: 0,
    transcriptRecordsEmitted: 0,
    verifiedNoopFiles: 0,
  };
}

function observeLocalJsonlScan(telemetry: LocalJsonlTelemetry, result: LocalJsonlScanResult): void {
  telemetry.prefixBytesHashed += result.prefix_bytes_hashed;
  telemetry.tailBytesParsed += result.tail_bytes_parsed;
  switch (result.decision.kind) {
    case "append":
      telemetry.appendFiles++;
      break;
    case "fast_skip":
      telemetry.fastSkipFiles++;
      break;
    case "rebuild":
      telemetry.rebuildFiles++;
      break;
    case "verified_noop":
      telemetry.verifiedNoopFiles++;
      break;
    default:
      break;
  }
}

async function emitLocalJsonlTelemetry(emit: CollectContext["emit"], telemetry: LocalJsonlTelemetry): Promise<void> {
  await emit({
    type: "PROGRESS",
    message:
      "Claude Code local_jsonl " +
      `fast_skip_files=${telemetry.fastSkipFiles} ` +
      `verified_noop_files=${telemetry.verifiedNoopFiles} ` +
      `append_files=${telemetry.appendFiles} ` +
      `rebuild_files=${telemetry.rebuildFiles} ` +
      `session_rebuild_all=${telemetry.sessionRebuildAll} ` +
      `prefix_bytes_hashed=${telemetry.prefixBytesHashed} ` +
      `tail_bytes_parsed=${telemetry.tailBytesParsed} ` +
      `transcript_records_emitted=${telemetry.transcriptRecordsEmitted} ` +
      `cursor_state_bytes=${telemetry.cursorStateBytes}`,
  });
}

async function discoverClaudeJsonlSources(
  baseDir: string,
  emit: CollectContext["emit"]
): Promise<ClaudeJsonlSource[] | null> {
  const projectDirs = await listProjectDirs(baseDir, emit);
  if (projectDirs === null) {
    return null;
  }
  const sources: ClaudeJsonlSource[] = [];
  for (const projectDir of projectDirs) {
    const projectPath = join(baseDir, projectDir);
    let entries: Dirent[];
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries
      .filter((item) => item.isFile() && item.name.endsWith(".jsonl"))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      sources.push({ forcedSessionId: null, path: join(projectPath, entry.name), projectDir });
    }
    for (const entry of entries
      .filter((item) => item.isDirectory() && SESSION_DIR_PREFIX_RE.test(item.name))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const subagentsDir = join(projectPath, entry.name, "subagents");
      for (const relPath of await readSubagentFiles(subagentsDir)) {
        sources.push({ forcedSessionId: entry.name, path: join(subagentsDir, relPath), projectDir });
      }
    }
  }
  return sources;
}

async function scanSessionSource(input: {
  cursor: ClaudeSessionFileCursorV1 | undefined;
  projectDir: string;
  sessionAccumulators: Map<string, SessionAccumulator>;
  source: ClaudeJsonlSource;
  telemetry: LocalJsonlTelemetry;
}): Promise<{ cursor: ClaudeSessionFileCursorV1; rebuilt: boolean; sessionIds: Set<string> }> {
  const observation = input.cursor
    ? cloneObservations(input.cursor.observation, input.source.forcedSessionId)
    : makeJsonlObservations(input.source.forcedSessionId);
  const sessionIds = new Set<string>();
  const result = await scanLocalJsonl({
    path: input.source.path,
    prior: input.cursor,
    onLine: async (line) => {
      const obj = parseJsonlLine(line);
      if (!obj) {
        return;
      }
      const before = observation.messageCount;
      observeJsonlFields(obj, observation, input.source.forcedSessionId);
      await processJsonlLine({
        buildOnly: true,
        deps: {
          emitRecord: async () => {
            // Build-only mode never calls this callback.
          },
          requested: new Map(),
        },
        obj,
        obs: observation,
      });
      updateSessionAccumulatorFromCurrentLine(
        input.sessionAccumulators,
        input.projectDir,
        observation,
        obj,
        observation.messageCount - before
      );
      if (observation.sessionId) {
        sessionIds.add(observation.sessionId);
      }
    },
  });
  observeLocalJsonlScan(input.telemetry, result);
  return {
    cursor: { ...result.cursor, observation },
    rebuilt: Boolean(input.cursor && result.decision.kind === "rebuild"),
    sessionIds,
  };
}

async function scanChildSource(input: {
  cursor: ClaudeChildFileCursorV1 | undefined;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emitRecords: boolean;
  requested: Map<string, StreamScope>;
  source: ClaudeJsonlSource;
  telemetry: LocalJsonlTelemetry;
}): Promise<ClaudeChildFileCursorV1> {
  const observation = makeJsonlObservations(input.source.forcedSessionId);
  observation.sessionId = input.cursor?.current_session_id ?? observation.sessionId;
  const result = await scanLocalJsonl({
    path: input.source.path,
    prior: input.cursor,
    onLine: async (line) => {
      const obj = parseJsonlLine(line);
      if (!obj) {
        return;
      }
      observeJsonlFields(obj, observation, input.source.forcedSessionId);
      await processJsonlLine({
        buildOnly: !input.emitRecords,
        deps: {
          emitRecord: async (stream, data) => {
            input.telemetry.transcriptRecordsEmitted++;
            await input.emitRecord(stream, data);
          },
          requested: input.requested,
        },
        obj,
        obs: observation,
      });
    },
  });
  observeLocalJsonlScan(input.telemetry, result);
  return { ...result.cursor, current_session_id: observation.sessionId };
}

async function emitChangedSessions(input: {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  next: Map<string, SessionAccumulator>;
  prior: Record<string, SessionAccumulator>;
  requested: Map<string, StreamScope>;
}): Promise<void> {
  if (!input.requested.has("sessions")) {
    return;
  }
  for (const [id, aggregate] of input.next) {
    if (!input.prior[id] || canonicalJson(input.prior[id]) !== canonicalJson(aggregate)) {
      await input.emitRecord("sessions", { ...aggregate });
    }
  }
}

async function isReadableDirectory(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function assertRequestedClaudeSources(input: {
  baseDir: string;
  claudeHome: string;
  requested: Map<string, StreamScope>;
}): Promise<void> {
  const missing: string[] = [];
  const needsProjects =
    input.requested.has("sessions") ||
    input.requested.has("messages") ||
    input.requested.has("attachments") ||
    input.requested.has("memory_notes");

  if (needsProjects && !(await isReadableDirectory(input.baseDir))) {
    missing.push(`CLAUDE_CODE_PROJECTS_DIR=${input.baseDir}`);
  }
  if (input.requested.has("skills") && !(await isReadableDirectory(join(input.claudeHome, "skills")))) {
    missing.push(`CLAUDE_CODE_HOME skills directory=${join(input.claudeHome, "skills")}`);
  }
  if (input.requested.has("slash_commands") && !(await isReadableDirectory(join(input.claudeHome, "commands")))) {
    missing.push(`CLAUDE_CODE_HOME commands directory=${join(input.claudeHome, "commands")}`);
  }
  if (missing.length > 0) {
    throw new Error(`requested Claude Code local source path(s) are missing or unreadable: ${missing.join(", ")}`);
  }
}

/**
 * Emit the per-store `coverage_diagnostics` rows from a pre-built
 * inventory. Kept separate from the inventory-record emission so the
 * durable coverage signal can be flushed BEFORE
 * {@link assertRequestedClaudeSources} runs: a missing requested content
 * source must still produce honest `missing` coverage rows rather than
 * omit the coverage stream entirely. `buildLocalSourceInventory` already
 * classifies every known store (including absent ones) without reading
 * payload, so this is safe to run even when the source home is partial or
 * empty. No-op when `coverage_diagnostics` was not requested.
 */
async function emitCoverageDiagnostics(input: {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  inventory: Awaited<ReturnType<typeof buildLocalSourceInventory>>;
  requested: Map<string, StreamScope>;
}): Promise<void> {
  if (!input.requested.has("coverage_diagnostics")) {
    return;
  }
  for (const record of input.inventory.coverage) {
    await input.emitRecord("coverage_diagnostics", record);
  }
}

async function emitCoverageDiagnosticsState(input: {
  emit: CollectContext["emit"];
  inventory: Awaited<ReturnType<typeof buildLocalSourceInventory>>;
  requested: Map<string, StreamScope>;
}): Promise<void> {
  if (input.requested.has("coverage_diagnostics")) {
    await input.emit({
      type: "STATE",
      stream: "coverage_diagnostics",
      cursor: { fetched_at: nowIso(), stores: buildCoverageDiagnosticsStateSnapshot(input.inventory.coverage) },
    });
  }
}

/** Emit one inventory stream's records under a fingerprint gate that excludes
 *  incidental `mtime_epoch`/`size_bytes`, then write a per-stream STATE cursor
 *  carrying the fingerprints forward. Inventory enumeration is a full scan, so
 *  stale ids are pruned: a store that disappears drops out and re-appears as a
 *  fresh emit. */
async function emitGatedInventoryStream(input: {
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  priorState: unknown;
  records: readonly RecordData[];
  stream: string;
}): Promise<void> {
  const cursor = openInventoryFingerprintCursor(input.priorState);
  for (const record of input.records) {
    if (cursor.shouldEmit(record)) {
      await input.emitRecord(input.stream, record);
    }
  }
  cursor.pruneStale();
  const inventoryCursor: Record<string, unknown> = { fetched_at: nowIso() };
  if (cursor.size() > 0) {
    inventoryCursor.fingerprints = cursor.toState();
  }
  await input.emit({ type: "STATE", stream: input.stream, cursor: inventoryCursor });
}

async function emitLocalInventoryStreams(input: {
  claudeHome: string;
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  inventory: Awaited<ReturnType<typeof buildLocalSourceInventory>>;
  requested: Map<string, StreamScope>;
  state: ClaudeCodeState;
}): Promise<void> {
  for (const [stream, records] of input.inventory.recordsByStream) {
    if (!input.requested.has(stream)) {
      continue;
    }
    await emitGatedInventoryStream({
      emit: input.emit,
      emitRecord: input.emitRecord,
      priorState: input.state[stream],
      records,
      stream,
    });
  }
  if (input.requested.has("file_history")) {
    const records = await listDirectoryInventory({
      tool: "claude_code",
      sourceHome: input.claudeHome,
      relativeRoot: "file-history",
      store: "file_history",
      stream: "file_history",
      reason: "metadata-only until payload contract is approved",
    });
    await emitGatedInventoryStream({
      emit: input.emit,
      emitRecord: input.emitRecord,
      priorState: input.state.file_history,
      records,
      stream: "file_history",
    });
  }
}

// ─── collect() wrapper ──────────────────────────────────────────────────

async function runSkillsAndCommands(
  claudeHome: string,
  requested: Map<string, StreamScope>,
  emit: CollectContext["emit"],
  emitRecord: (stream: string, data: RecordData) => Promise<void>,
  state: {
    skillsMtimes: Record<string, number>;
    newSkillsMtimes: Record<string, number>;
    slashCommandMtimes: Record<string, number>;
    newSlashCommandMtimes: Record<string, number>;
  }
): Promise<void> {
  try {
    await emitSkills({
      claudeHome,
      requested,
      emitRecord,
      fileMtimes: state.skillsMtimes,
      newMtimes: state.newSkillsMtimes,
    });
  } catch {
    await emit({ type: "PROGRESS", message: "Claude Code phase=index pass=index stream=skills scan_skipped=true" });
  }
  try {
    await emitSlashCommands({
      claudeHome,
      requested,
      emitRecord,
      fileMtimes: state.slashCommandMtimes,
      newMtimes: state.newSlashCommandMtimes,
    });
  } catch {
    await emit({
      type: "PROGRESS",
      message: "Claude Code phase=index pass=index stream=slash_commands scan_skipped=true",
    });
  }
  if (requested.has("skills")) {
    await emit({
      type: "STATE",
      stream: "skills",
      cursor: { file_mtimes: state.newSkillsMtimes, fetched_at: nowIso() },
    });
  }
  if (requested.has("slash_commands")) {
    await emit({
      type: "STATE",
      stream: "slash_commands",
      cursor: { file_mtimes: state.newSlashCommandMtimes, fetched_at: nowIso() },
    });
  }
}

function streamFileMtimes(
  state: ClaudeCodeState,
  stream: "memory_notes" | "messages" | "sessions" | "skills" | "slash_commands"
): Record<string, number> | undefined {
  return state[stream]?.file_mtimes;
}

/**
 * Read mtime-only transcript state from pre-v1 and mixed-version checkpoints.
 * A legacy mtime is only an eligibility hint: the scanner still reads the
 * source and returns a physical cursor before the migration can suppress its
 * records. Keeping every value for a path avoids treating one stale
 * per-stream map as authoritative when another legacy stream has the current
 * value.
 */
function readLegacyJsonlMtimes(...values: unknown[]): Map<string, Set<number>> {
  const mtimes = new Map<string, Set<number>>();
  for (const value of values) {
    if (!isRecord(value)) {
      continue;
    }
    for (const [path, mtime] of Object.entries(value)) {
      if (typeof mtime !== "number" || !Number.isFinite(mtime)) {
        continue;
      }
      const known = mtimes.get(path) ?? new Set<number>();
      known.add(mtime);
      mtimes.set(path, known);
    }
  }
  return mtimes;
}

function matchesLegacyJsonlMtime(mtimes: Map<string, Set<number>>, path: string, observedMtimeMs: number): boolean {
  return mtimes.get(path)?.has(observedMtimeMs) ?? false;
}

// Guarded so `import "./index.ts"` in tests doesn't spin up the runtime
// and block the Node event loop on stdin. Only fires when this module
// IS the process entry point (i.e. `tsx connectors/claude_code/index.ts`).
if (isMainModule(import.meta.url)) {
  runConnector({
    name: "claude_code",
    validateRecord,
    async collect({ state, requested, emit, emitRecord }) {
      const claudeHome = process.env.CLAUDE_CODE_HOME || join(homedir(), ".claude");
      const baseDir = process.env.CLAUDE_CODE_PROJECTS_DIR || join(claudeHome, "projects");
      // Build the source inventory and flush durable coverage diagnostics
      // BEFORE asserting requested content sources exist. A missing content
      // store should surface an honest `missing` coverage row, not abort the
      // run with zero coverage evidence — the connection-health rollup
      // derives a local collector's coverage axis from these records, and an
      // omitted coverage stream collapses to `coverage_unknown` forever (the
      // local run path writes no spine run). The inventory walk reads only
      // path metadata, never payload, so it is safe on a partial/empty home.
      const inventory = await buildLocalSourceInventory("claude_code", claudeHome, CLAUDE_CODE_KNOWN_LOCAL_STORES);
      await emitCoverageDiagnostics({ emitRecord, inventory, requested });
      await assertRequestedClaudeSources({ baseDir, claudeHome, requested });
      const typedState = state as ClaudeCodeState;
      // STATE is stream-keyed per Collection Profile. JSONL child emits and
      // session aggregation use separate cursors so sessions can backfill
      // without re-emitting unchanged child records. Fall back to top-level
      // for pre-stream-keyed message state.
      const messageFileMtimes: Record<string, number> =
        streamFileMtimes(typedState, "messages") ?? typedState.file_mtimes ?? {};
      const sessionFileMtimes = streamFileMtimes(typedState, "sessions") ?? {};
      const skillsMtimes = streamFileMtimes(typedState, "skills") ?? {};
      const slashCommandMtimes = streamFileMtimes(typedState, "slash_commands") ?? {};
      const memoryNoteMtimes = streamFileMtimes(typedState, "memory_notes") ?? {};
      const newSkillsMtimes: Record<string, number> = { ...skillsMtimes };
      const newSlashCommandMtimes: Record<string, number> = { ...slashCommandMtimes };
      const newMemoryNoteMtimes: Record<string, number> = { ...memoryNoteMtimes };

      await emitLocalInventoryStreams({ claudeHome, emit, emitRecord, inventory, requested, state: typedState });

      await runSkillsAndCommands(claudeHome, requested, emit, emitRecord, {
        skillsMtimes,
        newSkillsMtimes,
        slashCommandMtimes,
        newSlashCommandMtimes,
      });

      // The parent-first state machine intentionally keeps the temporal
      // ordering visible here: session records/state, non-JSONL attachments,
      // child records/state, then coverage state. Extracting those transitions
      // would hide the checkpoint barrier behind a shallow orchestration API.
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordering is the contract.
      const collectProjectStreams = async (): Promise<void> => {
        // ---- sessions / messages / attachments ----
        const needsProjects =
          requested.has("sessions") ||
          requested.has("messages") ||
          requested.has("attachments") ||
          requested.has("memory_notes");
        if (!needsProjects) {
          await emitCoverageDiagnosticsState({ emit, inventory, requested });
          return;
        }

        const messageRaw = typedState.messages;
        const sessionsRaw = typedState.sessions;
        const messageUsesLegacyJsonlMtimes = messageRaw?.local_jsonl_cursor_version !== 1;
        const sessionsUsesLegacyJsonlMtimes = sessionsRaw?.local_jsonl_cursor_version !== 1;
        const legacyJsonlMtimes = readLegacyJsonlMtimes(
          typedState.file_mtimes,
          messageUsesLegacyJsonlMtimes ? messageRaw?.file_mtimes : undefined,
          sessionsUsesLegacyJsonlMtimes ? sessionsRaw?.file_mtimes : undefined
        );
        const priorChildCursors =
          messageRaw?.local_jsonl_cursor_version === 1 ? readChildFileCursors(messageRaw.file_cursors) : {};
        const decodedSessionCursors =
          sessionsRaw?.local_jsonl_cursor_version === 1
            ? readSessionFileCursors(sessionsRaw.file_cursors)
            : { cursors: {}, valid: false };
        const decodedSessionAggregates =
          sessionsRaw?.local_jsonl_cursor_version === 1
            ? readSessionAggregates(sessionsRaw.session_aggregates)
            : { aggregates: {}, valid: false };
        const priorSessionCursors = decodedSessionCursors.cursors;
        const priorSessionAggregates = decodedSessionAggregates.aggregates;
        const sessionSnapshotIsValid =
          sessionsRaw?.local_jsonl_cursor_version === 1 &&
          decodedSessionCursors.valid &&
          decodedSessionAggregates.valid;
        const sources = await discoverClaudeJsonlSources(baseDir, emit);
        if (sources === null) {
          return;
        }
        const sourcePaths = new Set(sources.map((source) => source.path));
        const telemetry = makeLocalJsonlTelemetry();
        // Rich cursor state is authoritative. Rebuild these compatibility maps
        // only from files discovered in this pass so removed/rotated paths do
        // not become a retained per-file ledger.
        const newMessageFileMtimes: Record<string, number> = {};
        const newSessionFileMtimes: Record<string, number> = {};
        let nextSessionCursors: Record<string, ClaudeSessionFileCursorV1> = {};
        const nextChildCursors: Record<string, ClaudeChildFileCursorV1> = {};
        let stagedSessionCursor:
          | {
              file_cursors: Record<string, ClaudeSessionFileCursorV1>;
              file_mtimes: Record<string, number>;
              fetched_at: string;
              local_jsonl_cursor_version: 1;
              session_aggregates: Record<string, SessionAccumulator>;
            }
          | undefined;

        if (requested.has("sessions")) {
          const missingRichCursorForKnownFile = sources.some(
            (source) => sessionFileMtimes[source.path] !== undefined && !priorSessionCursors[source.path]
          );
          let rebuildAll =
            !sessionSnapshotIsValid ||
            missingRichCursorForKnownFile ||
            Object.keys(priorSessionCursors).some((path) => !sourcePaths.has(path));
          let sessionAccumulators = new Map<string, SessionAccumulator>(
            Object.entries(rebuildAll ? {} : priorSessionAggregates).map(([id, aggregate]) => [id, { ...aggregate }])
          );
          const changedLegacySessionIds = new Set<string>();
          for (const source of sources) {
            const scanned = await scanSessionSource({
              cursor: rebuildAll ? undefined : priorSessionCursors[source.path],
              projectDir: source.projectDir,
              sessionAccumulators,
              source,
              telemetry,
            });
            nextSessionCursors[source.path] = scanned.cursor;
            newSessionFileMtimes[source.path] = scanned.cursor.observed_mtime_ms;
            rebuildAll ||= scanned.rebuilt;
            if (
              sessionsUsesLegacyJsonlMtimes &&
              !matchesLegacyJsonlMtime(legacyJsonlMtimes, source.path, scanned.cursor.observed_mtime_ms)
            ) {
              for (const sessionId of scanned.sessionIds) {
                changedLegacySessionIds.add(sessionId);
              }
            }
          }
          if (rebuildAll && sessionSnapshotIsValid) {
            sessionAccumulators = new Map();
            nextSessionCursors = {};
            for (const source of sources) {
              const scanned = await scanSessionSource({
                cursor: undefined,
                projectDir: source.projectDir,
                sessionAccumulators,
                source,
                telemetry,
              });
              nextSessionCursors[source.path] = scanned.cursor;
              newSessionFileMtimes[source.path] = scanned.cursor.observed_mtime_ms;
            }
          }
          if (rebuildAll) {
            telemetry.sessionRebuildAll++;
          }
          await emitChangedSessions({
            emitRecord,
            next: sessionAccumulators,
            // A legacy checkpoint has no aggregate snapshot. Treat only the
            // session ids contributed by an mtime-mismatched/new source as
            // changed; matching sources were fully scanned to establish their
            // cursors and aggregate contribution, not replayed from an
            // all-or-nothing migration switch.
            prior: sessionsUsesLegacyJsonlMtimes
              ? Object.fromEntries(
                  [...sessionAccumulators].filter(([sessionId]) => !changedLegacySessionIds.has(sessionId))
                )
              : priorSessionAggregates,
            requested,
          });
          const sessionAggregates = Object.fromEntries(sessionAccumulators);
          stagedSessionCursor = {
            file_cursors: nextSessionCursors,
            file_mtimes: newSessionFileMtimes,
            fetched_at: nowIso(),
            local_jsonl_cursor_version: 1 as const,
            session_aggregates: sessionAggregates,
          };
        }

        // Existing non-JSONL discovery remains responsible for memory notes and
        // tool-result attachments. Fresh JSONL mtimes make its old JSONL path a
        // no-op while retaining its established blob privacy policy.
        const scanLegacyNonJsonl = async (): Promise<void> => {
          // Read the acknowledged dual-write map, but write only current
          // discovery into the fresh map so deleted non-JSONL paths prune.
          const nonJsonlMtimeGate = requested.has("sessions") ? sessionFileMtimes : messageFileMtimes;
          await scanProjectDirs({
            baseDir,
            buildOnly: requested.has("memory_notes"),
            emit,
            emitRecord,
            fileMtimes: nonJsonlMtimeGate,
            newMtimes: requested.has("sessions") ? newSessionFileMtimes : newMessageFileMtimes,
            memoryNoteMtimes,
            newMemoryNoteMtimes,
            requested,
            sessionAccumulators: new Map(),
            skipJsonl: true,
          });
        };
        if (requested.has("sessions")) {
          await scanLegacyNonJsonl();
          // The attachment walker owns current non-JSONL discovery. Preserve
          // its mtime gate in both downgrade maps when both streams are in
          // scope, while retaining JSONL ownership in the rich cursors.
          if (requested.has("messages") || requested.has("attachments")) {
            for (const [path, mtime] of Object.entries(newSessionFileMtimes)) {
              if (!sourcePaths.has(path)) {
                newMessageFileMtimes[path] = mtime;
              }
            }
          }
          if (stagedSessionCursor) {
            telemetry.cursorStateBytes += Buffer.byteLength(JSON.stringify(stagedSessionCursor), "utf8");
            await emit({
              type: "STATE",
              stream: "sessions",
              cursor: stagedSessionCursor,
            });
          }
        }

        if (requested.has("messages") || requested.has("attachments")) {
          for (const source of sources) {
            const candidateLegacyBaseline = messageUsesLegacyJsonlMtimes && legacyJsonlMtimes.has(source.path);
            let cursor = await scanChildSource({
              cursor: priorChildCursors[source.path],
              emitRecord,
              emitRecords: !candidateLegacyBaseline,
              requested,
              source,
              telemetry,
            });
            // The scan, not a pre-scan stat, decides whether the old mtime
            // actually describes the bytes that were cursorized. A change in
            // the small interval before the open snapshot is replayed from
            // zero rather than being silently baselined.
            if (
              candidateLegacyBaseline &&
              !matchesLegacyJsonlMtime(legacyJsonlMtimes, source.path, cursor.observed_mtime_ms)
            ) {
              cursor = await scanChildSource({
                cursor: undefined,
                emitRecord,
                emitRecords: true,
                requested,
                source,
                telemetry,
              });
            }
            nextChildCursors[source.path] = cursor;
            newMessageFileMtimes[source.path] = cursor.observed_mtime_ms;
          }
        }

        if (!requested.has("sessions")) {
          await scanLegacyNonJsonl();
        }
        if (requested.has("memory_notes")) {
          await emit({
            type: "STATE",
            stream: "memory_notes",
            cursor: { file_mtimes: newMemoryNoteMtimes, fetched_at: nowIso() },
          });
        }
        // Coverage STATE is emitted only after every requested collection pass
        // has completed successfully; a later failure cannot commit this proof.
        await emitCoverageDiagnosticsState({ emit, inventory, requested });

        if (requested.has("messages") || requested.has("attachments")) {
          const cursor = {
            file_cursors: nextChildCursors,
            file_mtimes: newMessageFileMtimes,
            fetched_at: nowIso(),
            local_jsonl_cursor_version: 1 as const,
          };
          telemetry.cursorStateBytes += Buffer.byteLength(JSON.stringify(cursor), "utf8");
          await emit({
            type: "STATE",
            stream: "messages",
            cursor,
          });
        }
        await emitLocalJsonlTelemetry(emit, telemetry);
      };
      await collectProjectStreams();
    },
  });
}
