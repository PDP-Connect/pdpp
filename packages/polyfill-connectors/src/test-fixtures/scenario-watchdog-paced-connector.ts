// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-cli.test.ts`'s inactivity
 * watchdog coverage (FIX 1, `bin/scenario-record.ts`/`bin/scenario-verify.ts`).
 *
 * Emits `PDPP_WATCHDOG_TEST_RECORD_COUNT` (default 3) records on a single
 * `items` stream, sleeping `PDPP_WATCHDOG_TEST_SLEEP_MS` (default 1000)
 * between each — this proves a PACED connector (one that keeps emitting
 * PROGRESS/RECORD lines between requests, exactly like ynab's audited
 * pacing) never trips a watchdog window comfortably larger than the sleep
 * gap, even though the connector's TOTAL run time may exceed that window.
 *
 * When `PDPP_WATCHDOG_TEST_HANG_AFTER` is set (to a 0-based record index),
 * this connector emits records up to and including that index, then hangs
 * forever (an unresolved `await new Promise(() => {})`, never emitting
 * another line) — proving the watchdog DOES fire on a genuine hang, killing
 * the subprocess rather than waiting out a real would-be-infinite stall.
 *
 * No network calls — pure timers, so this fixture works for both the
 * scenario-record (`--entrypoint`) and scenario-verify (replay) paths
 * without a synthetic HTTP provider.
 *
 * NOT registered in src/orchestrator.ts — fixture-only, never a production
 * connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected a string id" }] };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

runConnector({
  name: "scenario-watchdog-paced-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const recordCount = Number(process.env.PDPP_WATCHDOG_TEST_RECORD_COUNT ?? "3");
    const sleepMs = Number(process.env.PDPP_WATCHDOG_TEST_SLEEP_MS ?? "1000");
    const hangAfterRaw = process.env.PDPP_WATCHDOG_TEST_HANG_AFTER;
    const hangAfter = hangAfterRaw === undefined ? undefined : Number(hangAfterRaw);

    await emit({ type: "PROGRESS", stream: "items", message: "collecting paced items" });

    for (let i = 0; i < recordCount; i += 1) {
      await sleep(sleepMs);
      await emitRecord("items", { id: `item-${String(i)}` });
      if (hangAfter !== undefined && i === hangAfter) {
        // Genuine hang: never resolves, never emits another line. Proves
        // the watchdog is the only thing that can end this run.
        await new Promise<void>(() => {
          // Intentionally never resolves.
        });
      }
    }

    await emit({ type: "STATE", stream: "items", cursor: { last_index: recordCount - 1 } });
  },
});
