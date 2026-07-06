/**
 * OAuth substrate primitives — commodity OAuth 2.0 / PKCE crypto.
 *
 * Pure substrate (RFC 6749 / RFC 7636 / RFC 7662 envelope): opaque bearer-token
 * and refresh-token secret generation, refresh-token-at-rest hashing, PKCE S256
 * challenge derivation, and the PKCE verifier shape + challenge-method allow-list.
 *
 * This module carries no application policy — its public interface is purely
 * OAuth/PKCE crypto. Higher-level authorization semantics sit on top of this
 * substrate in auth.js.
 */
import { createHash, randomBytes } from "node:crypto";

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateOAuthRefreshToken(): string {
  return `rt_${randomBytes(32).toString("base64url")}`;
}

export function hashOAuthRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(String(refreshToken)).digest("base64url");
}

export function base64UrlSha256(value: string): string {
  return createHash("sha256").update(String(value)).digest("base64url");
}

export const SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS = new Set(["S256"]);
export const PKCE_CODE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
