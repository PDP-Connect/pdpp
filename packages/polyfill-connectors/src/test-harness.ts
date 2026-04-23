/**
 * Shared test harness for connector integration tests.
 *
 * Every integration test needs a fake `emit` + `emitRecord` pair that
 * captures what the collect() layer would push over the wire. Until
 * this file existed, each connector rolled its own, and the hand-rolled
 * `emitRecord` skipped the zod shape-check that the production runtime
 * applies. That meant a record that would SKIP_RESULT in production
 * silently landed in `.emitted` inside tests — tests looked green,
 * truth looked different.
 *
 * `makeRecordingEmit(validateRecord)` fixes that. It mirrors the
 * runtime's RECORD path: records that pass the zod check land in
 * `.emitted`; records that fail land in `.skipped`. Pass no validator
 * and you get pass-through mode for tests where the shape-check isn't
 * what's under test (e.g. pure scope-filter gates).
 *
 * This module has no side effects at import time. It exports only
 * factories and pure helpers.
 */

import type { EmittedMessage, RecordData, ValidateRecord } from "./connector-runtime.ts";

/** A record that passed (or bypassed) shape-check and would flow
 *  downstream as a RECORD in production. */
export interface EmittedRecord {
  data: RecordData;
  stream: string;
}

/** A record that failed shape-check — the runtime would convert this
 *  to a SKIP_RESULT. Tests can assert on `.skipped` to catch fixture
 *  drift. */
export interface SkippedRecord {
  issues: Array<{ message: string; path: string }>;
  stream: string;
}

export interface RecordingEmit {
  emit: (msg: EmittedMessage) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  emitted: EmittedRecord[];
  protocolMessages: EmittedMessage[];
  skipped: SkippedRecord[];
}

/**
 * Returns an emit/emitRecord pair that validates records through
 * `validateRecord`. Records that pass land in `.emitted`; records that
 * fail land in `.skipped` (same semantics as the runtime's RECORD
 * shape-check). The `.emit` side-channel records any direct protocol
 * messages (PROGRESS, STATE, SKIP_RESULT, INTERACTION) the helper
 * under test emits.
 *
 * If `validateRecord` is omitted, `emitRecord` is pass-through — useful
 * for tests where the helper is a pure function and the shape-check
 * isn't the point (e.g. scope-filter gates, ordering invariants on
 * synthetic data that intentionally omits fields).
 */
export function makeRecordingEmit(validateRecord?: ValidateRecord): RecordingEmit {
  const emitted: EmittedRecord[] = [];
  const skipped: SkippedRecord[] = [];
  const protocolMessages: EmittedMessage[] = [];

  const emit = (msg: EmittedMessage): Promise<void> => {
    protocolMessages.push(msg);
    return Promise.resolve();
  };

  const emitRecord = (stream: string, data: RecordData): Promise<void> => {
    if (validateRecord) {
      const result = validateRecord(stream, data);
      if (!result.ok) {
        skipped.push({ stream, issues: result.issues });
        return Promise.resolve();
      }
    }
    emitted.push({ stream, data });
    return Promise.resolve();
  };

  return { emit, emitRecord, emitted, skipped, protocolMessages };
}
