// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture that emits ONE Collection Profile INTERACTION
 * mid-run with `kind: "credentials"` — the counterpart to
 * `connector-dev-interaction-fixture.ts`'s `kind: "otp"` fixture, used to
 * prove the repair wave's FIX C: a credentials-kind prompt/response pair
 * must NEVER be persisted with a real value in a recorded scenario, and
 * `scenario-verify` must refuse outright to replay a redacted entry rather
 * than silently answering with nothing.
 *
 * Unlike the OTP fixture, this fixture does NOT bake the interaction
 * response into an emitted record's content — it just needs `status:
 * "success"` back to proceed, so recording succeeds normally (proving FIX C
 * redacts a response scenario-record otherwise had no trouble capturing).
 *
 * Used by bin/scenario-cli.test.ts (FIX C: record redacts; verify refuses to
 * replay a redacted entry). NOT registered in src/orchestrator.ts —
 * fixture-only, never a production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "connector-dev-credentials-fixture",
  validateRecord,
  async collect({ emit, emitRecord, sendInteraction }) {
    await emit({ type: "PROGRESS", stream: "items", message: "collecting synthetic items" });

    const response = await sendInteraction({
      kind: "credentials",
      message: "Enter your username and password.",
      timeout_seconds: 60,
    });

    if (response.status !== "success") {
      throw new Error(`interaction was not answered successfully: status=${response.status}`);
    }

    await emitRecord("items", { id: "item-after-credentials-prompt" });
    await emit({ type: "STATE", stream: "items", cursor: { done: true } });
  },
});
