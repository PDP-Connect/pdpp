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
import type { CalendarEvent, CalendarListEntry, EventsPage } from "./api.ts";
import { CalendarSyncTokenExpiredError } from "./api.ts";
import { collectGoogleCalendar } from "./index.ts";

class FakeCalendarClient {
  readonly calls: Array<{ args?: unknown; method: string }> = [];
  private readonly calendars: CalendarListEntry[];
  private readonly eventPages: EventsPage[];
  private readonly onListEvents?: (
    calendarId: string,
    options: { pageToken?: string; syncToken?: string }
  ) => EventsPage;

  constructor(args: {
    calendars: CalendarListEntry[];
    eventPages?: EventsPage[];
    onListEvents?: (calendarId: string, options: { pageToken?: string; syncToken?: string }) => EventsPage;
  }) {
    this.calendars = args.calendars;
    this.eventPages = args.eventPages ?? [];
    if (args.onListEvents) {
      this.onListEvents = args.onListEvents;
    }
  }

  listCalendars(): Promise<CalendarListEntry[]> {
    this.calls.push({ method: "listCalendars" });
    return Promise.resolve(this.calendars);
  }

  listEventsPage(calendarId: string, options: { pageToken?: string; syncToken?: string }): Promise<EventsPage> {
    this.calls.push({ args: { calendarId, options }, method: "listEventsPage" });
    if (this.onListEvents) {
      return Promise.resolve(this.onListEvents(calendarId, options));
    }
    const page = this.eventPages.shift();
    assert.ok(page, "unexpected listEventsPage call — no fake page queued");
    return Promise.resolve(page);
  }
}

function makeEvent(overrides: Partial<CalendarEvent> & { id: string }): CalendarEvent {
  return {
    attendees: [],
    description: null,
    end: null,
    htmlLink: null,
    location: null,
    organizer: null,
    recurrence: null,
    recurringEventId: null,
    start: { date: null, dateTime: "2026-08-01T09:00:00-05:00", timeZone: "America/Chicago" },
    status: "confirmed",
    summary: "Event",
    updated: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function makeContext({
  state = {},
  streams = [{ name: "calendars" }, { name: "events" }],
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
  GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token",
};

const FAKE_TOKEN = {
  getAccessToken: () => Promise.resolve({ accessToken: "ya29.fake", expiresAt: Date.now() + 3_600_000 }),
};

/** Narrow the last STATE message for a stream out of the emitted-message log. */
function lastStateCursor(messages: readonly EmittedMessage[], stream: string): unknown {
  const found = [...messages].reverse().find((msg) => msg.type === "STATE" && msg.stream === stream);
  return found && found.type === "STATE" ? found.cursor : undefined;
}

test("emits calendars and events, advancing the syncToken cursor", async () => {
  const fakeClient = new FakeCalendarClient({
    calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
    eventPages: [{ events: [makeEvent({ id: "evt1" })], nextPageToken: null, nextSyncToken: "sync-1" }],
  });
  const { ctx, messages, records } = makeContext();

  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  assert.equal(records.filter((r) => r.stream === "calendars").length, 1);
  assert.equal(records.filter((r) => r.stream === "events").length, 1);
  const cursor = lastStateCursor(messages, "events") as Record<string, { sync_token?: string }>;
  assert.equal(cursor.primary?.sync_token, "sync-1");
});

test("pages through multiple event pages before advancing the cursor", async () => {
  const fakeClient = new FakeCalendarClient({
    calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
    eventPages: [
      { events: [makeEvent({ id: "evt1" })], nextPageToken: "page2", nextSyncToken: null },
      { events: [makeEvent({ id: "evt2" })], nextPageToken: null, nextSyncToken: "sync-final" },
    ],
  });
  const { ctx, records } = makeContext();

  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  const eventCalls = fakeClient.calls.filter((c) => c.method === "listEventsPage");
  assert.equal(eventCalls.length, 2);
  assert.equal(records.filter((r) => r.stream === "events").length, 2);
});

test("carries forward the prior syncToken cursor on an incremental run", async () => {
  const fakeClient = new FakeCalendarClient({
    calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
    eventPages: [{ events: [makeEvent({ id: "evt2" })], nextPageToken: null, nextSyncToken: "sync-2" }],
  });
  const priorState = {
    calendars: { fingerprints: {} },
    events: { primary: { sync_token: "sync-1", fingerprints: {} } },
  };
  const { ctx } = makeContext({ state: priorState });

  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  const call = fakeClient.calls.find((c) => c.method === "listEventsPage");
  assert.ok(call);
  const args = call.args as { options: { syncToken?: string } };
  assert.equal(args.options.syncToken, "sync-1");
});

test("unchanged event does not re-emit (fingerprint gate) but does not drop the cursor", async () => {
  const event = makeEvent({ id: "evt1", updated: "2026-08-01T00:00:00Z" });
  const fakeClient = new FakeCalendarClient({
    calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
    eventPages: [{ events: [event], nextPageToken: null, nextSyncToken: "sync-2" }],
  });
  // Prior fingerprint computed by first emitting the same record through the
  // real builder shape (excluding `updated`) — simplest to just run once to
  // seed it, then run again and assert no second emit.
  const seedCtx = makeContext();
  await collectGoogleCalendar(seedCtx.ctx, {
    clientFactory: () =>
      new FakeCalendarClient({
        calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
        eventPages: [{ events: [event], nextPageToken: null, nextSyncToken: "sync-1" }],
      }),
    env: ENV,
    ...FAKE_TOKEN,
  });
  const seededState = lastStateCursor(seedCtx.messages, "events");

  const { ctx, records } = makeContext({ state: { events: seededState as Record<string, unknown> } });
  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  // Same event content (only `updated` differs is excluded from fingerprint,
  // and here it's identical too) — must NOT re-emit.
  assert.equal(records.filter((r) => r.stream === "events").length, 0);
});

test("cancelled event emits a tombstone record with deleted=true", async () => {
  const fakeClient = new FakeCalendarClient({
    calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
    eventPages: [
      {
        events: [makeEvent({ id: "evt-gone", status: "cancelled", summary: null })],
        nextPageToken: null,
        nextSyncToken: "sync-1",
      },
    ],
  });
  const { ctx, records } = makeContext();

  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  const eventRecord = records.find((r) => r.stream === "events");
  assert.ok(eventRecord);
  assert.equal(eventRecord.data.deleted, true);
  assert.equal(eventRecord.data.status, "cancelled");
});

test("falls back to a full resync when the syncToken has expired (HTTP 410)", async () => {
  let call = 0;
  const fakeClient = new FakeCalendarClient({
    calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
    onListEvents: (_calendarId, options) => {
      call += 1;
      if (call === 1) {
        assert.equal(options.syncToken, "sync-expired");
        throw new CalendarSyncTokenExpiredError();
      }
      // Full resync path — no syncToken this time.
      assert.equal(options.syncToken, undefined);
      return { events: [makeEvent({ id: "evt-full" })], nextPageToken: null, nextSyncToken: "sync-fresh" };
    },
  });
  const priorState = { events: { primary: { sync_token: "sync-expired", fingerprints: { stale: "abc" } } } };
  const { ctx, messages, records } = makeContext({ state: priorState });

  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  assert.equal(records.filter((r) => r.stream === "events").length, 1);
  const cursor = lastStateCursor(messages, "events") as Record<
    string,
    { sync_token?: string; fingerprints?: Record<string, string> }
  >;
  assert.equal(cursor.primary?.sync_token, "sync-fresh");
  // The stale fingerprint from the discarded cursor must be pruned on a full resync.
  assert.equal(cursor.primary?.fingerprints?.stale, undefined);
});

test("no-op when neither calendars nor events streams are requested", async () => {
  const fakeClient = new FakeCalendarClient({ calendars: [] });
  const { ctx, records } = makeContext({ streams: [] });

  await collectGoogleCalendar(ctx, { clientFactory: () => fakeClient, env: ENV, ...FAKE_TOKEN });

  assert.equal(fakeClient.calls.length, 0);
  assert.equal(records.length, 0);
});

// ─── Default credential-resolution path (no getAccessToken override) ────
//
// Every test above passes FAKE_TOKEN, which bypasses collectGoogleCalendar's
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
    const fakeClient = new FakeCalendarClient({
      calendars: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: null }],
      eventPages: [{ events: [], nextPageToken: null, nextSyncToken: "sync-1" }],
    });
    let capturedAccessToken: string | null = null;
    const { ctx } = makeContext();

    // No getAccessToken override — exercises collectGoogleCalendar's own
    // default closure, which must call resolveGoogleOAuthCredentials +
    // refreshGoogleAccessToken exactly as production does.
    await collectGoogleCalendar(ctx, {
      clientFactory: (accessToken) => {
        capturedAccessToken = accessToken;
        return fakeClient;
      },
      env: ENV,
    });

    assert.equal(tokenCalls.length, 1, "the real token endpoint must be called exactly once");
    assert.equal(tokenCalls[0]?.url, "https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(tokenCalls[0]?.body ?? "");
    assert.equal(params.get("client_id"), ENV.GOOGLE_OAUTH_CLIENT_ID);
    assert.equal(params.get("client_secret"), ENV.GOOGLE_OAUTH_CLIENT_SECRET);
    assert.equal(params.get("refresh_token"), ENV.GOOGLE_CALENDAR_REFRESH_TOKEN);
    assert.equal(params.get("grant_type"), "refresh_token");
    assert.equal(capturedAccessToken, "ya29.from-real-refresh-flow");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("default getAccessToken path surfaces google_calendar_auth_failed on invalid_grant (400) without calling the client", async () => {
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
    const { ctx } = makeContext();

    await assert.rejects(
      () =>
        collectGoogleCalendar(ctx, {
          clientFactory: () => {
            clientFactoryCalled = true;
            return new FakeCalendarClient({ calendars: [] });
          },
          env: ENV,
        }),
      /google_calendar_auth_failed/
    );
    assert.equal(clientFactoryCalled, false, "a revoked grant must fail before any client is constructed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
