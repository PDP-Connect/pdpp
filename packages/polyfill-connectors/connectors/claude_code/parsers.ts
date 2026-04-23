// Pure parsers for the Claude Code connector. Kept free of Node I/O so
// they can be unit-tested in isolation (see parsers.test.ts). The file
// walker and JSONL iterator live in index.ts.

import type { ContentPart, ParsedFrontmatter, SessionAccumulator } from "./types.ts";

// ─── Constants ──────────────────────────────────────────────────────────

export const SHORT_PREVIEW_CHARS = 300;
export const ATTACHMENT_PREVIEW_CHARS = 500;
export const TOOL_RESULT_PREVIEW_CHARS = 500;
export const MESSAGE_CONTENT_PREVIEW_CHARS = 5000;
export const SKILL_BODY_MAX_CHARS = 20_000;
// Emit a PROGRESS every N lines to surface per-file progress on large transcripts.
export const LINE_PROGRESS_INTERVAL = 2000;
// Bytes per MB for size formatting.
export const BYTES_PER_MB = 1024 * 1024;
// Session dir names encode UUIDs; a plain regex matches the first two groups
// to avoid confusing projects dir contents with per-session subdirs.
export const SESSION_DIR_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/;

// ─── Module-scoped regexes (Biome useTopLevelRegex) ─────────────────────

const CLAUDE_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const CLAUDE_FM_LINE_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const CLAUDE_FM_COMMENT_RE = /^\s*#/;
const CLAUDE_FM_INDENT_RE = /^\s+\S/;
const CLAUDE_FM_LEADING_WS_RE = /^\s+/;
const CLAUDE_FM_QUOTED_DOUBLE_RE = /^"([\s\S]*)"$/;
const CLAUDE_FM_QUOTED_SINGLE_RE = /^'([\s\S]*)'$/;
const CLAUDE_FM_COLLAPSE_WS_RE = /\s+/g;
const CLAUDE_FM_LINE_SPLIT_RE = /\r?\n/;

// ─── Previews ───────────────────────────────────────────────────────────

export function textPreview(s: unknown, max = SHORT_PREVIEW_CHARS): string | null {
  if (typeof s !== "string") {
    return null;
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function truncateBody(body: string, max: number = SKILL_BODY_MAX_CHARS): string {
  return body.length > max ? body.slice(0, max) : body;
}

// ─── Content extraction (messages + attachments) ────────────────────────

function extractFromArrayPart(p: unknown): string {
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
}

function extractFromArray(arr: unknown[]): string | null {
  const parts = arr.map(extractFromArrayPart).filter(Boolean);
  return parts.join("\n") || null;
}

function extractFromObject(obj: { content?: unknown; text?: unknown }): string | null {
  if (obj.content) {
    return extractContent(obj.content);
  }
  if (typeof obj.text === "string") {
    return obj.text;
  }
  return null;
}

export function extractContent(obj: unknown): string | null {
  if (!obj) {
    return null;
  }
  if (typeof obj === "string") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return extractFromArray(obj);
  }
  if (typeof obj === "object") {
    return extractFromObject(obj as { content?: unknown; text?: unknown });
  }
  return null;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────

function stripQuotes(value: string): string {
  return value.replace(CLAUDE_FM_QUOTED_DOUBLE_RE, "$1").replace(CLAUDE_FM_QUOTED_SINGLE_RE, "$1").trim();
}

function isBlockScalar(value: string): boolean {
  return value === ">" || value === "|" || value === ">-" || value === "|-";
}

interface BlockScalarResult {
  nextIndex: number;
  value: string;
}

function readBlockScalar(lines: string[], startIdx: number, marker: string): BlockScalarResult {
  const folded = marker.startsWith(">");
  const collected: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    const next = lines[i] ?? "";
    if (CLAUDE_FM_INDENT_RE.test(next) || next === "") {
      collected.push(next.replace(CLAUDE_FM_LEADING_WS_RE, ""));
      i++;
    } else {
      break;
    }
  }
  const value = folded
    ? collected.join(" ").replace(CLAUDE_FM_COLLAPSE_WS_RE, " ").trim()
    : collected.join("\n").trim();
  return { nextIndex: i, value };
}

/**
 * Minimal YAML-ish frontmatter parser — no external deps.
 * Supports flat `key: value` pairs and folded multi-line values introduced
 * with `>` or `|`. Returns { frontmatter, body }.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
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
  const lines = rawFm.split(CLAUDE_FM_LINE_SPLIT_RE);
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
    const rawValue = kv[2] ?? "";
    if (isBlockScalar(rawValue)) {
      const { nextIndex, value } = readBlockScalar(lines, i + 1, rawValue);
      frontmatter[key] = value;
      i = nextIndex;
    } else {
      frontmatter[key] = stripQuotes(rawValue);
      i++;
    }
  }
  return { frontmatter, body };
}

// ─── Session accumulator construction ───────────────────────────────────

export function makeEmptySessionAccumulator(id: string, projectPath: string): SessionAccumulator {
  return {
    id,
    project_path: projectPath,
    cwd: null,
    git_branch: null,
    version: null,
    started_at: null,
    last_event_at: null,
    message_count: 0,
    user_type: null,
    entrypoint: null,
  };
}

interface ObservedFields {
  cwd: string | null;
  entrypoint: string | null;
  gitBranch: string | null;
  userType: string | null;
  version: string | null;
}

export function mergeSessionObservations(acc: SessionAccumulator, obs: ObservedFields): void {
  if (obs.cwd) {
    acc.cwd = obs.cwd;
  }
  if (obs.gitBranch) {
    acc.git_branch = obs.gitBranch;
  }
  if (obs.version) {
    acc.version = obs.version;
  }
  if (obs.userType) {
    acc.user_type = obs.userType;
  }
  if (obs.entrypoint) {
    acc.entrypoint = obs.entrypoint;
  }
}

export function widenSessionTimeRange(
  acc: SessionAccumulator,
  firstTimestamp: string | null,
  lastTimestamp: string | null
): void {
  if (firstTimestamp && (!acc.started_at || firstTimestamp < acc.started_at)) {
    acc.started_at = firstTimestamp;
  }
  if (lastTimestamp && (!acc.last_event_at || lastTimestamp > acc.last_event_at)) {
    acc.last_event_at = lastTimestamp;
  }
}

// ─── Skill / slash-command record builders ──────────────────────────────

export function buildSkillRecord(args: {
  name: string;
  frontmatter: Record<string, string>;
  body: string;
  path: string;
  mtimeMs: number;
}): Record<string, unknown> {
  return {
    id: `skills:${args.name}`,
    name: args.frontmatter.name || args.name,
    description: args.frontmatter.description || null,
    source: "user",
    path: args.path,
    content: truncateBody(args.body),
    frontmatter: args.frontmatter,
    mtime_epoch: Math.floor(args.mtimeMs / 1000),
  };
}

export function buildSlashCommandRecord(args: {
  idPath: string;
  base: string;
  frontmatter: Record<string, string>;
  body: string;
  path: string;
  mtimeMs: number;
}): Record<string, unknown> {
  return {
    id: `commands:${args.idPath}`,
    name: args.frontmatter.name || args.base,
    description: args.frontmatter.description || null,
    path: args.path,
    content: truncateBody(args.body),
    frontmatter: args.frontmatter,
    mtime_epoch: Math.floor(args.mtimeMs / 1000),
  };
}

// ─── Project-dir scoping ────────────────────────────────────────────────

export function applyProjectDirScope(dirs: string[], include: readonly string[], exclude: readonly string[]): string[] {
  let out = dirs;
  if (include.length) {
    out = out.filter((d) => include.some((s) => d.includes(s)));
  }
  if (exclude.length) {
    out = out.filter((d) => !exclude.some((s) => d.includes(s)));
  }
  return out;
}

export function parseCsvEnv(value: string | undefined): string[] {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
