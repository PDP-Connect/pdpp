// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import { addressbookQueryAll, listAddressBooks, syncCollectionReport } from "./carddav-client.ts";
import { discoverCardDav, MAX_RESPONSE_BYTES, nativeFetchAdapter } from "./discovery.ts";
import { buildVCard, startFakeCardDavServer } from "./test-carddav-server.ts";

const USERNAME = "owner@example.com";
const PASSWORD = "app-specific-pw";
const AUTH_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
const fetchImpl = nativeFetchAdapter;

function discover(originUrl: string) {
  return discoverCardDav({ originUrl, authHeader: AUTH_HEADER, fetchImpl });
}

test("listAddressBooks: finds the address book collection with ctag", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    const discovery = await discover(server.origin);
    const books = await listAddressBooks({
      homeUrl: discovery.addressBookHomeUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    assert.equal(books.length, 1);
    assert.equal(books[0]?.displayName, "Contacts");
    assert.equal(books[0]?.url, server.url("/addressbooks/owner/card/"));
    assert.ok(books[0]?.ctag);
  } finally {
    await server.close();
  }
});

test("syncCollectionReport: returns resources and a fresh sync-token on initial sync", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    server.contacts.set("alice", {
      uid: "alice",
      href: "/addressbooks/owner/card/alice.vcf",
      vcard: buildVCard({ uid: "alice", fn: "Alice Example", email: "alice@example.com" }),
    });
    const discovery = await discover(server.origin);
    const books = await listAddressBooks({
      homeUrl: discovery.addressBookHomeUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    const result = await syncCollectionReport({
      bookUrl: books[0]?.url as string,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
      priorSyncToken: "",
    });
    assert.equal(result.supportsSyncCollection, true);
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0]?.vcardText.includes("Alice Example"), true);
    assert.ok(result.syncToken);
  } finally {
    await server.close();
  }
});

test("syncCollectionReport: a subsequent call reports deletions as 404 responses", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    server.contacts.set("bob", {
      uid: "bob",
      href: "/addressbooks/owner/card/bob.vcf",
      vcard: buildVCard({ uid: "bob", fn: "Bob Example" }),
    });
    const discovery = await discover(server.origin);
    const books = await listAddressBooks({
      homeUrl: discovery.addressBookHomeUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    const bookUrl = books[0]?.url as string;
    const first = await syncCollectionReport({
      bookUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
      priorSyncToken: "",
    });
    assert.equal(first.resources.length, 1);

    // Delete bob between runs.
    server.contacts.delete("bob");
    server.deletedHrefs.add("/addressbooks/owner/card/bob.vcf");
    server.markChanged();

    const second = await syncCollectionReport({
      bookUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
      priorSyncToken: first.syncToken as string,
    });
    assert.deepEqual(second.deletedHrefs, [server.url("/addressbooks/owner/card/bob.vcf")]);
    assert.notEqual(second.syncToken, first.syncToken);
  } finally {
    await server.close();
  }
});

test("syncCollectionReport: reports unsupported (501) as supportsSyncCollection=false", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD, disableSyncCollection: true });
  try {
    const discovery = await discover(server.origin);
    const books = await listAddressBooks({
      homeUrl: discovery.addressBookHomeUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    const result = await syncCollectionReport({
      bookUrl: books[0]?.url as string,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
      priorSyncToken: "",
    });
    assert.equal(result.supportsSyncCollection, false);
  } finally {
    await server.close();
  }
});

test("addressbookQueryAll: bounded full snapshot fallback returns every contact", async () => {
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD, disableSyncCollection: true });
  try {
    server.contacts.set("carol", {
      uid: "carol",
      href: "/addressbooks/owner/card/carol.vcf",
      vcard: buildVCard({ uid: "carol", fn: "Carol Example" }),
    });
    server.contacts.set("dave", {
      uid: "dave",
      href: "/addressbooks/owner/card/dave.vcf",
      vcard: buildVCard({ uid: "dave", fn: "Dave Example" }),
    });
    const discovery = await discover(server.origin);
    const books = await listAddressBooks({
      homeUrl: discovery.addressBookHomeUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    const resources = await addressbookQueryAll({
      bookUrl: books[0]?.url as string,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    assert.equal(resources.length, 2);
    const names = resources.map((r) => r.vcardText).join("\n");
    assert.equal(names.includes("Carol Example"), true);
    assert.equal(names.includes("Dave Example"), true);
  } finally {
    await server.close();
  }
});

test("syncCollectionReport: an oversized multistatus response (huge embedded photo) is rejected by the byte cap, not parsed", async () => {
  // Real end-to-end proof the bounded-response-read wiring is live in the
  // wire client, not just unit-tested in isolation: a vCard whose PHOTO
  // property alone pushes the multistatus response past MAX_RESPONSE_BYTES
  // must fail with the cap's error, never reach the XML/vCard parser.
  const server = await startFakeCardDavServer({ username: USERNAME, password: PASSWORD });
  try {
    const oversizedPhotoBase64 = "A".repeat(MAX_RESPONSE_BYTES + 1024);
    server.contacts.set("huge", {
      uid: "huge",
      href: "/addressbooks/owner/card/huge.vcf",
      vcard: buildVCard({
        uid: "huge",
        fn: "Huge Photo Contact",
        photo: { base64: oversizedPhotoBase64, mediaType: "jpeg" },
      }),
    });
    const discovery = await discover(server.origin);
    const books = await listAddressBooks({
      homeUrl: discovery.addressBookHomeUrl,
      authHeader: AUTH_HEADER,
      fetchImpl,
      trustedOrigins: [server.origin],
    });
    await assert.rejects(
      syncCollectionReport({
        bookUrl: books[0]?.url as string,
        authHeader: AUTH_HEADER,
        fetchImpl,
        trustedOrigins: [server.origin],
        priorSyncToken: "",
      }),
      (err: unknown) => err instanceof Error && err.message.startsWith("carddav_response_too_large")
    );
  } finally {
    await server.close();
  }
});
