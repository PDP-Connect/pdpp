// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Input telemetry buffer for the streaming companion.
 *
 * Diagnoses double-clicks, focus loss, and viewport flicker on mobile by
 * recording four layers along the input pipeline:
 *
 *   Layer C-1: `wire.input.received`   — POST /input arrived at the server.
 *   Layer C-2: `wire.input.dispatched` — companion.dispatch() resolved
 *                                        (the CDP command(s) were sent).
 *   Layer C-3: `wire.input.error`      — companion.dispatch() rejected.
 *   Layer D  : `remote.page.*`         — events from the streamed page's DOM,
 *                                        relayed via Patchright exposeBinding.
 *
 * The buffer is a fixed-size ring per (run_id, interaction_id). The viewer
 * polls `GET /_ref/run-interaction-streams/:token/input-telemetry?since=<seq>`
 * and merges the response into the same `/api/stream-debug` sink the
 * phone-side logger writes to, joined by `correlationId`.
 *
 * Bound, in-process, debug-only. Never throws into the streaming hot path.
 */

const DEFAULT_BUFFER_SIZE = 500;

/** A caller-supplied telemetry record — plain object with arbitrary keys. */
type TelemetryRecord = Record<string, unknown>;

/** A record after the buffer stamps it with `seq` and `serverAtMs`. */
type StampedRecord = TelemetryRecord & { seq: number; serverAtMs: number };

/** A per-session ring: monotonic `seq` plus the bounded record list. */
interface BufferEntry {
  records: StampedRecord[];
  seq: number;
}

/** The result of a `readSince` scan. */
interface ReadSinceResult {
  records: StampedRecord[];
  seq: number;
}

export interface InputTelemetry {
  drop(browser_session_id: string): void;
  push(browser_session_id: string, record: TelemetryRecord): StampedRecord | undefined;
  readSince(browser_session_id: string, since?: number): ReadSinceResult;
}

/**
 * Create a telemetry buffer registry. Each entry is keyed by browser_session_id
 * and holds a monotonic ring of records.
 */
export function createInputTelemetry({
  bufferSize = DEFAULT_BUFFER_SIZE,
}: {
  bufferSize?: number;
} = {}): InputTelemetry {
  const buffers = new Map<string, BufferEntry>(); // browser_session_id → { seq, records: [] }

  function getOrCreate(browser_session_id: string): BufferEntry {
    let entry = buffers.get(browser_session_id);
    if (!entry) {
      entry = { seq: 0, records: [] };
      buffers.set(browser_session_id, entry);
    }
    return entry;
  }

  function isStorableRecord(browser_session_id: string, record: TelemetryRecord): boolean {
    return Boolean(browser_session_id) && Boolean(record) && typeof record === "object";
  }

  function trimToBufferSize(entry: BufferEntry): void {
    const excess = entry.records.length - bufferSize;
    if (excess > 0) {
      entry.records.splice(0, excess);
    }
  }

  /**
   * Append a record. `record` is a plain object — caller-controlled keys.
   * Mutates record by assigning `seq` and `serverAtMs`.
   */
  function push(browser_session_id: string, record: TelemetryRecord): StampedRecord | undefined {
    if (!isStorableRecord(browser_session_id, record)) {
      return;
    }
    const entry = getOrCreate(browser_session_id);
    entry.seq += 1;
    const stamped = {
      seq: entry.seq,
      serverAtMs: Date.now(),
      ...record,
    };
    entry.records.push(stamped);
    trimToBufferSize(entry);
    return stamped;
  }

  /**
   * Read records with seq > since. Cheap O(n) scan; n is bounded by bufferSize.
   */
  function readSince(browser_session_id: string, since = 0): ReadSinceResult {
    const entry = buffers.get(browser_session_id);
    if (!entry) {
      return { seq: 0, records: [] };
    }
    const sinceNum = Number.isFinite(since) ? Number(since) : 0;
    const records = entry.records.filter((r) => r.seq > sinceNum);
    return { seq: entry.seq, records };
  }

  function drop(browser_session_id: string): void {
    buffers.delete(browser_session_id);
  }

  return { push, readSince, drop };
}
