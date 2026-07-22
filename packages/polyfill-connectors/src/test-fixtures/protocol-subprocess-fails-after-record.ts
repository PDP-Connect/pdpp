// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected id" }] };
};

runConnector({
  name: "protocol-subprocess-fails-after-record",
  validateRecord,
  retryablePattern: /retry budget exhausted/iu,
  async collect({ emitRecord }) {
    await emitRecord("items", { id: "item-before-failure" });
    throw new Error("retry budget exhausted on synthetic upstream");
  },
});
