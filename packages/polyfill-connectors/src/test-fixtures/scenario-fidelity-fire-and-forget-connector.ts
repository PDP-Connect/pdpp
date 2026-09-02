// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-fidelity.test.ts`'s
 * pending-counter race proof (FIX 1(e)): starts a `fetch()` call against a
 * provider endpoint that never responds (`/never-responds`, a request the
 * test's provider accepts the connection for and then simply never writes
 * a response body), deliberately does NOT `await` it, and calls
 * `process.exit(0)` immediately after — reproducing the exact silent-loss
 * race the fix closes: a request in flight when the process exits should
 * never be reported as a complete, trustworthy capture.
 *
 * This bypasses `runConnector`'s own DONE/exit machinery entirely (a
 * connector that calls `process.exit(0)` directly, mid-collect, is exactly
 * the misbehavior this fixture exists to simulate) — it does not use
 * `runConnector` at all, since the point is to prove the RECORD preload's
 * own `process.on("exit")` handler observes the pending counter
 * independently of whatever the connector-runtime protocol would otherwise
 * report. NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

const baseUrl = process.env.PDPP_SCENARIO_FIDELITY_BASE_URL;
if (!baseUrl) {
  throw new Error("scenario-fidelity-fire-and-forget-connector: PDPP_SCENARIO_FIDELITY_BASE_URL is not set");
}

// Fire-and-forget: intentionally not awaited. Errors are swallowed on
// purpose — this fixture proves the RECORD preload observes an in-flight
// request at exit regardless of how that request eventually would have
// settled; nothing here should ever surface an unhandledRejection.
fetch(new URL("/never-responds", baseUrl)).catch(() => undefined);

// Give the request a moment to actually reach the preload's patched fetch
// (and increment its pending counter) before this process exits — a
// same-tick exit could race the request never even starting.
setTimeout(() => {
  process.exit(0);
}, 200);
