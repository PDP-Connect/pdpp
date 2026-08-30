// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-verify-strict.test.ts`'s
 * FIX 4 (coverage exactness) tests. Makes exactly one `fetch` call (so a
 * scenario recording it has a real `interactions` entry to replay) and
 * emits one hardcoded record built from that response, plus a STATE
 * message — the shape FIX 4's `fullRefreshProven` needs to prove a real
 * from-scratch (`start.state === null`) collection: >=1 interaction AND
 * >=1 expected record. Never registered in src/orchestrator.ts.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "widgets" && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected id" }] };
};

runConnector({
  name: "scenario-verify-hardcoded-record-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const res = await fetch("https://toy.example/widgets");
    const body = (await res.json()) as { id: string; name: string };
    await emitRecord("widgets", { id: body.id, name: body.name });
    await emit({ type: "STATE", stream: "widgets", cursor: { last_id: body.id } });
  },
});
