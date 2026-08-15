#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Google Calendar Connector (v0.1.0)
 *
 * Official Calendar API v3 (OAuth2, `calendar.readonly` scope) — distinct
 * from the existing `ical` connector, which reads owner-supplied .ics files
 * or subscription URLs with no OAuth and no attendee/recurrence-via-API
 * fidelity. This connector differentiates by syncing directly against
 * Google's account API: syncToken-based incremental paging, in-band
 * deletion tombstones (`status: "cancelled"`), and a full resync on
 * syncToken expiry (HTTP 410).
 *
 * Streams: calendars, events.
 *
 * State shape:
 *   {
 *     calendars: { fingerprints: { [calendarId]: sha1 } },
 *     events: {
 *       [calendarId]: { sync_token?: string, fingerprints: { [eventId]: sha1 } }
 *     }
 *   }
 *
 * Auth: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (shared Google app
 * registration) + GOOGLE_CALENDAR_REFRESH_TOKEN (this connector's own consent
 * grant). See src/google-oauth.ts for the shared refresh primitive.
 */

import { createConnectorHttpGovernor } from "../../src/connector-http-governor.ts";
import { type CollectContext, emitDetailCoverage, type RecordData, runConnector } from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import {
  type GoogleAccessToken,
  isGoogleOAuthGrantInvalid,
  refreshGoogleAccessToken,
  resolveGoogleOAuthCredentials,
} from "../../src/google-oauth.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { google_calendarPacingProfile } from "../../src/provider-profile.ts";
import {
  type CalendarEvent,
  type CalendarListEntry,
  CalendarSyncTokenExpiredError,
  GoogleCalendarClient,
} from "./api.ts";
import { validateRecord } from "./schemas.ts";

/**
 * `httpGovernor.request` runs `send()` through `retryHttp`, which wraps a
 * thrown, non-retryable error in `RetryExhaustedError` (with the real error
 * on `.originalCause`) once its bounded attempts are exhausted. `maxAttempts:
 * 1` means that wrapping happens on the very first throw, so a direct
 * `instanceof CalendarSyncTokenExpiredError` check on the caught error never
 * matches — it must also check `.originalCause`.
 */
function isSyncTokenExpired(error: unknown): boolean {
  if (error instanceof CalendarSyncTokenExpiredError) {
    return true;
  }
  return (
    error instanceof Error &&
    "originalCause" in error &&
    (error as { originalCause?: unknown }).originalCause instanceof CalendarSyncTokenExpiredError
  );
}

const REFRESH_TOKEN_ENV_VAR = "GOOGLE_CALENDAR_REFRESH_TOKEN";
const MAX_PAGES_PER_CALENDAR = 200;

const httpGovernor = createConnectorHttpGovernor({
  name: "google_calendar",
  maxAttempts: 1,
  profile: google_calendarPacingProfile(),
});

interface EventsCalendarState {
  readonly fingerprints?: Record<string, string>;
  readonly sync_token?: string;
}

interface GoogleCalendarState {
  readonly calendars?: { fingerprints?: Record<string, string> };
  readonly events?: Record<string, EventsCalendarState>;
}

function calendarRecord(entry: CalendarListEntry): RecordData {
  return {
    id: entry.id,
    summary: entry.summary,
    time_zone: entry.timeZone,
    access_role: entry.accessRole,
    primary: entry.primary,
    source: "google_calendar_api",
  };
}

function isAllDay(event: CalendarEvent): boolean {
  return Boolean(event.start?.date && !event.start?.dateTime);
}

function eventRecord(calendarId: string, event: CalendarEvent): RecordData {
  const deleted = event.status === "cancelled";
  return {
    id: event.id,
    calendar_id: calendarId,
    summary: event.summary,
    description: event.description,
    location: event.location,
    status: event.status,
    deleted,
    start: event.start?.dateTime ?? null,
    start_date: event.start?.date ?? null,
    end: event.end?.dateTime ?? null,
    end_date: event.end?.date ?? null,
    all_day: isAllDay(event),
    organizer_email: event.organizer?.email ?? null,
    organizer_display_name: event.organizer?.displayName ?? null,
    attendees: event.attendees.map((a) => ({
      email: a.email,
      display_name: a.displayName,
      organizer: a.organizer,
      optional: a.optional,
      response_status: a.responseStatus,
      self: a.self,
    })),
    recurrence: event.recurrence,
    recurring_event_id: event.recurringEventId,
    html_link: event.htmlLink,
    updated: event.updated,
    source: "google_calendar_api",
  };
}

/** Fingerprint fields to exclude for events: `updated` is Google's own
 *  server-side write timestamp and moves whenever Google recomputes derived
 *  state without a human-visible content change (e.g. recurrence expansion
 *  bookkeeping); the rest of the record is the real content signal. */
const EVENT_FINGERPRINT_EXCLUDE = ["updated"] as const;

interface EventsSyncResult {
  readonly fullResync: boolean;
  readonly nextSyncToken: string | null;
}

/**
 * Page through one calendar's events once, either incrementally (`syncToken`
 * set) or as a full listing (`syncToken` absent). Shared by both the
 * incremental attempt and the expired-token full-resync fallback in
 * {@link syncCalendarEvents} — those two passes differ only in whether a
 * syncToken is sent, so factoring the loop out keeps each call site's own
 * cognitive complexity within the lint ceiling.
 */
async function pageThroughEvents(args: {
  readonly calendarId: string;
  readonly client: CalendarClientLike;
  readonly ctx: CollectContext;
  readonly cursor: FingerprintCursor;
  readonly syncToken: string | undefined;
}): Promise<string | null> {
  const { calendarId, client, ctx, cursor, syncToken } = args;
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let pages = 0;
  do {
    const page = await httpGovernor.request(
      () =>
        client.listEventsPage(calendarId, {
          ...(syncToken ? { syncToken } : {}),
          ...(pageToken ? { pageToken } : {}),
        }),
      (value) => ({ status: 200, value })
    );
    pages += 1;
    await ctx.progress(`Fetched Google Calendar events page ${String(pages)}`, {
      stream: "events",
      count: page.value.events.length,
    });
    for (const event of page.value.events) {
      const record = eventRecord(calendarId, event);
      if (cursor.shouldEmit(record)) {
        await ctx.emitRecord("events", record);
      }
    }
    pageToken = page.value.nextPageToken ?? undefined;
    nextSyncToken = page.value.nextSyncToken ?? nextSyncToken;
  } while (pageToken && pages < MAX_PAGES_PER_CALENDAR);
  return nextSyncToken;
}

async function syncCalendarEvents(args: {
  readonly calendarId: string;
  readonly client: CalendarClientLike;
  readonly ctx: CollectContext;
  readonly cursor: FingerprintCursor;
  readonly priorSyncToken: string | undefined;
}): Promise<EventsSyncResult> {
  const { calendarId, client, ctx, cursor, priorSyncToken } = args;
  try {
    const nextSyncToken = await pageThroughEvents({ calendarId, client, ctx, cursor, syncToken: priorSyncToken });
    return { fullResync: false, nextSyncToken };
  } catch (error) {
    if (!isSyncTokenExpired(error)) {
      throw error;
    }
    // Expired-token full-resync: discard the syncToken and prior
    // fingerprints, re-list from scratch. This connector treats the
    // discarded cursor as a fresh full scan, so pruneStale() below (in the
    // caller) is safe — a partial-scan cursor must not prune; a full resync
    // may.
    const nextSyncToken = await pageThroughEvents({ calendarId, client, ctx, cursor, syncToken: undefined });
    return { fullResync: true, nextSyncToken };
  }
}

/** Structural shape the connector needs from a Calendar client — lets tests
 *  substitute a fake without extending the concrete `GoogleCalendarClient`. */
export interface CalendarClientLike {
  listCalendars: () => Promise<CalendarListEntry[]>;
  listEventsPage: (
    calendarId: string,
    options: { pageToken?: string; syncToken?: string; timeMin?: string }
  ) => Promise<import("./api.ts").EventsPage>;
}

interface CalendarCollectOptions {
  readonly clientFactory?: (accessToken: string) => CalendarClientLike;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly getAccessToken?: () => Promise<GoogleAccessToken>;
}

export async function collectGoogleCalendar(ctx: CollectContext, options: CalendarCollectOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const getAccessToken =
    options.getAccessToken ??
    (async (): Promise<GoogleAccessToken> => {
      const credentials = resolveGoogleOAuthCredentials(env, REFRESH_TOKEN_ENV_VAR);
      try {
        return await refreshGoogleAccessToken(credentials);
      } catch (error) {
        if (isGoogleOAuthGrantInvalid(error)) {
          throw new Error("google_calendar_auth_failed", { cause: error });
        }
        throw error;
      }
    });

  const wantsCalendars = ctx.requested.has("calendars");
  const wantsEvents = ctx.requested.has("events");
  if (!(wantsCalendars || wantsEvents)) {
    await ctx.progress("No Google Calendar streams requested", { stream: "calendars" });
    return;
  }

  const { accessToken } = await getAccessToken();
  const client = options.clientFactory ? options.clientFactory(accessToken) : new GoogleCalendarClient({ accessToken });

  const state = (ctx.state as GoogleCalendarState) ?? {};
  const calendars = await httpGovernor.request(
    () => client.listCalendars(),
    (value) => ({ status: 200, value })
  );

  const calendarsCursor = openFingerprintCursor(state.calendars);
  if (wantsCalendars) {
    for (const entry of calendars.value) {
      const record = calendarRecord(entry);
      if (calendarsCursor.shouldEmit(record)) {
        await ctx.emitRecord("calendars", record);
      }
    }
    calendarsCursor.pruneStale();
    await ctx.emit({
      type: "STATE",
      stream: "calendars",
      cursor: { fingerprints: calendarsCursor.toState() },
    });
  }

  if (!wantsEvents) {
    return;
  }

  const nextEventsState: Record<string, EventsCalendarState> = { ...(state.events ?? {}) };
  const requiredCalendarIds = calendars.value.map((c) => c.id);
  const coveredCalendarIds: string[] = [];

  for (const entry of calendars.value) {
    const priorCalendarState = state.events?.[entry.id];
    const eventsCursor = openFingerprintCursor(priorCalendarState, {
      excludeFromFingerprint: [...EVENT_FINGERPRINT_EXCLUDE],
    });
    await ctx.progress("Syncing Google Calendar events", { stream: "events" });
    const result = await syncCalendarEvents({
      calendarId: entry.id,
      client,
      ctx,
      cursor: eventsCursor,
      priorSyncToken: priorCalendarState?.sync_token,
    });
    // A syncToken response is a PARTIAL delta (only changed/deleted events
    // surface), so pruning is only valid on the full-resync path — the same
    // rule Gmail/YNAB apply to their own delta vs. full-scan cursors.
    if (result.fullResync) {
      eventsCursor.pruneStale();
    }
    nextEventsState[entry.id] = {
      ...(result.nextSyncToken ? { sync_token: result.nextSyncToken } : {}),
      fingerprints: eventsCursor.toState(),
    };
    coveredCalendarIds.push(entry.id);
    await ctx.emit({
      type: "STATE",
      stream: "events",
      cursor: nextEventsState,
    });
  }

  await emitDetailCoverage(ctx, {
    stream: "events",
    stateStream: "events",
    requiredKeys: requiredCalendarIds,
    hydratedKeys: coveredCalendarIds,
    considered: requiredCalendarIds.length,
    covered: coveredCalendarIds.length,
  });
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "google_calendar",
    validateRecord,
    retryablePattern: /429|5\d\d|timeout|temporar|rate|unavailable|google_calendar_api_error/i,
    isTombstone: (stream, data) => stream === "events" && data.deleted === true,
    auth: {
      kind: "env",
      required: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", REFRESH_TOKEN_ENV_VAR],
    },
    collect: (ctx) => collectGoogleCalendar(ctx),
  });
}
