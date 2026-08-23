// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { RecordData } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import type { DiscoveryFetch, DiscoveryFetchResponse } from "./discovery.ts";
import { collectAddressBook } from "./index.ts";

const BOOK_URL = "https://contacts.example/addressbooks/owner/card/";
const BOOK_KEY = "https://contacts.example/addressbooks/owner/card";
const CONTACTS = [
  { href: "/addressbooks/owner/card/alice.vcf", uid: "alice", name: "Alice Example" },
  { href: "/addressbooks/owner/card/bob.vcf", uid: "bob", name: "Bob Example" },
  { href: "/addressbooks/owner/card/carol.vcf", uid: "carol", name: "Carol Example" },
];

function response(text: string): DiscoveryFetchResponse {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    headers: { get: () => null },
    status: 207,
  };
}

function memberResponse(contact: (typeof CONTACTS)[number]): string {
  return `<D:response><D:href>${contact.href}</D:href><D:propstat><D:prop><D:getetag>${contact.uid}</D:getetag></D:prop></D:propstat></D:response>`;
}

function vcardResponse(contact: (typeof CONTACTS)[number]): string {
  return `<D:response><D:href>${contact.href}</D:href><D:propstat><D:prop><D:getetag>${contact.uid}</D:getetag><C:address-data>BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${contact.uid}\r\nFN:${contact.name}\r\nEND:VCARD\r\n</C:address-data></D:prop></D:propstat></D:response>`;
}

const quietSyncResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:sync-token>next-token</D:sync-token></D:multistatus>`;
const initialSyncResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${CONTACTS.map(memberResponse).join("")}<D:sync-token>next-token</D:sync-token></D:multistatus>`;
const multigetResponse = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">${CONTACTS.map(vcardResponse).join("")}</D:multistatus>`;

test("collectAddressBook: legacy token without an initialization boundary re-enumerates iCloud-style member-only responses", async () => {
  const syncTokens: string[] = [];
  const fetchImpl: DiscoveryFetch = (_url, init) => {
    assert.equal(init.method, "REPORT");
    if (init.body?.includes("addressbook-multiget")) {
      return Promise.resolve(response(multigetResponse));
    }
    assert.match(init.body ?? "", /sync-collection/);
    const token = /<D:sync-token>(.*?)<\/D:sync-token>/.exec(init.body ?? "")?.[1] ?? "";
    syncTokens.push(token);
    return Promise.resolve(response(token ? quietSyncResponse : initialSyncResponse));
  };
  const state = {
    contacts: {
      [BOOK_KEY]: { fingerprints: {}, sync_token: "legacy-token" },
    },
  };
  const newState: Record<string, unknown> = structuredClone(state);
  const records: RecordData[] = [];

  const result = await collectAddressBook({
    authHeader: "Basic fixture",
    book: { url: BOOK_URL },
    bookCursor: openFingerprintCursor({ fingerprints: {} }),
    collectionMode: undefined,
    emit: () => Promise.resolve(),
    emitRecord: (_stream, data) => {
      records.push(data);
      return Promise.resolve();
    },
    fetchImpl,
    newState,
    progress: () => Promise.resolve(),
    requested: new Map([["contacts", {}]]),
    state,
    trustedOrigins: ["https://contacts.example"],
  });

  assert.equal(records.length, 3);
  assert.equal(result.contactsConsidered, 3);
  assert.equal(result.contactsCovered, 3);
  assert.equal(result.contactsBoundaryEstablished, true);
  assert.deepEqual(syncTokens, [""], "legacy state must withhold its unproven token once");
  const saved = newState.contacts as Record<string, { initial_sync_completed?: boolean; sync_token?: string }>;
  assert.equal(saved[BOOK_KEY]?.initial_sync_completed, true);
  assert.equal(saved[BOOK_KEY]?.sync_token, "next-token");

  const followUpState = structuredClone(newState);
  const followUpRecords: RecordData[] = [];
  const followUp = await collectAddressBook({
    authHeader: "Basic fixture",
    book: { url: BOOK_URL },
    bookCursor: openFingerprintCursor({ fingerprints: {} }),
    collectionMode: undefined,
    emit: () => Promise.resolve(),
    emitRecord: (_stream, data) => {
      followUpRecords.push(data);
      return Promise.resolve();
    },
    fetchImpl,
    newState: followUpState,
    progress: () => Promise.resolve(),
    requested: new Map([["contacts", {}]]),
    state: newState,
    trustedOrigins: ["https://contacts.example"],
  });

  assert.equal(followUpRecords.length, 0);
  assert.equal(followUp.contactsBoundaryEstablished, false);
  assert.deepEqual(syncTokens, ["", "next-token"], "the initialized follow-up must resume its quiet token");
});
