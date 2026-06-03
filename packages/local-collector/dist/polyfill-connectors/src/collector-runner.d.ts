import type { EmittedMessage, StartMessage } from "./connector-runtime-protocol.js";
import { type EnrollmentExchangeResponse, type HeartbeatOutboxDiagnostics, LocalDeviceClient } from "./local-device-client.js";
import { type LocalDeviceRecordEnvelope } from "./local-device-envelope.js";
import { LocalDeviceOutbox, type LocalDeviceOutboxItem, type LocalDeviceOutboxSummary } from "./local-device-outbox.js";
import type { LocalDeviceQueue } from "./local-device-queue.js";
import { type ConnectorPlacementInput, type RuntimeBindingName } from "./runtime-capabilities.js";
export declare const COLLECTOR_STDERR_MAX_BYTES: number;
export interface CollectorOutboxPolicy {
    drainBatchSize: number;
    leaseMs: number;
    maxAttempts: number;
    maxDrainDurationMs: number;
    maxDrainIterations: number;
    maxEnqueuedBatchesPerRun: number;
    maxQueueDepth: number;
    retryBackoffMs: number;
}
export declare const DEFAULT_COLLECTOR_OUTBOX_POLICY: Readonly<CollectorOutboxPolicy>;
export interface CollectorEnrollmentConfig {
    baseUrl: string;
    code: string;
    deviceLabel?: string;
}
export declare function enrollCollector(config: CollectorEnrollmentConfig): Promise<EnrollmentExchangeResponse>;
export interface CollectorConnectorSpec extends ConnectorPlacementInput {
    readonly args: readonly string[];
    readonly command: string;
    readonly connector_id: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly streams: readonly string[];
    readonly streamsToBackfill?: readonly string[];
}
export interface CollectorRunConfig {
    abortSignal?: AbortSignal;
    baseUrl: string;
    batchSize?: number;
    collectorHolderId?: string;
    connector: CollectorConnectorSpec;
    deviceId: string;
    deviceToken: string;
    outboxPath?: string;
    outboxPolicy?: Partial<CollectorOutboxPolicy>;
    queuePath: string;
    runId?: string;
    sourceInstanceId: string;
}
export declare const COLLECTOR_COVERAGE_STATUSES: readonly ["collected", "inventory_only", "excluded", "deferred", "missing", "unsupported", "unaccounted"];
export type CollectorCoverageStatus = (typeof COLLECTOR_COVERAGE_STATUSES)[number];
export interface CollectorCompletenessSummary {
    byStore: Readonly<Record<string, CollectorCoverageStatus>>;
    countsByStatus: Readonly<Record<CollectorCoverageStatus, number>>;
    fullyAccounted: boolean;
    storeCount: number;
    unaccountedStores: readonly string[];
}
export interface CollectorRunResult {
    completeness: CollectorCompletenessSummary | null;
    done: Extract<EmittedMessage, {
        type: "DONE";
    }> | null;
    enqueuedBatches: number;
    flushedState: Readonly<Record<string, unknown>> | null;
    outboxSummary: LocalDeviceOutboxSummary;
    priorState: Readonly<Record<string, unknown>>;
    recordsQueued: number;
    recoveredLeases: number;
    satisfiedBindings: readonly RuntimeBindingName[];
    scanBudgetExceeded: boolean;
    sentBatches: number;
    skippedScanForBacklog: boolean;
    statePutFailed: boolean;
    streamingBufferHighWaterMark: number;
}
export declare class CollectorStateReadError extends Error {
    constructor(message: string, cause: unknown);
}
export declare function runCollectorConnector(config: CollectorRunConfig): Promise<CollectorRunResult>;
export declare function summarizeCollectorCompleteness(coverageByStore: Map<string, CollectorCoverageStatus> | null): CollectorCompletenessSummary | null;
export declare function buildCollectorStartMessage(streams: readonly string[], streamsToBackfill?: readonly string[], priorState?: Readonly<Record<string, unknown>> | null): StartMessage;
export declare function transformRecordsToCollectorEnvelopes(input: {
    batchId: string;
    batchSeq: number;
    connectorId: string;
    deviceId: string;
    messages: readonly EmittedMessage[];
    sourceInstanceId: string;
}): LocalDeviceRecordEnvelope[];
export interface RecordBatchPayload {
    batchId: string;
    batchSeq: number;
    connectorId: string;
    deviceId: string;
    records: LocalDeviceRecordEnvelope[];
    sourceInstanceId: string;
}
export interface CheckpointPayload {
    connectorId: string;
    sourceInstanceId: string;
    state: Record<string, unknown>;
}
export type GapReason = "policy_budget" | "connector_child_failure";
export interface GapPayload {
    connectorId: string;
    details?: string;
    firstSeenAt: string;
    firstSeenRunId?: string;
    nextAttemptBackoffMs: number;
    reason: GapReason;
    retryable: boolean;
    sourceInstanceId: string;
    stream?: string;
    streamBoundary?: string;
}
export interface DrainCollectorOutboxInput {
    abortSignal?: AbortSignal;
    client: Pick<LocalDeviceClient, "ackLocalCollectorGap" | "ingestBatch" | "putSourceInstanceState">;
    connectorId: string;
    holderId: string;
    outbox: LocalDeviceOutbox;
    policy: CollectorOutboxPolicy;
    sourceInstanceId?: string;
}
export interface DrainCollectorOutboxResult {
    deadLettered: number;
    durationBudgetExceeded: boolean;
    failed: number;
    iterations: number;
    sent: number;
    sentByKind: Readonly<Partial<Record<LocalDeviceOutboxItem["kind"], number>>>;
}
export declare function drainCollectorOutbox(input: DrainCollectorOutboxInput): Promise<DrainCollectorOutboxResult>;
export declare const LOCAL_COLLECTOR_LIFECYCLE_STATES: readonly ["healthy_idle", "draining", "retryable_backlog", "dead_letter", "stale_lease", "coverage_missing"];
export type LocalCollectorLifecycleState = (typeof LOCAL_COLLECTOR_LIFECYCLE_STATES)[number];
export interface LocalCollectorLifecycleInput {
    coverageObserved: boolean | null;
    recordBatchCount: number;
    summary: LocalDeviceOutboxSummary;
}
export declare function deriveLocalCollectorLifecycleState(input: LocalCollectorLifecycleInput): LocalCollectorLifecycleState;
export declare function buildHeartbeatOutboxDiagnostics(summary: LocalDeviceOutboxSummary, options?: {
    backlogOpen?: number;
}): HeartbeatOutboxDiagnostics;
export declare function drainCollectorQueue(input: {
    abortSignal?: AbortSignal;
    client: Pick<LocalDeviceClient, "ingestBatch">;
    queue: LocalDeviceQueue;
}): Promise<number>;
export declare function recoverAndSummarizeOutbox(outbox: Pick<LocalDeviceOutbox, "recoverExpiredLeases" | "summary">, input?: {
    sourceInstanceId?: string;
}): {
    recovered: number;
    summary: ReturnType<LocalDeviceOutbox["summary"]>;
};
export interface CollectorChildContext {
    readonly baseUrl: string;
    readonly deviceToken: string;
    readonly runId?: string;
}
