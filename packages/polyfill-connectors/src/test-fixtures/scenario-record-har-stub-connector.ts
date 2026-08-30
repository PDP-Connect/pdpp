// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only stub connector for `bin/scenario-record-har.test.ts`.
 *
 * Simulates a browser-driven connector WITHOUT actually launching a real
 * Chromium — spinning up Patchright in CI for a plumbing test would be slow
 * and outside this suite's "no live browser" convention (see
 * `src/browser-launch.test.ts`'s module comment: "We do NOT spin up a real
 * Chromium for this"). Instead this fixture writes a synthetic UNREDACTED
 * HAR (real secret-shaped headers/cookies/postData) to the path
 * `bin/scenario-record.ts` publishes via `PDPP_SCENARIO_HAR_RECORD_PATH`
 * (src/browser-launch.ts's `HAR_RECORD_PATH_ENV`), then calls
 * `browser-launch.ts`'s EXPORTED, REAL `redactHarFileBestEffort` on it — the
 * exact same function `acquireIsolatedBrowser`'s `release()` calls for a
 * real browser context, not a re-implementation this fixture could drift
 * from. This is the faithful simulation boundary: everything Playwright
 * itself would do (launch, navigate, buffer HAR entries, flush on close) is
 * out of scope for a hermetic test; everything THIS package's own code does
 * with the result (redact, then hand off to the CLI) is exercised for real.
 * storageState is written directly (unredacted, matching
 * `writeStorageStateBestEffort`'s own behavior — there is nothing to redact
 * there by design; see that function's doc comment).
 *
 * Also makes one real fetch call to `PDPP_SCENARIO_STUB_BASE_URL`, mirroring
 * `scenario-cli-stub-connector.ts`, so the existing fetch-preload capture
 * path is exercised at the same time (a real browser-driven connector still
 * often makes SOME Node-side fetch calls, e.g. auth token refresh) — this is
 * incidental to the HAR test, not its focus.
 *
 * Controlled by env vars so the SAME fixture file can exercise both the
 * "recording requested and succeeds" and "context.close() never happens"
 * (SIGKILL-equivalent) paths from one test file:
 *   - `PDPP_TEST_HAR_STUB_SKIP_WRITE=1` — skip writing the HAR/storageState
 *     entirely, simulating a browser context whose close() never completed
 *     (this fixture then hangs, so the CALLER must be the one to SIGKILL it
 *     via the CLI's own inactivity watchdog with a short --timeout).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactHarFileBestEffort } from "../browser-launch.ts";
import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected string id" }] };
};

/** Synthetic HAR carrying exactly the secret shapes
 *  `bin/scenario-record-har.test.ts` asserts get stripped: a `Cookie`
 *  request header, a `Set-Cookie` response header, an `Authorization`
 *  request header, structured HAR `cookies[]` on both sides, and a
 *  form-encoded login POST with a `password` field — plus a JSON response
 *  body (left untouched, proving bodies are deliberately NOT redacted). */
function syntheticHar(): unknown {
  return {
    log: {
      version: "1.2",
      creator: { name: "test-fixture", version: "1" },
      entries: [
        {
          startedDateTime: "2026-08-21T00:00:00.000Z",
          request: {
            method: "POST",
            url: "https://provider.example.test/login",
            headers: [
              { name: "cookie", value: "session=super-secret-session-value" },
              { name: "authorization", value: "Bearer super-secret-bearer-token" },
              { name: "content-type", value: "application/x-www-form-urlencoded" },
            ],
            cookies: [{ name: "session", value: "super-secret-session-value" }],
            postData: {
              mimeType: "application/x-www-form-urlencoded",
              text: "username=alice&password=hunter2",
              params: [
                { name: "username", value: "alice" },
                { name: "password", value: "hunter2" },
              ],
            },
          },
          response: {
            status: 200,
            headers: [
              { name: "set-cookie", value: "session=super-secret-session-value; Path=/" },
              { name: "content-type", value: "application/json" },
            ],
            cookies: [{ name: "session", value: "super-secret-session-value" }],
            content: {
              mimeType: "application/json",
              text: JSON.stringify({ ok: true, account_id: "acct_12345" }),
            },
          },
        },
      ],
    },
  };
}

function syntheticStorageState(): unknown {
  return {
    cookies: [
      {
        name: "session",
        value: "super-secret-session-value",
        domain: "provider.example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

runConnector({
  name: "scenario-record-har-stub-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const harPath = process.env.PDPP_SCENARIO_HAR_RECORD_PATH;
    const storageStatePath = process.env.PDPP_SCENARIO_STORAGE_STATE_RECORD_PATH;
    const skipWrite = process.env.PDPP_TEST_HAR_STUB_SKIP_WRITE === "1";
    // Simulates a connector that never launches a browser at all — e.g. a
    // fetch-only connector run under `--record-har` (harmless no-op flag for
    // that connector). The env vars are present (the CLI always publishes
    // them when `--record-har` is passed, regardless of connector shape) but
    // nothing ever writes to them, and the run completes normally — proving
    // `bin/scenario-record.ts`'s `resolveRunEnvironment` keeps this run
    // `recorded-http` rather than claiming `recorded-browser` for a HAR that
    // was requested but never produced.
    const noBrowser = process.env.PDPP_TEST_HAR_STUB_NO_BROWSER === "1";

    await emit({ type: "PROGRESS", stream: "items", message: "simulating browser-driven collection" });

    if (harPath && storageStatePath && !(skipWrite || noBrowser)) {
      mkdirSync(dirname(harPath), { recursive: true });
      // Write the RAW, unredacted HAR first (this is what Playwright's own
      // HarRecorder.flush() would produce), then call the real redaction
      // pass — mirrors acquireIsolatedBrowser's release() ordering exactly.
      writeFileSync(harPath, JSON.stringify(syntheticHar()), "utf8");
      await redactHarFileBestEffort(harPath);
      // storageState is never redacted — see writeStorageStateBestEffort's
      // doc comment in browser-launch.ts.
      writeFileSync(storageStatePath, JSON.stringify(syntheticStorageState()), "utf8");
    }

    const baseUrl = process.env.PDPP_SCENARIO_STUB_BASE_URL;
    if (baseUrl) {
      const res = await fetch(new URL("/items", baseUrl));
      if (!res.ok) {
        throw new Error(`scenario-record-har-stub-connector: fetch failed with status ${String(res.status)}`);
      }
      const body = (await res.json()) as { items: Array<{ id: string }> };
      for (const item of body.items) {
        await emitRecord("items", { id: item.id });
      }
    } else {
      await emitRecord("items", { id: "stub-1" });
    }

    if (skipWrite) {
      // Simulate a context whose close() never ran: hang forever so the
      // test's own --timeout inactivity watchdog is what kills this
      // process, mirroring a real SIGKILLed browser context — this fixture
      // never gets to (and must not) write the HAR/storageState itself.
      await new Promise(() => undefined);
    }
  },
});
