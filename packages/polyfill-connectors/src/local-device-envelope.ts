import { createHash } from "node:crypto";
import type { EmittedMessage, RecordData } from "./connector-runtime-protocol.ts";

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
  record: Extract<EmittedMessage, { type: "RECORD" }>;
  sourceInstanceId: string;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function buildLocalDeviceRecordEnvelope(input: BuildLocalDeviceRecordEnvelopeInput): LocalDeviceRecordEnvelope {
  const body = {
    connector_id: input.connectorId,
    data: toNormalizedRecordData(input.record.data),
    emitted_at: input.record.emitted_at,
    record_key: String(input.record.key),
    stream: input.record.stream,
  };

  return {
    batch_id: input.batchId,
    batch_seq: input.batchSeq,
    body_hash: hashCanonicalJson(body),
    device_id: input.deviceId,
    source_instance_id: input.sourceInstanceId,
    ...body,
  };
}

function toCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toCanonicalValue(item));
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) {
      out[key] = toCanonicalValue(item);
    }
  }
  return out;
}

function toNormalizedRecordData(data: RecordData): RecordData {
  return toCanonicalValue(data) as RecordData;
}
