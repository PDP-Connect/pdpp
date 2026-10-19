// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { type PdppResponse, request } from "./http.ts";

/** Kept separate so live-target proofs can advance polling without altering HTTP timers. */
export const CLIENT_REVOCATION_CLOCK = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/** A timeout is an unobserved response, never proof that a token was revoked. */
async function probe(
  baseUrl: string,
  path: string,
  token: string,
  timeoutMs: number
): Promise<PdppResponse | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let onTimeout: (() => void) | undefined;
  const expired = new Promise<undefined>((resolve) => {
    onTimeout = () => resolve(undefined);
    timeout.addEventListener("abort", onTimeout, { once: true });
  });
  try {
    return await Promise.race([request(baseUrl, path, { token }), expired]);
  } finally {
    if (onTimeout) {
      timeout.removeEventListener("abort", onTimeout);
    }
  }
}

/**
 * Core Section 10 permits positive RS introspection caches for 60 seconds.
 * This clock is deliberately separate from immediate AS introspection checks.
 * A probe has at most five seconds and never more than the remaining window.
 * The final probe starts at the deadline with no additional waiting budget:
 * an unavailable final observation is inconclusive, not a conformance failure.
 * Stop on timeout, rather than piling up requests that may still be in flight.
 */
export async function pollClientRevocation(
  baseUrl: string,
  path: string,
  token: string
): Promise<PdppResponse | undefined> {
  const deadline = CLIENT_REVOCATION_CLOCK.now() + 60_000;
  let interval = 250;
  for (;;) {
    const remaining = deadline - CLIENT_REVOCATION_CLOCK.now();
    if (remaining < 0) {
      return undefined;
    }
    // biome-ignore lint/performance/noAwaitInLoops: deliberate sequential probes prevent overlapping requests.
    const response = await probe(baseUrl, path, token, Math.min(5000, remaining));
    if (response?.status !== 200) {
      return response;
    }
    if (CLIENT_REVOCATION_CLOCK.now() >= deadline) {
      // A pre-deadline request may legitimately read from a positive cache.
      // Only a probe started at the deadline can establish continued success.
      return remaining === 0 ? response : undefined;
    }
    await CLIENT_REVOCATION_CLOCK.sleep(Math.min(interval, deadline - CLIENT_REVOCATION_CLOCK.now()));
    interval = Math.min(interval * 2, 4000);
  }
}
