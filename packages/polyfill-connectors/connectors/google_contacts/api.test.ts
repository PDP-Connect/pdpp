// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { GooglePeopleClient, PeopleApiError, PeopleSyncTokenExpiredError } from "./api.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, status: 200, ...init });
}

interface CapturedRequest {
  readonly headers: Headers;
  readonly url: string;
}

function makeFetch(responses: readonly Response[]): {
  readonly calls: CapturedRequest[];
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
} {
  const calls: CapturedRequest[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch(url, init) {
      calls.push({ headers: new Headers(init.headers), url });
      const response = queue.shift();
      assert.ok(response, `unexpected fetch call to ${url}`);
      return Promise.resolve(response);
    },
  };
}

test("listConnectionsPage sends syncToken and requestSyncToken, and parses a person", async () => {
  const transport = makeFetch([
    jsonResponse({
      connections: [
        {
          resourceName: "people/c123",
          names: [{ displayName: "Ada Lovelace", givenName: "Ada", familyName: "Lovelace" }],
          emailAddresses: [{ type: "work", value: "ada@example.com" }],
          metadata: { deleted: false, sources: [{ updateTime: "2026-08-01T00:00:00Z" }] },
        },
      ],
      nextSyncToken: "sync-abc",
    }),
  ]);
  const client = new GooglePeopleClient({ accessToken: "ya29.access", fetch: transport.fetch });
  const page = await client.listConnectionsPage({ syncToken: "sync-prior" });
  assert.equal(page.people.length, 1);
  assert.equal(page.people[0]?.resourceName, "people/c123");
  assert.equal(page.people[0]?.names[0]?.displayName, "Ada Lovelace");
  assert.equal(page.people[0]?.emailAddresses[0]?.value, "ada@example.com");
  assert.equal(page.people[0]?.deleted, false);
  assert.equal(page.nextSyncToken, "sync-abc");
  assert.ok(transport.calls[0]?.url.includes("syncToken=sync-prior"));
  assert.ok(transport.calls[0]?.url.includes("requestSyncToken=true"));
  assert.equal(transport.calls[0]?.headers.get("Authorization"), "Bearer ya29.access");
});

test("listConnectionsPage surfaces PersonMetadata.deleted as a tombstone", async () => {
  const transport = makeFetch([
    jsonResponse({
      connections: [{ resourceName: "people/c-gone", metadata: { deleted: true } }],
      nextSyncToken: "sync-next",
    }),
  ]);
  const client = new GooglePeopleClient({ accessToken: "tok", fetch: transport.fetch });
  const page = await client.listConnectionsPage({ syncToken: "sync-prior" });
  assert.equal(page.people[0]?.deleted, true);
});

test("listConnectionsPage throws PeopleSyncTokenExpiredError on HTTP 410", async () => {
  const transport = makeFetch([jsonResponse({ error: { message: "invalid sync token" } }, { status: 410 })]);
  const client = new GooglePeopleClient({ accessToken: "tok", fetch: transport.fetch });
  await assert.rejects(
    () => client.listConnectionsPage({ syncToken: "expired" }),
    (error: unknown) => error instanceof PeopleSyncTokenExpiredError
  );
});

test("listConnectionsPage throws PeopleApiError on other non-2xx statuses", async () => {
  const transport = makeFetch([jsonResponse({ error: { message: "forbidden" } }, { status: 403 })]);
  const client = new GooglePeopleClient({ accessToken: "tok", fetch: transport.fetch });
  await assert.rejects(
    () => client.listConnectionsPage({}),
    (error: unknown) => error instanceof PeopleApiError && error.status === 403
  );
});

test("listContactGroups pages through contactGroups", async () => {
  const transport = makeFetch([
    jsonResponse({
      contactGroups: [{ resourceName: "contactGroups/myContacts", name: "My Contacts", memberCount: 12 }],
      nextPageToken: "page2",
    }),
    jsonResponse({
      contactGroups: [{ resourceName: "contactGroups/family", name: "Family", memberCount: 4 }],
    }),
  ]);
  const client = new GooglePeopleClient({ accessToken: "tok", fetch: transport.fetch });
  const groups = await client.listContactGroups();
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0], { resourceName: "contactGroups/myContacts", name: "My Contacts", memberCount: 12 });
  assert.ok(transport.calls[1]?.url.includes("pageToken=page2"));
});

test("constructor rejects an empty access token", () => {
  assert.throws(() => new GooglePeopleClient({ accessToken: "" }), /google_people_access_token_missing/);
});
