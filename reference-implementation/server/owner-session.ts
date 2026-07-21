import crypto from "node:crypto";

export const OWNER_SESSION_COOKIE_NAME = "pdpp_owner_session";
export const OWNER_SESSION_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const OWNER_SESSION_DEFAULT_SUBJECT_ID = "owner_local";

export const OWNER_AUTH_COOKIE_NAME = OWNER_SESSION_COOKIE_NAME;
export const OWNER_AUTH_DEFAULT_SESSION_TTL_SECONDS = OWNER_SESSION_DEFAULT_TTL_SECONDS;
export const OWNER_AUTH_DEFAULT_SUBJECT_ID = OWNER_SESSION_DEFAULT_SUBJECT_ID;

export type OwnerSessionSecret = string | Uint8Array;

export interface OwnerSessionPayload {
  readonly exp: number;
  readonly iat: number;
  readonly sub: string;
}

export type OwnerSessionSameSite = "lax" | "strict";

export interface OwnerSessionControllerOptions {
  readonly forceSecureCookies?: boolean;
  readonly password?: string | null;
  readonly sameSite?: OwnerSessionSameSite;
  readonly sessionTtlSeconds?: number;
  readonly subjectId?: string | null;
}

export interface OwnerSessionCookieOptions {
  readonly sameSite?: OwnerSessionSameSite;
  readonly secure?: boolean;
}

export interface OwnerSessionSetCookieOptions extends OwnerSessionCookieOptions {
  readonly maxAgeSeconds?: number;
}

export interface OwnerSessionController {
  clearSessionCookieHeader(opts?: OwnerSessionCookieOptions): string;
  readonly enabled: boolean;
  issueSessionCookieHeader(opts?: OwnerSessionCookieOptions): string | null;
  readSessionFromCookieHeader(header?: string | null): OwnerSessionPayload | null;
  readSessionFromCookieValue(raw?: string | null): OwnerSessionPayload | null;
  readonly subjectId: string;
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecodeToString(input: string): string {
  return Buffer.from(String(input), "base64url").toString("utf8");
}

function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signPayload(payload: string, secret: OwnerSessionSecret): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function coerceOwnerSessionPayload(value: unknown): OwnerSessionPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.exp !== "number") {
    return null;
  }
  const sub = typeof candidate.sub === "string" ? candidate.sub : "";
  const iat = typeof candidate.iat === "number" ? candidate.iat : 0;
  return { sub, iat, exp: candidate.exp };
}

export function encodeOwnerSession(payload: OwnerSessionPayload, secret: OwnerSessionSecret): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = signPayload(body, secret);
  return `${body}.${sig}`;
}

export function decodeOwnerSession(
  token: string,
  secret: OwnerSessionSecret,
  { nowSeconds = Math.floor(Date.now() / 1000) }: { nowSeconds?: number } = {}
): OwnerSessionPayload | null {
  if (typeof token !== "string" || !token.includes(".")) {
    return null;
  }
  const [body, sig] = token.split(".", 2);
  if (!(body && sig)) {
    return null;
  }
  const expectedSig = signPayload(body, secret);
  if (!timingSafeEqualString(sig, expectedSig)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecodeToString(body));
  } catch {
    return null;
  }
  const payload = coerceOwnerSessionPayload(parsed);
  if (!payload) {
    return null;
  }
  if (payload.exp <= nowSeconds) {
    return null;
  }
  return payload;
}

/**
 * Derive the HMAC signing secret for owner session cookies using scrypt.
 *
 * Previously this was a single-round SHA-256 hash, which is GPU-fast and
 * offline-brute-forceable if a session cookie leaks. Replaced with scrypt at
 * the same cost parameters used by credential-encryption.js (N=16384, r=8,
 * p=1) to match the ~100 000× work factor increase.
 *
 * The domain string "pdpp-owner-session-kdf-v1" acts as a fixed application
 * salt that defeats cross-context rainbow tables. The password itself is the
 * per-server variable, so no additional random salt storage is required for
 * this placeholder auth implementation.
 *
 * Migration note: existing pdpp_owner_session cookies issued under the old
 * SHA-256 derivation will fail HMAC verification and be silently rejected —
 * the owner must log in again after deploying this change. This is acceptable
 * for the placeholder single-owner auth model.
 */
export function deriveOwnerSessionSecret(password: string): Buffer {
  const domainSalt = Buffer.from("pdpp-owner-session-kdf-v1", "utf8");
  return crypto.scryptSync(password, domainSalt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function parseCookieHeader(header?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || typeof header !== "string") {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) {
      continue;
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function readOwnerSessionFromCookieValue(
  raw: string | null | undefined,
  secret: OwnerSessionSecret | null | undefined
): OwnerSessionPayload | null {
  if (!secret || typeof raw !== "string" || !raw) {
    return null;
  }
  return decodeOwnerSession(raw, secret);
}

export function readOwnerSessionFromCookieHeader(
  header: string | null | undefined,
  secret: OwnerSessionSecret | null | undefined
): OwnerSessionPayload | null {
  const cookies = parseCookieHeader(header);
  const raw = cookies[OWNER_SESSION_COOKIE_NAME];
  return readOwnerSessionFromCookieValue(raw ?? null, secret);
}

function sameSiteAttribute(mode: OwnerSessionSameSite | undefined): string {
  return mode === "strict" ? "SameSite=Strict" : "SameSite=Lax";
}

export function buildOwnerSessionSetCookie(
  value: string,
  { maxAgeSeconds, sameSite = "lax", secure = false }: OwnerSessionSetCookieOptions = {}
): string {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=${value}`];
  parts.push("HttpOnly");
  parts.push(sameSiteAttribute(sameSite));
  parts.push("Path=/");
  if (secure) {
    parts.push("Secure");
  }
  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function buildOwnerSessionClearCookie({
  sameSite = "lax",
  secure = false,
}: OwnerSessionCookieOptions = {}): string {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=`];
  parts.push("HttpOnly");
  parts.push(sameSiteAttribute(sameSite));
  parts.push("Path=/");
  if (secure) {
    parts.push("Secure");
  }
  parts.push("Max-Age=0");
  return parts.join("; ");
}

export function createOwnerSessionController({
  password,
  subjectId,
  sessionTtlSeconds = OWNER_SESSION_DEFAULT_TTL_SECONDS,
  sameSite = "lax",
  forceSecureCookies = false,
}: OwnerSessionControllerOptions = {}): OwnerSessionController {
  const enabled = typeof password === "string" && password.length > 0;
  const resolvedSubjectId = typeof subjectId === "string" && subjectId ? subjectId : OWNER_SESSION_DEFAULT_SUBJECT_ID;
  const secret = enabled && password ? deriveOwnerSessionSecret(password) : null;

  function resolveCookieFlags({ secure, sameSite: callerSameSite }: OwnerSessionCookieOptions): {
    secure: boolean;
    sameSite: OwnerSessionSameSite;
  } {
    return {
      secure: forceSecureCookies || Boolean(secure),
      sameSite: callerSameSite ?? sameSite,
    };
  }

  function readSessionFromCookieValue(raw?: string | null): OwnerSessionPayload | null {
    if (!(enabled && secret)) {
      return null;
    }
    return readOwnerSessionFromCookieValue(raw ?? null, secret);
  }

  function readSessionFromCookieHeader(header?: string | null): OwnerSessionPayload | null {
    if (!(enabled && secret)) {
      return null;
    }
    return readOwnerSessionFromCookieHeader(header ?? null, secret);
  }

  function issueSessionCookieHeader(opts: OwnerSessionCookieOptions = {}): string | null {
    if (!(enabled && secret)) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const payload: OwnerSessionPayload = {
      sub: resolvedSubjectId,
      iat: now,
      exp: now + sessionTtlSeconds,
    };
    const token = encodeOwnerSession(payload, secret);
    const flags = resolveCookieFlags(opts);
    return buildOwnerSessionSetCookie(token, {
      maxAgeSeconds: sessionTtlSeconds,
      secure: flags.secure,
      sameSite: flags.sameSite,
    });
  }

  function clearSessionCookieHeader(opts: OwnerSessionCookieOptions = {}): string {
    const flags = resolveCookieFlags(opts);
    return buildOwnerSessionClearCookie({ secure: flags.secure, sameSite: flags.sameSite });
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
