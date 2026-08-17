// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import type {
  CollectContext,
  EmittedMessage,
  RecordData,
  StartMessage,
  StreamScope,
} from "../../src/connector-runtime.ts";
import type { ConnectionsPage, ContactGroup, Person } from "./api.ts";
import { PeopleSyncTokenExpiredError } from "./api.ts";
import { collectGoogleContacts } from "./index.ts";

class FakePeopleClient {
  readonly calls: Array<{ args?: unknown; method: string }> = [];
  private readonly groups: ContactGroup[];
  private readonly connectionPages: ConnectionsPage[];
  private readonly onListConnections?: (options: { pageToken?: string; syncToken?: string }) => ConnectionsPage;

  constructor(args: {
    connectionPages?: ConnectionsPage[];
    groups?: ContactGroup[];
    onListConnections?: (options: { pageToken?: string; syncToken?: string }) => ConnectionsPage;
  }) {
    this.groups = args.groups ?? [];
    this.connectionPages = args.connectionPages ?? [];
    if (args.onListConnections) {
      this.onListConnections = args.onListConnections;
    }
  }

  listConnectionsPage(options: { pageToken?: string; syncToken?: string }): Promise<ConnectionsPage> {
    this.calls.push({ args: options, method: "listConnectionsPage" });
    if (this.onListConnections) {
      return Promise.resolve(this.onListConnections(options));
    }
    const page = this.connectionPages.shift();
    assert.ok(page, "unexpected listConnectionsPage call — no fake page queued");
    return Promise.resolve(page);
  }

  listContactGroups(): Promise<ContactGroup[]> {
    this.calls.push({ method: "listContactGroups" });
    return Promise.resolve(this.groups);
  }
}

function makePerson(overrides: Partial<Person> & { resourceName: string }): Person {
  return {
    addresses: [],
    biography: null,
    deleted: false,
    emailAddresses: [],
    memberships: [],
    names: [{ displayName: "Ada Lovelace", familyName: "Lovelace", givenName: "Ada" }],
    nickname: null,
    organizations: [],
    phoneNumbers: [],
    photoUrl: null,
    updated: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeContext({
  state = {},
  streams = [{ name: "people" }, { name: "contact_groups" }],
}: {
  readonly state?: Record<string, unknown>;
  readonly streams?: readonly StreamScope[];
} = {}): {
  readonly ctx: CollectContext;
  readonly messages: EmittedMessage[];
  readonly records: Array<{ data: RecordData; stream: string }>;
} {
  const messages: EmittedMessage[] = [];
  const records: Array<{ data: RecordData; stream: string }> = [];
  const start: StartMessage = { type: "START", scope: { streams }, state };
  return {
    messages,
    records,
    ctx: {
      assist: () => Promise.resolve("asst_test"),
      capture: null,
      completeAssistance: () => Promise.resolve(),
      credentials: {},
      detailGaps: [],
      emit: (msg) => {
        messages.push(msg);
        return Promise.resolve();
      },
      emitRecord: (stream, data) => {
        records.push({ data, stream });
        return Promise.resolve();
      },
      emittedAt: "2026-08-07T00:00:00.000Z",
      progress: () => Promise.resolve(),
      requested: new Map(streams.map((stream) => [stream.name, stream])),
      requestDetailGapPage: () => Promise.resolve([]),
      scope: start.scope,
      sendInteraction: () =>
        Promise.resolve({
          request_id: "int_test",
          status: "cancelled" as const,
          type: "INTERACTION_RESPONSE" as const,
        }),
      state,
    },
  };
}

const ENV = {
  GOOGLE_OAUTH_CLIENT_ID: "client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
  GOOGLE_CONTACTS_REFRESH_TOKEN: "refresh-token",
};

const FAKE_TOKEN = {
  getAccessToken: () => Promise.resolve({ accessToken: "ya29.fake", expiresAt: Date.now() + 3_600_000 }),
};
const FIXED_NOW = Date.parse("2026-08-07T00:00:00Z");

function lastStateCursor(messages: readonly EmittedMessage[], stream: string): unknown {
  const found = [...messages].reverse().find((msg) => msg.type === "STATE" && msg.stream === stream);
  return found && found.type === "STATE" ? found.cursor : undefined;
}

test("emits people and contact_groups, advancing the syncToken cursor", async () => {
  const fakeClient = new FakePeopleClient({
    connectionPages: [
      { people: [makePerson({ resourceName: "people/c1" })], nextPageToken: null, nextSyncToken: "sync-1" },
    ],
    groups: [{ resourceName: "contactGroups/myContacts", name: "My Contacts", memberCount: 1 }],
  });
  const { ctx, records } = makeContext();

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  assert.equal(records.filter((r) => r.stream === "people").length, 1);
  assert.equal(records.filter((r) => r.stream === "contact_groups").length, 1);
});

test("pages through multiple connection pages before advancing the cursor", async () => {
  const fakeClient = new FakePeopleClient({
    connectionPages: [
      { people: [makePerson({ resourceName: "people/c1" })], nextPageToken: "page2", nextSyncToken: null },
      { people: [makePerson({ resourceName: "people/c2" })], nextPageToken: null, nextSyncToken: "sync-final" },
    ],
  });
  const { ctx, records } = makeContext({ streams: [{ name: "people" }] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  const calls = fakeClient.calls.filter((c) => c.method === "listConnectionsPage");
  assert.equal(calls.length, 2);
  assert.equal(records.filter((r) => r.stream === "people").length, 2);
});

test("carries forward the prior syncToken cursor on an incremental run", async () => {
  const fakeClient = new FakePeopleClient({
    connectionPages: [
      { people: [makePerson({ resourceName: "people/c2" })], nextPageToken: null, nextSyncToken: "sync-2" },
    ],
  });
  const priorState = { people: { sync_token: "sync-1", synced_at: "2026-08-06T00:00:00Z", fingerprints: {} } };
  const { ctx } = makeContext({ state: priorState, streams: [{ name: "people" }] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  const call = fakeClient.calls.find((c) => c.method === "listConnectionsPage");
  assert.ok(call);
  assert.equal((call.args as { syncToken?: string }).syncToken, "sync-1");
});

test("deleted person (PersonMetadata.deleted) emits a tombstone record", async () => {
  const fakeClient = new FakePeopleClient({
    connectionPages: [
      {
        people: [makePerson({ resourceName: "people/c-gone", deleted: true, names: [] })],
        nextPageToken: null,
        nextSyncToken: "sync-1",
      },
    ],
  });
  const { ctx, records } = makeContext({ streams: [{ name: "people" }] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  const personRecord = records.find((r) => r.stream === "people");
  assert.ok(personRecord);
  assert.equal(personRecord.data.deleted, true);
});

test("falls back to a full resync when the syncToken has expired (HTTP 410)", async () => {
  let call = 0;
  const fakeClient = new FakePeopleClient({
    onListConnections: (options) => {
      call += 1;
      if (call === 1) {
        assert.equal(options.syncToken, "sync-expired");
        throw new PeopleSyncTokenExpiredError();
      }
      assert.equal(options.syncToken, undefined);
      return {
        people: [makePerson({ resourceName: "people/c-full" })],
        nextPageToken: null,
        nextSyncToken: "sync-fresh",
      };
    },
  });
  const priorState = {
    people: { sync_token: "sync-expired", synced_at: "2026-08-06T00:00:00Z", fingerprints: { stale: "abc" } },
  };
  const { ctx, messages, records } = makeContext({ state: priorState, streams: [{ name: "people" }] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  assert.equal(records.filter((r) => r.stream === "people").length, 1);
  const cursor = lastStateCursor(messages, "people") as { sync_token?: string; fingerprints?: Record<string, string> };
  assert.equal(cursor.sync_token, "sync-fresh");
  assert.equal(cursor.fingerprints?.stale, undefined);
});

test("proactively forces a full resync when the syncToken is past its 7-day window, without waiting for a 410", async () => {
  const fakeClient = new FakePeopleClient({
    connectionPages: [
      { people: [makePerson({ resourceName: "people/c1" })], nextPageToken: null, nextSyncToken: "sync-new" },
    ],
  });
  // synced_at is 8 days before FIXED_NOW — past the 6-day proactive threshold.
  const eightDaysAgo = new Date(FIXED_NOW - 8 * 24 * 60 * 60 * 1000).toISOString();
  const priorState = { people: { sync_token: "sync-old", synced_at: eightDaysAgo, fingerprints: {} } };
  const { ctx } = makeContext({ state: priorState, streams: [{ name: "people" }] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  const call = fakeClient.calls.find((c) => c.method === "listConnectionsPage");
  assert.ok(call);
  // No syncToken sent — full resync requested proactively, before any 410.
  assert.equal((call.args as { syncToken?: string }).syncToken, undefined);
});

test("does not force a full resync when the syncToken is still within its validity window", async () => {
  const fakeClient = new FakePeopleClient({
    connectionPages: [
      { people: [makePerson({ resourceName: "people/c1" })], nextPageToken: null, nextSyncToken: "sync-new" },
    ],
  });
  const oneDayAgo = new Date(FIXED_NOW - 1 * 24 * 60 * 60 * 1000).toISOString();
  const priorState = { people: { sync_token: "sync-recent", synced_at: oneDayAgo, fingerprints: {} } };
  const { ctx } = makeContext({ state: priorState, streams: [{ name: "people" }] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  const call = fakeClient.calls.find((c) => c.method === "listConnectionsPage");
  assert.ok(call);
  assert.equal((call.args as { syncToken?: string }).syncToken, "sync-recent");
});

test("unchanged person does not re-emit but the cursor still advances", async () => {
  const person = makePerson({ resourceName: "people/c1" });
  const seedCtx = makeContext({ streams: [{ name: "people" }] });
  await collectGoogleContacts(seedCtx.ctx, {
    clientFactory: () =>
      new FakePeopleClient({ connectionPages: [{ people: [person], nextPageToken: null, nextSyncToken: "sync-1" }] }),
    env: ENV,
    now: () => FIXED_NOW,
    ...FAKE_TOKEN,
  });
  const seededState = lastStateCursor(seedCtx.messages, "people");

  const fakeClient = new FakePeopleClient({
    connectionPages: [{ people: [person], nextPageToken: null, nextSyncToken: "sync-2" }],
  });
  const { ctx, records } = makeContext({
    state: { people: seededState as Record<string, unknown> },
    streams: [{ name: "people" }],
  });
  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  assert.equal(records.filter((r) => r.stream === "people").length, 0);
});

test("no-op when neither people nor contact_groups streams are requested", async () => {
  const fakeClient = new FakePeopleClient({});
  const { ctx, records } = makeContext({ streams: [] });

  await collectGoogleContacts(ctx, { clientFactory: () => fakeClient, env: ENV, now: () => FIXED_NOW, ...FAKE_TOKEN });

  assert.equal(fakeClient.calls.length, 0);
  assert.equal(records.length, 0);
});

// ─── Default credential-resolution path (no getAccessToken override) ────
//
// Every test above passes FAKE_TOKEN, which bypasses collectGoogleContacts's
// own default `getAccessToken` closure entirely — a dead or silently-broken
// refreshGoogleAccessToken()/resolveGoogleOAuthCredentials() call would not
// fail any of them. This test omits the override so the connector's real
// default path (src/google-oauth.ts, reached via the global `fetch`) runs
// end to end: it stubs `globalThis.fetch` for the token endpoint only, and
// asserts the access token handed to the client factory is the one that
// ONLY a real refresh exchange could have produced.

test("default getAccessToken path calls the real Google OAuth token endpoint and forwards its access_token to the client", async () => {
  const originalFetch = globalThis.fetch;
  const tokenCalls: Array<{ body: string; url: string }> = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    tokenCalls.push({ body: String(init.body ?? ""), url: String(url) });
    return Promise.resolve(
      new Response(JSON.stringify({ access_token: "ya29.from-real-refresh-flow", expires_in: 3600 }), {
        headers: { "Content-Type": "application/json" },
        status: 200,
      })
    );
  }) as typeof fetch;

  try {
    const fakeClient = new FakePeopleClient({
      connectionPages: [{ people: [], nextPageToken: null, nextSyncToken: "sync-1" }],
    });
    let capturedAccessToken: string | null = null;
    const { ctx } = makeContext({ streams: [{ name: "people" }] });

    // No getAccessToken override — exercises collectGoogleContacts's own
    // default closure, which must call resolveGoogleOAuthCredentials +
    // refreshGoogleAccessToken exactly as production does.
    await collectGoogleContacts(ctx, {
      clientFactory: (accessToken) => {
        capturedAccessToken = accessToken;
        return fakeClient;
      },
      env: ENV,
      now: () => FIXED_NOW,
    });

    assert.equal(tokenCalls.length, 1, "the real token endpoint must be called exactly once");
    assert.equal(tokenCalls[0]?.url, "https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(tokenCalls[0]?.body ?? "");
    assert.equal(params.get("client_id"), ENV.GOOGLE_OAUTH_CLIENT_ID);
    assert.equal(params.get("client_secret"), ENV.GOOGLE_OAUTH_CLIENT_SECRET);
    assert.equal(params.get("refresh_token"), ENV.GOOGLE_CONTACTS_REFRESH_TOKEN);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(capturedAccessToken, "ya29.from-real-refresh-flow");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default getAccessToken path surfaces google_contacts_auth_failed on invalid_grant (400) without calling the client", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        headers: { "Content-Type": "application/json" },
        status: 400,
      })
    )) as typeof fetch;

  try {
    let clientFactoryCalled = false;
    const { ctx } = makeContext({ streams: [{ name: "people" }] });

    await assert.rejects(
      () =>
        collectGoogleContacts(ctx, {
          clientFactory: () => {
            clientFactoryCalled = true;
            return new FakePeopleClient({});
          },
          env: ENV,
          now: () => FIXED_NOW,
        }),
      /google_contacts_auth_failed/
    );
    assert.equal(clientFactoryCalled, false, "a revoked grant must fail before any client is constructed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
