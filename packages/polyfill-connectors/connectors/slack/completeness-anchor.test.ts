// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Completeness-anchor tests for the Slack connector.
 *
 * Two independent concerns:
 *
 *  1. `unprovenChannelIds` — the set difference between the archive's own
 *     CHANNEL inventory and the channels slackdump proved it finished
 *     walking (`CHUNK.FINAL = 1` on the MESSAGES chunk type). This is the
 *     only per-channel completeness fact slackdump exposes; there is no
 *     per-channel message count and no `has_more` flag in its schema.
 *
 *     Deliberately a SET comparison. A count cannot distinguish missing
 *     from surplus from duplicated, and — because PDPP retains records the
 *     source later deletes — a channel we hold history for that Slack no
 *     longer lists must never read as loss.
 *
 *  2. `emitMessagesPass`'s `covered` — previously the message family
 *     declared `covered: considered` unconditionally, so the coverage
 *     number could not fail. It is now counted per-row from the parse
 *     outcome: a row whose Slack `ts` will not parse gets a fabricated
 *     `sent_at` and must NOT raise the numerator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordData } from "../../src/connector-runtime.ts";
import { emitMessagesPass, unprovenChannelIds } from "./index.ts";
import type { MessageRow } from "./types.ts";

// ─── unprovenChannelIds: the set difference ──────────────────────────────

test("unprovenChannelIds reports inventoried channels with no finalized walk", () => {
  const inventory = new Set(["C1", "C2", "C3", "C4"]);
  const finalized = new Set(["C1", "C3"]);
  assert.deepEqual(unprovenChannelIds(inventory, finalized), ["C2", "C4"]);
});

test("unprovenChannelIds reports nothing when every inventoried channel finalized", () => {
  const inventory = new Set(["C1", "C2"]);
  assert.deepEqual(unprovenChannelIds(inventory, new Set(["C1", "C2"])), []);
});

test("unprovenChannelIds reports the whole inventory when nothing finalized", () => {
  const inventory = new Set(["C1", "C2", "C3"]);
  assert.deepEqual(unprovenChannelIds(inventory, new Set()), ["C1", "C2", "C3"]);
});

test("unprovenChannelIds ignores a finalized channel absent from the inventory (preservation, not loss)", () => {
  // A channel we archived that Slack no longer lists. PDPP keeps what the
  // source deletes, so this must produce NO finding — the comparison is
  // one-directional by construction.
  const inventory = new Set(["C1"]);
  const finalized = new Set(["C1", "C_DELETED_UPSTREAM"]);
  assert.deepEqual(unprovenChannelIds(inventory, finalized), []);
});

test("unprovenChannelIds returns a stable sorted order", () => {
  const inventory = new Set(["C9", "C2", "C5"]);
  assert.deepEqual(unprovenChannelIds(inventory, new Set()), ["C2", "C5", "C9"]);
});

test("unprovenChannelIds on an empty inventory reports nothing", () => {
  assert.deepEqual(unprovenChannelIds(new Set(), new Set(["C1"])), []);
});

// ─── emitMessagesPass: covered is counted, not aliased ───────────────────

function messageRow(channelId: string, ts: string): MessageRow {
  return {
    CHANNEL_ID: channelId,
    DATA: JSON.stringify({ text: "hi", user: "U1" }),
    IS_PARENT: 0,
    NUM_FILES: 0,
    THREAD_TS: null,
    TS: ts,
    TXT: "hi",
  };
}

function passDeps(): { deps: Parameters<typeof emitMessagesPass>[0]; emitted: RecordData[] } {
  const emitted: RecordData[] = [];
  return {
    emitted,
    deps: {
      emitRecord: (_stream: string, data: RecordData) => {
        emitted.push(data);
        return Promise.resolve();
      },
      emittedAt: "2026-08-20T00:00:00.000Z",
      progress: () => Promise.resolve(),
      requested: new Map([["messages", { name: "messages" }]]),
    } as Parameters<typeof emitMessagesPass>[0],
  };
}

test("emitMessagesPass counts every parseable row as covered", async () => {
  const { deps } = passDeps();
  const rows = [messageRow("C1", "1700000000.000100"), messageRow("C1", "1700000001.000200")];
  const result = await emitMessagesPass(deps, rows, null);
  assert.equal(result.considered, 2);
  assert.equal(result.covered, 2);
});

test("emitMessagesPass does NOT count an unparseable-ts row as covered", async () => {
  // The row is still emitted (its body is real) but its sent_at is
  // fabricated from the run clock, so it is not objectively accounted for.
  const { deps } = passDeps();
  const rows = [messageRow("C1", "1700000000.000100"), messageRow("C1", "not-a-timestamp")];
  const result = await emitMessagesPass(deps, rows, null);
  assert.equal(result.considered, 2, "both rows were weighed");
  assert.equal(result.covered, 1, "only the parseable row is covered");
  assert.ok(result.covered < result.considered, "a shortfall must read partial, not complete");
});

test("emitMessagesPass does not count a zero ts as covered (Slack's unset, not 1970)", async () => {
  const { deps } = passDeps();
  const result = await emitMessagesPass(deps, [messageRow("C1", "0")], null);
  assert.equal(result.considered, 1);
  assert.equal(result.covered, 0);
});

test("emitMessagesPass reports covered === considered only when every row parsed", async () => {
  const { deps } = passDeps();
  const rows = ["1700000000.000100", "1700000001.000200", "1700000002.000300"].map((ts) => messageRow("C1", ts));
  const result = await emitMessagesPass(deps, rows, null);
  assert.equal(result.covered, result.considered);
  assert.equal(result.covered, 3);
});

test("emitMessagesPass on an empty row set proves an empty boundary", async () => {
  const { deps } = passDeps();
  const result = await emitMessagesPass(deps, [], null);
  assert.equal(result.considered, 0);
  assert.equal(result.covered, 0);
});

test("emitMessagesPass still emits the record for an unparseable-ts row", async () => {
  const { deps, emitted } = passDeps();
  await emitMessagesPass(deps, [messageRow("C1", "garbage")], null);
  assert.equal(emitted.length, 1, "the row is preserved even though it is not covered");
});
