// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture that emits ONE Collection Profile INTERACTION
 * mid-run (an `otp`-kind prompt, modeled on `bin/manual-action-stub-
 * connector.ts`'s role as a protocol-path test scaffold and on the
 * `otp`/`manual_action` shapes proven in `src/connector-runtime.test.ts`),
 * then emits a record whose `data.otp_value` field is exactly the value the
 * INTERACTION_RESPONSE carried.
 *
 * This makes a wrong or missing answer OBSERVABLE in the run's output: a
 * different `--answer` value produces a different `otp_value` in the
 * emitted record, so a scenario replay that answers with the wrong value (or
 * skips answering) changes the record's content hash and fails verification
 * — proving the interaction-answering path is actually load-bearing, not
 * just plumbing that gets exercised without affecting anything.
 *
 * Used by:
 *   - bin/connector-dev.test.ts (goals a, b: --answer completes the run;
 *     no answer + no TTY fails loudly naming the prompt)
 *   - bin/scenario-cli.test.ts (goals c-f: record captures the pair into
 *     user_interactions; verify replays scripted; tampering/removing the
 *     recorded response makes verify FAIL)
 *
 * NOT registered in src/orchestrator.ts — fixture-only, never a production
 * connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string" && typeof data.otp_value === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "otp_value", message: "expected string otp_value" }] };
};

runConnector({
  name: "connector-dev-interaction-fixture",
  validateRecord,
  async collect({ emit, emitRecord, sendInteraction }) {
    await emit({ type: "PROGRESS", stream: "items", message: "collecting synthetic items" });
    await emitRecord("items", { id: "item-before-prompt", otp_value: "(none)" });

    const response = await sendInteraction({
      kind: "otp",
      message: "Enter the verification code shown on your device.",
      timeout_seconds: 60,
    });

    if (response.status !== "success") {
      throw new Error(`interaction was not answered successfully: status=${response.status}`);
    }
    const otpValue = response.value ?? response.data?.code ?? "(missing)";

    await emitRecord("items", { id: "item-after-prompt", otp_value: otpValue });
    await emit({ type: "STATE", stream: "items", cursor: { last_id: "item-after-prompt" } });
  },
});
