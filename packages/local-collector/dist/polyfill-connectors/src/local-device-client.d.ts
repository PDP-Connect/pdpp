import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.js";
export declare const LOCAL_DEVICE_ENDPOINTS: {
    readonly exchangeEnrollment: "/_ref/device-exporters/enroll";
    readonly heartbeat: (deviceId: string) => string;
    readonly ingestBatch: (deviceId: string) => string;
    readonly localCollectorGap: (deviceId: string, sourceInstanceId: string) => string;
    readonly localCollectorGapRecovered: (deviceId: string, sourceInstanceId: string) => string;
    readonly sourceInstanceState: (deviceId: string, sourceInstanceId: string) => string;
};
export interface LocalDeviceClientOptions {
    baseUrl: string;
    deviceId?: string;
    deviceToken?: string;
    fetchImpl?: typeof fetch;
}
export interface EnrollmentExchangeRequest {
    device_label?: string;
    enrollment_code: string;
}
export interface EnrollmentExchangeResponse {
    connector_id: string;
    device_id: string;
    device_token: string;
    local_binding_name: string;
    source_instance_id: string;
}
export interface HeartbeatOutboxDiagnostics {
    backlog_open?: number;
    dead_letter: number;
    leased: number;
    oldest_pending_at?: string | null;
    pending: number;
    retrying: number;
    stale_leases: number;
    succeeded: number;
    total: number;
}
export interface HeartbeatRequest {
    connector_id: string;
    outbox?: HeartbeatOutboxDiagnostics;
    records_pending?: number;
    source_instance_id: string;
    status: "starting" | "healthy" | "retrying" | "blocked" | "stopped";
}
export interface IngestBatchRequest {
    batch_id: string;
    batch_seq: number;
    body_hash: string;
    connector_id: string;
    device_id: string;
    records: Pick<LocalDeviceRecordEnvelope, "data" | "emitted_at" | "record_key" | "stream">[];
    source_instance_id: string;
}
export interface GetSourceInstanceStateRequest {
    sourceInstanceId: string;
}
export interface PutSourceInstanceStateRequest {
    sourceInstanceId: string;
    state: Record<string, unknown>;
}
export interface SourceInstanceStateResponse {
    device_id: string;
    object: "device_source_instance_state";
    source_instance_id: string;
    state: Record<string, unknown>;
    updated_at: string | null;
}
export interface AckLocalCollectorGapRequest {
    connector_id: string;
    details?: string;
    first_seen_at: string;
    first_seen_run_id?: string;
    last_run_id?: string;
    next_attempt_backoff_ms: number;
    reason: "policy_budget" | "connector_child_failure";
    retryable: boolean;
    source_instance_id: string;
    stream?: string;
    stream_boundary?: string;
}
export interface AckLocalCollectorGapResponse {
    attempt_count: number;
    connector_id: string;
    connector_instance_id: string;
    device_id: string;
    first_seen_at: string | null;
    first_seen_run_id: string | null;
    gap_id: string;
    last_run_id: string | null;
    object: "device_local_collector_gap";
    reason: "policy_budget" | "connector_child_failure";
    retryable: boolean;
    source_instance_id: string;
    status: string;
    stream: string;
    updated_at: string | null;
}
export interface RecoverLocalCollectorGapRequest {
    connector_id: string;
    reason: "policy_budget" | "connector_child_failure";
    recovered_run_id?: string;
    source_instance_id: string;
    stream?: string;
    stream_boundary?: string;
}
export declare class LocalDeviceHttpError extends Error {
    readonly body: string;
    readonly envelopeMessage: string | null;
    readonly param: string | null;
    readonly status: number;
    readonly code: string | null;
    constructor(status: number, body: string);
}
export declare class LocalDeviceClient {
    #private;
    constructor(options: LocalDeviceClientOptions);
    exchangeEnrollment(request: EnrollmentExchangeRequest): Promise<EnrollmentExchangeResponse>;
    heartbeat(request: HeartbeatRequest): Promise<{
        ok: true;
    }>;
    ingestBatch(request: IngestBatchRequest): Promise<{
        ok: true;
    }>;
    getSourceInstanceState(request: GetSourceInstanceStateRequest): Promise<SourceInstanceStateResponse>;
    putSourceInstanceState(request: PutSourceInstanceStateRequest): Promise<SourceInstanceStateResponse>;
    ackLocalCollectorGap(request: AckLocalCollectorGapRequest): Promise<AckLocalCollectorGapResponse>;
    recoverLocalCollectorGap(request: RecoverLocalCollectorGapRequest): Promise<AckLocalCollectorGapResponse>;
}
