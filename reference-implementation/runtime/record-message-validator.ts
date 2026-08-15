// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// RECORD envelope shape validation for the connector runtime — the one
// message type with no dedicated shape check, letting a malformed envelope
// reach storage instead of failing as a connector protocol violation. Pure,
// dependency-free (no imports, no runtime state, no I/O): see
// record-message-validator.test.ts for the field-shape contract.

export interface RecordMessageLike {
  data?: unknown;
  emitted_at?: unknown;
  key?: unknown;
  op?: unknown;
  [key: string]: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function keyIsValid(key: unknown): boolean {
  return isNonEmptyString(key) || (Array.isArray(key) && key.length > 0 && key.every(isNonEmptyString));
}

function dataIsValid(data: unknown): boolean {
  return typeof data === "object" && data !== null && !Array.isArray(data);
}

/**
 * Validate a RECORD message's shape against spec-core.md's RECORD envelope
 * table: `key` is a non-empty string or string[] (array form for compound
 * primary keys), `data` is a required, non-null, non-array object (except
 * op:"delete", which addresses by key alone and omits data), `emitted_at`
 * is a required non-empty ISO 8601 string, `op` is absent or "delete".
 * Throws a bounded, public-safe Error (message built only from field names
 * and expectations, never the connector's own payload) when invalid;
 * returns normally when well-formed.
 */
export function assertValidRecordEnvelope(msg: RecordMessageLike): void {
  if (!keyIsValid(msg.key)) {
    throw new Error("Connector emitted RECORD with invalid key: expected a non-empty string or string[]");
  }
  if (msg.op !== undefined && msg.op !== null && msg.op !== "delete") {
    throw new Error(`Connector emitted RECORD with invalid op: expected 'delete' or omitted, got '${msg.op}'`);
  }
  if (msg.op !== "delete" && !dataIsValid(msg.data)) {
    throw new Error("Connector emitted RECORD with invalid data: expected a non-null, non-array object");
  }
  if (!isNonEmptyString(msg.emitted_at)) {
    throw new Error("Connector emitted RECORD with invalid emitted_at: expected a non-empty string");
  }
}
