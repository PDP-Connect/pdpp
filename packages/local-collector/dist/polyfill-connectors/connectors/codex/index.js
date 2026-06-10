#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { flushAndExitAfterRuntimeAck } from "../../src/connector-exit.js";
import { openCarryForwardCursor } from "../../src/fingerprint-cursor.js";
import { isMainModule } from "../../src/is-main-module.js";
import { buildLocalSourceInventory, listDirectoryInventory, openInventoryFingerprintCursor, } from "../../src/local-source-inventory.js";
import { stringifyForJsonl } from "../../src/safe-emit.js";
import { resourceSet } from "../../src/scope-filters.js";
import { buildPromptRecord, buildRolloutOnlySessionRecord, buildRuleRecord, buildSkillRecord, buildThreadSessionRecord, extendTimestampRange, extractMessageText, isRolloutFile, isSkippableRulesLine, parseFrontmatter, payloadOutputPreview, RULES_SUFFIX_RE, splitRulesLines, TWO_DIGIT_DIR_RE, textPreview, YEAR_DIR_RE, } from "./parsers.js";
import { validateRecord } from "./schemas.js";
const DEFAULT_ACTIVE_ROLLOUT_QUIET_MS = 120_000;
const ACTIVE_ROLLOUT_QUIET_MS_ENV = "PDPP_CODEX_ACTIVE_ROLLOUT_QUIET_MS";
const GUARD_PREFIX_BYTES = 64 * 1024;
let stdoutDrainPromise = null;
const emit = (m) => {
    const ok = process.stdout.write(stringifyForJsonl(m));
    if (!ok && stdoutDrainPromise === null) {
        stdoutDrainPromise = new Promise((resolve) => {
            process.stdout.once("drain", () => {
                stdoutDrainPromise = null;
                resolve();
            });
        });
    }
};
async function waitForEmitDrain() {
    if (stdoutDrainPromise !== null) {
        await stdoutDrainPromise;
    }
}
const flushAndExit = (code) => {
    flushAndExitAfterRuntimeAck(code);
};
const fail = (m, r = false) => {
    emit({
        type: "DONE",
        status: "failed",
        records_emitted: 0,
        error: { message: m, retryable: r },
    });
    flushAndExit(1);
};
export const CODEX_KNOWN_LOCAL_STORES = [
    {
        store: "sessions",
        relativePath: "sessions",
        stream: "sessions",
        classification: "collect",
        reason: "declared rollout source",
    },
    {
        store: "state_db",
        relativePath: "state_5.sqlite",
        stream: "sessions",
        classification: "collect",
        reason: "declared thread metadata source opened read-only",
    },
    {
        store: "rules",
        relativePath: "rules",
        stream: "rules",
        classification: "collect",
        reason: "declared user-authored rules source",
    },
    {
        store: "prompts",
        relativePath: "prompts",
        stream: "prompts",
        classification: "collect",
        reason: "declared user-authored prompts source",
    },
    {
        store: "skills",
        relativePath: "skills",
        stream: "skills",
        classification: "collect",
        reason: "declared user-authored skills source",
    },
    {
        store: "history",
        relativePath: "history.jsonl",
        stream: "history",
        classification: "inventory_only",
        reason: "metadata-only until prompt-history payload contract is approved",
    },
    {
        store: "session_index",
        relativePath: "session_index.jsonl",
        stream: "session_index",
        classification: "inventory_only",
        reason: "metadata-only until session-index payload contract is approved",
    },
    {
        store: "shell_snapshots",
        relativePath: "shell-snapshots",
        stream: "shell_snapshots",
        classification: "inventory_only",
        reason: "shell content requires redaction review before payload collection",
    },
    {
        store: "memories",
        relativePath: "memories",
        stream: null,
        classification: "inventory_only",
        reason: "deferred private local store; diagnostics only until a general Codex memory surface is approved",
    },
    {
        store: "context_mode",
        relativePath: "context-mode",
        stream: null,
        classification: "inventory_only",
        reason: "user-specific local convention; diagnostics only, not a general Codex stream",
    },
    {
        store: "logs",
        relativePath: "logs",
        stream: "logs",
        classification: "defer",
        reason: "logs require deterministic redaction before collection",
    },
    {
        store: "config",
        relativePath: "config.toml",
        stream: "config_inventory",
        classification: "inventory_only",
        reason: "configuration is inventoried without payload content",
    },
    {
        store: "cache",
        relativePath: "cache",
        stream: "cache_inventory",
        classification: "inventory_only",
        reason: "raw cache payloads may contain sensitive tool output",
    },
    {
        store: "auth",
        relativePath: "auth.json",
        stream: null,
        classification: "exclude",
        reason: "auth-adjacent credential material is never emitted",
    },
];
export async function* iterJsonlLinesFromOffset(path, startOffset) {
    const stream = createReadStream(path, { start: startOffset });
    let pending = Buffer.alloc(0);
    let committed = startOffset;
    for await (const chunk of stream) {
        const buf = chunk;
        pending = pending.length === 0 ? buf : Buffer.concat([pending, buf]);
        let nl = pending.indexOf(0x0a);
        while (nl !== -1) {
            const lineBuf = pending.subarray(0, nl);
            committed += nl + 1;
            const line = lineBuf.toString("utf8");
            const trimmed = line.trim();
            if (trimmed) {
                let parsed = null;
                try {
                    parsed = JSON.parse(line);
                }
                catch {
                    parsed = null;
                }
                if (parsed) {
                    yield { obj: parsed, committedOffset: committed };
                }
            }
            pending = pending.subarray(nl + 1);
            nl = pending.indexOf(0x0a);
        }
    }
}
async function hashFilePrefix(path, guardBytes) {
    if (guardBytes <= 0) {
        return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    }
    return await new Promise((resolve) => {
        const hash = createHash("sha256");
        let read = 0;
        const stream = createReadStream(path, { start: 0, end: guardBytes - 1 });
        stream.on("data", (chunk) => {
            const buf = chunk;
            read += buf.length;
            hash.update(buf);
        });
        stream.on("error", () => resolve(null));
        stream.on("end", () => {
            resolve(read >= guardBytes ? hash.digest("hex") : null);
        });
    });
}
async function listIfExists(dir) {
    try {
        return await readdir(dir);
    }
    catch {
        return null;
    }
}
async function* walkDayFiles(dayPath, year, month, day) {
    const files = await listIfExists(dayPath);
    if (files === null) {
        return;
    }
    for (const f of files) {
        if (isRolloutFile(f)) {
            yield { path: join(dayPath, f), year, month, day, file: f };
        }
    }
}
async function* walkMonthDays(monthPath, year, month) {
    const days = await listIfExists(monthPath);
    if (days === null) {
        return;
    }
    for (const d of days) {
        if (!TWO_DIGIT_DIR_RE.test(d)) {
            continue;
        }
        yield* walkDayFiles(join(monthPath, d), year, month, d);
    }
}
async function* walkYearMonths(yearPath, year) {
    const months = await listIfExists(yearPath);
    if (months === null) {
        return;
    }
    for (const m of months) {
        if (!TWO_DIGIT_DIR_RE.test(m)) {
            continue;
        }
        yield* walkMonthDays(join(yearPath, m), year, m);
    }
}
async function* walkRollouts(baseDir) {
    const years = await listIfExists(baseDir);
    if (years === null) {
        return;
    }
    for (const y of years) {
        if (!YEAR_DIR_RE.test(y)) {
            continue;
        }
        yield* walkYearMonths(join(baseDir, y), y);
    }
}
const THREADS_QUERY = `
  SELECT id, rollout_path, created_at, updated_at, source, model_provider,
         cwd, title, sandbox_policy, approval_mode, tokens_used,
         has_user_event, archived, archived_at, git_sha, git_branch,
         git_origin_url, cli_version, first_user_message, agent_nickname,
         agent_role, memory_mode, model, reasoning_effort
  FROM threads
`;
function openThreadsDb(dbPath) {
    try {
        return new DatabaseSync(dbPath, { readOnly: true });
    }
    catch {
        emit({
            type: "PROGRESS",
            message: "Codex phase=index pass=index state_db_readable=false fallback=rollouts_only",
        });
        return null;
    }
}
function queryThreadsRows(db) {
    try {
        const rawRows = db.prepare(THREADS_QUERY).all();
        return rawRows;
    }
    catch {
        emit({
            type: "PROGRESS",
            message: "Codex phase=index pass=index state_db_query_failed=true fallback=rollouts_only",
        });
        return [];
    }
}
function loadThreadsMap(dbPath) {
    if (!existsSync(dbPath)) {
        return { map: new Map(), present: false };
    }
    const db = openThreadsDb(dbPath);
    if (!db) {
        return { map: new Map(), present: false };
    }
    const map = new Map();
    try {
        for (const r of queryThreadsRows(db)) {
            map.set(r.id, r);
        }
    }
    finally {
        try {
            db.close();
        }
        catch {
        }
    }
    return { map, present: true };
}
async function statAndRead(path) {
    try {
        const st = await stat(path);
        const text = await readFile(path, "utf8");
        return { mtimeMs: Number(st.mtimeMs), size: Number(st.size), text };
    }
    catch {
        return null;
    }
}
async function emitRulesStream(rulesDir, emitRecord) {
    const entries = await listIfExists(rulesDir);
    if (entries === null) {
        return;
    }
    for (const f of entries) {
        if (!f.endsWith(".rules")) {
            continue;
        }
        const p = join(rulesDir, f);
        const loaded = await statAndRead(p);
        if (!loaded) {
            continue;
        }
        const mtime = Math.floor(loaded.mtimeMs / 1000);
        const ruleset = f.replace(RULES_SUFFIX_RE, "");
        let idx = 0;
        for (const raw of splitRulesLines(loaded.text)) {
            const line = raw.trim();
            if (isSkippableRulesLine(line)) {
                continue;
            }
            emitRecord("rules", buildRuleRecord({ ruleset, line, index: idx, path: p, mtime }));
            await waitForEmitDrain();
            idx++;
        }
    }
}
async function emitPromptsStream(promptsDir, emitRecord) {
    const entries = await listIfExists(promptsDir);
    if (entries === null) {
        return;
    }
    for (const f of entries) {
        if (!f.endsWith(".md")) {
            continue;
        }
        const p = join(promptsDir, f);
        const loaded = await statAndRead(p);
        if (!loaded) {
            continue;
        }
        const { meta, body } = parseFrontmatter(loaded.text);
        emitRecord("prompts", buildPromptRecord({ fileName: f, meta, body, path: p, mtimeMs: loaded.mtimeMs }));
        await waitForEmitDrain();
    }
}
function shouldSkipSkillEntry(ent) {
    return ent.name.startsWith(".") || ent.name === "skills.backup";
}
async function isDirectoryPath(p) {
    try {
        const s = await stat(p);
        return s.isDirectory();
    }
    catch {
        return false;
    }
}
async function emitSkillsStream(skillsDir, emitRecord) {
    let entries;
    try {
        entries = await readdir(skillsDir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const ent of entries) {
        if (shouldSkipSkillEntry(ent)) {
            continue;
        }
        const dirPath = join(skillsDir, ent.name);
        if (!(await isDirectoryPath(dirPath))) {
            continue;
        }
        const skillMdPath = join(dirPath, "SKILL.md");
        const loaded = await statAndRead(skillMdPath);
        if (!loaded) {
            continue;
        }
        const { meta, body } = parseFrontmatter(loaded.text);
        emitRecord("skills", buildSkillRecord({ dirName: ent.name, meta, body, path: skillMdPath, mtimeMs: loaded.mtimeMs }));
        await waitForEmitDrain();
    }
}
export function makeRolloutParseState(seed) {
    return {
        sessionId: seed?.sessionId ?? null,
        sessionMeta: null,
        firstTimestamp: seed?.firstTimestamp ?? null,
        lastTimestamp: seed?.lastTimestamp ?? null,
        messageCount: seed?.messageCount ?? 0,
        functionCallCount: seed?.functionCallCount ?? 0,
        pendingCalls: new Map(),
        lineCount: seed?.lineCount ?? 0,
    };
}
function emitMessageRecord(state, payload, ts, emitRecord) {
    const sessionId = state.sessionId;
    if (!sessionId) {
        return;
    }
    const id = `${sessionId}:${state.lineCount}`;
    emitRecord("messages", {
        id,
        session_id: sessionId,
        role: payload.role || null,
        type: "message",
        content: textPreview(extractMessageText(payload), 5000),
        timestamp: ts,
    });
}
function registerFunctionCall(state, payload, ts) {
    const sessionId = state.sessionId;
    if (!sessionId) {
        return;
    }
    const callId = payload.call_id || `${sessionId}:${state.lineCount}`;
    state.pendingCalls.set(callId, {
        id: callId,
        session_id: sessionId,
        call_id: callId,
        name: payload.name || null,
        arguments: textPreview(payload.arguments || null, 2000),
        output_preview: null,
        timestamp: ts,
    });
}
function applyFunctionCallOutput(state, payload, ts, emitRecord) {
    const sessionId = state.sessionId;
    if (!sessionId) {
        return;
    }
    const callId = payload.call_id;
    const existing = callId ? state.pendingCalls.get(callId) : null;
    const previewResult = payloadOutputPreview(payload.output);
    if (existing) {
        existing.output_preview = previewResult.preview;
        if (previewResult.binaryReason) {
            existing.output_binary_reason = previewResult.binaryReason;
        }
        if (callId) {
            state.pendingCalls.delete(callId);
        }
        emitRecord("function_calls", { ...existing });
        return;
    }
    emitRecord("function_calls", {
        id: `${sessionId}:${state.lineCount}:output`,
        session_id: sessionId,
        call_id: callId || null,
        name: null,
        arguments: null,
        output_preview: previewResult.preview,
        output_binary_reason: previewResult.binaryReason,
        timestamp: ts,
    });
}
export function processResponseItem({ deps, payload, state, ts }) {
    if (payload.type === "message") {
        state.messageCount++;
        if (deps.requested.has("messages")) {
            emitMessageRecord(state, payload, ts, deps.emitRecord);
        }
        return;
    }
    if (payload.type === "function_call") {
        state.functionCallCount++;
        if (deps.requested.has("function_calls")) {
            registerFunctionCall(state, payload, ts);
        }
        return;
    }
    if (payload.type === "function_call_output" && deps.requested.has("function_calls")) {
        applyFunctionCallOutput(state, payload, ts, deps.emitRecord);
    }
}
const PROGRESS_EVERY = 2000;
export function shouldDeferActiveRolloutFile(input) {
    return input.quietMs > 0 && input.mtimeMs > input.nowMs - input.quietMs;
}
export function processRolloutLine({ deps, obj, state }) {
    state.lineCount++;
    if (state.lineCount % PROGRESS_EVERY === 0) {
        deps.progress(`Codex phase=emit pass=emit lines_parsed=${state.lineCount}`);
    }
    const ts = obj.timestamp || null;
    const range = { firstTs: state.firstTimestamp, lastTs: state.lastTimestamp };
    extendTimestampRange(range, ts);
    state.firstTimestamp = range.firstTs;
    state.lastTimestamp = range.lastTs;
    if (obj.type === "session_meta") {
        if (state.sessionId === null) {
            state.sessionMeta = obj.payload || {};
            state.sessionId = state.sessionMeta.id || null;
        }
        return;
    }
    if (!state.sessionId) {
        return;
    }
    if (obj.type !== "response_item") {
        return;
    }
    processResponseItem({
        payload: obj.payload || {},
        ts,
        state,
        deps,
    });
}
export function flushPendingCalls(state, deps) {
    for (const call of state.pendingCalls.values()) {
        deps.emitRecord("function_calls", { ...call });
    }
    state.pendingCalls.clear();
}
export function shouldReemitThreadSession(thread, agg, priorFingerprint) {
    if (!priorFingerprint) {
        return true;
    }
    if (agg) {
        return true;
    }
    const priorUpdatedAt = priorFingerprint.updated_at ?? null;
    const currentUpdatedAt = thread.updated_at ?? null;
    if (currentUpdatedAt == null) {
        return priorUpdatedAt != null;
    }
    if (priorUpdatedAt == null) {
        return true;
    }
    return currentUpdatedAt > priorUpdatedAt;
}
function makeThreadFingerprint(thread, agg, priorFingerprint) {
    return {
        updated_at: thread.updated_at ?? null,
        message_count: agg?.messageCount ?? priorFingerprint?.message_count ?? null,
        function_call_count: agg?.functionCallCount ?? priorFingerprint?.function_call_count ?? null,
    };
}
export function emitSessionsFromMaps({ threadsMap, rolloutAggregates, emitRecord, cursor, }) {
    const emittedSessionIds = new Set();
    for (const [id, t] of threadsMap) {
        emittedSessionIds.add(id);
        const agg = rolloutAggregates.get(id);
        const prior = cursor?.prior(id);
        if (shouldReemitThreadSession(t, agg, prior)) {
            emitRecord("sessions", buildThreadSessionRecord(id, t, agg, prior));
        }
        cursor?.note(id, makeThreadFingerprint(t, agg, prior));
    }
    for (const [id, agg] of rolloutAggregates) {
        if (emittedSessionIds.has(id)) {
            continue;
        }
        emitRecord("sessions", buildRolloutOnlySessionRecord(id, agg));
    }
}
async function parseRolloutFile(args) {
    const state = makeRolloutParseState(args.seed);
    const deps = {
        emitRecord: args.emitRecord,
        progress: (message) => {
            emit({ type: "PROGRESS", message });
        },
        requested: args.requested,
    };
    let committedOffset = args.startOffset;
    for await (const { obj, committedOffset: lineEnd } of iterJsonlLinesFromOffset(args.path, args.startOffset)) {
        processRolloutLine({ obj, state, deps, file: args.file });
        committedOffset = lineEnd;
        await waitForEmitDrain();
    }
    flushPendingCalls(state, deps);
    await waitForEmitDrain();
    if (state.sessionId) {
        args.rolloutAggregates.set(state.sessionId, {
            meta: state.sessionMeta || {},
            firstTs: state.firstTimestamp,
            lastTs: state.lastTimestamp,
            messageCount: state.messageCount,
            functionCallCount: state.functionCallCount,
            rolloutPath: args.path,
        });
    }
    return {
        committedOffset,
        sessionId: state.sessionId,
        lineCount: state.lineCount,
        messageCount: state.messageCount,
        functionCallCount: state.functionCallCount,
        firstTimestamp: state.firstTimestamp,
        lastTimestamp: state.lastTimestamp,
    };
}
export function decideRolloutAction(input) {
    const { cursor, sizeBytes, mtimeMs } = input;
    if (!cursor) {
        return { kind: "full" };
    }
    if (sizeBytes === cursor.size_bytes && mtimeMs === cursor.mtime_ms) {
        return { kind: "skip" };
    }
    if (sizeBytes < cursor.size_bytes || cursor.offset_bytes > sizeBytes || !input.guardMatches) {
        return { kind: "unsafe_full" };
    }
    if (sizeBytes > cursor.size_bytes) {
        return {
            kind: "append",
            startOffset: cursor.offset_bytes,
            seed: {
                sessionId: cursor.session_id,
                lineCount: cursor.line_count,
                messageCount: cursor.message_count,
                functionCallCount: cursor.function_call_count,
                firstTimestamp: cursor.first_ts,
                lastTimestamp: cursor.last_ts,
            },
        };
    }
    return { kind: "skip" };
}
function carryFileCursorForward(args, path, mtime) {
    const prior = args.fileCursors[path];
    if (prior) {
        args.newFileCursors[path] = prior;
    }
    args.newMtimes[path] = mtime;
}
async function buildFileCursorAfterParse(path, result) {
    const guardBytes = Math.min(result.committedOffset, GUARD_PREFIX_BYTES);
    const head = (await hashFilePrefix(path, guardBytes)) ?? "";
    let mtimeMs = 0;
    try {
        mtimeMs = statSync(path).mtimeMs;
    }
    catch {
        mtimeMs = 0;
    }
    return {
        mtime_ms: mtimeMs,
        size_bytes: result.committedOffset,
        offset_bytes: result.committedOffset,
        line_count: result.lineCount,
        head_sha256: head,
        guard_bytes: guardBytes,
        session_id: result.sessionId,
        message_count: result.messageCount,
        function_call_count: result.functionCallCount,
        first_ts: result.firstTimestamp,
        last_ts: result.lastTimestamp,
    };
}
async function resolveRolloutAction(path, st, cursor) {
    const sizeBytes = Number(st.size);
    let guardMatches = false;
    if (cursor && sizeBytes > cursor.size_bytes && cursor.offset_bytes <= sizeBytes) {
        const head = await hashFilePrefix(path, cursor.guard_bytes);
        guardMatches = head !== null && head === cursor.head_sha256;
    }
    return decideRolloutAction({ cursor, sizeBytes, mtimeMs: st.mtimeMs, guardMatches });
}
async function processRolloutEntry(entry, args, rolloutOrdinal) {
    let st;
    try {
        st = statSync(entry.path);
    }
    catch {
        return "missing";
    }
    const mtime = st.mtimeMs;
    const cursor = args.fileCursors[entry.path];
    if (!cursor && args.fileMtimes[entry.path] === mtime) {
        args.newMtimes[entry.path] = mtime;
        return "skipped";
    }
    const action = await resolveRolloutAction(entry.path, st, cursor);
    if (action.kind === "skip") {
        carryFileCursorForward(args, entry.path, mtime);
        return "skipped";
    }
    if (shouldDeferActiveRolloutFile({ mtimeMs: mtime, nowMs: args.scanStartedAtMs, quietMs: args.activeQuietMs })) {
        emit({
            type: "PROGRESS",
            message: `Codex phase=index pass=index item=${rolloutOrdinal} backpressure=active_rollout_deferred`,
        });
        await waitForEmitDrain();
        if (cursor) {
            args.newFileCursors[entry.path] = cursor;
        }
        return "skipped";
    }
    const isAppend = action.kind === "append";
    emit({
        type: "PROGRESS",
        message: `Codex phase=emit pass=emit item=${rolloutOrdinal} mode=${isAppend ? "append" : "full"} file_size_mb=${(st.size / 1024 / 1024).toFixed(1)}`,
    });
    await waitForEmitDrain();
    const result = await parseRolloutFile({
        path: entry.path,
        file: entry.file,
        requested: args.requested,
        emitRecord: args.emitRecord,
        rolloutAggregates: args.rolloutAggregates,
        startOffset: isAppend ? action.startOffset : 0,
        seed: isAppend ? action.seed : undefined,
    });
    args.newFileCursors[entry.path] = await buildFileCursorAfterParse(entry.path, result);
    args.newMtimes[entry.path] = mtime;
    return "parsed";
}
async function scanRollouts(args) {
    const baseExists = (await listIfExists(args.baseDir)) !== null;
    if (!baseExists) {
        emit({
            type: "PROGRESS",
            message: "Codex phase=index pass=index sessions_dir_readable=false",
        });
        await waitForEmitDrain();
        return { parsedFiles: 0 };
    }
    let totalRollouts = 0;
    let parsedRollouts = 0;
    for await (const entry of walkRollouts(args.baseDir)) {
        totalRollouts++;
        if ((await processRolloutEntry(entry, args, totalRollouts)) === "parsed") {
            parsedRollouts++;
        }
    }
    emit({
        type: "PROGRESS",
        message: `Codex phase=index pass=index total_items=${totalRollouts} parsed_items=${parsedRollouts}`,
    });
    await waitForEmitDrain();
    return { parsedFiles: parsedRollouts };
}
function emitSessions({ stateDbPath, rolloutAggregates, emitRecord, cursor }) {
    const { map: threadsById } = loadThreadsMap(stateDbPath);
    emitSessionsFromMaps({
        threadsMap: threadsById,
        rolloutAggregates,
        emitRecord,
        cursor,
    });
}
async function readStartMessage() {
    const rl = createInterface({ input: process.stdin, terminal: false });
    return await new Promise((resolve, reject) => rl.once("line", (l) => {
        try {
            resolve(JSON.parse(l));
        }
        catch (e) {
            reject(e);
        }
    }));
}
function resolveCodexDirs() {
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    return {
        codexHome,
        baseDir: process.env.CODEX_SESSIONS_DIR || join(codexHome, "sessions"),
        stateDbPath: process.env.CODEX_STATE_DB || join(codexHome, "state_5.sqlite"),
        rulesDir: process.env.CODEX_RULES_DIR || join(codexHome, "rules"),
        promptsDir: process.env.CODEX_PROMPTS_DIR || join(codexHome, "prompts"),
        skillsDir: process.env.CODEX_SKILLS_DIR || join(codexHome, "skills"),
    };
}
function readFileMtimes(startMsg) {
    const state = startMsg.state || {};
    return (state.messages?.file_mtimes ||
        state.function_calls?.file_mtimes ||
        state.sessions?.file_mtimes ||
        state.file_mtimes ||
        {});
}
function coerceRolloutFileCursor(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const v = value;
    const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const offset = num(v.offset_bytes);
    const size = num(v.size_bytes);
    const mtime = num(v.mtime_ms);
    const line = num(v.line_count);
    const guardBytes = num(v.guard_bytes);
    const head = typeof v.head_sha256 === "string" ? v.head_sha256 : null;
    if (offset === null || size === null || mtime === null || line === null || guardBytes === null || head === null) {
        return null;
    }
    return {
        mtime_ms: mtime,
        size_bytes: size,
        offset_bytes: offset,
        line_count: line,
        head_sha256: head,
        guard_bytes: guardBytes,
        session_id: typeof v.session_id === "string" ? v.session_id : null,
        message_count: num(v.message_count) ?? 0,
        function_call_count: num(v.function_call_count) ?? 0,
        first_ts: typeof v.first_ts === "string" ? v.first_ts : null,
        last_ts: typeof v.last_ts === "string" ? v.last_ts : null,
    };
}
export function readPriorFileCursors(startMsg) {
    const state = startMsg.state || {};
    const raw = state.messages?.file_cursors || state.function_calls?.file_cursors || state.sessions?.file_cursors || null;
    const out = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return out;
    }
    for (const [path, value] of Object.entries(raw)) {
        const cursor = coerceRolloutFileCursor(value);
        if (cursor) {
            out[path] = cursor;
        }
    }
    return out;
}
function resolveActiveRolloutQuietMs(env = process.env) {
    const raw = env[ACTIVE_ROLLOUT_QUIET_MS_ENV];
    if (!raw) {
        return DEFAULT_ACTIVE_ROLLOUT_QUIET_MS;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ACTIVE_ROLLOUT_QUIET_MS;
}
function buildRequestedMap(startMsg) {
    return new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
}
function buildResourceFilters(requested) {
    const resFilters = new Map();
    for (const [n, r] of requested) {
        resFilters.set(n, resourceSet(r));
    }
    return resFilters;
}
async function isReadableDirectory(path) {
    try {
        const st = await stat(path);
        return st.isDirectory();
    }
    catch {
        return false;
    }
}
async function isReadableFile(path) {
    try {
        const st = await stat(path);
        return st.isFile();
    }
    catch {
        return false;
    }
}
async function assertRequestedCodexSources(dirs, requested) {
    const missing = [];
    const needsRollouts = requested.has("messages") || requested.has("function_calls");
    if (needsRollouts && !(await isReadableDirectory(dirs.baseDir))) {
        missing.push(`CODEX_SESSIONS_DIR=${dirs.baseDir}`);
    }
    if (requested.has("sessions")) {
        const hasRollouts = await isReadableDirectory(dirs.baseDir);
        const hasThreadsDb = await isReadableFile(dirs.stateDbPath);
        if (!(hasRollouts || hasThreadsDb)) {
            missing.push(`CODEX_SESSIONS_DIR=${dirs.baseDir} or CODEX_STATE_DB=${dirs.stateDbPath}`);
        }
    }
    if (requested.has("rules") && !(await isReadableDirectory(dirs.rulesDir))) {
        missing.push(`CODEX_RULES_DIR=${dirs.rulesDir}`);
    }
    if (requested.has("prompts") && !(await isReadableDirectory(dirs.promptsDir))) {
        missing.push(`CODEX_PROMPTS_DIR=${dirs.promptsDir}`);
    }
    if (requested.has("skills") && !(await isReadableDirectory(dirs.skillsDir))) {
        missing.push(`CODEX_SKILLS_DIR=${dirs.skillsDir}`);
    }
    if (missing.length > 0) {
        throw new Error(`requested Codex local source path(s) are missing or unreadable: ${missing.join(", ")}`);
    }
}
function emitStateCursors({ requested, newFileCursors, newMtimes, nowIso, sessionsSourceMtimeMs, threadFingerprints, }) {
    if (requested.has("sessions")) {
        emit({
            type: "STATE",
            stream: "sessions",
            cursor: {
                fetched_at: nowIso(),
                source_mtime_ms: sessionsSourceMtimeMs,
                thread_fingerprints: threadFingerprints.toState(),
            },
        });
    }
    if (requested.has("messages") || requested.has("function_calls")) {
        const cursorStream = requested.has("messages") ? "messages" : "function_calls";
        emit({
            type: "STATE",
            stream: cursorStream,
            cursor: { file_mtimes: newMtimes, file_cursors: newFileCursors, fetched_at: nowIso() },
        });
    }
    for (const s of ["rules", "prompts", "skills"]) {
        if (requested.has(s)) {
            emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
        }
    }
    if (requested.has("coverage_diagnostics")) {
        emit({ type: "STATE", stream: "coverage_diagnostics", cursor: { fetched_at: nowIso() } });
    }
}
function readPriorSessionsSourceMtimeMs(startMsg) {
    const state = startMsg.state || {};
    const sessions = state.sessions;
    const value = sessions && typeof sessions === "object" && !Array.isArray(sessions)
        ? sessions.source_mtime_ms
        : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function nullableFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function coerceFingerprintEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
    }
    const v = value;
    return {
        updated_at: nullableFiniteNumber(v.updated_at),
        message_count: nullableFiniteNumber(v.message_count),
        function_call_count: nullableFiniteNumber(v.function_call_count),
    };
}
function rawFingerprintMap(startMsg) {
    if (!startMsg || typeof startMsg !== "object") {
        return null;
    }
    const state = startMsg.state;
    if (!state || typeof state !== "object") {
        return null;
    }
    const sessions = state.sessions;
    if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) {
        return null;
    }
    const raw = sessions.thread_fingerprints;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return null;
    }
    return raw;
}
export function readPriorThreadFingerprints(startMsg) {
    const out = new Map();
    const raw = rawFingerprintMap(startMsg);
    if (!raw) {
        return out;
    }
    for (const [id, value] of Object.entries(raw)) {
        const entry = coerceFingerprintEntry(value);
        if (entry) {
            out.set(id, entry);
        }
    }
    return out;
}
function fileMtimeMs(path) {
    try {
        return statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
}
async function emitCoverageDiagnostics(input) {
    if (!input.requested.has("coverage_diagnostics")) {
        return;
    }
    for (const record of input.inventory.coverage) {
        input.emitRecord("coverage_diagnostics", record);
        await waitForEmitDrain();
    }
}
async function emitGatedInventoryStream(input) {
    const cursor = openInventoryFingerprintCursor(input.priorState);
    for (const record of input.records) {
        if (cursor.shouldEmit(record)) {
            input.emitRecord(input.stream, record);
            await waitForEmitDrain();
        }
    }
    cursor.pruneStale();
    const inventoryCursor = { fetched_at: input.nowIso() };
    if (cursor.size() > 0) {
        inventoryCursor.fingerprints = cursor.toState();
    }
    emit({ type: "STATE", stream: input.stream, cursor: inventoryCursor });
    await waitForEmitDrain();
}
export const CODEX_GATED_INVENTORY_STREAMS = [
    "history",
    "session_index",
    "shell_snapshots",
    "config_inventory",
    "cache_inventory",
    "logs",
];
async function emitLocalInventoryStreams(input) {
    for (const stream of CODEX_GATED_INVENTORY_STREAMS) {
        if (!input.requested.has(stream)) {
            continue;
        }
        const records = stream === "shell_snapshots"
            ? await listDirectoryInventory({
                tool: "codex",
                sourceHome: input.codexHome,
                relativeRoot: "shell-snapshots",
                store: "shell_snapshots",
                stream: "shell_snapshots",
                reason: "shell content requires redaction review before payload collection",
            })
            : (input.inventory.recordsByStream.get(stream) ?? []);
        await emitGatedInventoryStream({
            emitRecord: input.emitRecord,
            nowIso: input.nowIso,
            priorState: input.state[stream],
            records,
            stream,
        });
    }
}
async function main() {
    const startMsg = await readStartMessage();
    if (startMsg.type !== "START") {
        return fail("Expected START");
    }
    const requested = buildRequestedMap(startMsg);
    if (!requested.size) {
        return fail("START.scope.streams is required");
    }
    const resFilters = buildResourceFilters(requested);
    const dirs = resolveCodexDirs();
    const fileMtimes = readFileMtimes(startMsg);
    const fileCursors = readPriorFileCursors(startMsg);
    let total = 0;
    const nowIso = () => new Date().toISOString();
    const emittedAt = nowIso();
    const emitRecord = (s, d) => {
        if (d.id == null) {
            return;
        }
        const resSet = resFilters.get(s);
        if (resSet && !resSet.has(String(d.id))) {
            return;
        }
        const validation = validateRecord(s, d);
        if (!validation.ok) {
            const message = `${String(d.id)}: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
            emit({
                type: "SKIP_RESULT",
                stream: s,
                reason: "shape_check_failed",
                message,
            });
            return;
        }
        emit({
            type: "RECORD",
            stream: s,
            key: d.id,
            data: d,
            emitted_at: emittedAt,
        });
        total++;
    };
    const needRollouts = requested.has("sessions") || requested.has("messages") || requested.has("function_calls");
    const rolloutAggregates = new Map();
    const newMtimes = { ...fileMtimes };
    const newFileCursors = {};
    const scanStartedAtMs = Date.now();
    const sessionsSourceMtimeMs = fileMtimeMs(dirs.stateDbPath);
    let parsedRolloutFiles = 0;
    const threadFingerprints = openCarryForwardCursor(readPriorThreadFingerprints(startMsg));
    const inventory = await buildLocalSourceInventory("codex", dirs.codexHome, CODEX_KNOWN_LOCAL_STORES);
    await emitCoverageDiagnostics({ emitRecord, inventory, requested });
    await assertRequestedCodexSources(dirs, requested);
    await emitLocalInventoryStreams({
        codexHome: dirs.codexHome,
        emitRecord,
        inventory,
        nowIso,
        requested,
        state: startMsg.state || {},
    });
    if (needRollouts) {
        const rolloutScan = await scanRollouts({
            activeQuietMs: resolveActiveRolloutQuietMs(),
            baseDir: dirs.baseDir,
            fileCursors,
            fileMtimes,
            newFileCursors,
            newMtimes,
            requested,
            emitRecord,
            rolloutAggregates,
            scanStartedAtMs,
        });
        parsedRolloutFiles = rolloutScan.parsedFiles;
    }
    if (requested.has("sessions") &&
        (parsedRolloutFiles > 0 || readPriorSessionsSourceMtimeMs(startMsg) !== sessionsSourceMtimeMs)) {
        emitSessions({
            stateDbPath: dirs.stateDbPath,
            rolloutAggregates,
            emitRecord,
            cursor: threadFingerprints,
        });
        await waitForEmitDrain();
    }
    if (requested.has("rules")) {
        await emitRulesStream(dirs.rulesDir, emitRecord);
    }
    if (requested.has("prompts")) {
        await emitPromptsStream(dirs.promptsDir, emitRecord);
    }
    if (requested.has("skills")) {
        await emitSkillsStream(dirs.skillsDir, emitRecord);
    }
    emitStateCursors({ requested, newFileCursors, newMtimes, nowIso, sessionsSourceMtimeMs, threadFingerprints });
    await waitForEmitDrain();
    emit({ type: "DONE", status: "succeeded", records_emitted: total });
    flushAndExit(0);
}
if (isMainModule(import.meta.url)) {
    main().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        emit({
            type: "DONE",
            status: "failed",
            records_emitted: 0,
            error: { message: msg, retryable: false },
        });
        flushAndExit(1);
    });
}
