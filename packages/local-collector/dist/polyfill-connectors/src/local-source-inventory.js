import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
function pathHash(tool, relativePath) {
    return createHash("sha256").update(`${tool}:${relativePath}`).digest("hex");
}
function inventoryEntryType(st) {
    if (st.isDirectory()) {
        return "directory";
    }
    if (st.isFile()) {
        return "file";
    }
    return "other";
}
function coverageStatus(classification, exists) {
    if (!exists) {
        return "missing";
    }
    if (classification === "collect") {
        return "collected";
    }
    if (classification === "inventory_only") {
        return "inventory_only";
    }
    if (classification === "exclude") {
        return "excluded";
    }
    if (classification === "defer" || classification === "collect_redacted") {
        return "deferred";
    }
    return "unsupported";
}
async function statKind(path) {
    try {
        const st = await stat(path);
        return {
            exists: true,
            mtimeEpoch: Math.floor(st.mtimeMs / 1000),
            sizeBytes: st.isFile() ? st.size : null,
            type: inventoryEntryType(st),
        };
    }
    catch {
        return { exists: false, mtimeEpoch: null, sizeBytes: null, type: "missing" };
    }
}
export async function buildLocalSourceInventory(tool, sourceHome, stores) {
    const recordsByStream = new Map();
    const coverage = [];
    for (const store of stores) {
        const fullPath = join(sourceHome, store.relativePath);
        const pathMeta = await statKind(fullPath);
        const status = coverageStatus(store.classification, pathMeta.exists);
        coverage.push({
            id: `${store.store}:${status}`,
            store: store.store,
            stream: store.stream,
            status,
            reason: store.reason,
        });
        if (!(pathMeta.exists && store.stream) ||
            (store.classification !== "inventory_only" && store.classification !== "defer")) {
            continue;
        }
        const records = recordsByStream.get(store.stream) ?? [];
        records.push({
            id: `${store.store}:${pathHash(tool, store.relativePath)}`,
            store: store.store,
            relative_path: store.relativePath,
            path_hash: pathHash(tool, store.relativePath),
            type: pathMeta.type,
            size_bytes: pathMeta.sizeBytes,
            mtime_epoch: pathMeta.mtimeEpoch,
            classification: store.classification,
            reason: store.reason,
        });
        recordsByStream.set(store.stream, records);
    }
    return { coverage, recordsByStream };
}
export async function listDirectoryInventory(input) {
    const root = join(input.sourceHome, input.relativeRoot);
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const records = [];
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (ent.name.startsWith(".")) {
            continue;
        }
        const rel = `${input.relativeRoot}/${ent.name}`;
        const full = join(root, ent.name);
        let st;
        try {
            st = statSync(full);
        }
        catch {
            continue;
        }
        records.push({
            id: `${input.store}:${pathHash(input.tool, rel)}`,
            store: input.store,
            relative_path: rel,
            path_hash: pathHash(input.tool, rel),
            type: inventoryEntryType(st),
            size_bytes: st.isFile() ? st.size : null,
            mtime_epoch: Math.floor(st.mtimeMs / 1000),
            classification: "inventory_only",
            reason: input.reason,
        });
    }
    return records;
}
