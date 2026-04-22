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
 *   skills          — user-authored skills under ~/.claude/skills/<skill>/SKILL.md
 *   slash_commands  — user-authored slash commands under ~/.claude/commands/*.md
 *
 * Incremental via file-modified time: if a jsonl file's mtime hasn't changed
 * since last run, we skip re-parsing it entirely.
 *
 * Honors CLAUDE_CODE_PROJECTS_DIR override; defaults to ~/.claude/projects.
 * Skills/commands live under ~/.claude (overridable via CLAUDE_CODE_HOME).
 */

import { createReadStream, statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createFileReader } from "node:readline";
import {
  type CollectContext,
  type RecordData,
  runConnector,
  type StreamScope,
} from "../../src/connector-runtime.ts";

interface JsonlObject {
  agentId?: string | null;
  attachment?: {
    hookName?: string | null;
    toolUseID?: string | null;
    content?: unknown;
    toolUseResult?: unknown;
  };
  cwd?: string;
  entrypoint?: string;
  gitBranch?: string;
  isSidechain?: boolean | null;
  message?: unknown;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  type?: string;
  userType?: string;
  uuid?: string;
  version?: string;
}

interface ContentPart {
  name?: string;
  text?: string;
  type?: string;
}

interface SessionAccumulator {
  cwd: string | null;
  entrypoint: string | null;
  git_branch: string | null;
  id: string;
  last_event_at: string | null;
  message_count: number;
  project_path: string;
  started_at: string | null;
  user_type: string | null;
  version: string | null;
}

interface ClaudeCodeState {
  file_mtimes?: Record<string, number>;
  messages?: { file_mtimes?: Record<string, number> };
}

// Text-preview caps chosen to keep records well under JSON-line soft limits
// while still preserving most useful content.
const SHORT_PREVIEW_CHARS = 300;
const ATTACHMENT_PREVIEW_CHARS = 500;
const TOOL_RESULT_PREVIEW_CHARS = 500;
const MESSAGE_CONTENT_PREVIEW_CHARS = 5000;
const SKILL_BODY_MAX_CHARS = 20_000;
// Emit a PROGRESS every N lines to surface per-file progress on large transcripts.
const LINE_PROGRESS_INTERVAL = 2000;
// Bytes per MB for size formatting.
const BYTES_PER_MB = 1024 * 1024;
// Session dir names encode UUIDs; a plain regex matches the first two groups
// to avoid confusing projects dir contents with per-session subdirs.
const SESSION_DIR_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
// Module-level regexes (Biome useTopLevelRegex).
const CLAUDE_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const CLAUDE_FM_LINE_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const CLAUDE_FM_COMMENT_RE = /^\s*#/;
const CLAUDE_FM_INDENT_RE = /^\s+\S/;
const CLAUDE_FM_LEADING_WS_RE = /^\s+/;
const CLAUDE_FM_QUOTED_DOUBLE_RE = /^"([\s\S]*)"$/;
const CLAUDE_FM_QUOTED_SINGLE_RE = /^'([\s\S]*)'$/;
const CLAUDE_FM_COLLAPSE_WS_RE = /\s+/g;

const nowIso = (): string => new Date().toISOString();

function textPreview(s: unknown, max = SHORT_PREVIEW_CHARS): string | null {
  if (typeof s !== "string") {
    return null;
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function extractContent(obj: unknown): string | null {
  // User/assistant message content may be a string or an array of parts.
  // Attachments have nested `attachment.content` or `attachment.toolUseResult`.
  if (!obj) {
    return null;
  }
  if (typeof obj === "string") {
    return obj;
  }
  if (Array.isArray(obj)) {
    const parts = obj
      .map((p) => {
        if (typeof p === "string") {
          return p;
        }
        const part = p as ContentPart | null;
        if (part?.type === "text" && part.text) {
          return part.text;
        }
        if (part?.type === "tool_use") {
          return `[tool_use: ${part.name || "unknown"}]`;
        }
        if (part?.type === "tool_result") {
          return "[tool_result]";
        }
        return "";
      })
      .filter(Boolean);
    return parts.join("\n") || null;
  }
  if (typeof obj === "object") {
    const o = obj as { content?: unknown; text?: unknown };
    if (o.content) {
      return extractContent(o.content);
    }
    if (typeof o.text === "string") {
      return o.text;
    }
  }
  return null;
}

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

/**
 * Minimal YAML-ish frontmatter parser — no external deps.
 * Supports flat `key: value` pairs and folded multi-line values introduced
 * with `>` or `|`. Returns { frontmatter, body }.
 */
function parseFrontmatter(text: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (typeof text !== "string") {
    return { frontmatter: {}, body: text || "" };
  }
  const m = CLAUDE_FRONTMATTER_RE.exec(text);
  if (!m) {
    return { frontmatter: {}, body: text };
  }
  const rawFm = m[1] ?? "";
  const body = m[2] ?? "";
  const frontmatter: Record<string, string> = {};
  const lines = rawFm.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.trim() || CLAUDE_FM_COMMENT_RE.test(line)) {
      i++;
      continue;
    }
    const kv = CLAUDE_FM_LINE_RE.exec(line);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1] ?? "";
    let value = kv[2] ?? "";
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      // Folded/literal block scalar — collect indented continuation lines.
      const folded = value.startsWith(">");
      const collected: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? "";
        if (CLAUDE_FM_INDENT_RE.test(next) || next === "") {
          collected.push(next.replace(CLAUDE_FM_LEADING_WS_RE, ""));
          i++;
        } else {
          break;
        }
      }
      value = folded
        ? collected.join(" ").replace(CLAUDE_FM_COLLAPSE_WS_RE, " ").trim()
        : collected.join("\n").trim();
    } else {
      value = value
        .replace(CLAUDE_FM_QUOTED_DOUBLE_RE, "$1")
        .replace(CLAUDE_FM_QUOTED_SINGLE_RE, "$1")
        .trim();
      i++;
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

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

async function walkToolResults({
  sessionDir,
  sessionId,
  projectDir,
  requested,
  emitRecord,
  fileMtimes,
  newMtimes,
}: WalkToolResultsArgs): Promise<void> {
  const toolResultsDir = join(sessionDir, "tool-results");
  try {
    await readdir(toolResultsDir);
  } catch {
    return;
  }
  const walk = async (dir: string): Promise<void> => {
    let items;
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
      if (!(ent.isFile() || ent.isSymbolicLink())) {
        continue;
      }
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const mtime = st.mtimeMs;
      if (fileMtimes[full] === mtime) {
        newMtimes[full] = mtime;
        continue;
      }
      newMtimes[full] = mtime;
      if (!requested.has("attachments")) {
        continue;
      }
      let buf: string;
      try {
        buf = await readFile(full, "utf8");
      } catch {
        continue;
      }
      const rel = full.slice(toolResultsDir.length + 1);
      await emitRecord("attachments", {
        id: `tool_result_file:${projectDir}/${sessionId}/${rel}`,
        session_id: sessionId,
        parent_uuid: null,
        event_type: "tool_result_file",
        hook_name: null,
        tool_use_id: null,
        content_preview: textPreview(buf, TOOL_RESULT_PREVIEW_CHARS),
        content_bytes: st.size,
        timestamp: new Date(st.mtimeMs).toISOString(),
      });
    }
  };
  await walk(toolResultsDir);
}

interface ParseJsonlFileArgs {
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  forcedSessionId: string | null;
  path: string;
  projectDir: string;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
}

async function parseJsonlFile({
  path,
  projectDir,
  requested,
  emit,
  emitRecord,
  sessionAccumulators,
  forcedSessionId,
}: ParseJsonlFileArgs): Promise<string | null> {
  let sessionId: string | null = forcedSessionId || null;
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;
  let messageCount = 0;
  let lineCount = 0;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let userType: string | null = null;
  let entrypoint: string | null = null;
  let version: string | null = null;

  for await (const obj of iterJsonlLines(path)) {
    lineCount++;
    if (lineCount % LINE_PROGRESS_INTERVAL === 0) {
      await emit({
        type: "PROGRESS",
        message: `  ${path}: ${lineCount} lines parsed`,
      });
    }
    if (obj.sessionId && !forcedSessionId) {
      sessionId = obj.sessionId;
    }
    if (obj.cwd && !cwd) {
      cwd = obj.cwd;
    }
    if (obj.gitBranch && !gitBranch) {
      gitBranch = obj.gitBranch;
    }
    if (obj.userType && !userType) {
      userType = obj.userType;
    }
    if (obj.entrypoint && !entrypoint) {
      entrypoint = obj.entrypoint;
    }
    if (obj.version && !version) {
      version = obj.version;
    }
    if (obj.timestamp) {
      if (!firstTimestamp || obj.timestamp < firstTimestamp) {
        firstTimestamp = obj.timestamp;
      }
      if (!lastTimestamp || obj.timestamp > lastTimestamp) {
        lastTimestamp = obj.timestamp;
      }
    }

    const type = obj.type;
    const uuid = obj.uuid;
    const parentUuid = obj.parentUuid ?? null;
    if (!sessionId) {
      continue;
    }

    if (type === "user" || type === "assistant") {
      messageCount++;
      if (requested.has("messages") && uuid) {
        await emitRecord("messages", {
          id: uuid,
          session_id: sessionId,
          parent_uuid: parentUuid,
          role: type,
          type,
          content: textPreview(
            extractContent(obj.message || obj),
            MESSAGE_CONTENT_PREVIEW_CHARS
          ),
          timestamp: obj.timestamp || null,
          is_sidechain: obj.isSidechain ?? null,
          user_type: obj.userType ?? null,
          agent_id: obj.agentId ?? null,
        });
      }
    } else if (
      (type === "attachment" ||
        type === "file-history-snapshot" ||
        type === "permission-mode" ||
        type === "last-prompt") &&
      requested.has("attachments") &&
      uuid
    ) {
      const att = obj.attachment || {};
      await emitRecord("attachments", {
        id: uuid,
        session_id: sessionId,
        parent_uuid: parentUuid,
        event_type: type,
        hook_name: att.hookName || null,
        tool_use_id: att.toolUseID || null,
        content_preview: textPreview(
          extractContent(att) || extractContent(obj),
          ATTACHMENT_PREVIEW_CHARS
        ),
        content_bytes: null,
        timestamp: obj.timestamp || null,
      });
    }
  }

  if (sessionId) {
    const acc: SessionAccumulator = sessionAccumulators.get(sessionId) || {
      id: sessionId,
      project_path: projectDir,
      cwd: null,
      git_branch: null,
      version: null,
      started_at: null,
      last_event_at: null,
      message_count: 0,
      user_type: null,
      entrypoint: null,
    };
    if (cwd) {
      acc.cwd = cwd;
    }
    if (gitBranch) {
      acc.git_branch = gitBranch;
    }
    if (version) {
      acc.version = version;
    }
    if (userType) {
      acc.user_type = userType;
    }
    if (entrypoint) {
      acc.entrypoint = entrypoint;
    }
    if (
      firstTimestamp &&
      (!acc.started_at || firstTimestamp < acc.started_at)
    ) {
      acc.started_at = firstTimestamp;
    }
    if (
      lastTimestamp &&
      (!acc.last_event_at || lastTimestamp > acc.last_event_at)
    ) {
      acc.last_event_at = lastTimestamp;
    }
    acc.message_count += messageCount;
    sessionAccumulators.set(sessionId, acc);
  }
  return sessionId;
}

interface EmitSkillsArgs {
  claudeHome: string;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, StreamScope>;
}

async function emitSkills({
  claudeHome,
  requested,
  emitRecord,
}: EmitSkillsArgs): Promise<void> {
  if (!requested.has("skills")) {
    return;
  }
  const skillsDir = join(claudeHome, "skills");
  let entries;
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
    await emitRecord("skills", {
      id: `skills:${ent.name}`,
      name: frontmatter.name || ent.name,
      description: frontmatter.description || null,
      source: "user",
      path: skillPath,
      content:
        body.length > SKILL_BODY_MAX_CHARS
          ? body.slice(0, SKILL_BODY_MAX_CHARS)
          : body,
      frontmatter,
      mtime_epoch: Math.floor(st.mtimeMs / 1000),
    });
  }
}

async function emitSlashCommands({
  claudeHome,
  requested,
  emitRecord,
}: EmitSkillsArgs): Promise<void> {
  if (!requested.has("slash_commands")) {
    return;
  }
  const commandsDir = join(claudeHome, "commands");
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let items;
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
      if (!ent.name.endsWith(".md")) {
        continue;
      }
      let st: ReturnType<typeof statSync>;
      let raw: string;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      try {
        raw = await readFile(full, "utf8");
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(raw);
      const base = basename(ent.name, ".md");
      const idPath = prefix ? `${prefix}/${base}` : base;
      await emitRecord("slash_commands", {
        id: `commands:${idPath}`,
        name: frontmatter.name || base,
        description: frontmatter.description || null,
        path: full,
        content:
          body.length > SKILL_BODY_MAX_CHARS
            ? body.slice(0, SKILL_BODY_MAX_CHARS)
            : body,
        frontmatter,
        mtime_epoch: Math.floor(st.mtimeMs / 1000),
      });
    }
  };
  await walk(commandsDir, "");
}

async function scanProjectDirs(args: {
  baseDir: string;
  emit: CollectContext["emit"];
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fileMtimes: Record<string, number>;
  newMtimes: Record<string, number>;
  requested: Map<string, StreamScope>;
  sessionAccumulators: Map<string, SessionAccumulator>;
}): Promise<void> {
  const {
    baseDir,
    emit,
    emitRecord,
    fileMtimes,
    newMtimes,
    requested,
    sessionAccumulators,
  } = args;
  let projectDirs: string[];
  try {
    projectDirs = (await readdir(baseDir)).filter(
      (name) => !name.startsWith(".")
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await emit({
      type: "SKIP_RESULT",
      stream: "sessions",
      reason: "claude_dir_not_found",
      message: `${baseDir} not readable: ${errMsg}`,
    });
    return;
  }

  // Optional scoping — comma-separated substrings; a dir is included if any match.
  const include = (process.env.CLAUDE_CODE_PROJECT_INCLUDE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const exclude = (process.env.CLAUDE_CODE_PROJECT_EXCLUDE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (include.length) {
    projectDirs = projectDirs.filter((d) => include.some((s) => d.includes(s)));
  }
  if (exclude.length) {
    projectDirs = projectDirs.filter(
      (d) => !exclude.some((s) => d.includes(s))
    );
  }
  await emit({
    type: "PROGRESS",
    message: `${projectDirs.length} project dirs in scope`,
  });

  for (const projectDir of projectDirs) {
    const projectPath = join(baseDir, projectDir);
    let entries;
    try {
      entries = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }

    // Top-level *.jsonl (filename === sessionId).
    const topJsonl = entries
      .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
    for (const f of topJsonl) {
      const p = join(projectPath, f);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      const mtime = st.mtimeMs;
      if (fileMtimes[p] === mtime) {
        newMtimes[p] = mtime;
        continue;
      }
      await emit({
        type: "PROGRESS",
        message: `Parsing ${projectDir}/${f} (${(st.size / BYTES_PER_MB).toFixed(1)}MB)`,
      });
      await parseJsonlFile({
        path: p,
        projectDir,
        requested,
        emit,
        emitRecord,
        sessionAccumulators,
        forcedSessionId: null,
      });
      newMtimes[p] = mtime;
    }

    // Per-session subdirs: <sessionId>/subagents/*.jsonl and <sessionId>/tool-results/*.txt.
    const sessionDirs = entries.filter(
      (e) => e.isDirectory() && SESSION_DIR_PREFIX_RE.test(e.name)
    );
    for (const sessEnt of sessionDirs) {
      const sessionId = sessEnt.name;
      const sessionDir = join(projectPath, sessionId);

      // subagents/*.jsonl → parse as messages belonging to this session.
      const subagentsDir = join(sessionDir, "subagents");
      let subFiles: string[] = [];
      try {
        const sEntries = await readdir(subagentsDir, { withFileTypes: true });
        subFiles = sEntries
          .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
          .map((e) => e.name);
      } catch {
        /* no subagents dir */
      }
      for (const f of subFiles) {
        const p = join(subagentsDir, f);
        let st: ReturnType<typeof statSync>;
        try {
          st = statSync(p);
        } catch {
          continue;
        }
        const mtime = st.mtimeMs;
        if (fileMtimes[p] === mtime) {
          newMtimes[p] = mtime;
          continue;
        }
        await emit({
          type: "PROGRESS",
          message: `Parsing ${projectDir}/${sessionId}/subagents/${f} (${(st.size / BYTES_PER_MB).toFixed(1)}MB)`,
        });
        await parseJsonlFile({
          path: p,
          projectDir,
          requested,
          emit,
          emitRecord,
          sessionAccumulators,
          forcedSessionId: sessionId,
        });
        newMtimes[p] = mtime;
      }

      // tool-results/*.txt → attachments with event_type=tool_result_file.
      await walkToolResults({
        sessionDir,
        sessionId,
        projectDir,
        requested,
        emit,
        emitRecord,
        fileMtimes,
        newMtimes,
      });
    }
  }
}

runConnector({
  name: "claude_code",
  async collect({ state, requested, emit, emitRecord }) {
    const claudeHome =
      process.env.CLAUDE_CODE_HOME || join(homedir(), ".claude");
    const baseDir =
      process.env.CLAUDE_CODE_PROJECTS_DIR || join(claudeHome, "projects");
    const typedState = state as ClaudeCodeState;
    // STATE is stream-keyed per Collection Profile: `state` is
    // { <stream>: <cursor>, ... }. This connector emits STATE with
    // stream='messages', cursor={file_mtimes:{...}}, so reads must
    // qualify by that stream. Fall back to top-level for pre-fix state.
    const fileMtimes: Record<string, number> =
      typedState.messages?.file_mtimes || typedState.file_mtimes || {};

    // ---- skills + slash_commands (independent of projects dir) ----
    try {
      await emitSkills({ claudeHome, requested, emitRecord });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await emit({
        type: "PROGRESS",
        message: `skills scan skipped: ${msg}`,
      });
    }
    try {
      await emitSlashCommands({ claudeHome, requested, emitRecord });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await emit({
        type: "PROGRESS",
        message: `slash_commands scan skipped: ${msg}`,
      });
    }
    if (requested.has("skills")) {
      await emit({
        type: "STATE",
        stream: "skills",
        cursor: { fetched_at: nowIso() },
      });
    }
    if (requested.has("slash_commands")) {
      await emit({
        type: "STATE",
        stream: "slash_commands",
        cursor: { fetched_at: nowIso() },
      });
    }

    // ---- sessions / messages / attachments ----
    const needsProjects =
      requested.has("sessions") ||
      requested.has("messages") ||
      requested.has("attachments");
    if (!needsProjects) {
      return;
    }

    const newMtimes: Record<string, number> = { ...fileMtimes };
    const sessionAccumulators = new Map<string, SessionAccumulator>();

    await scanProjectDirs({
      baseDir,
      emit,
      emitRecord,
      fileMtimes,
      newMtimes,
      requested,
      sessionAccumulators,
    });

    if (requested.has("sessions")) {
      for (const session of sessionAccumulators.values()) {
        await emitRecord("sessions", { ...session });
      }
      await emit({
        type: "STATE",
        stream: "sessions",
        cursor: { fetched_at: nowIso() },
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
