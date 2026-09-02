// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/connector-dev.test.ts`.
 *
 * Exercises the same Collection Profile protocol surface as
 * `src/test-fixtures/protocol-subprocess-non-browser.ts` (PROGRESS, RECORD,
 * SKIP_RESULT, STATE, DONE) but is driven through `bin/connector-dev.ts`'s
 * `--entrypoint` override instead of `runConnectorProtocolSubprocess`
 * directly, proving the CLI's live-streaming + run-summary path end-to-end
 * without any live credentials. NOT registered in `src/orchestrator.ts` —
 * this is fixture-only, never a production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string" && data.ok === true) {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "ok", message: "expected ok=true" }] };
};

runConnector({
  name: "connector-dev-cli-fixture",
  validateRecord,
  async collect({ emit, emitRecord }) {
    await emit({ type: "PROGRESS", stream: "items", message: "collecting synthetic items" });
    await emitRecord("items", { id: "item-1", ok: true });
    await emitRecord("items", { id: "item-2", ok: true });
    await emitRecord("items", { id: "item-3", ok: true });
    await emitRecord("items", { id: "item-bad", ok: false });
    await emit({ type: "STATE", stream: "items", cursor: { last_id: "item-3" } });
  },
});
