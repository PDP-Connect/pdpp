export type LocalDeviceOutboxKind = "record_batch" | "checkpoint" | "gap" | "blob_upload";
export type LocalDeviceOutboxStatus = "ready" | "leased" | "succeeded" | "dead_letter";
export interface LocalDeviceOutboxItem {
    acknowledged_at: string | null;
    attempt_count: number;
    body_hash: string;
    created_at: string;
    id: string;
    kind: LocalDeviceOutboxKind;
    last_error: string | null;
    lease_epoch: number;
    lease_holder: string | null;
    lease_until: string | null;
    next_attempt_at: string;
    payload: unknown;
    source_instance_id: string;
    status: LocalDeviceOutboxStatus;
    updated_at: string;
}
export interface LocalDeviceOutboxSummary {
    deadLetter: number;
    leased: number;
    oldestReadyAt: string | null;
    ready: number;
    retrying: number;
    staleLeases: number;
    succeeded: number;
    total: number;
}
export interface LocalDeviceOutboxOptions {
    clock?: () => Date;
    path: string;
}
export interface LocalDeviceOutboxEnqueueInput {
    id: string;
    kind: LocalDeviceOutboxKind;
    nextAttemptAt?: Date;
    payload: unknown;
    sourceInstanceId: string;
}
export interface BuildLocalDeviceOutboxIdInput {
    kind: LocalDeviceOutboxKind;
    parts: readonly unknown[];
    sourceInstanceId: string;
}
export interface LocalDeviceOutboxClaimInput {
    holder: string;
    leaseMs: number;
    limit?: number;
    sourceInstanceId?: string;
}
export interface LocalDeviceOutboxLeaseInput {
    holder: string;
    id: string;
    leaseEpoch: number;
}
export interface LocalDeviceOutboxFailInput extends LocalDeviceOutboxLeaseInput {
    error: string;
    retryBackoffMs: number;
}
export interface LocalDeviceOutboxDeadLetterInput extends LocalDeviceOutboxLeaseInput {
    error: string;
}
export interface LocalDeviceOutboxRenewInput extends LocalDeviceOutboxLeaseInput {
    leaseMs: number;
}
export declare class LocalDeviceOutbox {
    #private;
    constructor(options: LocalDeviceOutboxOptions);
    close(): void;
    enqueue(input: LocalDeviceOutboxEnqueueInput): LocalDeviceOutboxItem;
    claimReady(input: LocalDeviceOutboxClaimInput): LocalDeviceOutboxItem[];
    acknowledge(input: LocalDeviceOutboxLeaseInput): void;
    failRetryable(input: LocalDeviceOutboxFailInput): void;
    deadLetter(input: LocalDeviceOutboxDeadLetterInput): void;
    renewLease(input: LocalDeviceOutboxRenewInput): LocalDeviceOutboxItem;
    recoverExpiredLeases(input?: {
        sourceInstanceId?: string;
    }): number;
    get(id: string): LocalDeviceOutboxItem | null;
    list(input?: {
        sourceInstanceId?: string;
    }): LocalDeviceOutboxItem[];
    summary(input?: {
        sourceInstanceId?: string;
    }): LocalDeviceOutboxSummary;
}
export declare function buildLocalDeviceOutboxId(input: BuildLocalDeviceOutboxIdInput): string;
