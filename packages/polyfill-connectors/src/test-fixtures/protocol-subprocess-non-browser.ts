// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string" && data.ok === true) {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "ok", message: "expected ok=true" }] };
};

runConnector({
  name: "protocol-subprocess-non-browser",
  validateRecord,
  async collect({ emit, emitRecord }) {
    await emit({ type: "PROGRESS", stream: "items", message: "collecting synthetic items" });
    await emitRecord("items", { id: "item-1", ok: true });
    await emitRecord("items", { id: "item-bad", ok: false });
    await emit({ type: "STATE", stream: "items", cursor: { last_id: "item-1" } });
  },
});
