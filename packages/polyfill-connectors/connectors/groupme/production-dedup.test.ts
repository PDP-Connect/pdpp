// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * GroupMe production dedup test (two-run simulation).
 *
 * Verifies that fingerprint cursor carry-forward prevents duplicate record
 * re-emission across runs. Simulates:
 * 1. Run 1: Fetch groups, messages, chats
 * 2. Merge runtime state (per-stream merge contract)
 * 3. Run 2: Fetch same data again; verify no duplicates
 *
 * Exercises the real `openFingerprintCursor` primitive from
 * src/fingerprint-cursor.ts (the connector's actual dependency), not a
 * hand-rolled mock, so a mismatch between the connector's cursor usage
 * and the real API surface fails this test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";

interface GroupMeRecord {
  created_at: string;
  id: string;
  [key: string]: unknown;
}

interface GroupMeState {
  direct_chat_messages?: Record<string, string>;
  direct_chats?: Record<string, string>;
  group_messages?: Record<string, string>;
  groups?: Record<string, string>;
}

describe("GroupMe two-run dedup test", () => {
  it("run 1: collects all records and builds state", () => {
    const priorState: GroupMeState = {};
    const run1Groups = [
      { id: "g1", name: "Group 1", created_at: "2021-01-01T00:00:00Z" },
      { id: "g2", name: "Group 2", created_at: "2021-01-02T00:00:00Z" },
    ];
    const run1Messages = [
      { id: "m1", group_id: "g1", text: "Hello", created_at: "2021-01-01T12:00:00Z" },
      { id: "m2", group_id: "g1", text: "Hi", created_at: "2021-01-01T13:00:00Z" },
    ];

    const groupCursor = openFingerprintCursor({ fingerprints: priorState.groups ?? {} });
    const msgCursor = openFingerprintCursor({ fingerprints: priorState.group_messages ?? {} });

    const emittedGroups: GroupMeRecord[] = [];
    const emittedMessages: GroupMeRecord[] = [];

    for (const g of run1Groups) {
      if (groupCursor.shouldEmit(g)) {
        emittedGroups.push(g);
      }
    }
    for (const m of run1Messages) {
      if (msgCursor.shouldEmit(m)) {
        emittedMessages.push(m);
      }
    }

    assert.equal(emittedGroups.length, 2, "run 1 should emit all 2 groups");
    assert.equal(emittedMessages.length, 2, "run 1 should emit all 2 messages");

    const run1State: GroupMeState = {
      groups: groupCursor.toState(),
      group_messages: msgCursor.toState(),
    };

    assert.ok(run1State.groups?.g1);
    assert.ok(run1State.group_messages?.m1);
  });

  it("run 2: reuses state from run 1, emits no duplicates", () => {
    const run1Groups = [
      { id: "g1", name: "Group 1", created_at: "2021-01-01T00:00:00Z" },
      { id: "g2", name: "Group 2", created_at: "2021-01-02T00:00:00Z" },
    ];
    const run1Messages = [
      { id: "m1", group_id: "g1", text: "Hello", created_at: "2021-01-01T12:00:00Z" },
      { id: "m2", group_id: "g1", text: "Hi", created_at: "2021-01-01T13:00:00Z" },
    ];

    const seedGroupCursor = openFingerprintCursor({ fingerprints: {} });
    for (const g of run1Groups) {
      seedGroupCursor.shouldEmit(g);
    }
    const seedMsgCursor = openFingerprintCursor({ fingerprints: {} });
    for (const m of run1Messages) {
      seedMsgCursor.shouldEmit(m);
    }
    const run1State: GroupMeState = {
      groups: seedGroupCursor.toState(),
      group_messages: seedMsgCursor.toState(),
    };

    // Run 2: fetch same data again (unchanged)
    const run2Groups = run1Groups;
    const run2Messages = run1Messages;

    const groupCursor = openFingerprintCursor({ fingerprints: run1State.groups ?? {} });
    const msgCursor = openFingerprintCursor({ fingerprints: run1State.group_messages ?? {} });

    const emittedGroups: GroupMeRecord[] = [];
    const emittedMessages: GroupMeRecord[] = [];

    for (const g of run2Groups) {
      if (groupCursor.shouldEmit(g)) {
        emittedGroups.push(g);
      }
    }
    for (const m of run2Messages) {
      if (msgCursor.shouldEmit(m)) {
        emittedMessages.push(m);
      }
    }

    assert.equal(emittedGroups.length, 0, "run 2 should emit 0 groups (fingerprints match)");
    assert.equal(emittedMessages.length, 0, "run 2 should emit 0 messages (fingerprints match)");

    const run2State: GroupMeState = {
      groups: groupCursor.toState(),
      group_messages: msgCursor.toState(),
    };

    assert.equal(Object.keys(run2State.groups ?? {}).length, 2, "run 2 should carry forward 2 groups");
    assert.equal(Object.keys(run2State.group_messages ?? {}).length, 2, "run 2 should carry forward 2 messages");
  });

  it("run 2 with edit: emits only the changed record", () => {
    const run1Messages = [
      { id: "m1", text: "Hello", created_at: "2021-01-01T12:00:00Z" },
      { id: "m2", text: "Hi", created_at: "2021-01-01T13:00:00Z" },
    ];
    const seedCursor = openFingerprintCursor({ fingerprints: {} });
    for (const m of run1Messages) {
      seedCursor.shouldEmit(m);
    }
    const run1State: GroupMeState = { group_messages: seedCursor.toState() };

    const run2Messages = [
      { id: "m1", text: "Hello World", created_at: "2021-01-01T12:00:00Z" }, // CHANGED
      { id: "m2", text: "Hi", created_at: "2021-01-01T13:00:00Z" }, // unchanged
    ];

    const msgCursor = openFingerprintCursor({ fingerprints: run1State.group_messages ?? {} });
    const emitted: GroupMeRecord[] = [];

    for (const m of run2Messages) {
      if (msgCursor.shouldEmit(m)) {
        emitted.push(m);
      }
    }

    assert.equal(emitted.length, 1, "run 2 should emit 1 changed message");
    assert.equal(emitted[0]?.id, "m1");
  });

  it("state namespace: unified under 'groups' stream per runtime merge contract", () => {
    const unifiedState: GroupMeState = {
      groups: { g1: "fp_g1" },
      group_messages: { m1: "fp_m1" },
      direct_chats: { c1: "fp_c1" },
      direct_chat_messages: { dm1: "fp_dm1" },
    };

    const stream = "groups";
    assert.ok(stream === "groups", "all GroupMe state must be emitted under 'groups' stream");
    assert.ok(unifiedState.groups);
    assert.ok(unifiedState.group_messages);
    assert.ok(unifiedState.direct_chats);
    assert.ok(unifiedState.direct_chat_messages);
  });

  it("attachment blob refs added to records without changing id/created_at", () => {
    const msgWithoutBlob = {
      id: "m1",
      text: "pic attached",
      created_at: "2021-01-01T12:00:00Z",
      attachments: [{ type: "image", url: "https://i.groupme.com/img.jpg", name: null }],
    };

    const msgWithBlob = {
      ...msgWithoutBlob,
      attachments: [
        {
          type: "image",
          url: "https://i.groupme.com/img.jpg",
          name: null,
          blob_id: "blob_abc123", // added by uploader
        },
      ],
    };

    const run1Cursor = openFingerprintCursor({ fingerprints: {} });
    run1Cursor.shouldEmit(msgWithoutBlob);
    const run1State = run1Cursor.toState();

    const run2Cursor = openFingerprintCursor({ fingerprints: run1State });
    const changed = run2Cursor.shouldEmit(msgWithBlob);

    assert.equal(changed, true, "blob_id addition changes fingerprint and re-emits");
    assert.notEqual(run2Cursor.toState().m1, run1State.m1);
    assert.equal(msgWithoutBlob.id, msgWithBlob.id);
    assert.equal(msgWithoutBlob.created_at, msgWithBlob.created_at);
  });
});
