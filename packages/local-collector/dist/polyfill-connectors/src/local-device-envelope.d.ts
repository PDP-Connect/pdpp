import type { EmittedMessage, RecordData } from "./connector-runtime-protocol.js";
export interface LocalDeviceRecordEnvelope {
    batch_id: string;
    batch_seq: number;
    body_hash: string;
    connector_id: string;
    data: RecordData;
    device_id: string;
    emitted_at: string;
    record_key: string;
    source_instance_id: string;
    stream: string;
}
export interface BuildLocalDeviceRecordEnvelopeInput {
    batchId: string;
    batchSeq: number;
    connectorId: string;
    deviceId: string;
    record: Extract<EmittedMessage, {
        type: "RECORD";
    }>;
    sourceInstanceId: string;
}
export declare function canonicalJson(value: unknown): string;
export declare function hashCanonicalJson(value: unknown): string;
export declare function buildLocalDeviceRecordEnvelope(input: BuildLocalDeviceRecordEnvelopeInput): LocalDeviceRecordEnvelope;
