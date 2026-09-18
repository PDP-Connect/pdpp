// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The evidence-capturing HTTP client every case speaks through.
//
// Two reasons this exists rather than bare `fetch`. First, evidence: a `fail`
// has to carry the exchange that produced it, and capturing that at the call
// site in every test would be both noisy and easy to forget. Second, redaction:
// reports are published under the governance programme's public-results model,
// so bearer tokens must never reach a report file. Redaction happens here, on
// the way into the record, rather than as a cleanup pass that can be skipped.

import type { Evidence } from "../report/result.ts";
import { EVIDENCE_BODY_LIMIT } from "../report/result.ts";

/** Headers whose values are replaced before capture. */
const REDACTED_HEADERS = new Set(["authorization", "cookie", "set-cookie"]);

function redact(headers: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [key, value] of entries) {
    out[key.toLowerCase()] = REDACTED_HEADERS.has(key.toLowerCase()) ? "<redacted>" : value;
  }
  return out;
}

export interface PdppResponse {
  readonly evidence: Evidence;
  readonly headers: Headers;
  /** Parsed body, or undefined when the body is absent or not JSON. */
  readonly json: unknown;
  readonly status: number;
  readonly text: string;
}

/**
 * A response captured as raw bytes rather than decoded text.
 *
 * `request()` always decodes the body as UTF-8 text, which corrupts binary
 * content (a JSON `.text()` round-trip is lossy for arbitrary bytes). The
 * RS-1 blob-fetch case needs the exact bytes the server returned to compare
 * against a stored digest or the original upload — treating a stringified
 * body as "actual bytes" would prove nothing about byte-for-byte fidelity.
 */
export interface PdppBytesResponse {
  readonly body: Uint8Array;
  readonly evidence: Evidence;
  readonly headers: Headers;
  readonly status: number;
}

export interface RequestOptions {
  /** Request body, for the provisioning calls an adapter makes. Not captured as
   * evidence: it may carry adapter credentials, and no conformance case asserts
   * on it. */
  readonly body?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly query?: Record<string, string | undefined>;
  /** Bearer token. Sent as `Authorization: Bearer <token>`, redacted in evidence. */
  readonly token?: string;
}

/**
 * Perform one request against the target and capture it as evidence.
 *
 * `path` is appended to the target base URL. Query values are encoded here so a
 * case can pass a raw parameter name like `filter[status]` without escaping it
 * by hand — several negative oracles depend on sending exactly the parameter
 * form the spec names.
 */
export async function request(baseUrl: string, path: string, options: RequestOptions = {}): Promise<PdppResponse> {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = { ...options.headers };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const method = options.method ?? "GET";
  const response = await fetch(url, {
    method,
    headers,
    ...(options.body !== undefined && { body: options.body }),
  });
  const text = await response.text();

  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  return {
    status: response.status,
    headers: response.headers,
    text,
    json,
    evidence: {
      request: { method, url: url.toString(), headers: redact(headers) },
      response: {
        status: response.status,
        headers: redact(response.headers),
        body: text.length > EVIDENCE_BODY_LIMIT ? `${text.slice(0, EVIDENCE_BODY_LIMIT)}…[truncated]` : text,
      },
    },
  };
}

/**
 * Perform one request and capture the response body as raw bytes, for cases
 * that must prove byte-for-byte fidelity (RS-1 blob fetch) rather than parsed
 * JSON or decoded text. Evidence records only the byte length, never raw
 * binary, so reports stay text-safe.
 *
 * Redirects are never followed (`redirect: "manual"`). Section 8 permits a
 * blob-fetch response to be either a direct 200 or a 302 to a short-lived
 * signed URL, and the two carry different required headers. Auto-following
 * (the default `fetch` behaviour) would hide a bare 302 from the case and
 * could forward the target's `Authorization` header to whatever the signed
 * URL's host turns out to be.
 */
export async function requestBytes(
  baseUrl: string,
  path: string,
  options: RequestOptions = {}
): Promise<PdppBytesResponse> {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = { ...options.headers };
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const method = options.method ?? "GET";
  const response = await fetch(url, {
    method,
    headers,
    redirect: "manual",
    ...(options.body !== undefined && { body: options.body }),
  });
  const body = new Uint8Array(await response.arrayBuffer());

  return {
    status: response.status,
    headers: response.headers,
    body,
    evidence: {
      request: { method, url: url.toString(), headers: redact(headers) },
      response: {
        status: response.status,
        headers: redact(response.headers),
        body: `<${body.length} bytes>`,
      },
    },
  };
}

/**
 * The Section 8 structured error body, when the response carries one.
 *
 * Returns undefined rather than throwing on a malformed body: several cases
 * assert that a well-formed error IS present, and they need to distinguish
 * "absent" from "present but wrong" to report a useful detail.
 */
export function errorBody(response: PdppResponse): { type?: string; code?: string; message?: string } | undefined {
  const body = response.json;
  if (typeof body !== "object" || body === null || !("error" in body)) {
    return undefined;
  }
  const { error } = body as { error: unknown };
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  return error as { type?: string; code?: string; message?: string };
}
