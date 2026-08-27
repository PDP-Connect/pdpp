// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

export interface BuildLocalDeviceIngestBatchRequestInput {
  batchId: string;
  batchSeq: number;
  connectorId: string;
  deviceId: string;
  records: readonly LocalDeviceRecordEnvelope[];
  sourceInstanceId: string;
}

export interface LocalDeviceIngestBatchRequest {
  batch_id: string;
  batch_seq: number;
  body_hash: string;
  connector_id: string;
  device_id: string;
  records: Pick<LocalDeviceRecordEnvelope, "data" | "emitted_at" | "record_key" | "stream">[];
  source_instance_id: string;
}

export interface CanonicalTerminalFactInput {
  readonly coverage_statuses: readonly string[];
  readonly scoped?: boolean;
  readonly stream: string;
}

export interface TerminalRunCommitEnvelopeInput {
  readonly collection_boundary: string;
  readonly commit_id: string;
  readonly connector_id: string;
  readonly connector_instance_id: string;
  readonly device_id: string;
  readonly run_id: string;
  readonly source_instance_id: string;
  readonly state_delta: Readonly<Record<string, unknown>>;
  readonly terminal_facts: readonly CanonicalTerminalFactInput[];
  readonly version: 1;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(toCanonicalValue(value));
}

export function hashCanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/**
 * Canonical string form of a RECORD envelope key (spec-core.md "The RECORD
 * envelope"): a scalar key is used as-is; a compound key is the minified
 * JSON array of its string components, in manifest `primary_key` order.
 */
function canonicalRecordKey(key: string | readonly string[]): string {
  return typeof key === "string" ? key : JSON.stringify(key);
}

export function buildLocalDeviceRecordEnvelope(input: BuildLocalDeviceRecordEnvelopeInput): LocalDeviceRecordEnvelope {
  const body = {
    connector_id: input.connectorId,
    data: toNormalizedRecordData(input.record.data),
    emitted_at: input.record.emitted_at,
    record_key: canonicalRecordKey(input.record.key),
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

/**
 * The one shipped envelope-to-wire boundary used by durable and legacy queue
 * senders. The idempotency hash deliberately covers the complete stored
 * envelopes while the HTTP body projects only record fields; keeping both
 * operations here prevents those representations from drifting independently.
 */
export function buildLocalDeviceIngestBatchRequest(
  input: BuildLocalDeviceIngestBatchRequestInput
): LocalDeviceIngestBatchRequest {
  return {
    batch_id: input.batchId,
    batch_seq: input.batchSeq,
    body_hash: hashCanonicalJson(input.records),
    connector_id: input.connectorId,
    device_id: input.deviceId,
    records: input.records.map((record) => ({
      data: record.data,
      emitted_at: record.emitted_at,
      record_key: record.record_key,
      stream: record.stream,
    })),
    source_instance_id: input.sourceInstanceId,
  };
}

/**
 * The one hash-authority projection shared by collector and reference server.
 * Connector identity MUST already be canonical before entry.
 *
 * Vendored from `packages/reference-contract/src/common/terminal-run-commit.ts`
 * (`canonicalTerminalRunCommitEnvelope`) rather than imported: this package is
 * published to npm and `@pdpp/reference-contract` ships raw, unbuilt
 * TypeScript with no publishable `main`/`exports` target, so importing it as a
 * bare specifier produced an undeclared, unresolvable dependency in every
 * published `@pdpp/local-collector` 1.5.1-1.5.4 tarball. The reference server
 * computes the same hash via the original reference-contract function, so this
 * copy MUST stay byte-identical to it — see the parity tests in this module's
 * test file.
 */
export function canonicalTerminalRunCommitEnvelope(input: TerminalRunCommitEnvelopeInput): unknown {
  return toCanonicalValue({
    collection_boundary: input.collection_boundary,
    commit_id: input.commit_id,
    connector_id: input.connector_id,
    connector_instance_id: input.connector_instance_id,
    device_id: input.device_id,
    run_id: input.run_id,
    source_instance_id: input.source_instance_id,
    state_delta: input.state_delta,
    terminal_facts: input.terminal_facts
      .map((fact) => ({
        coverage_statuses: [...new Set(fact.coverage_statuses)].sort(),
        ...(typeof fact.scoped === "boolean" ? { scoped: fact.scoped } : {}),
        stream: fact.stream,
      }))
      .sort((left, right) => left.stream.localeCompare(right.stream)),
    version: 1,
  });
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
