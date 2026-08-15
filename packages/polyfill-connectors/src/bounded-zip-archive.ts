// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal ZIP central-directory reader shared by manual-upload connectors
 * that accept an owner-provided archive (WhatsApp chat export with media,
 * Netflix's official "getmyinfo" export, etc).
 *
 * No external zip dependency: reads the central directory record-by-record.
 * Two backends share one algorithm via {@link BytesSource}:
 *   - `readZipEntries` — an already-buffered in-memory archive (the
 *     original, simplest form; still used by connectors whose archives are
 *     small enough that whole-buffer reads are an acceptable trade-off).
 *   - `readZipEntriesFromFile` — a file descriptor, read only in bounded
 *     windows (central directory, then one entry's compressed bytes at a
 *     time via `pread`-style positional reads). The archive's full bytes are
 *     never materialized as a single in-memory buffer, so a multi-GB archive
 *     does not require multi-GB of process memory just to list or extract
 *     its entries.
 *
 * Decompression-bomb defense: a small *compressed* upload can still expand to
 * an enormous *uncompressed* size (a "zip bomb") — compressed input size does
 * NOT bound inflated output size, and the central directory's declared
 * `uncompressed_size` field is UNTRUSTED (an adversarial archive can declare
 * a tiny size and inflate to something far larger). This module enforces
 * TWO independent, complementary layers — both must hold:
 *
 *   DECLARED (fast reject, at read-entries time, before any inflation):
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
 *      `readZipEntries`/`readZipEntriesFromFile` call, tracked with a real
 *      running counter over genuine inflate output. An archive with many
 *      small-DECLARED-but-actually-large entries cannot bypass the total by
 *      lying about individual declared sizes, because each entry's
 *      effective inflate cap is `min(maxEntryUncompressedBytes, remaining
 *      actual budget)`, and the counter only advances by bytes zlib
 *      actually produced.
 *
 * Net invariant: declared-per-entry AND declared-total AND actual-per-entry
 * AND actual-aggregate all stay <= policy, with inflation itself bounded
 * (not a post-hoc check).
 *
 * Every offset/length read from the central directory is bounds-checked
 * against the known archive length before use, so a corrupt or adversarial
 * entry cannot cause an out-of-bounds read or an unbounded loop.
 *
 * Entry-name safety is enforced HERE, centrally, rather than left as a
 * caller convention: a raw `entry.name` is never safe to use as a
 * filesystem path (both current callers only ever consume it via
 * {@link zipBasename}, never as a path), and a future caller that DID
 * `path.join(dest, entry.name)` would be immediately zip-slip-vulnerable if
 * this module didn't already reject the dangerous shapes below. Every
 * `readZipEntries`/`readZipEntriesFromFile` call throws
 * {@link ZipPolicyViolationError} (code `unsafe_entry_name`) up front,
 * before returning ANY entries, if the central directory contains:
 *   - a path-traversal name (`../`, `..\`, or a bare/trailing `..` segment),
 *   - an absolute path, a drive letter (`C:`), or a UNC root (`\\server\`),
 *   - an embedded NUL byte,
 *   - a Unix-symlink entry (detected via `version made by` + `external file
 *     attributes`; no supported connector's real export legitimately
 *     contains one), or
 *   - an EXACT duplicate of another entry's raw name.
 * Ordinary nested paths, Unicode names, and different entries that merely
 * share a basename across directories are unaffected.
 */

import { readSync } from "node:fs";
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
// "version made by" upper byte: the host OS the archiving tool ran on. 3 ==
// Unix, per the APPNOTE.TXT spec's host-system table -- this is the ONLY
// value under which "external file attributes" is defined to hold Unix
// st_mode bits (other host systems use that field for unrelated FAT/VMS/etc
// attribute bits, so checking the S_IFLNK bit without this gate would
// misread unrelated bytes as a symlink on a non-Unix-authored archive).
const ZIP_VERSION_MADE_BY_HOST_UNIX = 3;
// POSIX S_IFLNK: the symlink value of the st_mode file-type nibble (the top
// 4 bits of a 16-bit mode, i.e. S_IFMT's bits), as packed into the upper 16
// bits of a Unix "external file attributes" field by every common zip tool
// (Info-ZIP, bsdtar, etc).
const POSIX_S_IFLNK = 0o12_0000;
// Entry names containing any of these are rejected outright, centrally, so
// no caller can ever be zip-slip-vulnerable by accident (see module doc):
// parent-directory traversal (both slash directions -- a Windows-authored
// archive can embed literal backslashes, which node's path utilities on
// POSIX would NOT normalize, so `../` alone is not enough), a leading
// slash/backslash (POSIX absolute path), a drive letter (`C:`) or UNC root
// (`\\server\share`) on Windows, and an embedded NUL byte (a classic
// string-truncation confusion between the length-prefixed name this parser
// reads and any NUL-terminated-string API a caller or downstream tool might
// use on it).
const UNSAFE_ZIP_ENTRY_NAME_RE = /(^[/\\])|(\.\.[/\\])|(\.\.$)|(^[A-Za-z]:)|(\\\\)|\0/;
// A whitespace-padded dot-dot segment (`".. /foo"`, `"foo/..\t/bar"`) is NOT
// actually zip-slip-exploitable via path.join/path.resolve on either POSIX
// or Windows -- Node's path resolver treats ".. " as a literal directory
// name, not a traversal token, since it isn't exactly "..". It is still
// rejected here, separately from UNSAFE_ZIP_ENTRY_NAME_RE above: the module's
// own doc comment promises any bare/trailing ".." segment is caught
// unconditionally, and a name that merely LOOKS like a traversal attempt to
// a human or a different (non-Node) downstream tool must not silently pass
// this gate just because this module's specific path-join semantics happen
// to neutralize it today.
const WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE = /(^|[/\\])\s*\.\.\s*($|[/\\])/;
// Bound how much of the tail we scan hunting for the EOCD record: the
// record itself plus the largest possible archive comment. Reading this
// window is the one place both backends still read a bounded-but-nontrivial
// chunk up front — capped at 64KB + 22 bytes regardless of archive size.
const EOCD_SCAN_WINDOW_BYTES = ZIP_EOCD_MAX_COMMENT_LENGTH + ZIP_EOCD_MIN_LENGTH;
// A generous per-record ceiling for the central-directory size sanity check
// below: the fixed 46-byte header plus room for a very long path/comment
// (4 KiB is already far beyond any real file name/path this codebase
// accepts — see safePathSegment/UNSAFE_FILENAME_CHARS_RE elsewhere in the
// RI, which reject far shorter names long before a zip entry name would
// ever ordinarily approach this). The format itself permits each of name/
// extra/comment up to 0xFFFF bytes, but no REAL archive this code is meant
// to accept needs anywhere near that — this is a policy ceiling like
// maxEntries, not a format-derived one.
const ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH = ZIP_CENTRAL_DIRECTORY_HEADER_LENGTH + 4096;

export interface ZipReadPolicy {
  /** Reject archives whose central directory declares more entries than this. */
  readonly maxEntries: number;
  /** Bounds inflation of any single entry, enforced at inflate time via zlib's maxOutputLength. */
  readonly maxEntryUncompressedBytes: number;
  /**
   * Bounds the sum of ACTUAL bytes returned across every `data()` call made
   * against entries returned from one read-entries call — tracked with a
   * real running counter over genuine inflate output, not the untrusted
   * declared `uncompressed_size` field. Extracting entries beyond this budget
   * throws {@link ZipPolicyViolationError}.
   */
  readonly maxTotalUncompressedBytes: number;
}

export class ZipPolicyViolationError extends Error {
  readonly code: "entry_too_large" | "too_many_entries" | "total_too_large" | "unsafe_entry_name";
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

/**
 * A random-access byte source both read-entries backends parse against.
 * `readWindow` returns up to `length` bytes starting at `position` — fewer
 * if the source ends first (mirrors `fs.read`'s short-read semantics), never
 * more. Implementations must never materialize the WHOLE source at once
 * except where explicitly bounded (see {@link EOCD_SCAN_WINDOW_BYTES}).
 */
interface BytesSource {
  readonly length: number;
  readWindow: (position: number, length: number) => Buffer;
}

function bufferBytesSource(bytes: Buffer): BytesSource {
  return {
    length: bytes.length,
    readWindow(position, length) {
      const start = Math.max(0, position);
      const end = Math.min(bytes.length, start + length);
      return end > start ? bytes.subarray(start, end) : Buffer.alloc(0);
    },
  };
}

/**
 * File-descriptor-backed source: every window is a fresh positional read
 * (`fs.readSync(fd, buf, 0, length, position)`), so callers control exactly
 * how many bytes are ever resident at once. The fd is caller-owned — this
 * source never opens or closes it.
 */
function fileBytesSource(fd: number, fileSize: number): BytesSource {
  return {
    length: fileSize,
    readWindow(position, length) {
      const start = Math.max(0, position);
      const wantLength = Math.min(length, fileSize - start);
      if (wantLength <= 0) {
        return Buffer.alloc(0);
      }
      const buf = Buffer.allocUnsafe(wantLength);
      const bytesRead = readSync(fd, buf, 0, wantLength, start);
      return bytesRead === wantLength ? buf : buf.subarray(0, bytesRead);
    },
  };
}

function findEndOfCentralDirectory(source: BytesSource): { offset: number; tail: Buffer; tailStart: number } | null {
  const tailStart = Math.max(0, source.length - EOCD_SCAN_WINDOW_BYTES);
  const tail = source.readWindow(tailStart, source.length - tailStart);
  const min = Math.max(0, tail.length - ZIP_EOCD_MAX_COMMENT_LENGTH - ZIP_EOCD_MIN_LENGTH);
  for (let offset = tail.length - ZIP_EOCD_MIN_LENGTH; offset >= min; offset -= 1) {
    if (offset >= 0 && tail.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      return { offset, tail, tailStart };
    }
  }
  return null;
}

function decodeZipName(raw: Buffer, flags: number): string {
  const isUtf8 = Math.floor(flags / ZIP_UTF8_FLAG) % 2 === 1;
  return raw.toString(isUtf8 ? "utf8" : "latin1");
}

interface CentralDirectoryRecord {
  compressedSize: number;
  isUnixSymlink: boolean;
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
  const versionMadeByHost = bytes.readUInt8(offset + 5);
  const flags = bytes.readUInt16LE(offset + 8);
  const method = bytes.readUInt16LE(offset + 10);
  const compressedSize = bytes.readUInt32LE(offset + 20);
  const uncompressedSize = bytes.readUInt32LE(offset + 24);
  const fileNameLength = bytes.readUInt16LE(offset + 28);
  const extraLength = bytes.readUInt16LE(offset + 30);
  const commentLength = bytes.readUInt16LE(offset + 32);
  const externalFileAttributes = bytes.readUInt32LE(offset + 38);
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
  // Unix st_mode bits live in the upper 16 bits of externalFileAttributes,
  // but ONLY mean anything when the archiving tool ran on Unix (see
  // ZIP_VERSION_MADE_BY_HOST_UNIX) -- on other host systems this field holds
  // unrelated FAT/VMS/etc attribute bits that must not be misread as a mode.
  // Arithmetic (not bitwise ops, matching decodeZipName's UTF8-flag check
  // above): dividing out the lower 16 bits isolates the mode, then dividing
  // out the lower 12 bits of THAT isolates the S_IFMT file-type nibble
  // (bits 12-15 of a 16-bit mode) as a plain 0-15 integer, comparable
  // directly against S_IFLNK's own top nibble.
  const unixMode =
    versionMadeByHost === ZIP_VERSION_MADE_BY_HOST_UNIX ? Math.floor(externalFileAttributes / 65_536) : 0;
  const isUnixSymlink = Math.floor(unixMode / 4096) === POSIX_S_IFLNK / 4096;
  return {
    compressedSize,
    isUnixSymlink,
    localHeaderOffset,
    method,
    name: decodeZipName(bytes.subarray(nameStart, nameStart + fileNameLength), flags),
    nextOffset,
    uncompressedSize,
  };
}

/**
 * Shared, mutable state for one read-entries call — every entry's `data()`
 * reader checks and advances the SAME counter, so the total budget is
 * enforced across the whole archive regardless of what any individual entry
 * declared about itself.
 */
interface ExtractionBudget {
  remainingTotalBytes: number;
}

const INFLATE_OUTPUT_LIMIT_RE = /buffer|maxOutputLength|too large/i;

function resolveCompressedSlice(source: BytesSource, record: CentralDirectoryRecord): Buffer {
  if (record.localHeaderOffset < 0 || record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH > source.length) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localHeader = source.readWindow(record.localHeaderOffset, ZIP_LOCAL_FILE_HEADER_LENGTH);
  if (localHeader.length < ZIP_LOCAL_FILE_HEADER_LENGTH || localHeader.readUInt32LE(0) !== ZIP_LOCAL_FILE_SIGNATURE) {
    throw new Error("zip_entry_local_header_invalid");
  }
  const localNameLength = localHeader.readUInt16LE(26);
  const localExtraLength = localHeader.readUInt16LE(28);
  const dataStart = record.localHeaderOffset + ZIP_LOCAL_FILE_HEADER_LENGTH + localNameLength + localExtraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataStart < 0 || dataEnd < dataStart || dataEnd > source.length) {
    throw new Error("zip_entry_data_out_of_bounds");
  }
  const compressed = source.readWindow(dataStart, record.compressedSize);
  if (compressed.length !== record.compressedSize) {
    throw new Error("zip_entry_data_out_of_bounds");
  }
  return compressed;
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
  source: BytesSource,
  record: CentralDirectoryRecord,
  policy: ZipReadPolicy,
  budget: ExtractionBudget
): () => Buffer {
  return () => {
    const compressed = resolveCompressedSlice(source, record);
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
 * Shared core: reads the central directory from `source` (a bounded EOCD
 * tail scan plus the central-directory records themselves — small even for
 * a multi-GB archive, since it's metadata, not entry payload) and returns
 * one lazy entry per file. Entry payload bytes are never read until `data()`
 * is called on that specific entry, and then only that one entry's
 * compressed bytes are pulled from `source` — never the whole archive.
 */
function readZipEntriesFromSource(source: BytesSource, policy: ZipReadPolicy): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(source);
  if (!eocd) {
    return [];
  }
  const entryCount = eocd.tail.readUInt16LE(eocd.offset + 10);
  if (entryCount > policy.maxEntries) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares ${entryCount} entries, exceeding maxEntries (${policy.maxEntries})`
    );
  }
  const centralDirSize = eocd.tail.readUInt32LE(eocd.offset + 12);
  const centralDirStart = eocd.tail.readUInt32LE(eocd.offset + 16);
  // centralDirSize is an attacker-controlled UInt32LE field on the EOCD
  // record, independent of entryCount (which is gated above) — a crafted
  // archive can declare entryCount: 1 (passing that gate) while claiming a
  // multi-GB centralDirSize, forcing source.readWindow to allocate and read
  // up to that many bytes before a single entry is parsed. This is the
  // actual central-directory read (metadata only — names + fixed-size
  // headers, no entry payload), so it must never scale with the archive's
  // total size, only with entryCount, which is already bounded by
  // policy.maxEntries.
  const maxPlausibleCentralDirSize = entryCount * ZIP_CENTRAL_DIRECTORY_MAX_RECORD_LENGTH;
  if (centralDirSize > maxPlausibleCentralDirSize) {
    throw new ZipPolicyViolationError(
      "too_many_entries",
      `zip declares a central directory of ${centralDirSize} bytes for ${entryCount} entries, exceeding the ` +
        `plausible maximum (${maxPlausibleCentralDirSize} bytes) for that many records`
    );
  }
  const centralDirBytes = source.readWindow(centralDirStart, centralDirSize);

  let offset = 0;
  const entries: ZipEntry[] = [];
  const budget: ExtractionBudget = { remainingTotalBytes: policy.maxTotalUncompressedBytes };
  let declaredTotalUncompressed = 0;
  const seenNames = new Set<string>();
  for (let i = 0; i < entryCount; i += 1) {
    const record = readCentralDirectoryRecord(centralDirBytes, offset);
    if (!record) {
      break;
    }
    // Name-safety gate (fail-closed, before any size logic): a dangerous
    // name, a Unix-symlink entry, or an exact duplicate of an already-seen
    // name is treated as evidence the whole archive is adversarial, not a
    // per-entry quirk to skip past. See UNSAFE_ZIP_ENTRY_NAME_RE and the
    // module doc comment for why this lives here rather than relying on
    // every caller to sanitize entry.name itself.
    if (UNSAFE_ZIP_ENTRY_NAME_RE.test(record.name) || WHITESPACE_PADDED_DOT_DOT_SEGMENT_RE.test(record.name)) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip entry '${record.name}' has an unsafe name (path traversal, absolute path, drive/UNC root, or embedded NUL)`
      );
    }
    if (record.isUnixSymlink) {
      throw new ZipPolicyViolationError(
        "unsafe_entry_name",
        `zip entry '${record.name}' is a symlink, which this reader does not support extracting`
      );
    }
    if (seenNames.has(record.name)) {
      throw new ZipPolicyViolationError("unsafe_entry_name", `zip declares more than one entry named '${record.name}'`);
    }
    seenNames.add(record.name);
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
      data: makeEntryDataReader(source, record, policy, budget),
      name: record.name,
      uncompressedSize: record.uncompressedSize,
    });
    offset = record.nextOffset;
  }
  return entries;
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
 *
 * `bytes` must already be fully buffered in memory — for a multi-GB archive
 * where that is unacceptable, use {@link readZipEntriesFromFile} instead,
 * which reads the same way but pulls each window from a file descriptor.
 */
export function readZipEntries(bytes: Buffer, policy: ZipReadPolicy): ZipEntry[] {
  return readZipEntriesFromSource(bufferBytesSource(bytes), policy);
}

/**
 * Same algorithm and same security properties as {@link readZipEntries}, but
 * reads from an open file descriptor instead of a pre-buffered `Buffer`. The
 * archive's full bytes are never materialized as one in-memory buffer — the
 * central directory (metadata; small even for a huge archive) is read as one
 * bounded window, and each entry's compressed bytes are read from disk only
 * when that entry's `data()` is called. This is what makes multi-GB archive
 * support possible without multi-GB memory allocations: only the central
 * directory and, at any given moment, one entry's compressed+inflated bytes
 * need to be resident.
 *
 * `fd` is caller-owned: this function never opens or closes it.
 */
export function readZipEntriesFromFile(fd: number, fileSize: number, policy: ZipReadPolicy): ZipEntry[] {
  return readZipEntriesFromSource(fileBytesSource(fd, fileSize), policy);
}
