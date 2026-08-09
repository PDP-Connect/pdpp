// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage, RecordData } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";
import { buildVCard, startFakeCardDavServer } from "./test-carddav-server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CWD = join(__dirname, "..", "..");
const ENTRYPOINT = join(__dirname, "index.ts");
const USERNAME = "owner@example.com";
const PASSWORD = "app-specific-pw";

function startMessage(state: Record<string, unknown> = {}): {
  scope: { streams: Array<{ name: string }> };
  state: Record<string, unknown>;
  type: "START";
} {
  return {
    type: "START",
    scope: {
      streams: [{ name: "address_books" }, { name: "contacts" }, { name: "contact_groups" }],
    },
    state,
  };
}

function recordsOf(messages: EmittedMessage[], stream: string): RecordData[] {
  return messages
    .filter((m): m is Extract<EmittedMessage, { type: "RECORD" }> => m.type === "RECORD" && m.stream === stream)
    .map((m) => m.data);
}

test("apple_contacts integration: discovers, syncs via sync-collection, and emits typed contacts + groups", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    server.contacts.set("alice", {
      uid: "alice",
      href: "/addressbooks/owner/card/alice.vcf",
      vcard: buildVCard({ uid: "alice", fn: "Alice Example", email: "alice@example.com", categories: ["Friends"] }),
    });
    server.contacts.set("bob", {
      uid: "bob",
      href: "/addressbooks/owner/card/bob.vcf",
      vcard: buildVCard({ uid: "bob", fn: "Bob Example", categories: ["Friends", "Work"] }),
    });

    const result = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage(),
      env: {
        APPLE_ID: USERNAME,
        APPLE_APP_SPECIFIC_PASSWORD: PASSWORD,
        APPLE_CARDDAV_ORIGIN: server.origin,
      },
    });

    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE");
    assert.equal(done.status, "succeeded");

    const addressBooks = recordsOf(result.messages, "address_books");
    assert.equal(addressBooks.length, 1);
    assert.equal(addressBooks[0]?.supports_sync_collection, true);

    const contacts = recordsOf(result.messages, "contacts");
    assert.equal(contacts.length, 2);
    const alice = contacts.find((c) => c.display_name === "Alice Example");
    assert.ok(alice);
    assert.deepEqual(alice?.emails, [{ types: ["HOME"], value: "alice@example.com" }]);

    const groups = recordsOf(result.messages, "contact_groups");
    const groupNames = groups.map((g) => g.name).sort((a, b) => String(a).localeCompare(String(b)));
    assert.deepEqual(groupNames, ["Friends", "Work"]);
    const friends = groups.find((g) => g.name === "Friends");
    assert.ok(friends);
    assert.equal((friends.member_uids as string[]).length, 2);

    // contact_groups is a required, full_inventory stream — it must prove
    // its own coverage (not just emit records), otherwise it can never reach
    // `complete` regardless of how much real data it collected.
    const groupsCoverage = result.messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "contact_groups");
    assert.ok(groupsCoverage && groupsCoverage.type === "DETAIL_COVERAGE", "contact_groups must emit DETAIL_COVERAGE");
    assert.equal(groupsCoverage.considered, 2);
    assert.equal(groupsCoverage.covered, 2);

    // contacts must prove its own coverage the same way — otherwise a real
    // two-contact run and a run that silently enumerated nothing both read
    // as `unknown` coverage, indistinguishable from each other.
    const contactsCoverage = result.messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "contacts");
    assert.ok(contactsCoverage && contactsCoverage.type === "DETAIL_COVERAGE", "contacts must emit DETAIL_COVERAGE");
    assert.equal(contactsCoverage.considered, 2);
    assert.equal(contactsCoverage.covered, 2);
  } finally {
    await server.close();
  }
});

test("apple_contacts integration: a genuinely empty address book completes with proven-empty contacts coverage", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    // No contacts registered on the fake server at all — the address book
    // exists and enumerates cleanly, it is just genuinely empty.
    const result = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage(),
      env: {
        APPLE_ID: USERNAME,
        APPLE_APP_SPECIFIC_PASSWORD: PASSWORD,
        APPLE_CARDDAV_ORIGIN: server.origin,
      },
    });

    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE");
    assert.equal(done.status, "succeeded", "a zero-contact account is a successful run, not a failure");

    const contacts = recordsOf(result.messages, "contacts");
    assert.equal(contacts.length, 0);

    // The zero must be PROVEN (considered === covered === 0), not merely
    // absent — an empty stream with no DETAIL_COVERAGE reads as `unknown`
    // coverage downstream, indistinguishable from "never actually asked the
    // server." considered === covered === 0 is the only way a genuinely
    // empty address book can report `complete` rather than `partial`.
    const contactsCoverage = result.messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "contacts");
    assert.ok(contactsCoverage && contactsCoverage.type === "DETAIL_COVERAGE", "contacts must emit DETAIL_COVERAGE");
    assert.equal(contactsCoverage.considered, 0);
    assert.equal(contactsCoverage.covered, 0);

    // contact_groups derives entirely from contacts' CATEGORIES field, so a
    // zero-contact address book is also a zero-group address book — still
    // proven-empty, not merely absent.
    const groupsCoverage = result.messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "contact_groups");
    assert.ok(groupsCoverage && groupsCoverage.type === "DETAIL_COVERAGE", "contact_groups must emit DETAIL_COVERAGE");
    assert.equal(groupsCoverage.considered, 0);
    assert.equal(groupsCoverage.covered, 0);

    const addressBooksCoverage = result.messages.find(
      (m) => m.type === "DETAIL_COVERAGE" && m.stream === "address_books"
    );
    assert.ok(addressBooksCoverage && addressBooksCoverage.type === "DETAIL_COVERAGE");
    assert.equal(addressBooksCoverage.considered, 1, "the address book itself was discovered and enumerated");
    assert.equal(addressBooksCoverage.covered, 1);
  } finally {
    await server.close();
  }
});

test("apple_contacts integration: falls back to bounded full snapshot when sync-collection is unsupported", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD, disableSyncCollection: true });
  try {
    server.contacts.set("carol", {
      uid: "carol",
      href: "/addressbooks/owner/card/carol.vcf",
      vcard: buildVCard({ uid: "carol", fn: "Carol Example" }),
    });

    const result = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage(),
      env: {
        APPLE_ID: USERNAME,
        APPLE_APP_SPECIFIC_PASSWORD: PASSWORD,
        APPLE_CARDDAV_ORIGIN: server.origin,
      },
    });

    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE");
    assert.equal(done.status, "succeeded");

    const addressBooks = recordsOf(result.messages, "address_books");
    assert.equal(addressBooks[0]?.supports_sync_collection, false);

    const contacts = recordsOf(result.messages, "contacts");
    assert.equal(contacts.length, 1);
    assert.equal(contacts[0]?.display_name, "Carol Example");
  } finally {
    await server.close();
  }
});

test("apple_contacts integration: a second run emits a tombstone for a server-side deletion (sync-collection path)", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    server.contacts.set("dave", {
      uid: "dave",
      href: "/addressbooks/owner/card/dave.vcf",
      vcard: buildVCard({ uid: "dave", fn: "Dave Example" }),
    });

    const first = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage(),
      env: { APPLE_ID: USERNAME, APPLE_APP_SPECIFIC_PASSWORD: PASSWORD, APPLE_CARDDAV_ORIGIN: server.origin },
    });
    const firstState = first.messages.findLast(
      (m): m is Extract<EmittedMessage, { type: "STATE" }> => m.type === "STATE" && m.stream === "contacts"
    );
    assert.ok(firstState);

    server.contacts.delete("dave");
    server.deletedHrefs.add("/addressbooks/owner/card/dave.vcf");
    server.markChanged();

    const second = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage({ contacts: (firstState as Extract<EmittedMessage, { type: "STATE" }>).cursor }),
      env: { APPLE_ID: USERNAME, APPLE_APP_SPECIFIC_PASSWORD: PASSWORD, APPLE_CARDDAV_ORIGIN: server.origin },
    });

    const tombstone = second.messages.find(
      (m): m is Extract<EmittedMessage, { type: "RECORD" }> =>
        m.type === "RECORD" && m.stream === "contacts" && m.op === "delete"
    );
    assert.ok(tombstone, "expected a delete-op RECORD for the removed contact");
  } finally {
    await server.close();
  }
});

test("apple_contacts integration: fails cleanly on rejected credentials", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    const result = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage(),
      env: { APPLE_ID: USERNAME, APPLE_APP_SPECIFIC_PASSWORD: "wrong-password", APPLE_CARDDAV_ORIGIN: server.origin },
      allowFailedDone: true,
    });
    const done = result.messages.findLast((m) => m.type === "DONE");
    assert.ok(done && done.type === "DONE");
    assert.equal(done.status, "failed");
    // The stable machine code rides error.code (the typed, non-redacted
    // channel); error.message is human-readable free-form text that still
    // goes through the same redaction as any other connector diagnostic.
    assert.equal(done.error?.code, "auth_failed");
    assert.equal(done.error?.message, "Apple ID or app-specific password was rejected");
    // No vCard or credential content leaked into the terminal error/progress trace.
    const serialized = JSON.stringify(result.messages);
    assert.equal(serialized.includes("wrong-password"), false);
    assert.equal(serialized.includes(PASSWORD), false);
  } finally {
    await server.close();
  }
});

test("apple_contacts integration: never logs credentials or vCard field values in PROGRESS messages", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    server.contacts.set("erin", {
      uid: "erin",
      href: "/addressbooks/owner/card/erin.vcf",
      vcard: buildVCard({ uid: "erin", fn: "Erin Secretname", email: "erin-secret@example.com" }),
    });
    const result = await runConnectorProtocolSubprocess({
      cwd: CWD,
      entrypoint: ENTRYPOINT,
      start: startMessage(),
      env: { APPLE_ID: USERNAME, APPLE_APP_SPECIFIC_PASSWORD: PASSWORD, APPLE_CARDDAV_ORIGIN: server.origin },
    });
    const progressMessages = result.messages.filter((m) => m.type === "PROGRESS");
    const serialized = JSON.stringify(progressMessages);
    assert.equal(serialized.includes(PASSWORD), false);
    assert.equal(serialized.includes("Erin Secretname"), false);
    assert.equal(serialized.includes("erin-secret@example.com"), false);
  } finally {
    await server.close();
  }
});
