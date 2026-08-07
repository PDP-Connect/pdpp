// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Minimal in-memory ZIP central-directory reader shared by manual-upload
 * connectors that accept an owner-provided archive (WhatsApp chat export
 * with media, Netflix's official "getmyinfo" export, etc).
 *
 * No external zip dependency: reads the central directory record-by-record
 * from an already-buffered upload (uploads are already size-capped by the
 * manual-upload route's `max_file_bytes`, so unbounded-memory decompression
 * bombs are not a concern here — every entry is inflated from a bounded
 * input buffer, never streamed from an untrusted external source).
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
const PATH_SPLIT_RE = /[\\/]/;

export interface ZipEntry {
  data: () => Buffer;
  name: string;
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

/**
 * Read a ZIP archive's central directory and return one entry per file, each
 * with a lazy `data()` accessor that decompresses on demand. Returns an empty
 * list for non-ZIP or truncated/corrupt input rather than throwing.
 */
export function readZipEntries(bytes: Buffer): ZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  if (eocdOffset < 0) {
    return [];
  }
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  let offset = bytes.readUInt32LE(eocdOffset + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < entryCount; i += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      break;
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const fileNameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    if (nameStart + fileNameLength > bytes.length) {
      break;
    }
    const name = decodeZipName(bytes.subarray(nameStart, nameStart + fileNameLength), flags);
    if (localHeaderOffset + 30 > bytes.length || bytes.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_SIGNATURE) {
      offset = nameStart + fileNameLength + extraLength + commentLength;
      continue;
    }
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd <= bytes.length) {
      entries.push({
        name,
        data() {
          const compressed = bytes.subarray(dataStart, dataEnd);
          if (method === ZIP_STORE_METHOD) {
            return Buffer.from(compressed);
          }
          if (method === ZIP_DEFLATE_METHOD) {
            return inflateRawSync(compressed);
          }
          throw new Error(`unsupported_zip_compression_method:${method}`);
        },
      });
    }
    offset = nameStart + fileNameLength + extraLength + commentLength;
  }
  return entries;
}
