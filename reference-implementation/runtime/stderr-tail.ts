// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded UTF-8 stderr tail buffer for connector child processes.
//
// The reference runtime previously accumulated all stderr chunks for the
// lifetime of a run and then discarded the result before the terminal
// `run.failed` event was persisted. That left the owner with no durable
// evidence of why a connector exited.
//
// This module replaces the unbounded accumulator with a tail buffer that
// keeps only the last N bytes the connector wrote, while still tracking
// `bytes_observed` so the owner can tell whether evidence was omitted.
//
// Invariants:
//   - Memory use is bounded by `capBytes` regardless of total stderr volume.
//   - Multi-byte UTF-8 characters at the head of the kept tail are
//     repaired ("replaced with U+FFFD") rather than rendered as broken
//     bytes — connectors can write arbitrary UTF-8 and our cap is byte-based.
//   - `bytes_captured` is the byte length of the kept tail at finalize time
//     (before redaction).  `truncated` is true iff `bytes_observed` exceeds
//     `bytes_captured`.

const DEFAULT_CAP_BYTES = 16 * 1024;

export interface StderrTail {
  bytes_captured: number;
  bytes_observed: number;
  text: string;
  truncated: boolean;
}

export interface StderrTailBuffer {
  append(chunk: Buffer | string | null | undefined): void;
  finalize(): StderrTail;
}

export function createStderrTailBuffer({ capBytes = DEFAULT_CAP_BYTES }: { capBytes?: number } = {}): StderrTailBuffer {
  let observed = 0;
  // Ring of small buffers; we keep their cumulative size <= capBytes.
  // Older chunks at the head are evicted/sliced when capBytes is exceeded.
  const chunks: Buffer[] = [];
  let kept = 0;

  function append(chunk: Buffer | string | null | undefined): void {
    if (!chunk) {
      return;
    }
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    observed += buf.length;
    chunks.push(buf);
    kept += buf.length;
    while (kept > capBytes && chunks.length > 0) {
      const head = chunks[0];
      if (head === undefined) {
        break;
      }
      const overflow = kept - capBytes;
      if (head.length <= overflow) {
        chunks.shift();
        kept -= head.length;
      } else {
        chunks[0] = head.subarray(overflow);
        kept -= overflow;
      }
    }
  }

  function finalize() {
    const tail = Buffer.concat(chunks, kept);
    // Decode with `fatal: false` so a leading partial multi-byte sequence
    // (caused by a tail slice mid-character) becomes U+FFFD instead of
    // raising. The trailing characters are intact because we never slice
    // the most recent chunk.
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const text = decoder.decode(tail);
    return {
      text,
      bytes_observed: observed,
      bytes_captured: tail.length,
      truncated: observed > tail.length,
    };
  }

  return { append, finalize };
}

export const STDERR_TAIL_DEFAULT_CAP_BYTES = DEFAULT_CAP_BYTES;
