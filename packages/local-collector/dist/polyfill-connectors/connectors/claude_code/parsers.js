import { safeTextPreview } from "../../src/safe-text-preview.js";
export const SHORT_PREVIEW_CHARS = 300;
export const ATTACHMENT_PREVIEW_CHARS = 500;
export const TOOL_RESULT_PREVIEW_CHARS = 500;
export const MESSAGE_CONTENT_PREVIEW_CHARS = 5000;
export const SKILL_BODY_MAX_CHARS = 20_000;
export const LINE_PROGRESS_INTERVAL = 2000;
export const BYTES_PER_MB = 1024 * 1024;
export const SESSION_DIR_PREFIX_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/;
const CLAUDE_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const CLAUDE_FM_LINE_RE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const CLAUDE_FM_COMMENT_RE = /^\s*#/;
const CLAUDE_FM_INDENT_RE = /^\s+\S/;
const CLAUDE_FM_LEADING_WS_RE = /^\s+/;
const CLAUDE_FM_QUOTED_DOUBLE_RE = /^"([\s\S]*)"$/;
const CLAUDE_FM_QUOTED_SINGLE_RE = /^'([\s\S]*)'$/;
const CLAUDE_FM_COLLAPSE_WS_RE = /\s+/g;
const CLAUDE_FM_LINE_SPLIT_RE = /\r?\n/;
const CLAUDE_MD_SUFFIX_RE = /\.md$/i;
export function textPreview(s, max = SHORT_PREVIEW_CHARS) {
    return safeTextPreview(s, max).preview;
}
export function truncateBody(body, max = SKILL_BODY_MAX_CHARS) {
    return body.length > max ? body.slice(0, max) : body;
}
function extractFromArrayPart(p) {
    if (typeof p === "string") {
        return p;
    }
    const part = p;
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
function extractFromArray(arr) {
    const parts = arr.map(extractFromArrayPart).filter(Boolean);
    return parts.join("\n") || null;
}
function extractFromObject(obj) {
    if (obj.content) {
        return extractContent(obj.content);
    }
    if (typeof obj.text === "string") {
        return obj.text;
    }
    return null;
}
export function extractContent(obj) {
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
        return extractFromObject(obj);
    }
    return null;
}
function stripQuotes(value) {
    return value.replace(CLAUDE_FM_QUOTED_DOUBLE_RE, "$1").replace(CLAUDE_FM_QUOTED_SINGLE_RE, "$1").trim();
}
function isBlockScalar(value) {
    return value === ">" || value === "|" || value === ">-" || value === "|-";
}
function readBlockScalar(lines, startIdx, marker) {
    const folded = marker.startsWith(">");
    const collected = [];
    let i = startIdx;
    while (i < lines.length) {
        const next = lines[i] ?? "";
        if (CLAUDE_FM_INDENT_RE.test(next) || next === "") {
            collected.push(next.replace(CLAUDE_FM_LEADING_WS_RE, ""));
            i++;
        }
        else {
            break;
        }
    }
    const value = folded
        ? collected.join(" ").replace(CLAUDE_FM_COLLAPSE_WS_RE, " ").trim()
        : collected.join("\n").trim();
    return { nextIndex: i, value };
}
export function parseFrontmatter(text) {
    if (typeof text !== "string") {
        return { frontmatter: {}, body: text || "" };
    }
    const m = CLAUDE_FRONTMATTER_RE.exec(text);
    if (!m) {
        return { frontmatter: {}, body: text };
    }
    const rawFm = m[1] ?? "";
    const body = m[2] ?? "";
    const frontmatter = {};
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
        }
        else {
            frontmatter[key] = stripQuotes(rawValue);
            i++;
        }
    }
    return { frontmatter, body };
}
export function makeEmptySessionAccumulator(id, projectPath) {
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
export function mergeSessionObservations(acc, obs) {
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
export function widenSessionTimeRange(acc, firstTimestamp, lastTimestamp) {
    if (firstTimestamp && (!acc.started_at || firstTimestamp < acc.started_at)) {
        acc.started_at = firstTimestamp;
    }
    if (lastTimestamp && (!acc.last_event_at || lastTimestamp > acc.last_event_at)) {
        acc.last_event_at = lastTimestamp;
    }
}
export function buildSkillRecord(args) {
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
export function buildMemoryNoteRecord(args) {
    const fallbackName = args.relPath.replace(CLAUDE_MD_SUFFIX_RE, "");
    return {
        id: `memory_notes:${args.projectDir}/${args.relPath}`,
        project_path: args.projectDir,
        note_path: args.relPath,
        name: args.frontmatter.name || args.frontmatter.title || fallbackName,
        description: args.frontmatter.description || null,
        path: args.path,
        content: truncateBody(args.body),
        frontmatter: args.frontmatter,
        mtime_epoch: Math.floor(args.mtimeMs / 1000),
    };
}
export function buildSlashCommandRecord(args) {
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
export function applyProjectDirScope(dirs, include, exclude) {
    let out = dirs;
    if (include.length) {
        out = out.filter((d) => include.some((s) => d.includes(s)));
    }
    if (exclude.length) {
        out = out.filter((d) => !exclude.some((s) => d.includes(s)));
    }
    return out;
}
export function parseCsvEnv(value) {
    return (value || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}
