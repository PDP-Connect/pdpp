#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface as createFileReader } from "node:readline";
import { runConnector } from "../../src/connector-runtime.js";
import { isMainModule } from "../../src/is-main-module.js";
import { buildLocalSourceInventory, listDirectoryInventory, } from "../../src/local-source-inventory.js";
import { safeTextPreview } from "../../src/safe-text-preview.js";
import { ATTACHMENT_PREVIEW_CHARS, applyProjectDirScope, BYTES_PER_MB, buildMemoryNoteRecord, buildSkillRecord, buildSlashCommandRecord, extractContent, LINE_PROGRESS_INTERVAL, MESSAGE_CONTENT_PREVIEW_CHARS, makeEmptySessionAccumulator, mergeSessionObservations, parseCsvEnv, parseFrontmatter, SESSION_DIR_PREFIX_RE, TOOL_RESULT_PREVIEW_CHARS, textPreview, widenSessionTimeRange, } from "./parsers.js";
import { validateRecord } from "./schemas.js";
const nowIso = () => new Date().toISOString();
const MD_FILE_RE = /\.md$/i;
export const CLAUDE_CODE_KNOWN_LOCAL_STORES = [
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
export function makeJsonlObservations(forcedSessionId) {
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
export function observeJsonlFields(obj, obs, forcedSessionId) {
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
function updateSessionAccumulatorFromCurrentLine(sessionAccumulators, projectDir, obs, obj, messageCountDelta) {
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
export function isMessageType(type) {
    return type === "user" || type === "assistant";
}
export function isAttachmentType(type) {
    return (type === "attachment" || type === "file-history-snapshot" || type === "permission-mode" || type === "last-prompt");
}
export function buildMessageRecord(obj, sessionId, uuid) {
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
export function buildAttachmentRecord(obj, sessionId, uuid) {
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
export async function processJsonlLine({ buildOnly, deps, obj, obs }) {
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
export async function emitSessionsFromAccumulators({ emitRecord, requested, sessionAccumulators, }) {
    if (!requested.has("sessions")) {
        return;
    }
    for (const session of sessionAccumulators.values()) {
        await emitRecord("sessions", { ...session });
    }
}
async function emitToolResultFile(args) {
    let buf;
    try {
        buf = await readFile(args.full, "utf8");
    }
    catch {
        return;
    }
    const rel = args.full.slice(args.toolResultsDir.length + 1);
    const previewResult = safeTextPreview(buf, TOOL_RESULT_PREVIEW_CHARS);
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
async function processToolResultEntry(ent, args) {
    if (!(ent.isFile() || ent.isSymbolicLink())) {
        return;
    }
    let st;
    try {
        st = statSync(args.full);
    }
    catch {
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
async function walkToolResults(args) {
    const { sessionDir, sessionId, projectDir, requested, emitRecord, fileMtimes, newMtimes } = args;
    const toolResultsDir = join(sessionDir, "tool-results");
    try {
        await readdir(toolResultsDir);
    }
    catch {
        return;
    }
    const walk = async (dir) => {
        let items;
        try {
            items = await readdir(dir, { withFileTypes: true });
        }
        catch {
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
async function readFilesRecursively(rootDir, predicate) {
    const out = [];
    const walk = async (dir, prefix) => {
        let items;
        try {
            items = await readdir(dir, { withFileTypes: true });
        }
        catch {
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
function updateSessionAccumulator(sessionAccumulators, projectDir, obs) {
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
async function parseJsonlFile(args) {
    const { buildOnly, path, projectDir, requested, emit, emitRecord, sessionAccumulators, forcedSessionId } = args;
    const obs = makeJsonlObservations(forcedSessionId);
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
            updateSessionAccumulatorFromCurrentLine(sessionAccumulators, projectDir, obs, obj, obs.messageCount - messageCountBeforeLine);
        }
    }
    return obs.sessionId;
}
function markFileMtimeAndShouldSkip(fileMtimes, newMtimes, path, mtime) {
    newMtimes[path] = mtime;
    return fileMtimes[path] === mtime;
}
async function emitSkills({ claudeHome, requested, emitRecord, fileMtimes, newMtimes }) {
    if (!requested.has("skills")) {
        return;
    }
    const skillsDir = join(claudeHome, "skills");
    let entries;
    try {
        entries = await readdir(skillsDir, { withFileTypes: true });
    }
    catch {
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
        let st;
        let raw;
        try {
            st = statSync(skillPath);
        }
        catch {
            continue;
        }
        if (markFileMtimeAndShouldSkip(fileMtimes, newMtimes, skillPath, st.mtimeMs)) {
            continue;
        }
        try {
            raw = await readFile(skillPath, "utf8");
        }
        catch {
            continue;
        }
        const { frontmatter, body } = parseFrontmatter(raw);
        await emitRecord("skills", buildSkillRecord({ name: ent.name, frontmatter, body, path: skillPath, mtimeMs: st.mtimeMs }));
    }
}
async function processSlashCommandFile(args) {
    if (!args.name.endsWith(".md")) {
        return;
    }
    let st;
    let raw;
    try {
        st = statSync(args.full);
    }
    catch {
        return;
    }
    if (markFileMtimeAndShouldSkip(args.fileMtimes, args.newMtimes, args.full, st.mtimeMs)) {
        return;
    }
    try {
        raw = await readFile(args.full, "utf8");
    }
    catch {
        return;
    }
    const { frontmatter, body } = parseFrontmatter(raw);
    const base = basename(args.name, ".md");
    const idPath = args.prefix ? `${args.prefix}/${base}` : base;
    await args.emitRecord("slash_commands", buildSlashCommandRecord({ idPath, base, frontmatter, body, path: args.full, mtimeMs: st.mtimeMs }));
}
async function emitSlashCommands({ claudeHome, requested, emitRecord, fileMtimes, newMtimes, }) {
    if (!requested.has("slash_commands")) {
        return;
    }
    const commandsDir = join(claudeHome, "commands");
    const walk = async (dir, prefix) => {
        let items;
        try {
            items = await readdir(dir, { withFileTypes: true });
        }
        catch {
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
async function emitProjectMemoryNotes({ emitRecord, fileMtimes, newMtimes, projectDir, projectPath, requested, }) {
    if (!requested.has("memory_notes")) {
        return;
    }
    const memoryDir = join(projectPath, "memory");
    const files = await readFilesRecursively(memoryDir, (ent) => (ent.isFile() || ent.isSymbolicLink()) && MD_FILE_RE.test(ent.name));
    for (const { fullPath, relPath } of files) {
        let st;
        let raw;
        try {
            st = statSync(fullPath);
        }
        catch {
            continue;
        }
        if (markFileMtimeAndShouldSkip(fileMtimes, newMtimes, fullPath, st.mtimeMs)) {
            continue;
        }
        try {
            raw = await readFile(fullPath, "utf8");
        }
        catch {
            continue;
        }
        const { frontmatter, body } = parseFrontmatter(raw);
        await emitRecord("memory_notes", buildMemoryNoteRecord({ projectDir, relPath, frontmatter, body, path: fullPath, mtimeMs: st.mtimeMs }));
    }
}
async function processJsonlFile({ args, forcedSessionId, path, projectDir }) {
    let st;
    try {
        st = statSync(path);
    }
    catch {
        return;
    }
    const mtime = st.mtimeMs;
    if (args.fileMtimes[path] === mtime) {
        args.newMtimes[path] = mtime;
        return;
    }
    await args.emit({
        type: "PROGRESS",
        message: `Claude Code phase=${args.buildOnly ? "index" : "emit"} pass=${args.buildOnly ? "index" : "emit"} file_size_mb=${(st.size / BYTES_PER_MB).toFixed(1)}`,
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
async function processTopLevelJsonl(entries, projectPath, projectDir, args) {
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
async function readSubagentFiles(subagentsDir) {
    const files = await readFilesRecursively(subagentsDir, (ent) => (ent.isFile() || ent.isSymbolicLink()) && ent.name.endsWith(".jsonl"));
    return files.map((file) => file.relPath);
}
async function processSessionDir(sessEnt, projectPath, projectDir, args) {
    const sessionId = sessEnt.name;
    const sessionDir = join(projectPath, sessionId);
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
async function scanProjectDir(projectDir, args) {
    const projectPath = join(args.baseDir, projectDir);
    let entries;
    try {
        entries = await readdir(projectPath, { withFileTypes: true });
    }
    catch {
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
    await processTopLevelJsonl(entries, projectPath, projectDir, args);
    const sessionDirs = entries.filter((e) => e.isDirectory() && SESSION_DIR_PREFIX_RE.test(e.name));
    for (const sessEnt of sessionDirs) {
        await processSessionDir(sessEnt, projectPath, projectDir, args);
    }
}
async function listProjectDirs(baseDir, emit) {
    let projectDirs;
    try {
        projectDirs = (await readdir(baseDir)).filter((name) => !name.startsWith("."));
    }
    catch {
        await emit({
            type: "SKIP_RESULT",
            stream: "sessions",
            reason: "claude_dir_not_found",
            message: "Claude Code projects directory not readable",
        });
        return null;
    }
    const include = parseCsvEnv(process.env.CLAUDE_CODE_PROJECT_INCLUDE);
    const exclude = parseCsvEnv(process.env.CLAUDE_CODE_PROJECT_EXCLUDE);
    return applyProjectDirScope(projectDirs, include, exclude);
}
export async function scanProjectDirs(args) {
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
async function isReadableDirectory(path) {
    try {
        const st = await stat(path);
        return st.isDirectory();
    }
    catch {
        return false;
    }
}
async function assertRequestedClaudeSources(input) {
    const missing = [];
    const needsProjects = input.requested.has("sessions") ||
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
async function emitCoverageDiagnostics(input) {
    if (!input.requested.has("coverage_diagnostics")) {
        return;
    }
    for (const record of input.inventory.coverage) {
        await input.emitRecord("coverage_diagnostics", record);
    }
}
async function emitLocalInventoryStreams(input) {
    for (const [stream, records] of input.inventory.recordsByStream) {
        if (!input.requested.has(stream)) {
            continue;
        }
        for (const record of records) {
            await input.emitRecord(stream, record);
        }
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
        for (const record of records) {
            await input.emitRecord("file_history", record);
        }
    }
}
async function runSkillsAndCommands(claudeHome, requested, emit, emitRecord, state) {
    try {
        await emitSkills({
            claudeHome,
            requested,
            emitRecord,
            fileMtimes: state.skillsMtimes,
            newMtimes: state.newSkillsMtimes,
        });
    }
    catch {
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
    }
    catch {
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
function streamFileMtimes(state, stream) {
    return state[stream]?.file_mtimes;
}
if (isMainModule(import.meta.url)) {
    runConnector({
        name: "claude_code",
        validateRecord,
        async collect({ state, requested, emit, emitRecord }) {
            const claudeHome = process.env.CLAUDE_CODE_HOME || join(homedir(), ".claude");
            const baseDir = process.env.CLAUDE_CODE_PROJECTS_DIR || join(claudeHome, "projects");
            const inventory = await buildLocalSourceInventory("claude_code", claudeHome, CLAUDE_CODE_KNOWN_LOCAL_STORES);
            await emitCoverageDiagnostics({ emitRecord, inventory, requested });
            await assertRequestedClaudeSources({ baseDir, claudeHome, requested });
            const typedState = state;
            const messageFileMtimes = streamFileMtimes(typedState, "messages") ?? typedState.file_mtimes ?? {};
            const sessionFileMtimes = streamFileMtimes(typedState, "sessions") ?? {};
            const skillsMtimes = streamFileMtimes(typedState, "skills") ?? {};
            const slashCommandMtimes = streamFileMtimes(typedState, "slash_commands") ?? {};
            const memoryNoteMtimes = streamFileMtimes(typedState, "memory_notes") ?? {};
            const newSkillsMtimes = { ...skillsMtimes };
            const newSlashCommandMtimes = { ...slashCommandMtimes };
            const newMemoryNoteMtimes = { ...memoryNoteMtimes };
            await emitLocalInventoryStreams({ claudeHome, inventory, requested, emitRecord });
            await runSkillsAndCommands(claudeHome, requested, emit, emitRecord, {
                skillsMtimes,
                newSkillsMtimes,
                slashCommandMtimes,
                newSlashCommandMtimes,
            });
            const needsProjects = requested.has("sessions") ||
                requested.has("messages") ||
                requested.has("attachments") ||
                requested.has("memory_notes");
            if (!needsProjects) {
                return;
            }
            const newMessageFileMtimes = { ...messageFileMtimes };
            const newSessionFileMtimes = { ...sessionFileMtimes };
            const sessionAccumulators = new Map();
            await scanProjectDirs({
                baseDir,
                buildOnly: true,
                emit,
                emitRecord,
                fileMtimes: sessionFileMtimes,
                newMtimes: newSessionFileMtimes,
                memoryNoteMtimes,
                newMemoryNoteMtimes,
                requested,
                sessionAccumulators,
            });
            await emitSessionsFromAccumulators({ emitRecord, requested, sessionAccumulators });
            if (requested.has("sessions")) {
                await emit({
                    type: "STATE",
                    stream: "sessions",
                    cursor: { file_mtimes: newSessionFileMtimes, fetched_at: nowIso() },
                });
            }
            if (requested.has("memory_notes")) {
                await emit({
                    type: "STATE",
                    stream: "memory_notes",
                    cursor: { file_mtimes: newMemoryNoteMtimes, fetched_at: nowIso() },
                });
            }
            if (requested.has("messages") || requested.has("attachments")) {
                await scanProjectDirs({
                    baseDir,
                    buildOnly: false,
                    emit,
                    emitRecord,
                    fileMtimes: messageFileMtimes,
                    newMtimes: newMessageFileMtimes,
                    requested,
                    sessionAccumulators,
                });
            }
            if (requested.has("messages") || requested.has("attachments")) {
                await emit({
                    type: "STATE",
                    stream: "messages",
                    cursor: { file_mtimes: newMessageFileMtimes, fetched_at: nowIso() },
                });
            }
        },
    });
}
