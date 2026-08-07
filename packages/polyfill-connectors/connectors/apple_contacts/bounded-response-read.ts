// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Bounded-size response body reader for the Apple Contacts CardDAV client.
 *
 * Every authenticated request this connector makes reads an XML multistatus
 * body (PROPFIND/REPORT) that embeds vCards, which in turn can embed a
 * base64 PHOTO property. None of those three layers has a protocol-enforced
 * size ceiling: a misbehaving or compromised CardDAV server (or a
 * man-in-the-middle on a redirect hop that slipped past origin validation)
 * could return an arbitrarily large body and force this connector to
 * allocate unbounded memory before any content is even inspected.
 *
 * This module is the single choke point every response body passes through.
 * It is deliberately NOT a generic "bounded fetch" package — Apple Contacts
 * is the only consumer today (per the standing rule: don't build a shared
 * abstraction before a second consumer exists). If a second CardDAV-ish
 * connector shows up, promote this to `src/` then.
 *
 * Two independent guards, because either one alone is insufficient:
 *   1. `Content-Length`, when present, is checked BEFORE reading a single
 *      body byte — the fast rejection path for a server that discloses an
 *      oversized body up front.
 *   2. A streaming byte-count cap is enforced while consuming the body
 *      regardless of what `Content-Length` claimed (or omitted) — this is
 *      the ONLY guard that catches a missing or dishonest Content-Length
 *      (a server that under-reports the header, or omits it and chunks
 *      indefinitely). The stream is aborted as soon as the cap is crossed,
 *      so memory usage is bounded by `maxBytes` even against a hostile body.
 */

export type BoundedReadOutcome =
  | { kind: "ok"; text: string }
  | { kind: "content_length_exceeded"; declaredBytes: number; maxBytes: number }
  | { kind: "content_length_missing_stream_exceeded"; maxBytes: number }
  | { kind: "content_length_understated_stream_exceeded"; declaredBytes: number; maxBytes: number };

export interface BoundedReadableResponse {
  body: ReadableStream<Uint8Array> | null;
  headers: { get: (name: string) => string | null };
}

const CONTENT_LENGTH_DIGITS_RE = /^\d+$/;

/** Parse a `Content-Length` header value. Returns `null` for anything that
 *  is not a non-negative integer (missing, empty, non-numeric, negative,
 *  or a value with trailing garbage) — treated identically to "absent" by
 *  the caller, which is the safe direction (falls through to the streaming
 *  guard rather than trusting a malformed declaration). */
function parseContentLength(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!CONTENT_LENGTH_DIGITS_RE.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read a response body as text, enforcing `maxBytes` two ways: an upfront
 * `Content-Length` check (when the header is present and parses cleanly),
 * and a streaming byte-count cap that is authoritative regardless of what
 * the header said. Never buffers more than `maxBytes` (+ one chunk's worth
 * of overrun before the cap trips, since chunk boundaries aren't caller
 * controlled) before returning a rejection.
 */
export async function readBoundedText(res: BoundedReadableResponse, maxBytes: number): Promise<BoundedReadOutcome> {
  const declaredBytes = parseContentLength(res.headers.get("content-length"));
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    return { kind: "content_length_exceeded", declaredBytes, maxBytes };
  }

  if (!res.body) {
    return { kind: "ok", text: "" };
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.length;
      if (total > maxBytes) {
        return declaredBytes === null
          ? { kind: "content_length_missing_stream_exceeded", maxBytes }
          : { kind: "content_length_understated_stream_exceeded", declaredBytes, maxBytes };
      }
      chunks.push(value);
    }
  } finally {
    // Release the reader lock and cancel any remaining backpressure so a
    // rejected (oversized) body doesn't keep pulling bytes off the wire.
    reader.releaseLock();
    await res.body.cancel().catch((): undefined => undefined);
  }

  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
  return { kind: "ok", text: buffer.toString("utf8") };
}

/** Human-readable summary for a rejected outcome, safe to include in a
 *  thrown error message — carries no response body content, only sizes. */
export function describeBoundedReadRejection(outcome: Exclude<BoundedReadOutcome, { kind: "ok" }>): string {
  switch (outcome.kind) {
    case "content_length_exceeded":
      return `declared Content-Length ${String(outcome.declaredBytes)} exceeds cap ${String(outcome.maxBytes)}`;
    case "content_length_missing_stream_exceeded":
      return `response body exceeded cap ${String(outcome.maxBytes)} with no Content-Length header`;
    case "content_length_understated_stream_exceeded":
      return `response body exceeded cap ${String(outcome.maxBytes)} (declared Content-Length ${String(outcome.declaredBytes)} understated the real size)`;
    default:
      return "response body exceeded the size cap";
  }
}
