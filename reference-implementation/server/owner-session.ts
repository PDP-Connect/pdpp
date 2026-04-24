import crypto from "node:crypto";

export const OWNER_SESSION_COOKIE_NAME = "pdpp_owner_session";
export const OWNER_SESSION_DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours
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

export interface OwnerSessionControllerOptions {
  readonly password?: string | null;
  readonly sessionTtlSeconds?: number;
  readonly subjectId?: string | null;
}

export interface OwnerSessionCookieOptions {
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

export function deriveOwnerSessionSecret(password: string): Buffer {
  return crypto.createHash("sha256").update(`pdpp-owner-session:${password}`).digest();
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

export function buildOwnerSessionSetCookie(
  value: string,
  { maxAgeSeconds, secure = false }: OwnerSessionSetCookieOptions = {}
): string {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=${value}`];
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
  parts.push("Path=/");
  if (secure) {
    parts.push("Secure");
  }
  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function buildOwnerSessionClearCookie({ secure = false }: OwnerSessionCookieOptions = {}): string {
  const parts = [`${OWNER_SESSION_COOKIE_NAME}=`];
  parts.push("HttpOnly");
  parts.push("SameSite=Lax");
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
}: OwnerSessionControllerOptions = {}): OwnerSessionController {
  const enabled = typeof password === "string" && password.length > 0;
  const resolvedSubjectId = typeof subjectId === "string" && subjectId ? subjectId : OWNER_SESSION_DEFAULT_SUBJECT_ID;
  const secret = enabled && password ? deriveOwnerSessionSecret(password) : null;

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

  function issueSessionCookieHeader({ secure = false }: OwnerSessionCookieOptions = {}): string | null {
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
    return buildOwnerSessionSetCookie(token, {
      maxAgeSeconds: sessionTtlSeconds,
      secure,
    });
  }

  function clearSessionCookieHeader({ secure = false }: OwnerSessionCookieOptions = {}): string {
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
