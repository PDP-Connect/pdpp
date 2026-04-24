/**
 * Server-only dashboard helpers for:
 * - internal AS/RS fetch targets
 * - browser-facing reference URLs on the composed Next origin
 * - owner-session forwarding and dashboard gating
 * - owner self-export token minting
 */
import "server-only";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createOwnerSessionController, OWNER_AUTH_COOKIE_NAME } from "pdpp-reference-implementation/owner-session";
import {
  resolveReferenceBrowserOrigin,
  resolveReferenceTopology,
  stripTrailingSlash,
} from "pdpp-reference-implementation/reference-topology";

const SUBJECT_ID = process.env.PDPP_SUBJECT_ID || "the owner";
const CLIENT_ID = "pdpp-polyfill-owner-bootstrap";
// Built via RegExp constructor so Biome's noControlCharactersInRegex lint
// (which scans regex literals for literal C0/DEL escapes) does not fire.
// Still matches the C0 control range (0x00-0x1F) and DEL (0x7F).
const CONTROL_CHAR_RE = new RegExp("[\\u0000-\\u001F\\u007F]");

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

function normalizeDashboardReturnTo(input: string | null | undefined): string {
  if (typeof input !== "string" || !input) {
    return "/dashboard";
  }
  if (!input.startsWith("/dashboard")) {
    return "/dashboard";
  }
  if (input.startsWith("//")) {
    return "/dashboard";
  }
  if (input.includes("\\")) {
    return "/dashboard";
  }
  if (CONTROL_CHAR_RE.test(input)) {
    return "/dashboard";
  }
  return input;
}

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
  if (!ownerSessionController.enabled) {
    return null;
  }

  try {
    const cookieStore = await cookies();
    const rawCookie = cookieStore.get(OWNER_AUTH_COOKIE_NAME)?.value ?? null;
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

export async function requireDashboardOwnerSession(explicitReturnTo?: string) {
  if (!ownerSessionController.enabled) {
    return null;
  }

  const cookieStore = await cookies();
  const rawCookie = cookieStore.get(OWNER_AUTH_COOKIE_NAME)?.value ?? null;
  const session = ownerSessionController.readSessionFromCookieValue(rawCookie);
  if (session) {
    return session;
  }

  let returnTo = explicitReturnTo;
  if (!returnTo) {
    const headerList = await headers();
    returnTo = headerList.get("x-pdpp-return-to") ?? "/dashboard";
  }

  redirect(`${getOwnerLoginPath()}?return_to=${encodeURIComponent(normalizeDashboardReturnTo(returnTo))}`);
}

export class ReferenceServerUnreachableError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown
  ) {
    super(message);
    this.name = "ReferenceServerUnreachableError";
  }
}

async function mintOwnerToken(): Promise<string> {
  const form = (obj: Record<string, string>) => new URLSearchParams(obj).toString();

  let deviceRes: Response;
  try {
    deviceRes = await fetch(
      `${getAsInternalUrl()}/oauth/device_authorization`,
      await withOwnerSessionCookie({
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ client_id: CLIENT_ID }),
        cache: "no-store",
      })
    );
  } catch (err) {
    throw new ReferenceServerUnreachableError(`Cannot reach authorization server at ${getAsInternalUrl()}`, err);
  }
  if (!deviceRes.ok) {
    throw new Error(`device_authorization failed (${deviceRes.status}): ${await deviceRes.text()}`);
  }
  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
  };

  const approveRes = await fetch(
    `${getAsInternalUrl()}/device/approve`,
    await withOwnerSessionCookie({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({ user_code: device.user_code, subject_id: SUBJECT_ID }),
      cache: "no-store",
    })
  );
  if (!approveRes.ok) {
    throw new Error(`device/approve failed (${approveRes.status}): ${await approveRes.text()}`);
  }

  const tokenRes = await fetch(
    `${getAsInternalUrl()}/oauth/token`,
    await withOwnerSessionCookie({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
        client_id: CLIENT_ID,
      }),
      cache: "no-store",
    })
  );
  if (!tokenRes.ok) {
    throw new Error(`/oauth/token failed (${tokenRes.status}): ${await tokenRes.text()}`);
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
