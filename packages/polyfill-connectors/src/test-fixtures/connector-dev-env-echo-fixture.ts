// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/connector-dev.test.ts`'s FIX 1
 * coverage (default-on failure-evidence retention). Writes the literal
 * value this subprocess observed for `process.env.PDPP_CAPTURE_ON_FAILURE`
 * to stderr as `PDPP_CAPTURE_ON_FAILURE_ECHO=<value>` (or `__unset__` when
 * the key is absent entirely) — the same distinction
 * `resolveCaptureOnFailureEnv`/`runAndStream`'s conditional spread makes
 * between "set to a value" and "not set at all". `runAndStream` pipes the
 * child's stderr straight through to this CLI's own stderr unmodified
 * (`child.stderr?.on("data", ...)`), so this is a real stub-that-echoes-it,
 * not a parallel assertion mechanism the code under test doesn't actually
 * exercise. NOT registered in `src/orchestrator.ts` — fixture-only.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected a string id" }] };
};

runConnector({
  name: "connector-dev-env-echo-fixture",
  validateRecord,
  async collect({ emitRecord }) {
    const value = process.env.PDPP_CAPTURE_ON_FAILURE ?? "__unset__";
    process.stderr.write(`PDPP_CAPTURE_ON_FAILURE_ECHO=${value}\n`);
    await emitRecord("items", { id: "env-echo-1" });
  },
});
