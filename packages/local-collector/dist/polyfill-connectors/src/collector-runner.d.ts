import type { EmittedMessage, StartMessage } from "./connector-runtime-protocol.js";
import { type EnrollmentExchangeResponse, LocalDeviceClient } from "./local-device-client.js";
import { type LocalDeviceRecordEnvelope } from "./local-device-envelope.js";
import { LocalDeviceQueue } from "./local-device-queue.js";
import { type ConnectorPlacementInput, type RuntimeBindingName } from "./runtime-capabilities.js";
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
    baseUrl: string;
    batchSize?: number;
    connector: CollectorConnectorSpec;
    deviceId: string;
    deviceToken: string;
    queuePath: string;
    runId?: string;
    sourceInstanceId: string;
}
export interface CollectorRunResult {
    done: Extract<EmittedMessage, {
        type: "DONE";
    }> | null;
    enqueuedBatches: number;
    flushedState: Readonly<Record<string, unknown>> | null;
    priorState: Readonly<Record<string, unknown>>;
    recordsQueued: number;
    satisfiedBindings: readonly RuntimeBindingName[];
    sentBatches: number;
    statePutFailed: boolean;
}
export declare class CollectorStateReadError extends Error {
    constructor(message: string, cause: unknown);
}
export declare function runCollectorConnector(config: CollectorRunConfig): Promise<CollectorRunResult>;
export declare function buildCollectorStartMessage(streams: readonly string[], streamsToBackfill?: readonly string[], priorState?: Readonly<Record<string, unknown>> | null): StartMessage;
export declare function transformRecordsToCollectorEnvelopes(input: {
    batchId: string;
    batchSeq: number;
    connectorId: string;
    deviceId: string;
    messages: readonly EmittedMessage[];
    sourceInstanceId: string;
}): LocalDeviceRecordEnvelope[];
export declare function drainCollectorQueue(input: {
    client: Pick<LocalDeviceClient, "ingestBatch">;
    queue: LocalDeviceQueue;
}): Promise<number>;
export interface CollectorChildContext {
    readonly baseUrl: string;
    readonly deviceToken: string;
    readonly runId?: string;
}
