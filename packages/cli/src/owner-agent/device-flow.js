// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// RFC 8628 device-authorization handling for the trusted owner-agent flow.
//
// The owner approves in a browser; the CLI prints only the verification URL,
// the user code, and non-secret polling status. The bearer returned by the
// token endpoint is NEVER printed here — it is returned to the caller for
// non-printing storage.

import { OwnerAgentError } from "./errors.js";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Initiate device authorization. Returns the public RFC 8628 envelope.
 */
export async function initiateDeviceAuthorization({ fetchFn, endpoint, clientId }) {
  const body = new URLSearchParams();
  if (clientId) {
    body.set("client_id", clientId);
  }
  const result = await postForm(fetchFn, endpoint, body);
  const verificationUri = result.verification_uri_complete ?? result.verification_uri;
  if (!result.device_code || !verificationUri) {
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

/**
 * Poll the token endpoint until the owner approves, denies, or it expires.
 * Honors RFC 8628 `authorization_pending` / `slow_down` / `access_denied` /
 * `expired_token`.
 */
export async function pollForOwnerAgentToken({
  fetchFn,
  endpoint,
  clientId,
  deviceCode,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  onPending,
}) {
  const startedAt = now();
  let currentInterval = intervalMs;

  while (now() - startedAt <= timeoutMs) {
    const body = new URLSearchParams();
    body.set("grant_type", DEVICE_CODE_GRANT_TYPE);
    body.set("device_code", deviceCode);
    if (clientId) {
      body.set("client_id", clientId);
    }

    const { status, json } = await postFormRaw(fetchFn, endpoint, body);
    const errorCode = json?.error?.code ?? json?.error ?? json?.code;

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

function expiresAt(expiresIn, now) {
  const seconds = Number(expiresIn);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(now() + seconds * 1000).toISOString();
}

async function postForm(fetchFn, url, body) {
  const { status, json } = await postFormRaw(fetchFn, url, body);
  if (status < 200 || status >= 300) {
    const errorCode = json?.error?.code ?? json?.error ?? json?.code ?? `http_${status}`;
    throw new OwnerAgentError("device_authorization_failed", `Device authorization failed (${errorCode}).`);
  }
  return json ?? {};
}

async function postFormRaw(fetchFn, url, body) {
  let response;
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
    throw new OwnerAgentError("request_failed", `Request to ${url} failed: ${error.message}.`);
  }
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}
