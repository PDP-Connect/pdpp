// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Server-only dashboard helpers for:
 * - internal AS/RS fetch targets
 * - browser-facing reference URLs on the composed Next origin
 * - owner-session forwarding (BFF cookie → AS)
 * - owner self-export token minting (via the AS back-channel endpoint)
 *
 * Auth gating lives in two layers per the BFF / token-handler pattern:
 *   1. `proxy.ts` — optimistic UX redirect when the session cookie is absent.
 *   2. `verify-session.ts` (DAL) — authoritative HMAC check before any fetch.
 * This module is the BFF's outbound-call helper, not an auth gate.
 */
import "server-only";

import { cookies, headers } from "next/headers";
import { createOwnerSessionController, OWNER_AUTH_COOKIE_NAME } from "pdpp-reference-implementation/owner-session";
import {
  resolveReferenceBrowserOrigin,
  resolveReferenceTopology,
  stripTrailingSlash,
} from "pdpp-reference-implementation/reference-topology";
import { isOwnerSessionRequiredBody } from "./auth-errors.ts";
import { redirectToOwnerLogin } from "./login-redirect.ts";

const CLIENT_ID = "pdpp-polyfill-owner-bootstrap";

let cachedToken: string | null = null;
let inFlight: Promise<string> | null = null;

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

async function getRequestOrigin(): Promise<string | null> {
  try {
    const headerList = await headers();
    const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
    if (!host) {
      return null;
    }

    const protocol =
      headerList.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1") ? "http" : "https");

    return `${protocol}://${host}`;
  } catch {
    return null;
  }
}

function resolveConfiguredReferenceOrigin(): string | null {
  const configured = process.env.PDPP_REFERENCE_ORIGIN?.trim();
  return configured ? stripTrailingSlash(configured) : null;
}

const referenceTopology = resolveReferenceTopology();

const ownerSessionController = createOwnerSessionController({
  password: process.env.PDPP_OWNER_PASSWORD,
  subjectId: process.env.PDPP_OWNER_SUBJECT_ID,
});

export function getAsInternalUrl(): string {
  return referenceTopology.asInternalUrl;
}

export function getRsInternalUrl(): string {
  return referenceTopology.rsInternalUrl;
}

export function getOwnerLoginPath(): string {
  return "/owner/login";
}

export function getReferencePublicPath(path: string): string {
  return ensureLeadingSlash(path);
}

export async function getReferencePublicOrigin(): Promise<string> {
  return resolveReferenceBrowserOrigin({
    explicitOrigin: resolveConfiguredReferenceOrigin(),
    requestOrigin: await getRequestOrigin(),
  });
}

export async function getReferencePublicUrl(path: string): Promise<string> {
  const origin = await getReferencePublicOrigin();
  return new URL(getReferencePublicPath(path), `${origin}/`).toString();
}

export async function toReferencePublicUrl(input: string): Promise<string> {
  if (!input) {
    return input;
  }
  if (input.startsWith("/")) {
    return getReferencePublicUrl(input);
  }

  try {
    const url = new URL(input);
    const origin = stripTrailingSlash(url.origin);
    const publicOrigin = await getReferencePublicOrigin();
    if (origin === stripTrailingSlash(publicOrigin)) {
      return url.toString();
    }

    if (origin === getAsInternalUrl() || origin === getRsInternalUrl()) {
      return new URL(`${url.pathname}${url.search}${url.hash}`, `${publicOrigin}/`).toString();
    }

    return url.toString();
  } catch {
    return input;
  }
}

export async function getOwnerSessionCookieHeader(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const rawCookie = cookieStore.get(OWNER_AUTH_COOKIE_NAME)?.value ?? null;
    // The web process is not the authority for placeholder owner-auth.
    // In Docker and composed deployments the reference AS may be the only
    // process with PDPP_OWNER_PASSWORD, so server components must forward
    // the browser's AS-issued session cookie even when this process cannot
    // validate it locally. The AS re-validates on every `/_ref` request.
    return rawCookie ? `${OWNER_AUTH_COOKIE_NAME}=${rawCookie}` : null;
  } catch {
    return null;
  }
}

export async function withOwnerSessionCookie(init: RequestInit = {}): Promise<RequestInit> {
  const cookieHeader = await getOwnerSessionCookieHeader();
  if (!cookieHeader) {
    return init;
  }

  const requestHeaders = new Headers(init.headers);
  const existingCookie = requestHeaders.get("cookie");
  requestHeaders.set("cookie", existingCookie ? `${existingCookie}; ${cookieHeader}` : cookieHeader);

  return {
    ...init,
    headers: requestHeaders,
  };
}

export function isOwnerSessionGateEnabled(): boolean {
  return ownerSessionController.enabled;
}

/**
 * Read the validated owner session payload from the request cookie, or `null`
 * if owner-auth is disabled in this process or the cookie is absent / invalid.
 *
 * Authoritative validation when this process holds `PDPP_OWNER_PASSWORD`. In
 * split deployments (AS holds password, web does not), the controller's
 * `readSessionFromCookieValue` returns `null` and callers fall back to
 * forwarding the cookie to the AS for revalidation.
 */
export async function readDashboardOwnerSession() {
  if (!ownerSessionController.enabled) {
    return null;
  }
  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(OWNER_AUTH_COOKIE_NAME)?.value ?? null;
  return ownerSessionController.readSessionFromCookieValue(rawCookie);
}

export class ReferenceServerUnreachableError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ReferenceServerUnreachableError";
    this.cause = cause;
  }
}

/**
 * Thrown by `authedFetch` and friends when the resource server returns a
 * non-OK HTTP status. Carries the status code so callers can branch on
 * `404` to render a graceful "stream unavailable" state instead of throwing
 * to the segment error boundary. Stream/connector visibility under owner
 * tokens is manifest-derived; once a stream is dropped from the manifest,
 * records-read endpoints return 404; that is an expected, recoverable
 * state for the dashboard, not a runtime error.
 */
export class ResourceServerHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly path: string;

  constructor(path: string, status: number, body: string) {
    super(`RS ${path} failed (${status}): ${body}`);
    this.name = "ResourceServerHttpError";
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

/**
 * Mint an owner-scoped self-export bearer for `/v1/*` reads by driving the
 * canonical RFC 8628 device flow against the AS, server-to-server.
 *
 * Why device flow specifically:
 *   - There is no IETF-standardized "personal access token" primitive. PATs
 *     are a vendor convention (GitHub/Linear/Vercel/Stripe each invented one).
 *   - OAuth 2.1 (draft-ietf-oauth-v2-1) deletes ROPC and offers no first-party
 *     exception. Authorization Code + PKCE assumes a redirect; Client
 *     Credentials assumes no user identity. For "operator at a browser issuing
 *     a bearer for their own CLI" the IETF-blessed primitive is Device Flow.
 *   - RFC 8628 §5.6 explicitly contemplates the operator-runs-the-flow-against-
 *     themselves case: "the user in possession of the client credentials can
 *     already impersonate the client and create a new authorization grant."
 *
 * The three POSTs (`/oauth/device_authorization`, `/device/approve`,
 * `/oauth/token`) use `Content-Type: application/json` to use the documented
 * CSRF exemption (server/owner-auth.ts isJsonRequest). Form-encoded POSTs
 * would require a hosted-form CSRF token that this server-to-server caller
 * never has — and shouldn't need, because cross-origin JSON POSTs require a
 * CORS preflight and aren't browser-forgeable.
 *
 * The session cookie is forwarded so requireOwnerSession (on /device/approve)
 * sees the operator's signed-in subject; the AS is the authority on subject
 * binding regardless of what we send in the body.
 */
async function mintOwnerToken(): Promise<string> {
  const asUrl = getAsInternalUrl();

  let deviceRes: Response;
  try {
    deviceRes = await fetch(
      `${asUrl}/oauth/device_authorization`,
      await withOwnerSessionCookie({
        body: JSON.stringify({ client_id: CLIENT_ID }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${asUrl}`, err);
  }
  if (!deviceRes.ok) {
    const body = await deviceRes.text();
    if (deviceRes.status === 401 && isOwnerSessionRequiredBody(body)) {
      await redirectToOwnerLogin();
    }
    throw new Error(`device_authorization failed (${deviceRes.status}): ${body}`);
  }
  const device = (await deviceRes.json()) as { device_code: string; user_code: string };

  const approveRes = await fetch(
    `${asUrl}/device/approve`,
    await withOwnerSessionCookie({
      body: JSON.stringify({ user_code: device.user_code }),
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  );
  if (!approveRes.ok) {
    const body = await approveRes.text();
    if (approveRes.status === 401 && isOwnerSessionRequiredBody(body)) {
      await redirectToOwnerLogin();
    }
    throw new Error(`device/approve failed (${approveRes.status}): ${body}`);
  }

  const tokenRes = await fetch(
    `${asUrl}/oauth/token`,
    await withOwnerSessionCookie({
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    })
  );
  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    if (tokenRes.status === 401 && isOwnerSessionRequiredBody(body)) {
      await redirectToOwnerLogin();
    }
    throw new Error(`/oauth/token failed (${tokenRes.status}): ${body}`);
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

export function getOwnerToken(force = false): Promise<string> {
  if (!force && cachedToken) {
    return Promise.resolve(cachedToken);
  }
  if (!force && inFlight) {
    return inFlight;
  }
  inFlight = mintOwnerToken()
    .then((t) => {
      cachedToken = t;
      return t;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function clearOwnerToken(): void {
  cachedToken = null;
}
