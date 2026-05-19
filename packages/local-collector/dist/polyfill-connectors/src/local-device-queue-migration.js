import { readFile, rename, stat } from "node:fs/promises";
import { buildLocalDeviceOutboxId } from "./local-device-outbox.js";
const IMPORTABLE_STATUSES = new Set(["pending", "in_flight"]);
export async function inspectLegacyLocalDeviceQueue(path) {
    const items = await readLegacyItems(path);
    if (!items.exists) {
        return {
            exists: false,
            importable: 0,
            invalid: 0,
            path,
            permanentFailure: 0,
            sent: 0,
            total: 0,
        };
    }
    const report = baseInspection(path, true);
    for (const item of items.items) {
        report.total++;
        if (!isLegacyQueueItem(item)) {
            report.invalid++;
            continue;
        }
        if (IMPORTABLE_STATUSES.has(item.status)) {
            report.importable++;
        }
        else if (item.status === "sent") {
            report.sent++;
        }
        else if (item.status === "permanent_failure") {
            report.permanentFailure++;
        }
        else {
            report.invalid++;
        }
    }
    return report;
}
export async function importLegacyLocalDeviceQueue(options) {
    const items = await readLegacyItems(options.queuePath);
    if (!items.exists) {
        return {
            ...(await inspectLegacyLocalDeviceQueue(options.queuePath)),
            imported: 0,
            importedItems: [],
            quarantinePath: null,
        };
    }
    const report = {
        ...baseInspection(options.queuePath, true),
        imported: 0,
        importedItems: [],
        quarantinePath: null,
    };
    for (const item of items.items) {
        report.total++;
        if (!isLegacyQueueItem(item)) {
            report.invalid++;
            continue;
        }
        if (item.status === "sent") {
            report.sent++;
            continue;
        }
        if (item.status === "permanent_failure") {
            report.permanentFailure++;
            continue;
        }
        if (!IMPORTABLE_STATUSES.has(item.status)) {
            report.invalid++;
            continue;
        }
        report.importable++;
        const imported = options.outbox.enqueue({
            id: buildLocalDeviceOutboxId({
                kind: "record_batch",
                parts: ["legacy-json-queue", item.source_instance_id, item.batch_id, item.batch_seq],
                sourceInstanceId: item.source_instance_id,
            }),
            kind: "record_batch",
            payload: {
                batch_id: item.batch_id,
                batch_seq: item.batch_seq,
                imported_from: "legacy-local-device-queue",
                legacy_status: item.status,
                records: item.records,
                source_instance_id: item.source_instance_id,
            },
            sourceInstanceId: item.source_instance_id,
        });
        report.imported++;
        report.importedItems.push(imported);
    }
    report.quarantinePath = await quarantineLegacyQueue(options.queuePath, options.quarantinePath);
    return report;
}
function baseInspection(path, exists) {
    return {
        exists,
        importable: 0,
        invalid: 0,
        path,
        permanentFailure: 0,
        sent: 0,
        total: 0,
    };
}
async function readLegacyItems(path) {
    try {
        await stat(path);
    }
    catch (error) {
        if (isNotFoundError(error)) {
            return { exists: false };
        }
        throw error;
    }
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return { exists: true, items: Array.isArray(parsed.items) ? parsed.items : [parsed.items] };
}
async function quarantineLegacyQueue(queuePath, explicitPath) {
    const quarantinePath = explicitPath ?? `${queuePath}.quarantined-${Date.now()}`;
    await rename(queuePath, quarantinePath);
    return quarantinePath;
}
function isLegacyQueueItem(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const item = value;
    return (typeof item.available_at === "string" &&
        typeof item.batch_id === "string" &&
        typeof item.batch_seq === "number" &&
        typeof item.created_at === "string" &&
        Array.isArray(item.records) &&
        typeof item.retry_count === "number" &&
        typeof item.source_instance_id === "string" &&
        isLegacyQueueStatus(item.status) &&
        typeof item.updated_at === "string");
}
function isLegacyQueueStatus(value) {
    return value === "pending" || value === "in_flight" || value === "sent" || value === "permanent_failure";
}
function isNotFoundError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
