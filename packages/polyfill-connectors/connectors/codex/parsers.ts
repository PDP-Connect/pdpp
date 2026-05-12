// Pure parsers for the Codex connector. Kept free of Node I/O so they can
// be unit-tested in isolation (see parsers.test.ts). The filesystem
// walker, sqlite reader, and JSONL iterator live in index.ts.

import { PDPP_PREVIEW_MAX_CHARS, safeTextPreview } from "../../src/safe-text-preview.ts";
import type { ParsedFrontmatter, RolloutAggregate, RolloutPayload, ThreadRow } from "./types.ts";

// ─── Constants & regexes (module-scope per Biome useTopLevelRegex) ──────

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
export const YEAR_DIR_RE = /^\d{4}$/;
export const TWO_DIGIT_DIR_RE = /^\d{2}$/;
const LINE_SPLIT_RE = /\r?\n/;
const FRONTMATTER_KV_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
export const RULES_SUFFIX_RE = /\.rules$/;
export const MD_SUFFIX_RE = /\.md$/;

// ─── Text preview ───────────────────────────────────────────────────────

export function textPreview(s: unknown, max = PDPP_PREVIEW_MAX_CHARS): string | null {
  const r = safeTextPreview(s, max);
  return r.preview;
}

// ─── Rollout payload text extraction ────────────────────────────────────

export function extractMessageText(payload: RolloutPayload): string | null {
  if (!(payload?.content && Array.isArray(payload.content))) {
    return null;
  }
  const parts = payload.content.map((p) => p?.text).filter(Boolean);
  return parts.join("\n") || null;
}

export function payloadOutputPreview(
  output: unknown,
  max = PDPP_PREVIEW_MAX_CHARS
): { preview: string | null; binaryReason: string | null } {
  let toPreview: unknown = output;
  if (typeof output !== "string" && output !== null && output !== undefined) {
    toPreview = JSON.stringify(output);
  }
  const r = safeTextPreview(toPreview, max);
  return {
    preview: r.preview,
    binaryReason: r.kind === "binary" ? r.reason : null,
  };
}

// ─── Epoch / ISO conversion ─────────────────────────────────────────────

export function epochToIso(sec: number | null | undefined): string | null {
  return Number.isFinite(sec) && typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null;
}

// ─── Frontmatter parsing ────────────────────────────────────────────────

function stripSurroundingQuotes(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatterLine(line: string, meta: Record<string, string>): void {
  const kv = line.match(FRONTMATTER_KV_RE);
  if (!kv) {
    return;
  }
  const key = kv[1];
  if (!key) {
    return;
  }
  meta[key] = stripSurroundingQuotes((kv[2] ?? "").trim());
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
  const m = text.match(FRONTMATTER_RE);
  if (!m) {
    return { meta: {}, body: text };
  }
  const meta: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(LINE_SPLIT_RE)) {
    parseFrontmatterLine(line, meta);
  }
  return { meta, body: m[2] ?? "" };
}

// ─── Rollout directory filtering ────────────────────────────────────────

export function isRolloutFile(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

// ─── Session record builders ────────────────────────────────────────────

export function buildThreadSessionRecord(
  id: string,
  t: ThreadRow,
  agg: RolloutAggregate | undefined
): Record<string, unknown> {
  return {
    id,
    cwd: t.cwd || null,
    originator: t.source || null,
    cli_version: t.cli_version || null,
    model_provider: t.model_provider || null,
    git_commit: t.git_sha || null,
    git_branch: t.git_branch || null,
    repository_url: t.git_origin_url || null,
    started_at: epochToIso(t.created_at) || agg?.meta?.timestamp || agg?.firstTs || null,
    last_event_at: epochToIso(t.updated_at) || agg?.lastTs || null,
    message_count: agg?.messageCount ?? null,
    function_call_count: agg?.functionCallCount ?? null,
    // Codex can stuff large assistant output into `title` and
    // `first_user_message`; cap to keep records reasonable.
    title: textPreview(t.title || null, 500),
    archived: t.archived === 1 || t.archived === true,
    tokens_used: t.tokens_used ?? null,
    first_user_message: textPreview(t.first_user_message || null, 2000),
    sandbox_policy: t.sandbox_policy || null,
    approval_mode: t.approval_mode || null,
    rollout_path: t.rollout_path || agg?.rolloutPath || null,
  };
}

export function buildRolloutOnlySessionRecord(id: string, agg: RolloutAggregate): Record<string, unknown> {
  const meta = agg.meta || {};
  return {
    id,
    cwd: meta.cwd || null,
    originator: meta.originator || null,
    cli_version: meta.cli_version || null,
    model_provider: meta.model_provider || null,
    git_commit: meta.git?.commit_hash || null,
    git_branch: meta.git?.branch || null,
    repository_url: meta.git?.repository_url || null,
    started_at: meta.timestamp || agg.firstTs,
    last_event_at: agg.lastTs,
    message_count: agg.messageCount,
    function_call_count: agg.functionCallCount,
    title: null,
    archived: null,
    tokens_used: null,
    first_user_message: null,
    sandbox_policy: null,
    approval_mode: null,
    rollout_path: agg.rolloutPath || null,
  };
}

// ─── Rules / prompts / skills line helpers ──────────────────────────────

export function splitRulesLines(text: string): string[] {
  return text.split(LINE_SPLIT_RE);
}

export function isSkippableRulesLine(line: string): boolean {
  return !line || line.startsWith("#");
}

export function buildRuleRecord(args: {
  ruleset: string;
  line: string;
  index: number;
  path: string;
  mtime: number;
}): Record<string, unknown> {
  return {
    id: `rules:${args.ruleset}:${args.index}`,
    ruleset: args.ruleset,
    rule_text: textPreview(args.line, 4000),
    rule_index: args.index,
    path: args.path,
    mtime_epoch: args.mtime,
  };
}

export function buildPromptRecord(args: {
  fileName: string;
  meta: Record<string, string>;
  body: string;
  path: string;
  mtimeMs: number;
}): Record<string, unknown> {
  const name = args.meta.name || args.fileName.replace(MD_SUFFIX_RE, "");
  return {
    id: `prompts:${args.fileName}`,
    name,
    description: args.meta.description || null,
    content: textPreview(args.body, 20_000),
    path: args.path,
    mtime_epoch: Math.floor(args.mtimeMs / 1000),
  };
}

export function buildSkillRecord(args: {
  dirName: string;
  meta: Record<string, string>;
  body: string;
  path: string;
  mtimeMs: number;
}): Record<string, unknown> {
  return {
    id: `skills:${args.dirName}`,
    name: args.meta.name || args.dirName,
    description: args.meta.description || null,
    content: textPreview(args.body, 20_000),
    path: args.path,
    mtime_epoch: Math.floor(args.mtimeMs / 1000),
  };
}

// ─── Rollout aggregate timestamp update ─────────────────────────────────

export interface TimestampRange {
  firstTs: string | null;
  lastTs: string | null;
}

export function extendTimestampRange(range: TimestampRange, ts: string | null): void {
  if (!ts) {
    return;
  }
  if (!range.firstTs || ts < range.firstTs) {
    range.firstTs = ts;
  }
  if (!range.lastTs || ts > range.lastTs) {
    range.lastTs = ts;
  }
}
