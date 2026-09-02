// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only stub connector for `bin/scenario-cli.test.ts`'s `--streams`
 * proof — a second, multi-stream stub alongside `scenario-cli-stub-
 * connector.ts` (which is deliberately single-stream and used by that
 * file's many other tests; adding a second declared stream to it would risk
 * changing those tests' behavior).
 *
 * Declares two streams, `items` and `extras`, each making a single REAL
 * `fetch` against `PDPP_SCENARIO_STUB_BASE_URL` (a synthetic loopback HTTP
 * provider this test starts) — only for the stream(s) present in
 * `ctx.requested` (built by connector-runtime.ts from `START.scope.streams`,
 * exactly the same mechanism `--streams` filters via `bin/scenario-
 * record.ts`'s `filterStreamsByName`). A stream absent from `requested`
 * makes NO request at all and emits nothing, so `--streams items` produces a
 * capture with `expected.records` containing ONLY `items` — proving the
 * scoping is real, not just a cosmetic START.scope echo.
 *
 * NOT registered in src/orchestrator.ts — fixture-only, never a production
 * connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

interface StubItem {
  id: string;
  value: string;
}

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if ((stream === "items" || stream === "extras") && typeof data.id === "string" && typeof data.value === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected string id and value" }] };
};

runConnector({
  name: "scenario-cli-multi-stream-stub-connector",
  validateRecord,
  async collect({ emit, emitRecord, requested }) {
    const baseUrl = process.env.PDPP_SCENARIO_STUB_BASE_URL;
    if (!baseUrl) {
      throw new Error("scenario-cli-multi-stream-stub-connector: PDPP_SCENARIO_STUB_BASE_URL is not set");
    }

    for (const stream of ["items", "extras"] as const) {
      if (!requested.has(stream)) {
        continue;
      }
      await emit({ type: "PROGRESS", stream, message: `collecting stub ${stream}` });
      const url = new URL(`/${stream}`, baseUrl);
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`scenario-cli-multi-stream-stub-connector: fetch failed with status ${String(res.status)}`);
      }
      const body = (await res.json()) as { items: StubItem[] };
      let lastId: string | undefined;
      for (const item of body.items) {
        await emitRecord(stream, { id: item.id, value: item.value });
        lastId = item.id;
      }
      if (lastId) {
        await emit({ type: "STATE", stream, cursor: { last_id: lastId } });
      }
    }
  },
});
