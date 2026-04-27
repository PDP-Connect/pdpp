/**
 * Reference-only CSRF token mechanism for hosted owner forms.
 *
 * Scope:
 *   - protects state-changing POSTs from the server-rendered hosted UI:
 *     `/owner/login`, `/owner/logout`, `/consent/approve`, `/consent/deny`,
 *     `/device/approve`, `/device/deny`.
 *
 * Design — signed double-submit:
 *   - On a hosted-form GET we mint a random nonce and an HMAC signature
 *     over that nonce using a server-side secret. The pair is encoded as
 *     `<nonce>.<sig>` and stored in a `pdpp_owner_csrf` cookie *and*
 *     embedded as a hidden form field `_csrf` in the rendered page.
 *   - On the matching POST we require both values to be present, the
 *     signatures to verify against the secret, and the cookie value to
 *     match the field value in constant time.
 *   - Verifying the signature defends against cookie-injection /
 *     subdomain-overwrite attacks where an attacker controls a sibling
 *     origin and can write the cookie but cannot compute a valid HMAC.
 *
 * Why double-submit (not session-bound HMAC)?
 *   - Login posts happen *before* there is an owner session; binding to
 *     the session cookie would force a separate flow for the login form.
 *     Double-submit works identically pre- and post-login.
 *   - The cookie is `HttpOnly`; only the server-rendered form embeds the
 *     token, so an XSS-free cross-origin attacker cannot read it.
 *
 * The CSRF cookie is intentionally distinct from the session cookie so
 * we can rotate it on login/logout without disturbing the session.
 */
import crypto from "node:crypto";

export const OWNER_CSRF_COOKIE_NAME = "pdpp_owner_csrf";
export const OWNER_CSRF_FIELD_NAME = "_csrf";
export const OWNER_CSRF_DEFAULT_TTL_SECONDS = 12 * 60 * 60;
const OWNER_CSRF_NONCE_BYTES = 32;

export type OwnerSameSiteMode = "lax" | "strict";

export type OwnerCsrfSecret = Buffer | string | Uint8Array;

export interface OwnerCsrfCookieOptions {
  readonly maxAgeSeconds?: number;
  readonly sameSite?: OwnerSameSiteMode;
  readonly secure?: boolean;
}

export function deriveOwnerCsrfSecret(password: string): Buffer {
  return crypto.createHash("sha256").update(`pdpp-owner-csrf:${password}`).digest();
}

function timingSafeEqualString(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function signNonce(nonce: string, secret: OwnerCsrfSecret): string {
  return crypto.createHmac("sha256", secret).update(nonce).digest("base64url");
}

export function issueOwnerCsrfToken(secret: OwnerCsrfSecret): string {
  const nonce = crypto.randomBytes(OWNER_CSRF_NONCE_BYTES).toString("base64url");
  const sig = signNonce(nonce, secret);
  return `${nonce}.${sig}`;
}

/**
 * Validate that `token` is a structurally well-formed `<nonce>.<sig>`
 * pair signed by `secret`. Returns true only if the signature verifies.
 */
export function verifyOwnerCsrfToken(token: string | null | undefined, secret: OwnerCsrfSecret): boolean {
  if (typeof token !== "string" || !token.includes(".")) {
    return false;
  }
  const idx = token.indexOf(".");
  const nonce = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!(nonce && sig)) {
    return false;
  }
  const expected = signNonce(nonce, secret);
  return timingSafeEqualString(sig, expected);
}

export function buildOwnerCsrfSetCookie(
  token: string,
  { secure = false, sameSite = "lax", maxAgeSeconds = OWNER_CSRF_DEFAULT_TTL_SECONDS }: OwnerCsrfCookieOptions = {}
): string {
  const sameSiteValue = sameSite === "strict" ? "Strict" : "Lax";
  const parts = [`${OWNER_CSRF_COOKIE_NAME}=${token}`, "HttpOnly", `SameSite=${sameSiteValue}`, "Path=/"];
  if (secure) {
    parts.push("Secure");
  }
  if (typeof maxAgeSeconds === "number") {
    parts.push(`Max-Age=${maxAgeSeconds}`);
  }
  return parts.join("; ");
}

export function buildOwnerCsrfClearCookie({
  secure = false,
  sameSite = "lax",
}: Omit<OwnerCsrfCookieOptions, "maxAgeSeconds"> = {}): string {
  const sameSiteValue = sameSite === "strict" ? "Strict" : "Lax";
  const parts = [`${OWNER_CSRF_COOKIE_NAME}=`, "HttpOnly", `SameSite=${sameSiteValue}`, "Path=/"];
  if (secure) {
    parts.push("Secure");
  }
  parts.push("Max-Age=0");
  return parts.join("; ");
}

function parseCookieHeader(header?: string | null): Record<string, string> {
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

export function readCsrfTokenFromCookieHeader(header?: string | null): string | null {
  const cookies = parseCookieHeader(header);
  const raw = cookies[OWNER_CSRF_COOKIE_NAME];
  return typeof raw === "string" && raw ? raw : null;
}

/**
 * Validate a signed double-submit pair. Returns true only if both the
 * cookie and form values are present, both have valid signatures, and
 * the cookie matches the field byte-for-byte.
 */
export function validateOwnerCsrfPair(
  cookieValue: string | null,
  formValue: unknown,
  secret: OwnerCsrfSecret
): boolean {
  if (!cookieValue || typeof formValue !== "string" || !formValue) {
    return false;
  }
  if (!verifyOwnerCsrfToken(cookieValue, secret)) {
    return false;
  }
  if (!verifyOwnerCsrfToken(formValue, secret)) {
    return false;
  }
  return timingSafeEqualString(cookieValue, formValue);
}

/**
 * Render a hidden input element carrying the CSRF token. The token is
 * `<nonce>.<sig>` where both halves are base64url-safe; HTML escaping
 * is unnecessary but we belt-and-brace against future alphabet changes.
 */
export function renderCsrfHiddenField(token: string): string {
  const safe = token.replace(/[^A-Za-z0-9_\-=.]/g, "");
  return `<input type="hidden" name="${OWNER_CSRF_FIELD_NAME}" value="${safe}" />`;
}
