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
import { emitMessagesPass, partitionUnprovenChannels, unprovenChannelIds } from "./index.ts";
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

// ─── partitionUnprovenChannels: member scope, and ONLY member scope ──────
//
// `-member-only` filters on `is_member` and nothing else. slackdump v4.4.2,
// `internal/chunk/control/processors.go`:
//
//     if c.memberOnly && !structures.IsMember(&ch) { continue }
//
// and `internal/structures/conversation.go`:
//
//     if ChannelType(*ch) != CPublic || (ch.ID != "" && ch.ID[0] != 'C') {
//         return true
//     }
//     return ch.IsMember
//
// `is_archived` is never read — not there, not anywhere in slackdump. Slack's
// `conversations.list` includes archived channels by default and slackdump
// never sends `exclude_archived`. So an ARCHIVED channel is collected exactly
// like a live one, and an unwalked archived channel is a REAL gap.
//
// This was previously inverted: archived was treated as out of scope, which
// told this owner his 95 archived channels were absent by design. Live proof
// they are collectable: his Aug-17 archive holds 15 archived channels, all 15
// of which he is a member of, all 15 finalized, 16,173 messages collected —
// under `-member-only`.

/** Order-insensitive comparison with an explicit comparator (Biome-clean). */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => a.localeCompare(b));
}

test("partitionUnprovenChannels puts a non-member public channel out of scope", () => {
  const { inScope, outOfScope } = partitionUnprovenChannels(
    ["C016HTUEMHD"],
    new Map([["C016HTUEMHD", { isArchived: false, isMember: false }]]),
    true
  );
  assert.deepEqual(outOfScope, ["C016HTUEMHD"]);
  assert.deepEqual(inScope, []);
});

test("partitionUnprovenChannels keeps an ARCHIVED joined channel IN scope", () => {
  // The D8 regression guard. `-member-only` does not filter on is_archived,
  // so an archived channel the account belongs to was requestable and its
  // absence is an unexplained gap, not a configuration choice.
  const { inScope, outOfScope } = partitionUnprovenChannels(
    ["C016S03HPHU"],
    new Map([["C016S03HPHU", { isArchived: true, isMember: true }]]),
    true
  );
  assert.deepEqual(inScope, ["C016S03HPHU"]);
  assert.deepEqual(outOfScope, []);
});

test("partitionUnprovenChannels puts an archived NON-member public channel out of scope under member-only", () => {
  // 91 of this owner's 94 archived channels are public and not joined: they
  // are out of scope because of membership, never because of archiving.
  const { inScope, outOfScope } = partitionUnprovenChannels(
    ["C0ARCHNOMEM"],
    new Map([["C0ARCHNOMEM", { isArchived: true, isMember: false }]]),
    true
  );
  assert.deepEqual(outOfScope, ["C0ARCHNOMEM"]);
  assert.deepEqual(inScope, []);
});

test("partitionUnprovenChannels puts NOTHING out of scope when member-only is off", () => {
  // With MEMBER_ONLY=false slackdump requests every enumerated channel, so
  // there is no configuration excuse left for any unwalked channel.
  const { inScope, outOfScope } = partitionUnprovenChannels(
    ["C0ARCHNOMEM", "C016HTUEMHD"],
    new Map([
      ["C0ARCHNOMEM", { isArchived: true, isMember: false }],
      ["C016HTUEMHD", { isArchived: false, isMember: false }],
    ]),
    false
  );
  assert.deepEqual(outOfScope, []);
  assert.deepEqual(sorted(inScope), sorted(["C016HTUEMHD", "C0ARCHNOMEM"]));
});

test("partitionUnprovenChannels keeps a non-member DM/MPIM/private channel in scope", () => {
  // slackdump's IsMember returns true for every non-`C` id regardless of the
  // is_member flag, so member-only never explains a missing DM.
  const { inScope, outOfScope } = partitionUnprovenChannels(
    ["D01DIRECT01", "G01PRIVATE1"],
    new Map([
      ["D01DIRECT01", { isArchived: false, isMember: false }],
      ["G01PRIVATE1", { isArchived: true, isMember: false }],
    ]),
    true
  );
  assert.deepEqual(sorted(inScope), sorted(["D01DIRECT01", "G01PRIVATE1"]));
  assert.deepEqual(outOfScope, []);
});

test("partitionUnprovenChannels keeps a joined, unarchived channel in scope", () => {
  // The genuinely unexplained bucket — a channel member-only archiving DID
  // request and slackdump still did not finish.
  const { inScope, outOfScope } = partitionUnprovenChannels(
    ["C021ZPKLP7G"],
    new Map([["C021ZPKLP7G", { isArchived: false, isMember: true }]]),
    true
  );
  assert.deepEqual(inScope, ["C021ZPKLP7G"]);
  assert.deepEqual(outOfScope, []);
});

test("partitionUnprovenChannels treats a channel with NO reachability evidence as in scope", () => {
  // Absent evidence must never downgrade a gap into "explained" — the same
  // rule the finalized-set read follows when CHUNK is missing.
  const { inScope, outOfScope } = partitionUnprovenChannels(["C0UNKNOWN01"], new Map(), true);
  assert.deepEqual(inScope, ["C0UNKNOWN01"]);
  assert.deepEqual(outOfScope, []);
});

test("partitionUnprovenChannels accounts for every unproven channel exactly once", () => {
  const unproven = ["C0AAA", "C0BBB", "C0CCC", "C0DDD"];
  const { inScope, outOfScope } = partitionUnprovenChannels(
    unproven,
    new Map([
      ["C0AAA", { isArchived: false, isMember: false }],
      ["C0BBB", { isArchived: true, isMember: true }],
      ["C0CCC", { isArchived: false, isMember: true }],
    ]),
    true
  );
  assert.equal(inScope.length + outOfScope.length, unproven.length);
  assert.deepEqual([...inScope, ...outOfScope].sort(), [...unproven].sort());
});
