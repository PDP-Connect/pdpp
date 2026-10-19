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
 * Probes inside the window have at most five seconds and never more than the
 * remaining window; a refusal ends the poll early. A 200 inside the window may
 * come from a permitted cache, so it proves nothing. Once the window has
 * passed, one final probe always runs with its own five-second budget, so
 * timer overshoot cannot turn a server that never revokes into a skip: its
 * 200 is the evidence of continued access. A final probe that times out is
 * inconclusive. Stop on a timeout rather than piling up requests in flight.
 */
export async function pollClientRevocation(
  baseUrl: string,
  path: string,
  token: string
): Promise<PdppResponse | undefined> {
  const deadline = CLIENT_REVOCATION_CLOCK.now() + 60_000;
  let interval = 250;
  let remaining = deadline - CLIENT_REVOCATION_CLOCK.now();
  while (remaining > 0) {
    // biome-ignore lint/performance/noAwaitInLoops: deliberate sequential probes prevent overlapping requests.
    const response = await probe(baseUrl, path, token, Math.min(5000, remaining));
    if (response?.status !== 200) {
      return response;
    }
    remaining = deadline - CLIENT_REVOCATION_CLOCK.now();
    if (remaining > 0) {
      await CLIENT_REVOCATION_CLOCK.sleep(Math.min(interval, remaining));
      interval = Math.min(interval * 2, 4000);
      remaining = deadline - CLIENT_REVOCATION_CLOCK.now();
    }
  }
  return probe(baseUrl, path, token, 5000);
}
