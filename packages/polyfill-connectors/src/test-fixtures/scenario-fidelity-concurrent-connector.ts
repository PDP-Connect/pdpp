// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-fidelity.test.ts`'s
 * seq-at-initiation proof: fires TWO requests concurrently
 * (`Promise.all`, not awaited one at a time) against a provider that
 * resolves the SECOND-initiated request FIRST (`/slow` sleeps before
 * responding; `/fast` responds immediately) — so the requests' seq numbers
 * can only reflect call order (both initiated before either resolves), not
 * response-completion order, if FIX 1(c) is actually in effect. Recording
 * seq at response-completion (the pre-fix behavior) would number `/fast`
 * (completes first) ahead of `/slow` even though `/slow` was called first.
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "scenario-fidelity-concurrent-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const baseUrl = process.env.PDPP_SCENARIO_FIDELITY_BASE_URL;
    if (!baseUrl) {
      throw new Error("scenario-fidelity-concurrent-connector: PDPP_SCENARIO_FIDELITY_BASE_URL is not set");
    }

    await emit({ type: "PROGRESS", stream: "items", message: "firing concurrent requests" });

    // Initiated in this order (slow first), but /slow resolves AFTER /fast.
    const slowPromise = fetch(new URL("/slow", baseUrl));
    const fastPromise = fetch(new URL("/fast", baseUrl));
    const [slowRes, fastRes] = await Promise.all([slowPromise, fastPromise]);
    const slow = (await slowRes.json()) as { id: string };
    const fast = (await fastRes.json()) as { id: string };
    await emitRecord("items", { id: slow.id });
    await emitRecord("items", { id: fast.id });

    await emit({ type: "STATE", stream: "items", cursor: { done: true } });
  },
});
