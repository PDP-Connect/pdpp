// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { CalendarApiError, CalendarSyncTokenExpiredError, GoogleCalendarClient } from "./api.ts";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
    ...init,
  });
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

test("listCalendars pages through calendarList and sends a bearer token", async () => {
  const transport = makeFetch([
    jsonResponse({
      items: [{ id: "primary", summary: "Work", primary: true, accessRole: "owner", timeZone: "America/Chicago" }],
      nextPageToken: "page2",
    }),
    jsonResponse({
      items: [{ id: "cal2", summary: "Family", primary: false, accessRole: "reader" }],
    }),
  ]);
  const client = new GoogleCalendarClient({ accessToken: "ya29.access", fetch: transport.fetch });
  const calendars = await client.listCalendars();
  assert.equal(calendars.length, 2);
  assert.deepEqual(calendars[0], {
    id: "primary",
    summary: "Work",
    primary: true,
    accessRole: "owner",
    timeZone: "America/Chicago",
  });
  assert.equal(transport.calls.length, 2);
  assert.equal(transport.calls[0]?.headers.get("Authorization"), "Bearer ya29.access");
  assert.ok(transport.calls[1]?.url.includes("pageToken=page2"));
});

test("listEventsPage sends syncToken when provided and parses recurrence/attendees", async () => {
  const transport = makeFetch([
    jsonResponse({
      items: [
        {
          id: "evt1",
          status: "confirmed",
          summary: "Standup",
          start: { dateTime: "2026-08-01T09:00:00-05:00" },
          end: { dateTime: "2026-08-01T09:15:00-05:00" },
          recurrence: ["RRULE:FREQ=DAILY"],
          attendees: [{ email: "a@example.com", responseStatus: "accepted", organizer: true, self: true }],
        },
      ],
      nextSyncToken: "sync-abc",
    }),
  ]);
  const client = new GoogleCalendarClient({ accessToken: "tok", fetch: transport.fetch });
  const page = await client.listEventsPage("primary", { syncToken: "sync-prior" });
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0]?.recurrence?.[0], "RRULE:FREQ=DAILY");
  assert.equal(page.events[0]?.attendees[0]?.email, "a@example.com");
  assert.equal(page.nextSyncToken, "sync-abc");
  assert.ok(transport.calls[0]?.url.includes("syncToken=sync-prior"));
});

test("listEventsPage surfaces cancelled events for deletion tombstones", async () => {
  const transport = makeFetch([
    jsonResponse({
      items: [{ id: "evt-deleted", status: "cancelled" }],
      nextSyncToken: "sync-next",
    }),
  ]);
  const client = new GoogleCalendarClient({ accessToken: "tok", fetch: transport.fetch });
  const page = await client.listEventsPage("primary", { syncToken: "sync-prior" });
  assert.equal(page.events[0]?.status, "cancelled");
});

test("listEventsPage throws CalendarSyncTokenExpiredError on HTTP 410", async () => {
  const transport = makeFetch([jsonResponse({ error: { message: "Sync token is no longer valid" } }, { status: 410 })]);
  const client = new GoogleCalendarClient({ accessToken: "tok", fetch: transport.fetch });
  await assert.rejects(
    () => client.listEventsPage("primary", { syncToken: "expired" }),
    (error: unknown) => error instanceof CalendarSyncTokenExpiredError
  );
});

test("listEventsPage throws CalendarApiError on other non-2xx statuses", async () => {
  const transport = makeFetch([jsonResponse({ error: { message: "forbidden" } }, { status: 403 })]);
  const client = new GoogleCalendarClient({ accessToken: "tok", fetch: transport.fetch });
  await assert.rejects(
    () => client.listEventsPage("primary", {}),
    (error: unknown) => error instanceof CalendarApiError && error.status === 403
  );
});

test("constructor rejects an empty access token", () => {
  assert.throws(() => new GoogleCalendarClient({ accessToken: "  " }), /google_calendar_access_token_missing/);
});
