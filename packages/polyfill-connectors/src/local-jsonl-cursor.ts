// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash, type Hash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { open, stat } from "node:fs/promises";

const READ_CHUNK_BYTES = 64 * 1024;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

export interface LocalJsonlPhysicalCursorV1 {
  committed_offset_bytes: number;
  committed_prefix_sha256: string;
  observed_mtime_ms: number;
  observed_size_bytes: number;
}

export type LocalJsonlDecision =
  | { kind: "fast_skip" }
  | { kind: "verified_noop" }
  | { kind: "append"; start_offset_bytes: number }
  | { kind: "rebuild"; reason: "invalid_cursor" | "prefix_changed" | "shrunk_before_offset" };

export interface LocalJsonlScanResult {
  cursor: LocalJsonlPhysicalCursorV1;
  decision: LocalJsonlDecision;
  lines_delivered: number;
  prefix_bytes_hashed: number;
  tail_bytes_parsed: number;
}

export interface ScanLocalJsonlArgs {
  onLine: (line: Buffer) => Promise<void>;
  path: string;
  prior: LocalJsonlPhysicalCursorV1 | undefined;
}

export class LocalJsonlUnstableSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalJsonlUnstableSourceError";
  }
}

function isFiniteNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isLocalJsonlPhysicalCursorV1(value: unknown): value is LocalJsonlPhysicalCursorV1 {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isFiniteNonNegativeInteger(value.committed_offset_bytes) &&
    typeof value.committed_prefix_sha256 === "string" &&
    SHA256_HEX_RE.test(value.committed_prefix_sha256) &&
    typeof value.observed_mtime_ms === "number" &&
    Number.isFinite(value.observed_mtime_ms) &&
    isFiniteNonNegativeInteger(value.observed_size_bytes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameOpenFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function hashRange(handle: FileHandle, bytes: number): Promise<string> {
  return (await hashRangeState(handle, bytes)).digest("hex");
}

/** Read a prefix once and retain its hash state for a later continuation. */
async function hashRangeState(handle: FileHandle, bytes: number): Promise<Hash> {
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < bytes) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, bytes - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead !== buffer.length) {
      throw new LocalJsonlUnstableSourceError("local JSONL source ended during a required prefix read");
    }
    hash.update(buffer);
    offset += bytesRead;
  }
  return hash;
}

async function verifyStablePath(
  path: string,
  handle: FileHandle,
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number }
): Promise<void> {
  const [afterHandle, afterPath] = await Promise.all([handle.stat(), stat(path)]);
  if (!(sameOpenFile(snapshot, afterHandle) && sameOpenFile(snapshot, afterPath))) {
    throw new LocalJsonlUnstableSourceError("local JSONL path changed while scanning");
  }
  if (afterHandle.size < snapshot.size) {
    throw new LocalJsonlUnstableSourceError("local JSONL source shrank while scanning");
  }
  if (afterHandle.size === snapshot.size && afterHandle.mtimeMs !== snapshot.mtimeMs) {
    throw new LocalJsonlUnstableSourceError("local JSONL source mutated while scanning");
  }
}

/**
 * Prove that the exact LF-terminated bytes given to callbacks remain the
 * current committed prefix. Growth is fine; a rewrite under that prefix is
 * not. The second hash/check pair closes the check-then-hash window for the
 * ordinary concurrent rewrite+append case without claiming a filesystem lock.
 */
async function proveCommittedPrefix(input: {
  expectedSha256: string;
  handle: FileHandle;
  path: string;
  snapshot: { dev: number; ino: number; size: number; mtimeMs: number };
  bytes: number;
}): Promise<number> {
  await verifyStablePath(input.path, input.handle, input.snapshot);
  const first = await hashRange(input.handle, input.bytes);
  await verifyStablePath(input.path, input.handle, input.snapshot);
  const second = await hashRange(input.handle, input.bytes);
  await verifyStablePath(input.path, input.handle, input.snapshot);
  if (first !== input.expectedSha256 || second !== input.expectedSha256) {
    throw new LocalJsonlUnstableSourceError("local JSONL committed prefix changed while scanning");
  }
  return input.bytes * 2;
}

/**
 * Scan one local JSONL file through a fixed open-file snapshot. The callback is
 * invoked only for LF-terminated lines; malformed JSON remains the caller's
 * policy. STATE is returned only after the path stays compatible with the
 * opened handle, so a caller that emits it after this promise resolves keeps
 * the connector's existing checkpoint barrier intact.
 */
export async function scanLocalJsonl({ onLine, path, prior }: ScanLocalJsonlArgs): Promise<LocalJsonlScanResult> {
  const handle = await open(path, "r");
  try {
    const snapshot = await handle.stat();
    if (prior && prior.observed_size_bytes === snapshot.size && prior.observed_mtime_ms === snapshot.mtimeMs) {
      return {
        cursor: prior,
        decision: { kind: "fast_skip" },
        lines_delivered: 0,
        prefix_bytes_hashed: 0,
        tail_bytes_parsed: 0,
      };
    }

    let decision: LocalJsonlDecision;
    let startOffset = 0;
    let prefixBytesHashed = 0;
    let deliveredPrefix: Hash = createHash("sha256");
    if (!(prior && isLocalJsonlPhysicalCursorV1(prior)) || prior.committed_offset_bytes > prior.observed_size_bytes) {
      decision = { kind: "rebuild", reason: "invalid_cursor" };
    } else if (snapshot.size < prior.committed_offset_bytes) {
      decision = { kind: "rebuild", reason: "shrunk_before_offset" };
    } else {
      const actualPrefix = await hashRangeState(handle, prior.committed_offset_bytes);
      prefixBytesHashed += prior.committed_offset_bytes;
      if (actualPrefix.copy().digest("hex") === prior.committed_prefix_sha256) {
        startOffset = prior.committed_offset_bytes;
        // Continue the decision-time hash. Its bytes are exactly those that
        // were compared with the saved cursor; never seed this from a second
        // disk read, which would reopen a rewrite-plus-growth race.
        deliveredPrefix = actualPrefix;
        decision = { kind: "append", start_offset_bytes: startOffset };
      } else {
        decision = { kind: "rebuild", reason: "prefix_changed" };
      }
    }

    let position = startOffset;
    let committed = startOffset;
    let pending = Buffer.alloc(0);
    let linesDelivered = 0;
    while (position < snapshot.size) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, snapshot.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead !== buffer.length) {
        throw new LocalJsonlUnstableSourceError("local JSONL source ended during a snapshot read");
      }
      position += bytesRead;
      pending = pending.length === 0 ? buffer : Buffer.concat([pending, buffer]);
      let lineEnd = pending.indexOf(0x0a);
      while (lineEnd !== -1) {
        // Hash the bytes before invoking the callback: this is the exact
        // committed prefix the callback observed, including the LF boundary.
        deliveredPrefix.update(pending.subarray(0, lineEnd + 1));
        await onLine(pending.subarray(0, lineEnd));
        linesDelivered++;
        committed += lineEnd + 1;
        pending = pending.subarray(lineEnd + 1);
        lineEnd = pending.indexOf(0x0a);
      }
    }

    const committedPrefix = deliveredPrefix.digest("hex");
    prefixBytesHashed += await proveCommittedPrefix({
      bytes: committed,
      expectedSha256: committedPrefix,
      handle,
      path,
      snapshot,
    });
    const cursor = {
      committed_offset_bytes: committed,
      committed_prefix_sha256: committedPrefix,
      observed_mtime_ms: snapshot.mtimeMs,
      observed_size_bytes: snapshot.size,
    };
    return {
      cursor,
      decision: linesDelivered === 0 && decision.kind === "append" ? { kind: "verified_noop" } : decision,
      lines_delivered: linesDelivered,
      prefix_bytes_hashed: prefixBytesHashed,
      tail_bytes_parsed: snapshot.size - startOffset,
    };
  } finally {
    await handle.close();
  }
}
