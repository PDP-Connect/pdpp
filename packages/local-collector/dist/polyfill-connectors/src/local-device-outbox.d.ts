export type LocalDeviceOutboxKind = "record_batch" | "checkpoint" | "gap" | "blob_upload";
export type LocalDeviceOutboxStatus = "ready" | "leased" | "succeeded" | "dead_letter";
export interface LocalDeviceOutboxItem {
    acknowledged_at: string | null;
    attempt_count: number;
    body_hash: string;
    created_at: string;
    id: string;
    insert_order: number;
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
    excludeKinds?: readonly LocalDeviceOutboxKind[];
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
export interface LocalDeviceOutboxRequeueDeadLettersInput {
    dryRun?: boolean;
    kind?: LocalDeviceOutboxKind;
    limit?: number;
    sourceInstanceId?: string;
}
export interface LocalDeviceOutboxRequeueDeadLettersResult {
    matched: number;
    requeued: number;
}
export interface LocalDeviceOutboxDeadLetterErrorClass {
    count: number;
    error_class: string;
}
export interface LocalDeviceOutboxDeadLetterErrorSummary {
    dead_letter_count: number;
    null_error_count: number;
    top_classes: LocalDeviceOutboxDeadLetterErrorClass[];
}
export interface LocalDeviceOutboxDeadLetterErrorSummaryInput {
    limit?: number;
    sourceInstanceId?: string;
}
export declare class LocalDeviceOutbox {
    #private;
    constructor(options: LocalDeviceOutboxOptions);
    close(): void;
    enqueue(input: LocalDeviceOutboxEnqueueInput): LocalDeviceOutboxItem;
    claimReady(input: LocalDeviceOutboxClaimInput): LocalDeviceOutboxItem[];
    peekReady(input?: {
        sourceInstanceId?: string;
    }): LocalDeviceOutboxItem | null;
    acknowledge(input: LocalDeviceOutboxLeaseInput): void;
    failRetryable(input: LocalDeviceOutboxFailInput): void;
    deadLetter(input: LocalDeviceOutboxDeadLetterInput): void;
    renewLease(input: LocalDeviceOutboxRenewInput): LocalDeviceOutboxItem;
    recoverExpiredLeases(input?: {
        sourceInstanceId?: string;
    }): number;
    get(id: string): LocalDeviceOutboxItem | null;
    deleteSucceeded(id: string): boolean;
    backupTo(path: string): void;
    requeueDeadLetters(input?: LocalDeviceOutboxRequeueDeadLettersInput): LocalDeviceOutboxRequeueDeadLettersResult;
    hasNonSucceededWork(input: {
        excludeKinds?: readonly LocalDeviceOutboxKind[];
        kinds?: readonly LocalDeviceOutboxKind[];
        sourceInstanceId: string;
    }): boolean;
    hasNonSucceededPredecessor(input: {
        beforeInsertOrder: number;
        kinds: readonly LocalDeviceOutboxKind[];
        sourceInstanceId: string;
    }): boolean;
    countOpenGaps(input: {
        sourceInstanceId: string;
    }): number;
    listByKind(input: {
        kind: LocalDeviceOutboxKind;
        sourceInstanceId: string;
        statuses?: readonly LocalDeviceOutboxStatus[];
    }): LocalDeviceOutboxItem[];
    maxRecordBatchSeq(input: {
        sourceInstanceId: string;
    }): number;
    list(input?: {
        sourceInstanceId?: string;
    }): LocalDeviceOutboxItem[];
    summary(input?: {
        sourceInstanceId?: string;
    }): LocalDeviceOutboxSummary;
    deadLetterErrorSummary(input?: LocalDeviceOutboxDeadLetterErrorSummaryInput): LocalDeviceOutboxDeadLetterErrorSummary;
}
export declare function buildLocalDeviceOutboxId(input: BuildLocalDeviceOutboxIdInput): string;
export declare function classifyDeadLetterError(raw: string): string;
