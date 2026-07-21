// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded prefix reader for connectors that emit a *preview* of an on-disk
 * blob rather than its full body.
 *
 * Motivation: filesystem-class connectors (Claude Code, Codex) inventory
 * machine-generated artifacts whose size is unbounded — a single Claude Code
 * `tool-results/*.txt` blob can be hundreds of megabytes (a large command
 * output, a file dump, a build log). The durable record keeps only a short
 * `content_preview` (a few hundred chars via {@link safeTextPreview}) plus the
 * byte length, which `fs.stat` already reports. Reading the *entire* file into
 * a string just to slice a 500-char preview allocates O(file) memory and walks
 * every byte for control-character screening — a real memory/backpressure
 * hazard on huge sessions.
 *
 * This helper reads at most `maxBytes` from the head of the file via a byte
 * stream, so memory stays bounded by `maxBytes` regardless of file size. The
 * caller passes the returned buffer to {@link safeTextPreview}, which keeps its
 * existing decode-and-truncate semantics. Because the preview is an explicitly
 * lossy projection, screening only the leading `maxBytes` is acceptable: a
 * forbidden byte beyond the window cannot reach the preview anyway.
 *
 * UTF-8 boundary safety: a fixed byte cut can land in the middle of a
 * multi-byte code point, which would make a fatal UTF-8 decode wrongly classify
 * otherwise-text content as binary. We trim any trailing incomplete UTF-8
 * sequence from the buffer before returning, so the prefix always ends on a
 * complete code point.
 */

import { createReadStream } from "node:fs";

/** Default prefix budget. Matches the Codex connector's `GUARD_PREFIX_BYTES`
 *  (64 KiB) — comfortably larger than any connector preview char limit even at
 *  4 UTF-8 bytes/char, while capping per-blob memory at a small constant. */
export const BOUNDED_PREVIEW_MAX_BYTES = 64 * 1024;

export interface BoundedFilePreview {
  /** Leading bytes of the file, trimmed to a complete UTF-8 code point. */
  readonly buffer: Buffer;
  /** Number of bytes actually retained in {@link buffer}. */
  readonly bytesRead: number;
  /** True when the file was longer than the bytes retained (preview is a
   *  prefix, not the whole file). */
  readonly truncated: boolean;
}

/**
 * Count the bytes at the tail of `buf` that form an incomplete trailing UTF-8
 * sequence, i.e. a multi-byte code point whose continuation bytes were cut off
 * by the byte boundary. Returns 0 when the buffer ends on a complete code
 * point. Never reports more than 3 (the max continuation length).
 */
function trailingIncompleteUtf8Bytes(buf: Buffer): number {
  // Scan back over continuation bytes (0b10xxxxxx).
  let i = buf.length - 1;
  let continuation = 0;
  while (i >= 0) {
    const byte = buf[i];
    // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 byte-class checks require bit masks.
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    continuation++;
    i--;
    if (continuation > 3) {
      // More continuation bytes than any lead byte can introduce; the data is
      // not valid UTF-8 here, so don't trim — let the decoder classify it.
      return 0;
    }
  }
  const lead = i >= 0 ? buf[i] : undefined;
  if (lead === undefined) {
    return 0;
  }
  // Expected total length of the sequence introduced by `lead`.
  let expected: number;
  // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 byte-class checks require bit masks.
  if ((lead & 0b1000_0000) === 0) {
    expected = 1; // ASCII
    // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 byte-class checks require bit masks.
  } else if ((lead & 0b1110_0000) === 0b1100_0000) {
    expected = 2;
    // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 byte-class checks require bit masks.
  } else if ((lead & 0b1111_0000) === 0b1110_0000) {
    expected = 3;
    // biome-ignore lint/suspicious/noBitwiseOperators: UTF-8 byte-class checks require bit masks.
  } else if ((lead & 0b1111_1000) === 0b1111_0000) {
    expected = 4;
  } else {
    // Not a valid lead byte; leave the bytes in place for the decoder.
    return 0;
  }
  const have = continuation + 1;
  // If the sequence is complete (or over-long, which is invalid and left for
  // the decoder), nothing to trim.
  return have < expected ? have : 0;
}

/**
 * Read at most `maxBytes` from the head of `path`. The returned buffer ends on
 * a complete UTF-8 code point. On any read error returns `null` (the caller
 * decides whether a missing/unreadable blob is fatal), matching the prior
 * `readFile(...).catch()` behavior at the tool-result call site.
 */
export async function readBoundedFilePreview(
  path: string,
  maxBytes: number = BOUNDED_PREVIEW_MAX_BYTES
): Promise<BoundedFilePreview | null> {
  if (maxBytes <= 0) {
    return { buffer: Buffer.alloc(0), bytesRead: 0, truncated: false };
  }
  return await new Promise<BoundedFilePreview | null>((resolve) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    let sawMore = false;
    // Read one extra byte so we can tell "exactly maxBytes" from "longer than
    // maxBytes" and report `truncated` honestly.
    const stream = createReadStream(path, { start: 0, end: maxBytes });
    stream.on("data", (chunk) => {
      const buf = chunk as Buffer;
      const remaining = maxBytes - collected;
      if (remaining <= 0) {
        sawMore = true;
        return;
      }
      if (buf.length > remaining) {
        chunks.push(buf.subarray(0, remaining));
        collected += remaining;
        sawMore = true;
      } else {
        chunks.push(buf);
        collected += buf.length;
      }
    });
    stream.on("error", () => resolve(null));
    stream.on("end", () => {
      let buffer = chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks, collected);
      const trim = trailingIncompleteUtf8Bytes(buffer);
      if (trim > 0) {
        buffer = buffer.subarray(0, buffer.length - trim);
      }
      resolve({ buffer, bytesRead: buffer.length, truncated: sawMore });
    });
  });
}
