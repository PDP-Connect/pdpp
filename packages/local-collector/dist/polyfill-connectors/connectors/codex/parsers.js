import { PDPP_PREVIEW_MAX_CHARS, safeTextPreview } from "../../src/safe-text-preview.js";
const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/;
export const YEAR_DIR_RE = /^\d{4}$/;
export const TWO_DIGIT_DIR_RE = /^\d{2}$/;
const LINE_SPLIT_RE = /\r?\n/;
const FRONTMATTER_KV_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
export const RULES_SUFFIX_RE = /\.rules$/;
export const MD_SUFFIX_RE = /\.md$/;
export function textPreview(s, max = PDPP_PREVIEW_MAX_CHARS) {
    const r = safeTextPreview(s, max);
    return r.preview;
}
export function extractMessageText(payload) {
    if (!(payload?.content && Array.isArray(payload.content))) {
        return null;
    }
    const parts = payload.content.map((p) => p?.text).filter(Boolean);
    return parts.join("\n") || null;
}
export function payloadOutputPreview(output, max = PDPP_PREVIEW_MAX_CHARS) {
    let toPreview = output;
    if (typeof output !== "string" && output !== null && output !== undefined) {
        toPreview = JSON.stringify(output);
    }
    const r = safeTextPreview(toPreview, max);
    return {
        preview: r.preview,
        binaryReason: r.kind === "binary" ? r.reason : null,
    };
}
export function epochToIso(sec) {
    return Number.isFinite(sec) && typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null;
}
function stripSurroundingQuotes(value) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
function parseFrontmatterLine(line, meta) {
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
export function parseFrontmatter(text) {
    const m = text.match(FRONTMATTER_RE);
    if (!m) {
        return { meta: {}, body: text };
    }
    const meta = {};
    for (const line of (m[1] ?? "").split(LINE_SPLIT_RE)) {
        parseFrontmatterLine(line, meta);
    }
    return { meta, body: m[2] ?? "" };
}
export function isRolloutFile(name) {
    return name.startsWith("rollout-") && name.endsWith(".jsonl");
}
export function buildThreadSessionRecord(id, t, agg) {
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
        title: textPreview(t.title || null, 500),
        archived: t.archived === 1 || t.archived === true,
        tokens_used: t.tokens_used ?? null,
        first_user_message: textPreview(t.first_user_message || null, 2000),
        sandbox_policy: t.sandbox_policy || null,
        approval_mode: t.approval_mode || null,
        rollout_path: t.rollout_path || agg?.rolloutPath || null,
    };
}
export function buildRolloutOnlySessionRecord(id, agg) {
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
export function splitRulesLines(text) {
    return text.split(LINE_SPLIT_RE);
}
export function isSkippableRulesLine(line) {
    return !line || line.startsWith("#");
}
export function buildRuleRecord(args) {
    return {
        id: `rules:${args.ruleset}:${args.index}`,
        ruleset: args.ruleset,
        rule_text: textPreview(args.line, 4000),
        rule_index: args.index,
        path: args.path,
        mtime_epoch: args.mtime,
    };
}
export function buildPromptRecord(args) {
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
export function buildSkillRecord(args) {
    return {
        id: `skills:${args.dirName}`,
        name: args.meta.name || args.dirName,
        description: args.meta.description || null,
        content: textPreview(args.body, 20_000),
        path: args.path,
        mtime_epoch: Math.floor(args.mtimeMs / 1000),
    };
}
export function extendTimestampRange(range, ts) {
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
