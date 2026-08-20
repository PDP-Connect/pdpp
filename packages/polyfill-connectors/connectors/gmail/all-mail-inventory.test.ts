// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Gmail receives an authoritative mailbox-wide message count on every run and
 * used to throw it away: the SELECT that opens All Mail returns IMAP `EXISTS`,
 * and the connector read `uidValidity`/`uidNext` off the same `MailboxObject`
 * while ignoring the count sitting next to them. The `labels` record body still
 * carries the fossil of that decision — `message_count: null`.
 *
 * These tests drive the real `runAllMailPasses` with a stubbed IMAP client and
 * assert on the emitted protocol, so they fail if the total stops being bound,
 * stops being validated, or stops being carried across runs.
 *
 * The contract deliberately does NOT make `EXISTS` the `messages`
 * DETAIL_COVERAGE denominator. That fact is per-page by design — the runtime
 * admits a bounded continuation only when a page reports
 * `considered === covered` on same-page facts — so substituting a 140k-message
 * mailbox total there would make every run read `partial` forever and break
 * continuation outright. A wrong denominator is worse than none. The mailbox
 * total is disclosed as its own fact instead, and the per-page denominator is
 * left alone; `messagesPageCoverageIsStillPerPage` below pins that boundary.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { FetchMessageObject, ImapFlow, ListResponse, MessageEnvelopeObject } from "imapflow";
import { runAllMailPasses } from "./index.ts";
import type { StreamRequest } from "./types.ts";

const FROZEN_NOW = "2026-04-21T00:00:00.000Z";

function makeAllMailMailbox(): ListResponse {
  return {
    delimiter: "/",
    flags: new Set(["\\All"]),
    listed: true,
    name: "All Mail",
    path: "[Gmail]/All Mail",
    pathAsListed: "[Gmail]/All Mail",
    parent: ["[Gmail]"],
    parentPath: "[Gmail]",
    specialUse: "\\All",
    subscribed: true,
  };
}

function makeRequested(streams: readonly string[]): Map<string, StreamRequest> {
  return new Map(streams.map((name) => [name, { name }]));
}

function makeMsg(uid: number): FetchMessageObject {
  const envelope: MessageEnvelopeObject = {
    date: new Date("2026-04-20T10:00:00.000Z"),
    subject: "Test subject",
    from: [{ name: "Alice", address: "alice@example.com" }],
    to: [{ name: "Bob", address: "bob@example.com" }],
    cc: [],
    bcc: [],
    messageId: `<msg-${uid}@example.com>`,
  };
  return {
    seq: uid,
    uid,
    emailId: `gmmsgid-${uid}`,
    threadId: "gmthrid-2222",
    flags: new Set<string>(["\\Seen"]),
    labels: new Set<string>(["\\Inbox"]),
    envelope,
    internalDate: new Date("2026-04-20T10:00:05.000Z"),
    size: 1024,
  } as FetchMessageObject;
}

interface RunOutcome {
  messages: Record<string, unknown>[];
  inventory: Record<string, unknown> | undefined;
  state: Record<string, unknown> | undefined;
}

/**
 * Run one All Mail pass against a stubbed mailbox and return the protocol it
 * emitted. `mailboxOverrides` is how each test injects the EXISTS value under
 * examination — including the malformed values a real server should never send
 * but which must fail closed rather than read as a complete mailbox.
 */
async function runPass(
  mailboxOverrides: Record<string, unknown>,
  state: Record<string, unknown> = {}
): Promise<RunOutcome> {
  const originalWrite = globalThis.process.stdout.write;
  const protocolMessages: Record<string, unknown>[] = [];
  globalThis.process.stdout.write = ((data: string): boolean => {
    if (typeof data === "string") {
      try {
        protocolMessages.push(JSON.parse(data) as Record<string, unknown>);
      } catch {
        // Ignore non-protocol output.
      }
    }
    return true;
  }) as typeof process.stdout.write;

  try {
    const client: Pick<ImapFlow, "close" | "download" | "fetch" | "fetchOne" | "mailbox" | "search"> = {
      close: mock.fn(),
      download: () => {
        throw new Error("download must not be called without attachments");
      },
      fetchOne: () => {
        throw new Error("fetchOne must not be called without bodies");
      },
      search: mock.fn(async () => []),
      mailbox: {
        delimiter: "/",
        exists: 1200,
        flags: new Set<string>(),
        path: "[Gmail]/All Mail",
        uidNext: 1201,
        uidValidity: 123n,
        ...mailboxOverrides,
      } as ImapFlow["mailbox"],
      // biome-ignore lint/suspicious/useAwait: async generator is required by the ImapFlow fetch shape.
      async *fetch() {
        for (const uid of [1, 2]) {
          yield makeMsg(uid);
        }
      },
    };

    await runAllMailPasses(client, makeAllMailMailbox(), state, {
      emitRecord: async () => true,
      emittedAt: FROZEN_NOW,
      requested: makeRequested(["messages"]),
    });
  } finally {
    globalThis.process.stdout.write = originalWrite;
  }

  return {
    messages: protocolMessages,
    inventory: protocolMessages.find((m) => m.type === "PROGRESS" && m.all_mail_inventory !== undefined),
    state: protocolMessages.find((m) => m.type === "STATE" && m.stream === "messages"),
  };
}

test("gmail all mail: the server-declared EXISTS is bound and disclosed, not discarded", async () => {
  const { inventory } = await runPass({ exists: 1200 });

  assert.ok(inventory, "a run must disclose the mailbox total the server handed it");
  assert.deepEqual(inventory.all_mail_inventory, {
    all_mail_exists: 1200,
    backfilled_through_uid: 0,
    forward_floor_uid: 1200,
    historical_backfill_complete: false,
    uidvalidity: 123,
  });
});

test("gmail all mail: EXISTS is measured at the provider boundary, not derived from what was emitted", async () => {
  // The pass emits exactly 2 message records but the mailbox holds 1200. If the
  // total were ever derived from the emitted/collected count instead of read off
  // the SELECT, this would report 2 and a 1198-message mailbox would read as
  // fully accounted for — the exact defect this contract exists to prevent.
  const { inventory } = await runPass({ exists: 1200 });
  const disclosed = inventory?.all_mail_inventory as { all_mail_exists: number };

  assert.equal(disclosed.all_mail_exists, 1200, "the total is the server's count, independent of the 2 emitted");
  assert.notEqual(disclosed.all_mail_exists, 2, "the total must never collapse to the emitted count");
});

test("gmail all mail: the EXISTS total is carried on STATE so the next run can compare it", async () => {
  const { state } = await runPass({ exists: 1200 });
  const allMail = (state?.cursor as Record<string, Record<string, unknown>> | undefined)?.all_mail;

  assert.ok(allMail, "the messages STATE carries an all_mail cursor");
  assert.equal(allMail.exists, 1200, "the cursor persists the epoch's inventory size");
  assert.equal(allMail.uidvalidity, 123, "the count is only meaningful alongside the epoch it was measured in");
});

test("gmail all mail: a missing EXISTS fails closed instead of reading as a complete mailbox", async () => {
  // A silently absent total that defaults to success reproduces the bug being
  // fixed, so absence must be louder than a wrong number, not quieter.
  await assert.rejects(
    () => runPass({ exists: undefined }),
    /gmail_all_mail_exists_missing/,
    "no EXISTS means no proof of inventory; the run must fail rather than assume"
  );
});

test("gmail all mail: a non-numeric EXISTS fails closed", async () => {
  await assert.rejects(() => runPass({ exists: "1200" }), /gmail_all_mail_exists_not_number/);
});

test("gmail all mail: a non-finite EXISTS fails closed", async () => {
  await assert.rejects(() => runPass({ exists: Number.POSITIVE_INFINITY }), /gmail_all_mail_exists_not_finite/);
});

test("gmail all mail: a fractional EXISTS fails closed", async () => {
  await assert.rejects(() => runPass({ exists: 12.5 }), /gmail_all_mail_exists_not_integer/);
});

test("gmail all mail: a negative EXISTS fails closed", async () => {
  await assert.rejects(() => runPass({ exists: -1 }), /gmail_all_mail_exists_negative/);
});

test("gmail all mail: a shrinking mailbox within one UID epoch throws", async () => {
  // Mirrors Jellyfin's decreasing-total guard. Inside a single UIDVALIDITY the
  // UID space is stable, so a smaller count is deletion or a server bug — either
  // way it is a fact about the data that must not pass silently.
  const priorState = {
    messages: { all_mail: { uidvalidity: 123, uidnext: 1201, forward_uidnext: 1201, exists: 1200 } },
  };

  await assert.rejects(
    () => runPass({ exists: 900 }, priorState),
    /gmail_all_mail_exists_decreased: 900 < 1200/,
    "a mailbox that lost 300 messages must be surfaced, not absorbed"
  );
});

test("gmail all mail: a growing mailbox within one UID epoch is normal and does not throw", async () => {
  const priorState = {
    messages: { all_mail: { uidvalidity: 123, uidnext: 1201, forward_uidnext: 1201, exists: 1000 } },
  };
  const { inventory } = await runPass({ exists: 1200 }, priorState);

  assert.equal(
    (inventory?.all_mail_inventory as { all_mail_exists: number }).all_mail_exists,
    1200,
    "new mail is the expected case and must not be mistaken for corruption"
  );
});

test("gmail all mail: a UIDVALIDITY re-key does not read a lower count as loss", async () => {
  // A UIDVALIDITY change means the server rebuilt the UID space. The old count
  // describes a different space, so comparing across the boundary would turn
  // every legitimate re-key into a spurious failure. The guard must scope its
  // comparison to one epoch — this is the case that distinguishes a real
  // decreasing-total check from a naive one.
  const priorState = {
    messages: { all_mail: { uidvalidity: 999, uidnext: 5000, forward_uidnext: 5000, exists: 4000 } },
  };
  const { inventory } = await runPass({ exists: 1200 }, priorState);

  assert.equal(
    (inventory?.all_mail_inventory as { all_mail_exists: number }).all_mail_exists,
    1200,
    "a re-key must read as a new epoch, never as a 2800-message loss"
  );
  assert.equal((inventory?.all_mail_inventory as { uidvalidity: number }).uidvalidity, 123);
});

test("gmail all mail: the messages page coverage denominator stays per-page", async () => {
  // Guards the boundary this design turns on. The runtime's bounded-continuation
  // check requires same-page `considered === covered`; if a future change routed
  // the mailbox-wide EXISTS into this fact, a 1200-message mailbox walked 2
  // messages at a time would report 2/1200, read `partial` on every run forever,
  // and lose the continuation proof. The mailbox total belongs beside this fact,
  // not inside it.
  const { messages } = await runPass({ exists: 1200 });
  const coverage = messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "messages");

  assert.ok(coverage, "the bounded page still proves its own coverage");
  assert.equal(coverage.considered, 2, "the page denominator is the page, not the mailbox");
  assert.equal(coverage.covered, 2);
  assert.notEqual(coverage.considered, 1200, "the mailbox total must not be substituted here");
});
