/**
 * Server-only helper: mint and cache an owner token from the reference AS.
 *
 * Matches the device-code flow used by
 * packages/polyfill-connectors/src/orchestrator.js (issueOwnerToken).
 * The owner token is the standard PDPP owner-self-export credential — the
 * dashboard is an ordinary PDPP client holding that token.
 *
 * Server-only: this module must not be imported by client components. It
 * reads env vars and holds a module-level token cache.
 */

const AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';
const RS_URL = process.env.PDPP_RS_URL || 'http://localhost:7663';
const SUBJECT_ID = process.env.PDPP_SUBJECT_ID || 'the owner';
const CLIENT_ID = 'pdpp-polyfill-owner-bootstrap';

let cachedToken: string | null = null;
let inFlight: Promise<string> | null = null;

export function getAsUrl(): string {
  return AS_URL;
}

export function getRsUrl(): string {
  return RS_URL;
}

export class ReferenceServerUnreachableError extends Error {
  constructor(message: string, public readonly cause: unknown) {
    super(message);
    this.name = 'ReferenceServerUnreachableError';
  }
}

async function mintOwnerToken(): Promise<string> {
  const form = (obj: Record<string, string>) =>
    new URLSearchParams(obj).toString();

  let deviceRes: Response;
  try {
    deviceRes = await fetch(`${AS_URL}/oauth/device_authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: CLIENT_ID }),
      cache: 'no-store',
    });
  } catch (err) {
    throw new ReferenceServerUnreachableError(
      `Cannot reach authorization server at ${AS_URL}`,
      err,
    );
  }
  if (!deviceRes.ok) {
    throw new Error(
      `device_authorization failed (${deviceRes.status}): ${await deviceRes.text()}`,
    );
  }
  const device = (await deviceRes.json()) as {
    device_code: string;
    user_code: string;
  };

  const approveRes = await fetch(`${AS_URL}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ user_code: device.user_code, subject_id: SUBJECT_ID }),
    cache: 'no-store',
  });
  if (!approveRes.ok) {
    throw new Error(
      `device/approve failed (${approveRes.status}): ${await approveRes.text()}`,
    );
  }

  const tokenRes = await fetch(`${AS_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: CLIENT_ID,
    }),
    cache: 'no-store',
  });
  if (!tokenRes.ok) {
    throw new Error(
      `/oauth/token failed (${tokenRes.status}): ${await tokenRes.text()}`,
    );
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };
  return access_token;
}

export async function getOwnerToken(force = false): Promise<string> {
  if (!force && cachedToken) return cachedToken;
  if (!force && inFlight) return inFlight;
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
