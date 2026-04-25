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
 * Incremental via file-modified time: if a jsonl file's mtime hasn't changed
 * since last run, we skip re-parsing it entirely.
 *
 * Honors CLAUDE_CODE_PROJECTS_DIR override; defaults to ~/.claude/projects.
 * Skills/commands live under ~/.claude (overridable via CLAUDE_CODE_HOME).
 */

import { createReadStream, type Dirent, type Stats, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createFileReader } from "node:readline";
import { type CollectContext, type RecordData, runConnector, type StreamScope } from "../../src/connector-runtime.ts";
import { isMainModule } from "../../src/is-main-module.ts";
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
import type { ClaudeCodeState, JsonlObject, SessionAccumulator } from "./types.ts";

const nowIso = (): string => new Date().toISOString();
const MD_FILE_RE = /\.md$/i;

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

/** Running observations pinned from a single JSONL file's lines. Only the
 *  first non-null value wins for metadata; timestamps widen to cover the
 *  min/max seen so the session aggregate covers the full file span. */
export interface JsonlObservations {
  cwd: string | null;
  entrypoint: string | null;
  firstTimestamp: string | null;
  gitBranch: string | null;
  lastTimestamp: string | null;
  messageCount: number;
  sessionId: string | null;
  userType: string | null;
  version: string | null;
}

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
 * Fold one JSONL object into running observations. Pure, no emit. The
 * session id sticks on first sighting unless a `forcedSessionId` is set
 * (subagent files reuse the parent session id from the directory name).
 * Other metadata fields follow the same first-wins rule; timestamps
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
  return {
    id: uuid,
    session_id: sessionId,
    parent_uuid: obj.parentUuid ?? null,
    event_type: obj.type ?? null,
    hook_name: att.hookName || null,
    tool_use_id: att.toolUseID || null,
    content_preview: textPreview(extractContent(att) || extractContent(obj), ATTACHMENT_PREVIEW_CHARS),
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

interface EmitToolResultFileArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  full: string;
  projectDir: string;
  sessionId: string;
  st: Stats;
  toolResultsDir: string;
}

async function emitToolResultFile(args: EmitToolResultFileArgs): Promise<void> {
  let buf: string;
  try {
    buf = await readFile(args.full, "utf8");
  } catch {
    return;
  }
  const rel = args.full.slice(args.toolResultsDir.length + 1);
  await args.emitRecord("attachments", {
    id: `tool_result_file:${args.projectDir}/${args.sessionId}/${rel}`,
    session_id: args.sessionId,
    parent_uuid: null,
    event_type: "tool_result_file",
    hook_name: null,
    tool_use_id: null,
    content_preview: textPreview(buf, TOOL_RESULT_PREVIEW_CHARS),
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
        message: `  ${path}: ${lineCount} lines parsed`,
      });
    }
    observeJsonlFields(obj, obs, forcedSessionId);
    await processJsonlLine({ buildOnly, deps: { emitRecord, requested }, obj, obs });
  }

  // Only update the accumulator on the build pass. On the emit pass,
  // accumulators are already populated and we must not double-count.
  if (buildOnly) {
    updateSessionAccumulator(sessionAccumulators, projectDir, obs);
  }
  return obs.sessionId;
}

// ─── Skills + slash commands ────────────────────────────────────────────

interface EmitSkillsArgs {
  claudeHome: string;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, StreamScope>;
}

async function emitSkills({ claudeHome, requested, emitRecord }: EmitSkillsArgs): Promise<void> {
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
    let raw: string;
    try {
      st = statSync(skillPath);
    } catch {
      continue;
    }
    try {
      raw = await readFile(skillPath, "utf8");
    } catch {
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
  full: string;
  name: string;
  prefix: string;
}

async function processSlashCommandFile(args: ProcessSlashCommandArgs): Promise<void> {
  if (!args.name.endsWith(".md")) {
    return;
  }
  let st: ReturnType<typeof statSync>;
  let raw: string;
  try {
    st = statSync(args.full);
  } catch {
    return;
  }
  try {
    raw = await readFile(args.full, "utf8");
  } catch {
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

async function emitSlashCommands({ claudeHome, requested, emitRecord }: EmitSkillsArgs): Promise<void> {
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
      await processSlashCommandFile({ full, name: ent.name, prefix, emitRecord });
    }
  };
  await walk(commandsDir, "");
}

// ─── Project memory notes ───────────────────────────────────────────────

interface EmitProjectMemoryNotesArgs {
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  projectDir: string;
  projectPath: string;
  requested: Map<string, StreamScope>;
}

async function emitProjectMemoryNotes({
  emitRecord,
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
    let raw: string;
    try {
      st = statSync(fullPath);
    } catch {
      continue;
    }
    try {
      raw = await readFile(fullPath, "utf8");
    } catch {
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
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
}

interface ProcessJsonlFileArgs {
  args: ScanProjectDirsArgs;
  forcedSessionId: string | null;
  path: string;
  progressLabel: string;
  projectDir: string;
}

async function processJsonlFile({
  args,
  forcedSessionId,
  path,
  progressLabel,
  projectDir,
}: ProcessJsonlFileArgs): Promise<void> {
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
    message: `${args.buildOnly ? "Indexing" : "Emitting"} ${progressLabel} (${(st.size / BYTES_PER_MB).toFixed(1)}MB)`,
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
      progressLabel: `${projectDir}/${f}`,
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

  // subagents/*.jsonl → parse as messages belonging to this session.
  const subagentsDir = join(sessionDir, "subagents");
  const subFiles = await readSubagentFiles(subagentsDir);
  for (const f of subFiles) {
    await processJsonlFile({
      args,
      forcedSessionId: sessionId,
      path: join(subagentsDir, f),
      progressLabel: `${projectDir}/${sessionId}/subagents/${f}`,
      projectDir,
    });
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
    await emitProjectMemoryNotes({ projectDir, projectPath, requested: args.requested, emitRecord: args.emitRecord });
  }
  await processTopLevelJsonl(entries, projectPath, projectDir, args);

  const sessionDirs = entries.filter((e) => e.isDirectory() && SESSION_DIR_PREFIX_RE.test(e.name));
  for (const sessEnt of sessionDirs) {
    await processSessionDir(sessEnt, projectPath, projectDir, args);
  }
}

async function listProjectDirs(baseDir: string, emit: CollectContext["emit"]): Promise<string[] | null> {
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(baseDir)).filter((name) => !name.startsWith("."));
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await emit({
      type: "SKIP_RESULT",
      stream: "sessions",
      reason: "claude_dir_not_found",
      message: `${baseDir} not readable: ${errMsg}`,
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
  await args.emit({
    type: "PROGRESS",
    message: `${projectDirs.length} project dirs in scope`,
  });
  for (const projectDir of projectDirs) {
    await scanProjectDir(projectDir, args);
  }
}

// ─── collect() wrapper ──────────────────────────────────────────────────

async function runSkillsAndCommands(
  claudeHome: string,
  requested: Map<string, StreamScope>,
  emit: CollectContext["emit"],
  emitRecord: (stream: string, data: RecordData) => Promise<void>
): Promise<void> {
  try {
    await emitSkills({ claudeHome, requested, emitRecord });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emit({ type: "PROGRESS", message: `skills scan skipped: ${msg}` });
  }
  try {
    await emitSlashCommands({ claudeHome, requested, emitRecord });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await emit({ type: "PROGRESS", message: `slash_commands scan skipped: ${msg}` });
  }
  if (requested.has("skills")) {
    await emit({ type: "STATE", stream: "skills", cursor: { fetched_at: nowIso() } });
  }
  if (requested.has("slash_commands")) {
    await emit({ type: "STATE", stream: "slash_commands", cursor: { fetched_at: nowIso() } });
  }
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
      const typedState = state as ClaudeCodeState;
      // STATE is stream-keyed per Collection Profile: `state` is
      // { <stream>: <cursor>, ... }. This connector emits STATE with
      // stream='messages', cursor={file_mtimes:{...}}, so reads must
      // qualify by that stream. Fall back to top-level for pre-fix state.
      const fileMtimes: Record<string, number> = typedState.messages?.file_mtimes || typedState.file_mtimes || {};

      await runSkillsAndCommands(claudeHome, requested, emit, emitRecord);

      // ---- sessions / messages / attachments ----
      const needsProjects =
        requested.has("sessions") ||
        requested.has("messages") ||
        requested.has("attachments") ||
        requested.has("memory_notes");
      if (!needsProjects) {
        return;
      }

      const newMtimes: Record<string, number> = { ...fileMtimes };
      const sessionAccumulators = new Map<string, SessionAccumulator>();

      // Parent-first emit (Tranche C 2026-04-23): sessions must emit
      // before messages/attachments, but sessions are aggregates built
      // from scanning all jsonl lines. Two-pass approach:
      //   Pass 1 — scan to build sessionAccumulators. `buildOnly=true`
      //            suppresses per-line message/attachment emits; the
      //            scope filter still controls whether it's worth
      //            scanning (if sessions is the only stream requested,
      //            only Pass 1 runs).
      //   Emit sessions.
      //   Pass 2 — scan again to emit messages/attachments, now that
      //            consumers have seen all parent session records.
      await scanProjectDirs({
        baseDir,
        buildOnly: true,
        emit,
        emitRecord,
        fileMtimes,
        newMtimes,
        requested,
        sessionAccumulators,
      });

      await emitSessionsFromAccumulators({ emitRecord, requested, sessionAccumulators });
      if (requested.has("sessions")) {
        await emit({
          type: "STATE",
          stream: "sessions",
          cursor: { fetched_at: nowIso() },
        });
      }

      if (requested.has("memory_notes")) {
        await emit({
          type: "STATE",
          stream: "memory_notes",
          cursor: { fetched_at: nowIso() },
        });
      }

      if (requested.has("messages") || requested.has("attachments")) {
        // Pass 2: emit messages + attachments. Accumulators already
        // built, so skip the accumulator-update side effects this time.
        await scanProjectDirs({
          baseDir,
          buildOnly: false,
          emit,
          emitRecord,
          fileMtimes,
          newMtimes,
          requested,
          sessionAccumulators,
        });
      }

      if (requested.has("messages") || requested.has("attachments")) {
        await emit({
          type: "STATE",
          stream: "messages",
          cursor: { file_mtimes: newMtimes, fetched_at: nowIso() },
        });
      }
    },
  });
}
