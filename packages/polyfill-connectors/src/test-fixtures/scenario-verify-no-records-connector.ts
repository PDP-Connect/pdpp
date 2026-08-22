// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-verify-strict.test.ts`'s
 * FIX 4 (coverage exactness) negative test: makes exactly one `fetch` call
 * and emits ZERO records. A scenario driving this fixture proves the run
 * happened (a real interaction occurred) but proves nothing was actually
 * collected — `full_refresh` must not be claimed for a run with zero
 * expected/emitted records. Never registered in src/orchestrator.ts.
 */

import { runConnector } from "../connector-runtime.ts";

runConnector({
  name: "scenario-verify-no-records-connector",
  validateRecord: () => ({ ok: false, issues: [{ path: "$", message: "this fixture never emits a record" }] }),
  async collect({ emit }) {
    const res = await fetch("https://toy.example/widgets");
    await res.text();
    await emit({ type: "PROGRESS", stream: "widgets", message: "collected nothing, on purpose" });
  },
});
