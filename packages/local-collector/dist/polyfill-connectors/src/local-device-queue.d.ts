import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.js";
export type LocalDeviceQueueStatus = "pending" | "in_flight" | "sent" | "permanent_failure";
export interface LocalDeviceQueueItem {
    available_at: string;
    batch_id: string;
    batch_seq: number;
    created_at: string;
    last_error?: string;
    records: LocalDeviceRecordEnvelope[];
    retry_count: number;
    source_instance_id: string;
    status: LocalDeviceQueueStatus;
    updated_at: string;
}
export interface LocalDeviceQueueOptions {
    clock?: () => Date;
    path: string;
    retryBackoffMs?: (retryCount: number) => number;
}
export declare class LocalDeviceQueue {
    #private;
    constructor(options: LocalDeviceQueueOptions);
    enqueue(input: {
        batchId: string;
        batchSeq: number;
        records: LocalDeviceRecordEnvelope[];
        sourceInstanceId: string;
    }): Promise<LocalDeviceQueueItem>;
    dequeueReady(): Promise<LocalDeviceQueueItem | null>;
    markSent(batchId: string): Promise<void>;
    markRetry(batchId: string, error: string): Promise<void>;
    markPermanentFailure(batchId: string, error: string): Promise<void>;
    list(): Promise<LocalDeviceQueueItem[]>;
}
