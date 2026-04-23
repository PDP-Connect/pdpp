import crypto from 'node:crypto';

export const OWNER_SESSION_COOKIE_NAME = 'pdpp_owner_session';
export const OWNER_SESSION_DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours
export const OWNER_SESSION_DEFAULT_SUBJECT_ID = 'owner_local';

export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
export const OWNER_AUTH_DEFAULT_SESSION_TTL_SECONDS = OWNER_SESSION_DEFAULT_TTL_SECONDS;
export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecodeToString(input) {
  return Buffer.from(String(input), 'base64url').toString('utf8');
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signPayload(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeOwnerSession(payload, secret) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = signPayload(body, secret);
  return `${body}.${sig}`;
}

export function decodeOwnerSession(token, secret, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.', 2);
  if (!body || !sig) return null;
  const expectedSig = signPayload(body, secret);
  if (!timingSafeEqualString(sig, expectedSig)) return null;
  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToString(body));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) {
    return null;
  }
  return payload;
}

export function deriveOwnerSessionSecret(password) {
  return crypto.createHash('sha256').update(`pdpp-owner-session:${password}`).digest();
}

export function parseCookieHeader(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function readOwnerSessionFromCookieValue(raw, secret) {
  if (!secret || typeof raw !== 'string' || !raw) return null;
  return decodeOwnerSession(raw, secret);
}

export function readOwnerSessionFromCookieHeader(header, secret) {
  const cookies = parseCookieHeader(header);
  return readOwnerSessionFromCookieValue(cookies[OWNER_SESSION_COOKIE_NAME], secret);
}

export function buildOwnerSessionSetCookie(value, { maxAgeSeconds, secure = false } = {}) {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=${value}`];
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  parts.push('Path=/');
  if (secure) parts.push('Secure');
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function buildOwnerSessionClearCookie({ secure = false } = {}) {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=`];
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  parts.push('Path=/');
  if (secure) parts.push('Secure');
  parts.push('Max-Age=0');
  return parts.join('; ');
}

export function createOwnerSessionController({
  password,
  subjectId,
  sessionTtlSeconds = OWNER_SESSION_DEFAULT_TTL_SECONDS,
} = {}) {
  const enabled = typeof password === 'string' && password.length > 0;
  const resolvedSubjectId =
    (typeof subjectId === 'string' && subjectId) || OWNER_SESSION_DEFAULT_SUBJECT_ID;
  const secret = enabled ? deriveOwnerSessionSecret(password) : null;

  function readSessionFromCookieValue(raw) {
    if (!enabled || !secret) return null;
    return readOwnerSessionFromCookieValue(raw, secret);
  }

  function readSessionFromCookieHeader(header) {
    if (!enabled || !secret) return null;
    return readOwnerSessionFromCookieHeader(header, secret);
  }

  function issueSessionCookieHeader({ secure = false } = {}) {
    if (!enabled || !secret) return null;
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: resolvedSubjectId,
      iat: now,
      exp: now + sessionTtlSeconds,
    };
    const token = encodeOwnerSession(payload, secret);
    return buildOwnerSessionSetCookie(token, {
      maxAgeSeconds: sessionTtlSeconds,
      secure,
    });
  }

  function clearSessionCookieHeader({ secure = false } = {}) {
    return buildOwnerSessionClearCookie({ secure });
  }

  return {
    enabled,
    subjectId: resolvedSubjectId,
    readSessionFromCookieHeader,
    readSessionFromCookieValue,
    issueSessionCookieHeader,
    clearSessionCookieHeader,
  };
}
