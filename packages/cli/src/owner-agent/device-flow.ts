// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// RFC 8628 device-authorization handling for the trusted owner-agent flow.
//
// The owner approves in a browser; the CLI prints only the verification URL,
// the user code, and non-secret polling status. The bearer returned by the
// token endpoint is NEVER printed here — it is returned to the caller for
// non-printing storage.

import { OwnerAgentError } from "./errors.ts";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

type FetchFn = typeof fetch;

interface DeviceAuthorizationResponse {
  device_code?: string;
  expires_in?: number;
  interval?: number;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  expiresInMs: number;
  intervalMs: number;
  userCode: string | null;
  verificationUri: string;
  verificationUriComplete: string | null;
}

interface InitiateDeviceAuthorizationArgs {
  clientId?: string;
  endpoint: string;
  fetchFn: FetchFn;
}

/**
 * Initiate device authorization. Returns the public RFC 8628 envelope.
 */
export async function initiateDeviceAuthorization({
  fetchFn,
  endpoint,
  clientId,
}: InitiateDeviceAuthorizationArgs): Promise<DeviceAuthorization> {
  const body = new URLSearchParams();
  if (clientId) {
    body.set("client_id", clientId);
  }
  const result = await postForm(fetchFn, endpoint, body);
  const verificationUri = result.verification_uri_complete ?? result.verification_uri;
  if (!(result.device_code && verificationUri)) {
    throw new OwnerAgentError(
      "device_authorization_invalid",
      "Device authorization response did not include a device_code and verification URI."
    );
  }
  return {
    deviceCode: result.device_code,
    userCode: result.user_code ?? null,
    verificationUri,
    verificationUriComplete: result.verification_uri_complete ?? null,
    intervalMs: Number.isFinite(Number(result.interval)) ? Number(result.interval) * 1000 : DEFAULT_POLL_INTERVAL_MS,
    expiresInMs: Number.isFinite(Number(result.expires_in))
      ? Number(result.expires_in) * 1000
      : DEFAULT_POLL_TIMEOUT_MS,
  };
}

interface TokenResponse {
  access_token?: string;
  code?: string;
  error?: { code?: string } | string;
  expires_in?: number;
  registration_client_uri?: string;
  scope?: string;
  token_type?: string;
}

export interface OwnerAgentToken {
  access_token: string;
  expires_at: string | null;
  registration_client_uri: string | null;
  scope: string | null;
  token_type: string;
}

interface PollForOwnerAgentTokenArgs {
  clientId?: string | undefined;
  deviceCode: string;
  endpoint: string;
  fetchFn: FetchFn;
  intervalMs?: number | undefined;
  now?: (() => number) | undefined;
  onPending?: ((kind: "pending" | "slow_down") => void) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Poll the token endpoint until the owner approves, denies, or it expires.
 * Honors RFC 8628 `authorization_pending` / `slow_down` / `access_denied` /
 * `expired_token`.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this function's branching mirrors RFC 8628's distinct terminal poll outcomes (pending/slow_down/denied/expired/invalid/unexpected); splitting it would scatter closely-related error handling.
export async function pollForOwnerAgentToken({
  fetchFn,
  endpoint,
  clientId,
  deviceCode,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  onPending,
}: PollForOwnerAgentTokenArgs): Promise<OwnerAgentToken> {
  const startedAt = now();
  let currentInterval = intervalMs;

  while (now() - startedAt <= timeoutMs) {
    const body = new URLSearchParams();
    body.set("grant_type", DEVICE_CODE_GRANT_TYPE);
    body.set("device_code", deviceCode);
    if (clientId) {
      body.set("client_id", clientId);
    }

    // biome-ignore lint/performance/noAwaitInLoops: intentional sequential polling with backoff, not a parallelizable batch.
    const { status, json } = await postFormRaw(fetchFn, endpoint, body);
    const errorObj = typeof json?.error === "object" ? json.error : undefined;
    const errorCode = errorObj?.code ?? json?.error ?? json?.code;

    if (status >= 200 && status < 300 && json?.access_token) {
      return {
        access_token: json.access_token,
        token_type: json.token_type ?? "Bearer",
        expires_at: expiresAt(json.expires_in, now),
        scope: json.scope ?? null,
        registration_client_uri: json.registration_client_uri ?? null,
      };
    }

    if (errorCode === "authorization_pending") {
      onPending?.("pending");
      await sleep(currentInterval);
      continue;
    }
    if (errorCode === "slow_down") {
      currentInterval += 5000;
      onPending?.("slow_down");
      await sleep(currentInterval);
      continue;
    }
    if (errorCode === "access_denied") {
      throw new OwnerAgentError("approval_denied", "Owner denied the trusted owner-agent onboarding request.");
    }
    if (errorCode === "expired_token") {
      throw new OwnerAgentError(
        "approval_expired",
        "Owner-agent approval expired before it was granted. Run onboarding again."
      );
    }
    if (errorCode === "invalid_client" || errorCode === "invalid_grant") {
      throw new OwnerAgentError(
        "token_exchange_failed",
        `Token endpoint rejected the device-code exchange (${errorCode}).`
      );
    }

    throw new OwnerAgentError("token_exchange_failed", `Unexpected token endpoint response (HTTP ${status}).`);
  }

  throw new OwnerAgentError("approval_expired", "Timed out waiting for owner approval of the owner-agent credential.");
}

function expiresAt(expiresIn: number | undefined, now: () => number): string | null {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(now() + seconds * 1000).toISOString();
}

async function postForm(fetchFn: FetchFn, url: string, body: URLSearchParams): Promise<DeviceAuthorizationResponse> {
  const { status, json } = await postFormRaw(fetchFn, url, body);
  if (status < 200 || status >= 300) {
    const errorObj = typeof json?.error === "object" ? json.error : undefined;
    const errorCode = errorObj?.code ?? json?.error ?? json?.code ?? `http_${status}`;
    throw new OwnerAgentError("device_authorization_failed", `Device authorization failed (${errorCode}).`);
  }
  return json ?? {};
}

interface PostFormRawResult<T> {
  json: T | null;
  status: number;
}

async function postFormRaw<T = TokenResponse & DeviceAuthorizationResponse>(
  fetchFn: FetchFn,
  url: string,
  body: URLSearchParams
): Promise<PostFormRawResult<T>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: OwnerAgentError's constructor (code, message, exitCode) has no cause param; the original error's message is interpolated into the thrown message instead.
    throw new OwnerAgentError("request_failed", `Request to ${url} failed: ${(error as Error).message}.`);
  }
  let json: T | null = null;
  try {
    json = (await response.json()) as T;
  } catch {
    json = null;
  }
  return { status: response.status, json };
}
