import type { LocalDeviceRecordEnvelope } from "./local-device-envelope.js";
export declare const LOCAL_DEVICE_ENDPOINTS: {
    readonly exchangeEnrollment: "/_ref/device-exporters/enroll";
    readonly heartbeat: (deviceId: string) => string;
    readonly ingestBatch: (deviceId: string) => string;
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
export interface HeartbeatRequest {
    connector_id: string;
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
export declare class LocalDeviceHttpError extends Error {
    readonly body: string;
    readonly status: number;
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
}
