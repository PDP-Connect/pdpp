#!/usr/bin/env node
import { createReadStream, existsSync, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface as createFileReader, createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { isMainModule } from "../../src/is-main-module.js";
import { buildLocalSourceInventory, listDirectoryInventory, } from "../../src/local-source-inventory.js";
import { stringifyForJsonl } from "../../src/safe-emit.js";
import { resourceSet } from "../../src/scope-filters.js";
import { buildPromptRecord, buildRolloutOnlySessionRecord, buildRuleRecord, buildSkillRecord, buildThreadSessionRecord, extendTimestampRange, extractMessageText, isRolloutFile, isSkippableRulesLine, parseFrontmatter, payloadOutputPreview, RULES_SUFFIX_RE, splitRulesLines, TWO_DIGIT_DIR_RE, textPreview, YEAR_DIR_RE, } from "./parsers.js";
import { validateRecord } from "./schemas.js";
const emit = (m) => process.stdout.write(stringifyForJsonl(m));
const flushAndExit = (code) => {
    if (process.stdout.writableLength > 0) {
        process.stdout.once("drain", () => process.exit(code));
        setTimeout(() => process.exit(code), 3000).unref();
    }
    else {
        process.exit(code);
    }
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
async function* iterJsonlLines(path) {
    const r = createFileReader({
        input: createReadStream(path, { encoding: "utf8" }),
        terminal: false,
    });
    for await (const line of r) {
        if (!line.trim()) {
            continue;
        }
        try {
            yield JSON.parse(line);
        }
        catch {
        }
    }
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
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
            type: "PROGRESS",
            message: `state_5.sqlite unreadable (${msg}); falling back to rollouts only`,
        });
        return null;
    }
}
function queryThreadsRows(db) {
    try {
        const rawRows = db.prepare(THREADS_QUERY).all();
        return rawRows;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({
            type: "PROGRESS",
            message: `threads query failed (${msg}); falling back to rollouts only`,
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
    }
}
export function makeRolloutParseState() {
    return {
        sessionId: null,
        sessionMeta: null,
        firstTimestamp: null,
        lastTimestamp: null,
        messageCount: 0,
        functionCallCount: 0,
        pendingCalls: new Map(),
        lineCount: 0,
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
export function processRolloutLine({ deps, file, obj, state }) {
    state.lineCount++;
    if (state.lineCount % PROGRESS_EVERY === 0) {
        deps.progress(`  ${file}: ${state.lineCount} lines parsed`);
    }
    const ts = obj.timestamp || null;
    const range = { firstTs: state.firstTimestamp, lastTs: state.lastTimestamp };
    extendTimestampRange(range, ts);
    state.firstTimestamp = range.firstTs;
    state.lastTimestamp = range.lastTs;
    if (obj.type === "session_meta") {
        state.sessionMeta = obj.payload || {};
        state.sessionId = state.sessionMeta.id || null;
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
}
export function emitSessionsFromMaps({ threadsMap, rolloutAggregates, emitRecord }) {
    const emittedSessionIds = new Set();
    for (const [id, t] of threadsMap) {
        emitRecord("sessions", buildThreadSessionRecord(id, t, rolloutAggregates.get(id)));
        emittedSessionIds.add(id);
    }
    for (const [id, agg] of rolloutAggregates) {
        if (emittedSessionIds.has(id)) {
            continue;
        }
        emitRecord("sessions", buildRolloutOnlySessionRecord(id, agg));
    }
}
async function parseRolloutFile(args) {
    const state = makeRolloutParseState();
    const deps = {
        emitRecord: args.emitRecord,
        progress: (message) => {
            emit({ type: "PROGRESS", message });
        },
        requested: args.requested,
    };
    for await (const obj of iterJsonlLines(args.path)) {
        processRolloutLine({ obj, state, deps, file: args.file });
    }
    flushPendingCalls(state, deps);
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
}
async function processRolloutEntry(entry, args) {
    let st;
    try {
        st = statSync(entry.path);
    }
    catch {
        return false;
    }
    const mtime = st.mtimeMs;
    if (args.fileMtimes[entry.path] === mtime) {
        args.newMtimes[entry.path] = mtime;
        return true;
    }
    emit({
        type: "PROGRESS",
        message: `Parsing ${entry.year}/${entry.month}/${entry.day}/${entry.file} (${(st.size / 1024 / 1024).toFixed(1)}MB)`,
    });
    await parseRolloutFile({
        path: entry.path,
        file: entry.file,
        requested: args.requested,
        emitRecord: args.emitRecord,
        rolloutAggregates: args.rolloutAggregates,
    });
    args.newMtimes[entry.path] = mtime;
    return true;
}
async function scanRollouts(args) {
    const baseExists = (await listIfExists(args.baseDir)) !== null;
    if (!baseExists) {
        emit({
            type: "PROGRESS",
            message: `${args.baseDir} not readable`,
        });
        return;
    }
    let fileCount = 0;
    for await (const entry of walkRollouts(args.baseDir)) {
        fileCount++;
        await processRolloutEntry(entry, args);
    }
    emit({
        type: "PROGRESS",
        message: `Scanned ${fileCount} rollout files`,
    });
}
function emitSessions({ stateDbPath, rolloutAggregates, emitRecord }) {
    const { map: threadsById } = loadThreadsMap(stateDbPath);
    emitSessionsFromMaps({ threadsMap: threadsById, rolloutAggregates, emitRecord });
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
function emitStateCursors({ requested, newMtimes, nowIso }) {
    if (requested.has("sessions")) {
        emit({ type: "STATE", stream: "sessions", cursor: { fetched_at: nowIso() } });
    }
    if (requested.has("messages") || requested.has("function_calls")) {
        const cursorStream = requested.has("messages") ? "messages" : "function_calls";
        emit({
            type: "STATE",
            stream: cursorStream,
            cursor: { file_mtimes: newMtimes, fetched_at: nowIso() },
        });
    }
    for (const s of ["rules", "prompts", "skills"]) {
        if (requested.has(s)) {
            emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
        }
    }
    for (const s of [
        "history",
        "session_index",
        "logs",
        "shell_snapshots",
        "config_inventory",
        "cache_inventory",
        "coverage_diagnostics",
    ]) {
        if (requested.has(s)) {
            emit({ type: "STATE", stream: s, cursor: { fetched_at: nowIso() } });
        }
    }
}
async function emitLocalInventoryStreams(input) {
    const inventory = await buildLocalSourceInventory("codex", input.codexHome, CODEX_KNOWN_LOCAL_STORES);
    for (const [stream, records] of inventory.recordsByStream) {
        if (!input.requested.has(stream)) {
            continue;
        }
        for (const record of records) {
            input.emitRecord(stream, record);
        }
    }
    for (const directoryStream of [
        {
            relativeRoot: "shell-snapshots",
            store: "shell_snapshots",
            stream: "shell_snapshots",
            reason: "shell content requires redaction review before payload collection",
        },
    ]) {
        if (!input.requested.has(directoryStream.stream)) {
            continue;
        }
        const records = await listDirectoryInventory({
            tool: "codex",
            sourceHome: input.codexHome,
            ...directoryStream,
        });
        for (const record of records) {
            input.emitRecord(directoryStream.stream, record);
        }
    }
    if (input.requested.has("coverage_diagnostics")) {
        for (const record of inventory.coverage) {
            input.emitRecord("coverage_diagnostics", record);
        }
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
    await assertRequestedCodexSources(dirs, requested);
    const fileMtimes = readFileMtimes(startMsg);
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
    await emitLocalInventoryStreams({ codexHome: dirs.codexHome, requested, emitRecord });
    if (needRollouts) {
        await scanRollouts({
            baseDir: dirs.baseDir,
            fileMtimes,
            newMtimes,
            requested,
            emitRecord,
            rolloutAggregates,
        });
    }
    if (requested.has("sessions")) {
        emitSessions({ stateDbPath: dirs.stateDbPath, rolloutAggregates, emitRecord });
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
    emitStateCursors({ requested, newMtimes, nowIso });
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
