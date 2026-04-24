export const OWNER_SESSION_COOKIE_NAME: string;
export const OWNER_SESSION_DEFAULT_TTL_SECONDS: number;
export const OWNER_SESSION_DEFAULT_SUBJECT_ID: string;

export const OWNER_AUTH_COOKIE_NAME: string;
export const OWNER_AUTH_DEFAULT_SESSION_TTL_SECONDS: number;
export const OWNER_AUTH_DEFAULT_SUBJECT_ID: string;

export interface OwnerSessionPayload {
  exp: number;
  iat: number;
  sub: string;
}

export function encodeOwnerSession(payload: OwnerSessionPayload, secret: string | Uint8Array): string;

export function decodeOwnerSession(
  token: string,
  secret: string | Uint8Array,
  opts?: { nowSeconds?: number }
): OwnerSessionPayload | null;

export function deriveOwnerSessionSecret(password: string): Uint8Array;

export function parseCookieHeader(header?: string | null): Record<string, string>;

export function readOwnerSessionFromCookieValue(
  raw: string | null | undefined,
  secret: string | Uint8Array | null | undefined
): OwnerSessionPayload | null;

export function readOwnerSessionFromCookieHeader(
  header: string | null | undefined,
  secret: string | Uint8Array | null | undefined
): OwnerSessionPayload | null;

export function buildOwnerSessionSetCookie(value: string, opts?: { maxAgeSeconds?: number; secure?: boolean }): string;

export function buildOwnerSessionClearCookie(opts?: { secure?: boolean }): string;

export interface OwnerSessionController {
  clearSessionCookieHeader(opts?: { secure?: boolean }): string;
  enabled: boolean;
  issueSessionCookieHeader(opts?: { secure?: boolean }): string | null;
  readSessionFromCookieHeader(header?: string | null): OwnerSessionPayload | null;
  readSessionFromCookieValue(raw?: string | null): OwnerSessionPayload | null;
  subjectId: string;
}

export function createOwnerSessionController(opts?: {
  password?: string | null;
  subjectId?: string | null;
  sessionTtlSeconds?: number;
}): OwnerSessionController;
