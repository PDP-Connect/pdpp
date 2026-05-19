import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export class LocalDeviceQueue {
    #clock;
    #path;
    #retryBackoffMs;
    constructor(options) {
        this.#clock = options.clock ?? (() => new Date());
        this.#path = options.path;
        this.#retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
    }
    async enqueue(input) {
        if (input.records.length === 0) {
            throw new Error("cannot enqueue an empty local device batch");
        }
        const items = await this.#readItems();
        if (items.some((item) => item.batch_id === input.batchId)) {
            throw new Error(`local device batch already queued: ${input.batchId}`);
        }
        const now = this.#clock().toISOString();
        const item = {
            available_at: now,
            batch_id: input.batchId,
            batch_seq: input.batchSeq,
            created_at: now,
            records: input.records,
            retry_count: 0,
            source_instance_id: input.sourceInstanceId,
            status: "pending",
            updated_at: now,
        };
        await this.#writeItems([...items, item]);
        return item;
    }
    async dequeueReady() {
        const now = this.#clock().toISOString();
        const items = await this.#readItems();
        const index = items.findIndex((item) => isReadyHeadOfSource(item, items, now));
        if (index < 0) {
            return null;
        }
        const item = items[index];
        if (!item) {
            return null;
        }
        const updated = { ...item, status: "in_flight", updated_at: now };
        items[index] = updated;
        await this.#writeItems(items);
        return updated;
    }
    async markSent(batchId) {
        await this.#updateItem(batchId, (item, now) => ({ ...item, status: "sent", updated_at: now }));
    }
    async markRetry(batchId, error) {
        await this.#updateItem(batchId, (item, now) => {
            const retryCount = item.retry_count + 1;
            return {
                ...item,
                available_at: new Date(this.#clock().getTime() + this.#retryBackoffMs(retryCount)).toISOString(),
                last_error: error,
                retry_count: retryCount,
                status: "pending",
                updated_at: now,
            };
        });
    }
    async markPermanentFailure(batchId, error) {
        await this.#updateItem(batchId, (item, now) => ({
            ...item,
            last_error: error,
            status: "permanent_failure",
            updated_at: now,
        }));
    }
    async list() {
        return await this.#readItems();
    }
    async #updateItem(batchId, update) {
        const items = await this.#readItems();
        const index = items.findIndex((item) => item.batch_id === batchId);
        const item = items[index];
        if (!item) {
            throw new Error(`local device batch not found: ${batchId}`);
        }
        items[index] = update(item, this.#clock().toISOString());
        await this.#writeItems(items);
    }
    async #readItems() {
        try {
            const raw = await readFile(this.#path, "utf8");
            if (!raw.trim()) {
                return [];
            }
            const parsed = JSON.parse(raw);
            return [...(parsed.items ?? [])].sort(compareQueueItems);
        }
        catch (error) {
            if (isNotFoundError(error)) {
                return [];
            }
            throw error;
        }
    }
    async #writeItems(items) {
        await mkdir(dirname(this.#path), { recursive: true });
        const ordered = [...items].sort(compareQueueItems);
        const tmpPath = `${this.#path}.tmp`;
        await writeFile(tmpPath, `${JSON.stringify({ items: ordered }, null, 2)}\n`);
        await rename(tmpPath, this.#path);
    }
}
function compareQueueItems(a, b) {
    const source = a.source_instance_id.localeCompare(b.source_instance_id);
    if (source !== 0) {
        return source;
    }
    return a.batch_seq - b.batch_seq;
}
function isReadyHeadOfSource(item, items, now) {
    if (item.status !== "pending" || item.available_at > now) {
        return false;
    }
    return !items.some((other) => other.source_instance_id === item.source_instance_id &&
        other.batch_seq < item.batch_seq &&
        other.status !== "sent" &&
        other.status !== "permanent_failure");
}
function defaultRetryBackoffMs(retryCount) {
    return Math.min(60_000, 1000 * 2 ** Math.max(0, retryCount - 1));
}
function isNotFoundError(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
