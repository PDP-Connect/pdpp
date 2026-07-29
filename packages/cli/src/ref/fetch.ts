// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppCliError, PdppHttpError } from "./errors.ts";
import { readOwnerSession } from "./session.ts";

export const OWNER_SESSION_COOKIE_NAME = "pdpp_owner_session";
const TRAILING_SLASH_RE = /\/$/;

export interface FetchJsonResult {
  body: unknown;
  headers: Headers;
  status: number;
}

type FetchImpl = typeof fetch;

export async function fetchJson(
  url: string | URL,
  opts: RequestInit = {},
  fetchImpl: FetchImpl = globalThis.fetch
): Promise<FetchJsonResult> {
  let resp: Response;
  try {
    resp = await fetchImpl(url, opts);
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: PdppCliError's constructor (message, exitCode, details) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new PdppCliError(`Network request failed: ${(error as Error).message}`);
  }

  const text = await resp.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!resp.ok) {
    const errBody = body as { error_description?: string; error?: { message?: string }; message?: string } | null;
    const message =
      errBody?.error_description ||
      errBody?.error?.message ||
      errBody?.message ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new PdppHttpError(message, resp.status, body);
  }

  return { status: resp.status, body, headers: resp.headers };
}

export interface OwnerSessionHeadersOpts {
  cacheRoot?: string | undefined;
  ownerSession?: string | undefined;
  referenceUrl?: string | undefined;
}

// Resolves owner session cookie with precedence:
//   1. opts.ownerSession (e.g. --owner-session flag)
//   2. PDPP_OWNER_SESSION_COOKIE env var
//   3. project-local cached session (when opts.referenceUrl is provided)
// Returns headers object with Cookie set, or empty object if no session found.
export function ownerSessionHeaders(opts: OwnerSessionHeadersOpts = {}): Record<string, string> {
  const fromOpts = typeof opts.ownerSession === "string" ? opts.ownerSession : "";
  const fromEnv =
    typeof process.env.PDPP_OWNER_SESSION_COOKIE === "string" ? process.env.PDPP_OWNER_SESSION_COOKIE : "";

  let value = (fromOpts || fromEnv).trim();

  if (!value && opts.referenceUrl) {
    const cached = readOwnerSession({
      referenceUrl: opts.referenceUrl,
      cacheRoot: opts.cacheRoot,
    });
    if (cached) {
      value = cached.cookie;
    }
  }

  if (!value) {
    return {};
  }
  const cookie = value.includes("=") ? value : `${OWNER_SESSION_COOKIE_NAME}=${value}`;
  return { Cookie: cookie };
}

// Resolves the reference base URL from --as-url flag or PDPP_AS_URL / AS_URL env vars.
// `flags['as-url']` is `string | boolean` (a bare `--as-url` with no value parses
// to `true`); preserved as-is to match the original's unguarded `.replace()` call,
// which throws a TypeError for that malformed-flag case rather than a PdppCliError.
export function resolveReferenceUrl(flags: Record<string, string | boolean>): string {
  const url = flags["as-url"] || process.env.PDPP_AS_URL || process.env.AS_URL;
  if (!url) {
    throw new PdppCliError("Missing reference server URL. Provide --as-url <url> or set PDPP_AS_URL.");
  }
  return (url as string).replace(TRAILING_SLASH_RE, "");
}
