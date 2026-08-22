// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-fidelity.test.ts`'s
 * plain-text body integrity proof (FIX 2(a)): fetches a `text/plain`
 * response ("hello", no JSON structure at all) and emits it as a record,
 * proving the recorder stores it as raw text and the replay bridge serves
 * it back byte-identical — never `JSON.stringify`-corrupted into `"hello"`
 * (with literal quote characters) or parsed-as-JSON-and-failed.
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "scenario-fidelity-text-body-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const baseUrl = process.env.PDPP_SCENARIO_FIDELITY_BASE_URL;
    if (!baseUrl) {
      throw new Error("scenario-fidelity-text-body-connector: PDPP_SCENARIO_FIDELITY_BASE_URL is not set");
    }

    await emit({ type: "PROGRESS", stream: "items", message: "fetching plain-text body" });
    const res = await fetch(new URL("/greeting", baseUrl));
    const text = await res.text();
    await emitRecord("items", { id: "greeting", text });

    await emit({ type: "STATE", stream: "items", cursor: { done: true } });
  },
});
