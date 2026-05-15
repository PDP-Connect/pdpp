import { PdppCliError, PdppHttpError } from './errors.js';

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

// Resolves owner session cookie from --owner-session flag or PDPP_OWNER_SESSION_COOKIE env var.
// Returns headers object with Cookie set, or empty object if no session provided.
export function ownerSessionHeaders(opts = {}) {
  const fromOpts = typeof opts.ownerSession === 'string' ? opts.ownerSession : '';
  const fromEnv = typeof process.env.PDPP_OWNER_SESSION_COOKIE === 'string'
    ? process.env.PDPP_OWNER_SESSION_COOKIE
    : '';
  const value = (fromOpts || fromEnv).trim();
  if (!value) return {};
  const cookie = value.includes('=') ? value : `pdpp_owner_session=${value}`;
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
