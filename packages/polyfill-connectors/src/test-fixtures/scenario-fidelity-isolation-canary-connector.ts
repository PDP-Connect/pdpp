// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-fidelity.test.ts`'s network
 * namespace isolation proof (FIX 3). This connector deliberately ESCAPES
 * the JS-layer `fetch` patching that `subprocess-fetch-preloads.ts`'s
 * replay preload installs — the entire point of `isolation.ts` is to close
 * exactly this gap at the OS layer, so the proof has to actually attempt
 * the escape a real misbehaving/compromised connector would:
 *
 *   1. Spawns `curl <canaryUrl>` as a CHILD PROCESS (child_process.spawn),
 *      not through `fetch` at all — the preload's JS-layer denial has no
 *      power over a spawned descendant's own network stack.
 *   2. ALSO makes one ordinary `fetch()` call through the bridge (to
 *      `PDPP_SCENARIO_FIDELITY_BASE_URL`, the test's normal in-scenario
 *      provider), proving the UDS bridge mode still works for legitimate
 *      traffic even while namespace-isolated.
 *
 * Reads the canary target from `PDPP_SCENARIO_FIDELITY_CANARY_URL` — a
 * parent-side plain HTTP server this fixture must NEVER be able to reach
 * when network-namespace isolation (isolation.ts's
 * `spawnWithNetworkIsolation`) actually wraps this process. Exits non-zero
 * if the curl escape unexpectedly reaches the canary (belt-and-suspenders —
 * the test's authoritative proof is the canary server's own hit counter,
 * which this fixture cannot fake since it runs in a separate process the
 * test parent observes directly).
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import { spawnSync } from "node:child_process";
import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "scenario-fidelity-isolation-canary-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const baseUrl = process.env.PDPP_SCENARIO_FIDELITY_BASE_URL;
    const canaryUrl = process.env.PDPP_SCENARIO_FIDELITY_CANARY_URL;
    if (!baseUrl) {
      throw new Error("scenario-fidelity-isolation-canary-connector: PDPP_SCENARIO_FIDELITY_BASE_URL is not set");
    }
    if (!canaryUrl) {
      throw new Error("scenario-fidelity-isolation-canary-connector: PDPP_SCENARIO_FIDELITY_CANARY_URL is not set");
    }

    await emit({ type: "PROGRESS", stream: "items", message: "attempting curl escape + bridged fetch" });

    // Escape attempt: a real network-capable child process, bypassing the
    // JS-layer fetch patch entirely. `--max-time 3` bounds how long this can
    // hang when isolation is working (no route to the canary at all).
    const curlResult = spawnSync("curl", ["--silent", "--max-time", "3", "--fail", canaryUrl], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await emitRecord("items", {
      id: "curl-escape-attempt",
      curl_exit_code: curlResult.status,
      curl_reached_canary: curlResult.status === 0,
    });

    // Legitimate traffic: must still work over the UDS bridge even while
    // this process (and the curl child above) is namespace-isolated.
    const res = await fetch(new URL("/ping", baseUrl));
    const body = (await res.json()) as { ok: boolean };
    await emitRecord("items", { id: "bridged-fetch", ok: body.ok });

    await emit({ type: "STATE", stream: "items", cursor: { done: true } });
  },
});
