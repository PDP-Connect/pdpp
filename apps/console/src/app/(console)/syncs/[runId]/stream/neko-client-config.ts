// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

export const NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE =
  "The browser stream could not finish loading. Check your network connection and try again.";

const CONFIG_FETCH_ATTEMPTS = 3;
const CONFIG_FETCH_RETRY_MS = 250;
const NETWORK_ERROR_MESSAGE_RE = /failed to fetch|network/i;

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;
type SleepLike = (ms: number) => Promise<void>;
export type NekoClientConfigObservation =
  | { attempt: number; outcome: "request_started" }
  | { attempt: number; outcome: "response"; status: number }
  | {
      attempt: number;
      errorKind: "http_status" | "invalid_response" | "network";
      outcome: "failed";
      willRetry: boolean;
    };

function notifyObservation(
  callback: ((observation: NekoClientConfigObservation) => void) | undefined,
  observation: NekoClientConfigObservation
): void {
  try {
    callback?.(observation);
  } catch {
    /* Diagnostics must not affect config fetch or retry behavior. */
  }
}

function isRetryableConfigFetchError(err: unknown): boolean {
  if (err instanceof TypeError) {
    return true;
  }
  if (err instanceof DOMException && err.name === "NetworkError") {
    return true;
  }
  return err instanceof Error && NETWORK_ERROR_MESSAGE_RE.test(err.message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchNekoClientConfigResponse(
  clientConfigPath: string,
  options: {
    fetchImpl?: FetchLike;
    onObservation?: (observation: NekoClientConfigObservation) => void;
    sleepImpl?: SleepLike;
  } = {}
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleepImpl = options.sleepImpl ?? sleep;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= CONFIG_FETCH_ATTEMPTS; attempt += 1) {
    let httpStatusFailure = false;
    try {
      notifyObservation(options.onObservation, { attempt, outcome: "request_started" });
      const response = await fetchImpl(clientConfigPath, {
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      notifyObservation(options.onObservation, { attempt, outcome: "response", status: response.status });
      if (!response.ok) {
        httpStatusFailure = true;
        notifyObservation(options.onObservation, {
          attempt,
          errorKind: "http_status",
          outcome: "failed",
          willRetry: false,
        });
        throw new Error(`n.eko client config failed with HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      lastError = err;
      if (httpStatusFailure) {
        throw err;
      }
      const retryable = isRetryableConfigFetchError(err);
      const willRetry = retryable && attempt < CONFIG_FETCH_ATTEMPTS;
      notifyObservation(options.onObservation, {
        attempt,
        errorKind: retryable ? "network" : "invalid_response",
        outcome: "failed",
        willRetry,
      });
      if (!retryable) {
        throw err;
      }
      if (!willRetry) {
        break;
      }
      await sleepImpl(CONFIG_FETCH_RETRY_MS * attempt);
    }
  }

  throw new Error(NEKO_CLIENT_CONFIG_UNAVAILABLE_MESSAGE, { cause: lastError });
}
