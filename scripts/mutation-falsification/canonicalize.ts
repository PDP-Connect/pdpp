// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 8785 JSON Canonicalization Scheme (JCS) plus SHA-256 content digests.
 *
 * INTEGRITY, NOT AUTHENTICITY: `digestOf`/`sha256Hex` prove that a piece of
 * evidence is internally self-consistent and byte-identical to a separately
 * retained copy — tamper evidence relative to that copy. They do NOT prove
 * who produced the evidence, and nothing in this file, or any caller of it,
 * may name a function or field "sign", "auth", "verify identity", or
 * similar. Anyone controlling the host that produced a digest can also
 * recompute it; there is no key, no secret, no external attestation here.
 * See openspec/changes/add-mutation-falsification-evidence/design.md
 * Decision #4.
 */

import { createHash } from "node:crypto";

const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * RFC 8785's normative output is UTF-8, so a string containing an unpaired
 * (lone) UTF-16 surrogate cannot be canonicalized at all — there is no valid
 * UTF-8 encoding for it. `JSON.stringify` degrades a lone surrogate to a
 * `\uD800`-style escape instead of rejecting it (verified locally: it does
 * not throw), which would silently produce non-conformant output. This scan
 * is the one place that gap is closed — every caller of `canonicalizeString`
 * routes through it first.
 */
function assertNoUnpairedSurrogate(value: string, label: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    const isHighSurrogate = code >= 0xd800 && code <= 0xdbff;
    const isLowSurrogate = code >= 0xdc00 && code <= 0xdfff;
    if (isHighSurrogate) {
      const next = value.charCodeAt(i + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        throw new Error(
          `canonicalizeJSON: ${label} contains an unpaired high surrogate at index ${i} — RFC 8785 output is UTF-8 and cannot represent it`
        );
      }
      i++; // Skip the matched low surrogate; it's part of the same code point.
      continue;
    }
    if (isLowSurrogate) {
      throw new Error(
        `canonicalizeJSON: ${label} contains an unpaired low surrogate at index ${i} — RFC 8785 output is UTF-8 and cannot represent it`
      );
    }
  }
}

/**
 * RFC 8785 string serialization: identical to RFC 8259 (JSON) string
 * escaping, which is exactly what `JSON.stringify` already produces for a
 * single string value — object-key ordering and number formatting are the
 * only places JCS diverges from `JSON.stringify`'s default behavior, and
 * both are handled by the caller (`canonicalizeValue`), not here. Rejects
 * unpaired surrogates first — see `assertNoUnpairedSurrogate`.
 */
function canonicalizeString(value: string, label = "string"): string {
  assertNoUnpairedSurrogate(value, label);
  return JSON.stringify(value);
}

/**
 * RFC 8785 number serialization defers to ECMA-262's `Number::toString`
 * abstract operation. `String(number)` (equivalently template coercion) IS
 * that abstract operation in V8/Node — verified to agree with
 * `JSON.stringify`'s own number formatting for integers, floats, large
 * exponential magnitudes, and signed zero (`-0` serializes as `"0"` in both).
 * `JSON.stringify` is not reused directly here because it is only called for
 * a bare number at the top of the recursion, and using the same primitive
 * `String()` this file already uses for the recursive descent keeps one
 * code path instead of two.
 */
function canonicalizeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`canonicalizeJSON: cannot canonicalize non-finite number: ${value}`);
  }
  return String(value);
}

function canonicalizeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === true || value === false) {
    return String(value);
  }
  if (typeof value === "number") {
    return canonicalizeNumber(value);
  }
  if (typeof value === "string") {
    return canonicalizeString(value, "a string value");
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeValue(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // RFC 8785 §3.2.3: object member names are sorted by UTF-16 code unit
    // (i.e. plain `<` on JS strings, which compares UTF-16 code units).
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined) // JSON has no `undefined`; drop it like JSON.stringify does.
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map((key) => `${canonicalizeString(key, "an object key")}:${canonicalizeValue(record[key])}`).join(",")}}`;
  }
  throw new Error(`canonicalizeJSON: cannot canonicalize value of type ${typeof value}`);
}

/** Serializes `value` to its RFC 8785 JSON Canonicalization Scheme (JCS) string: sorted keys, no insignificant whitespace, ECMA-262 number formatting. */
export function canonicalizeJSON(value: unknown): string {
  if (value === undefined) {
    throw new Error("canonicalizeJSON: cannot canonicalize undefined at the top level");
  }
  return canonicalizeValue(value);
}

/** SHA-256 hex digest of a string or buffer. Reuses Node's `node:crypto`, consistent with `scripts/test-accounting/inventory.ts`'s `contentDigest`. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 hex digest of `value`'s RFC 8785 canonical form. Integrity binding only — see the file-level comment. */
export function digestOf(value: unknown): string {
  return sha256Hex(canonicalizeJSON(value));
}

/** True if `value` is a 64-character lowercase hex SHA-256 digest string. */
export function isHexDigest(value: unknown): value is string {
  return typeof value === "string" && HEX_DIGEST_PATTERN.test(value);
}
