// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal in-memory ZIP central-directory reader shared by manual-upload
 * connectors that accept an owner-provided archive (WhatsApp chat export
 * with media, Netflix's official "getmyinfo" export, etc).
 *
 * No external zip dependency: reads the central directory record-by-record
 * from an already-buffered upload.
 *
 * Decompression-bomb defense: a small *compressed* upload can still expand to
 * an enormous *uncompressed* size (a "zip bomb") — compressed input size does
 * NOT bound inflated output size, and the central directory's declared
 * `uncompressed_size` field is UNTRUSTED (an adversarial archive can declare
 * a tiny size and inflate to something far larger). This module enforces
 * TWO independent, complementary layers — both must hold:
 *
 *   DECLARED (fast reject, at `readZipEntries` time, before any inflation):
 *   1. `maxEntries` — central-directory record count.
 *   2. Each entry's declared `uncompressed_size` <= `maxEntryUncompressedBytes`.
 *   3. The running sum of declared `uncompressed_size` across all entries
 *      <= `maxTotalUncompressedBytes`.
 *   These are cheap and reject an honestly-labeled oversized archive
 *   immediately, without ever calling `data()` — but they are NOT the
 *   security boundary by themselves, since declared sizes are attacker
 *   controlled.
 *
 *   ACTUAL (the real gate, enforced during/after inflation):
 *   4. `maxEntryUncompressedBytes` bounds inflation of any SINGLE entry via
 *      zlib's `inflateRawSync(..., { maxOutputLength })` — zlib aborts once
 *      output would exceed the cap, rather than allocating the full
 *      expansion and checking its length afterward.
 *   5. `maxTotalUncompressedBytes` also bounds the SUM of ACTUAL bytes
 *      returned by every `data()` call made against entries from one
 *      `readZipEntries` call, tracked with a real running counter over
 *      genuine inflate output. An archive with many small-DECLARED-but-
 *      actually-large entries cannot bypass the total by lying about
 *      individual declared sizes, because each entry's effective inflate cap
 *      is `min(maxEntryUncompressedBytes, remaining actual budget)`, and the
 *      counter only advances by bytes zlib actually produced.
 *
 * Net invariant: declared-per-entry AND declared-total AND actual-per-entry
 * AND actual-aggregate all stay <= policy, with inflation itself bounded
 * (not a post-hoc check).
 *
 * Every offset/length read from the central directory is bounds-checked
 * against the buffer length before use, so a corrupt or adversarial entry
 * cannot cause an out-of-bounds read or an unbounded loop.
 */

import { inflateRawSync } from "node:zlib";

const ZIP_EOCD_SIGNATURE = 0x06_05_4b_50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02_01_4b_50;
const ZIP_LOCAL_FILE_SIGNATURE = 0x04_03_4b_50;
const ZIP_UTF8_FLAG = 0x08_00;
const ZIP_STORE_METHOD = 0;
const ZIP_DEFLATE_METHOD = 8;
const ZIP_EOCD_MIN_LENGTH = 22;
const ZIP_EOCD_MAX_COMMENT_LENGTH = 0xff_ff;
const ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH = 46;
const ZIP_LOCAL_FILE_HEADER_LENGTH = 30;
const PATH_SPLIT_RE = /[\\/]/;

export interface ZipReadPolicy {
  /** Reject archives whose central directory declares more entries than this. */
  readonly maxEntries: number;
  /** Bounds inflation of any single entry, enforced at inflate time via zlib's maxOutputLength. */
  readonly maxEntryUncompressedBytes: number;
  /**
   * Bounds the sum of ACTUAL bytes returned across every `data()` call made
   * against entries returned from one `readZipEntries` call — tracked with a
   * real running counter over genuine inflate output, not the untrusted
   * declared `uncompressed_size` field. Extracting entries beyond this budget
   * throws {@link ZipPolicyViolationError}.
   */
  readonly maxTotalUncompressedBytes: number;
}

export class ZipPolicyViolationError extends Error {
  readonly code: "entry_too_large" | "too_many_entries" | "total_too_large";
  constructor(code: ZipPolicyViolationError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "ZipPolicyViolationError";
  }
}

export interface ZipEntry {
  readonly compressedSize: number;
  readonly data: () => Buffer;
  readonly name: string;
  readonly uncompressedSize: number;
}

export function zipBasename(path: string): string {
  return path.split(PATH_SPLIT_RE).filter(Boolean).at(-1) ?? path;
}

export function hasZipLocalFileSignature(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === ZIP_LOCAL_FILE_SIGNATURE;
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const min = Math.max(0, bytes.length - ZIP_EOCD_MAX_COMMENT_LENGTH - ZIP_EOCD_MIN_LENGTH);
  for (let offset = bytes.length - ZIP_EOCD_MIN_LENGTH; offset >= min; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

function decodeZipName(raw: Buffer, flags: number): string {
  const isUtf8 = Math.floor(flags / ZIP_UTF8_FLAG) % 2 === 1;
  return raw.toString(isUtf8 ? "utf8" : "latin1");
}

interface CentralDirectoryRecord {
  compressedSize: number;
  localHeaderOffset: number;
  method: number;
  name: string;
  nextOffset: number;
  uncompressedSize: number;
}

function readCentralDirectoryRecord(bytes: Buffer, offset: number): CentralDirectoryRecord | null {
  if (offset + ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH > bytes.length) {
    return null;
  }
  if (bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
    return null;
  }
  const flags = bytes.readUInt16LE(offset + 8);
  const method = bytes.readUInt16LE(offset + 10);
  const compressedSize = bytes.readUInt32LE(offset + 20);
  const uncompressedSize = bytes.readUInt32LE(offset + 24);
  const fileNameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  const localHeaderOffset = bytes.readUInt32LE(offset + 42);
  const nameStart = offset + ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH;
  if (nameStart + fileNameLength > bytes.length) {
    return null;
  }
  const nextOffset = nameStart + fileNameLength + extraLength + commentLength;
  if (nextOffset < offset || nextOffset > bytes.length) {
    // Overflow or out-of-bounds jump from a corrupt/adversarial length field.
    return null;
  }
  return {
    compressedSize,
    localHeaderOffset,
    method,
    name: decodeZipName(bytes.subarray(nameStart, nameStart + fileNameLength), flags),
    nextOffset,
    uncompressedSize,
  };
}

/**
 * Shared, mutable state for one `readZipEntries` call — every entry's
 * `data()` reader checks and advances the SAME counter, so the total budget
 * is enforced across the whole archive regardless of what any individual
 * entry declared about itself.
 */
interface ExtractionBudget {
  remainingTotalBytes: number;
}

const INFLATE_OUTPUT_LIMIT_RE = /buffer|maxOutputLength|too large/i;

function resolveCompressedSlice(bytes: Buffer, record: CentralDirectoryRecord): Buffer {
  if (
    record.localHeaderOffset < 0 ||
    record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH > bytes.length ||
    bytes.readUInt32LE(record.localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE
  ) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localNameLength = bytes.readUInt16LE(record.localHeaderOffset + 26);
  const localExtraLength = bytes.readUInt16LE(record.localHeaderOffset + 28);
  const dataStart = record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH + localNameLength + localExtraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataStart < 0 || dataEnd < dataStart || dataEnd > bytes.length) {
    throw new Error("zip_entry_data_out_of_bounds");
  }
  return bytes.subarray(dataStart, dataEnd);
}

interface EffectiveCap {
  readonly bytes: number;
  /**
   * Which limit is binding for THIS extraction: the flat per-entry policy
   * (entry_too_large — this entry alone exceeds its own independent cap) or
   * the shared aggregate budget across the whole archive (total_too_large —
   * the per-entry policy would allow more, but other entries already
   * consumed most of the total). A thrown violation is classified from this,
   * deterministically — never conflated.
   */
  readonly violationCode: "entry_too_large" | "total_too_large";
}

function resolveEffectiveCap(policy: ZipReadPolicy, budget: ExtractionBudget): EffectiveCap {
  const totalBudgetIsBinding = budget.remainingTotalBytes < policy.maxEntryUncompressedBytes;
  return {
    bytes: totalBudgetIsBinding ? budget.remainingTotalBytes : policy.maxEntryUncompressedBytes,
    violationCode: totalBudgetIsBinding ? "total_too_large" : "entry_too_large",
  };
}

function inflateOrStoreEntry(compressed: Buffer, record: CentralDirectoryRecord, cap: EffectiveCap): Buffer {
  const boundDescription = cap.violationCode === "total_too_large" ? "the shared total" : "the per-entry cap";
  if (record.method === ZIP_STORE_METHOD) {
    // Stored (uncompressed): the compressed-size bound IS the output-size
    // bound, so no inflate-time cap is needed — just check it directly.
    if (compressed.length > cap.bytes) {
      throw new ZipPolicyViolationError(
        cap.violationCode,
        `zip entry '${record.name}' exceeds the available bounded-read budget (${cap.bytes} bytes remaining, bound by ${boundDescription})`
      );
    }
    return Buffer.from(compressed);
  }
  if (record.method === ZIP_DEFLATE_METHOD) {
    try {
      // maxOutputLength bounds inflation itself: zlib aborts once output
      // would exceed cap.bytes, rather than allocating the full expansion
      // and checking its length afterward. This is the actual
      // decompression-bomb gate.
      return inflateRawSync(compressed, { maxOutputLength: cap.bytes });
    } catch (err) {
      if (err instanceof Error && INFLATE_OUTPUT_LIMIT_RE.test(err.message)) {
        // biome-ignore lint/style/useErrorCause: cause IS passed via the third constructor arg ({ cause: err }); the linter doesn't see through ZipPolicyViolationError's custom (code, message, options) signature.
        throw new ZipPolicyViolationError(
          cap.violationCode,
          `zip entry '${record.name}' exceeds the available bounded-read budget (${cap.bytes} bytes remaining, bound by ${boundDescription}) when inflated`,
          { cause: err }
        );
      }
      throw err;
    }
  }
  throw new Error(`unsupported_zip_compression_method:${record.method}`);
}

function makeEntryDataReader(
  bytes: Buffer,
  record: CentralDirectoryRecord,
  policy: ZipReadPolicy,
  budget: ExtractionBudget
): () => Buffer {
  return () => {
    const compressed = resolveCompressedSlice(bytes, record);
    const cap = resolveEffectiveCap(policy, budget);
    if (cap.bytes <= 0) {
      throw new ZipPolicyViolationError(
        cap.violationCode,
        `extracting zip entry '${record.name}' would exceed the ${cap.violationCode === "total_too_large" ? "shared maxTotalUncompressedBytes" : "maxEntryUncompressedBytes"} budget`
      );
    }
    const output = inflateOrStoreEntry(compressed, record, cap);
    // Advance the shared budget by what was ACTUALLY produced, not what the
    // entry declared. A second data() call on the same entry (or another
    // entry) sees the reduced remainder.
    budget.remainingTotalBytes -= output.length;
    return output;
  };
}

/**
 * Read a ZIP archive's central directory and return one entry per file, each
 * with a lazy `data()` accessor that decompresses on demand. All entries
 * returned from one `readZipEntries` call share one extraction budget (see
 * {@link ZipReadPolicy.maxTotalUncompressedBytes}): calling `data()` past the
 * budget throws {@link ZipPolicyViolationError}, regardless of what any
 * entry's central-directory metadata claimed. Returns an empty list for
 * non-ZIP or truncated/corrupt input rather than throwing. Throws
 * {@link ZipPolicyViolationError} up front if the archive's OWN declared
 * metadata already violates `maxEntries` or a single entry's declared size
 * exceeds `maxEntryUncompressedBytes` — a cheap fast-reject that avoids
 * building entries for an obviously-bad archive, but is not the security
 * boundary by itself (that's the running budget above, since declared sizes
 * are untrusted).
 */
export function readZipEntries(bytes: Buffer, policy: ZipReadPolicy): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    return [];
  }
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  if (entryCount > policy.maxEntries) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares ${entryCount} entries, exceeding maxEntries (${policy.maxEntries})`
    );
  }
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  const budget: ExtractionBudget = { remainingTotalBytes: policy.maxTotalUncompressedBytes };
  let declaredTotalUncompressed = 0;
  for (let i = 0; i < entryCount; i += 1) {
    const record = readCentralDirectoryRecord(bytes, offset);
    if (!record) {
      break;
    }
    // Layer 1 (declared, fast-reject): honestly-labeled oversized entries
    // are rejected here, before any inflation is attempted. This does NOT
    // replace the actual-bytes budget enforced in makeEntryDataReader — an
    // adversarial archive can still lie about these fields — but it means a
    // normal oversized upload never reaches inflation at all.
    if (record.uncompressedSize > policy.maxEntryUncompressedBytes) {
      throw new ZipPolicyViolationError(
        "entry_too_large",
        `zip entry '${record.name}' declares uncompressed_size ${record.uncompressedSize}, exceeding maxEntryUncompressedBytes (${policy.maxEntryUncompressedBytes})`
      );
    }
    declaredTotalUncompressed += record.uncompressedSize;
    if (declaredTotalUncompressed > policy.maxTotalUncompressedBytes) {
      throw new ZipPolicyViolationError(
        "total_too_large",
        `zip entries declare a combined uncompressed_size exceeding maxTotalUncompressedBytes (${policy.maxTotalUncompressedBytes})`
      );
    }
    entries.push({
      compressedSize: record.compressedSize,
      data: makeEntryDataReader(bytes, record, policy, budget),
      name: record.name,
      uncompressedSize: record.uncompressedSize,
    });
    offset = record.nextOffset;
  }
  return entries;
}
