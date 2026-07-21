// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppCliError, PdppHttpError } from './errors.js';
import { readOwnerSession } from './session.js';

export const OWNER_SESSION_COOKIE_NAME = 'pdpp_owner_session';

export async function fetchJson(url, opts = {}, fetchImpl = globalThis.fetch) {
  let resp;
  try {
    resp = await fetchImpl(url, opts);
  } catch (error) {
    throw new PdppCliError(`Network request failed: ${error.message}`);
  }

  const text = await resp.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!resp.ok) {
    const message =
      body?.error_description ||
      body?.error?.message ||
      body?.message ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new PdppHttpError(message, resp.status, body);
  }

  return { status: resp.status, body, headers: resp.headers };
}

// Resolves owner session cookie with precedence:
//   1. opts.ownerSession (e.g. --owner-session flag)
//   2. PDPP_OWNER_SESSION_COOKIE env var
//   3. project-local cached session (when opts.referenceUrl is provided)
// Returns headers object with Cookie set, or empty object if no session found.
export function ownerSessionHeaders(opts = {}) {
  const fromOpts = typeof opts.ownerSession === 'string' ? opts.ownerSession : '';
  const fromEnv =
    typeof process.env.PDPP_OWNER_SESSION_COOKIE === 'string'
      ? process.env.PDPP_OWNER_SESSION_COOKIE
      : '';

  let value = (fromOpts || fromEnv).trim();

  if (!value && opts.referenceUrl) {
    const cached = readOwnerSession({
      referenceUrl: opts.referenceUrl,
      cacheRoot: opts.cacheRoot,
    });
    if (cached) value = cached.cookie;
  }

  if (!value) return {};
  const cookie = value.includes('=') ? value : `${OWNER_SESSION_COOKIE_NAME}=${value}`;
  return { Cookie: cookie };
}

// Resolves the reference base URL from --as-url flag or PDPP_AS_URL / AS_URL env vars.
export function resolveReferenceUrl(flags) {
  const url =
    flags['as-url'] ||
    process.env.PDPP_AS_URL ||
    process.env.AS_URL;
  if (!url) {
    throw new PdppCliError(
      'Missing reference server URL. Provide --as-url <url> or set PDPP_AS_URL.'
    );
  }
  return url.replace(/\/$/, '');
}
