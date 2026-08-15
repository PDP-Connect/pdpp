// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Google Calendar API v3 client.
 *
 * Scope confirmed against the reconciliation report (§1): `calendarList`
 * (calendars the user can see) and `events` (per-calendar, syncToken
 * incremental). No blob path exists — attachments are external `fileUrl`
 * references, never fetched here. `Event.status: "cancelled"` deletion
 * semantics are PLAUSIBLE per the sync guide but not independently confirmed
 * against the schema page — the connector treats a `cancelled` status as a
 * tombstone (the well-documented enum meaning) without asserting Google
 * guarantees it in every deletion path; a syncToken response's "deleted
 * entries always surface" guarantee is what's actually confirmed and is the
 * property this client relies on.
 *
 * Docs: https://developers.google.com/calendar/api/guides/sync
 *       https://developers.google.com/calendar/api/v3/reference/events/list
 */

const DEFAULT_BASE_URL = "https://www.googleapis.com/calendar/v3";
const EVENTS_PAGE_SIZE = 250;
const TRAILING_SLASHES = /\/+$/;

export type CalendarFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CalendarClientOptions {
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly fetch?: CalendarFetch;
}

export class CalendarApiError extends Error {
  readonly bodySnippet: string;
  readonly status: number;
  constructor(status: number, bodySnippet: string) {
    super(`google_calendar_api_error: ${status}`);
    this.name = "CalendarApiError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/** Thrown when Google reports the syncToken is no longer valid (HTTP 410 GONE).
 *  Per the sync guide this requires the caller to discard the token and do a
 *  full resync. */
export class CalendarSyncTokenExpiredError extends Error {
  constructor() {
    super("google_calendar_sync_token_expired");
    this.name = "CalendarSyncTokenExpiredError";
  }
}

export interface CalendarListEntry {
  readonly accessRole: string | null;
  readonly id: string;
  readonly primary: boolean;
  readonly summary: string | null;
  readonly timeZone: string | null;
}

export interface CalendarEventAttendee {
  readonly displayName: string | null;
  readonly email: string | null;
  readonly optional: boolean;
  readonly organizer: boolean;
  readonly responseStatus: string | null;
  readonly self: boolean;
}

export interface CalendarEventDateTime {
  readonly date: string | null;
  readonly dateTime: string | null;
  readonly timeZone: string | null;
}

export interface CalendarEvent {
  readonly attendees: readonly CalendarEventAttendee[];
  readonly description: string | null;
  readonly end: CalendarEventDateTime | null;
  readonly htmlLink: string | null;
  readonly id: string;
  readonly location: string | null;
  readonly organizer: { email: string | null; displayName: string | null } | null;
  readonly recurrence: readonly string[] | null;
  readonly recurringEventId: string | null;
  readonly start: CalendarEventDateTime | null;
  readonly status: string;
  readonly summary: string | null;
  readonly updated: string | null;
}

export interface EventsPage {
  readonly events: readonly CalendarEvent[];
  readonly nextPageToken: string | null;
  readonly nextSyncToken: string | null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBool(value: unknown): boolean {
  return value === true;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toDateTime(value: unknown): CalendarEventDateTime | null {
  const obj = asObject(value);
  if (Object.keys(obj).length === 0) {
    return null;
  }
  return {
    date: asString(obj.date),
    dateTime: asString(obj.dateTime),
    timeZone: asString(obj.timeZone),
  };
}

function toAttendee(value: unknown): CalendarEventAttendee {
  const obj = asObject(value);
  return {
    email: asString(obj.email),
    displayName: asString(obj.displayName),
    organizer: asBool(obj.organizer),
    optional: asBool(obj.optional),
    responseStatus: asString(obj.responseStatus),
    self: asBool(obj.self),
  };
}

function toEvent(value: unknown): CalendarEvent | null {
  const obj = asObject(value);
  const id = asString(obj.id);
  if (!id) {
    return null;
  }
  const organizerObj = asObject(obj.organizer);
  const recurrence = asArray(obj.recurrence).filter((item): item is string => typeof item === "string");
  return {
    attendees: asArray(obj.attendees).map(toAttendee),
    description: asString(obj.description),
    end: toDateTime(obj.end),
    htmlLink: asString(obj.htmlLink),
    id,
    location: asString(obj.location),
    organizer:
      Object.keys(organizerObj).length > 0
        ? { email: asString(organizerObj.email), displayName: asString(organizerObj.displayName) }
        : null,
    recurrence: recurrence.length > 0 ? recurrence : null,
    recurringEventId: asString(obj.recurringEventId),
    start: toDateTime(obj.start),
    status: asString(obj.status) ?? "confirmed",
    summary: asString(obj.summary),
    updated: asString(obj.updated),
  };
}

function toCalendarListEntry(value: unknown): CalendarListEntry | null {
  const obj = asObject(value);
  const id = asString(obj.id);
  if (!id) {
    return null;
  }
  return {
    accessRole: asString(obj.accessRole),
    id,
    primary: asBool(obj.primary),
    summary: asString(obj.summary),
    timeZone: asString(obj.timeZone),
  };
}

export class GoogleCalendarClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: CalendarFetch;

  constructor(options: CalendarClientOptions) {
    const trimmed = options.accessToken.trim();
    if (!trimmed) {
      throw new Error("google_calendar_access_token_missing");
    }
    this.accessToken = trimmed;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(TRAILING_SLASHES, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** GET /users/me/calendarList — every calendar the owner can see. Not
   *  incremental; the list is small and re-enumerated each run (the
   *  connector fingerprint-gates emit, not this client). */
  async listCalendars(): Promise<CalendarListEntry[]> {
    const out: CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.baseUrl}/users/me/calendarList`);
      url.searchParams.set("maxResults", "250");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      const body = asObject(await this.request(url));
      for (const item of asArray(body.items)) {
        const entry = toCalendarListEntry(item);
        if (entry) {
          out.push(entry);
        }
      }
      pageToken = asString(body.nextPageToken) ?? undefined;
    } while (pageToken);
    return out;
  }

  /**
   * GET /calendars/{calendarId}/events, one page. `syncToken` requests an
   * incremental delta (deleted events surface with status: "cancelled" per
   * the sync guide); its absence requests a full listing. `pageToken`
   * continues a paginated response within either mode — Google's sync guide
   * documents that `nextSyncToken` only appears on the LAST page, so callers
   * must page fully via `pageToken` before treating a page's absent
   * `nextSyncToken` as "not done yet".
   *
   * Throws `CalendarSyncTokenExpiredError` on HTTP 410 (Gone) — the
   * documented expired/invalid-syncToken signal — so the caller can fall
   * back to a full resync.
   */
  async listEventsPage(
    calendarId: string,
    options: { pageToken?: string; syncToken?: string; timeMin?: string } = {}
  ): Promise<EventsPage> {
    const url = new URL(`${this.baseUrl}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set("maxResults", String(EVENTS_PAGE_SIZE));
    url.searchParams.set("singleEvents", "false");
    if (options.syncToken) {
      url.searchParams.set("syncToken", options.syncToken);
    } else if (options.timeMin) {
      // timeMin is only valid on a full (non-incremental) listing per the API
      // reference — combining it with syncToken is rejected by Google.
      url.searchParams.set("timeMin", options.timeMin);
    }
    if (options.pageToken) {
      url.searchParams.set("pageToken", options.pageToken);
    }
    let body: Record<string, unknown>;
    try {
      body = asObject(await this.request(url));
    } catch (error) {
      if (error instanceof CalendarApiError && error.status === 410) {
        // biome-ignore lint/style/useErrorCause: intentional — this is a typed control-flow signal (expired syncToken), not a diagnostic; the caller matches on `instanceof`, not on wrapped detail
        throw new CalendarSyncTokenExpiredError();
      }
      throw error;
    }
    const events = asArray(body.items)
      .map(toEvent)
      .filter((event): event is CalendarEvent => event !== null);
    return {
      events,
      nextPageToken: asString(body.nextPageToken),
      nextSyncToken: asString(body.nextSyncToken),
    };
  }

  private async request(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new CalendarApiError(response.status, text.slice(0, 500));
    }
    return text ? JSON.parse(text) : {};
  }
}
