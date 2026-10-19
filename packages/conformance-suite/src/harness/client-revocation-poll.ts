// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
import { type PdppResponse, request } from "./http.ts";

/**
 * Core Section 10 permits positive RS introspection caches for 60 seconds.
 * This clock is deliberately separate from immediate AS introspection checks.
 * Tests replace Date.now and setTimeout; production always allows the full TTL.
 */
export async function pollClientRevocation(baseUrl: string, path: string, token: string): Promise<PdppResponse> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: deliberate sequential poll; each probe waits on the previous response and the sleep below.
    const response = await request(baseUrl, path, { token });
    if (response.status !== 200 || Date.now() >= deadline) {
      return response;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
}
