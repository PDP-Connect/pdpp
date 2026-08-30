// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Hermetic REAL-browser fixture connector, built to prove the
 * `writeBrowserHarReplayPreload` fix in `src/scenario/browser-har-replay.ts`
 * end to end: `bin/scenario-record.ts --record-har` against this fixture
 * produces a `recorded-browser` scenario (real HAR + storageState), and
 * `bin/scenario-verify.ts` against that scenario replays it through a real
 * patchright Chromium with `context.routeFromHAR`.
 *
 * Unlike `src/test-fixtures/scenario-record-har-stub-connector.ts` (which
 * simulates HAR writing without ever launching Chromium — see that file's
 * doc comment), this fixture launches a REAL browser via
 * `browser: { profileName }`, so `collect()` runs with a live `page` and
 * this package's actual browser-launch/session-establish machinery. No
 * `ensureSession`/`probeSession` is configured — `establishSession` treats
 * that as "connector assumes session is live" (src/session-establish.ts),
 * which is correct here: the loopback stub server this fixture talks to has
 * no login wall.
 *
 * Shape mirrors reddit's actual traffic pattern (the task's stated proof
 * target): `page.goto` to load a page, then `page.evaluate(fetch(...))` for
 * the data call — the exact pattern that makes browser-driven connectors'
 * network traffic invisible to the Node-process-level fetch/http/net
 * preload (subprocess-fetch-preloads.ts) and therefore need HAR-level replay
 * at all (see browser-har-replay.ts's module doc comment).
 *
 * `PDPP_SCENARIO_STUB_BASE_URL` points at a same-test loopback HTTP stub
 * (never a real provider — this fixture is for a hermetic local proof only).
 */

import type { BrowserCollectContext, RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

interface StubItem {
  id: string;
  value: string;
}

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string" && typeof data.value === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected string id and value" }] };
};

runConnector({
  name: "browser-har-replay-e2e-connector",
  validateRecord,
  browser: {
    profileName: "browser-har-replay-e2e",
  },
  async collect({ page, emit, emitRecord }: BrowserCollectContext) {
    const baseUrl = process.env.PDPP_SCENARIO_STUB_BASE_URL;
    if (!baseUrl) {
      throw new Error("browser-har-replay-e2e-connector: PDPP_SCENARIO_STUB_BASE_URL is not set");
    }

    await emit({ type: "PROGRESS", stream: "items", message: "loading stub page" });
    await page.goto(new URL("/", baseUrl).toString(), { waitUntil: "load" });

    // reddit's exact shape: page.evaluate(fetch), never a Node-side fetch.
    const body = (await page.evaluate(async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`fetch failed with status ${String(res.status)}`);
      }
      return (await res.json()) as { items: StubItem[] };
    }, new URL("/api/items", baseUrl).toString())) as { items: StubItem[] };

    for (const item of body.items) {
      await emitRecord("items", { id: item.id, value: item.value });
    }
  },
});
