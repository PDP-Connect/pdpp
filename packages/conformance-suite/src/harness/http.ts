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

export interface RequestOptions {
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
  const response = await fetch(url, { method, headers });
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
