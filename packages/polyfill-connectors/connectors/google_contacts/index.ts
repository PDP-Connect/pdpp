#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Google Contacts Connector (v0.1.0)
 *
 * Official People API v1 (OAuth2, `contacts.readonly` scope). Reuses the
 * shared Google OAuth refresh primitive (src/google-oauth.ts) — its second
 * concrete consumer alongside Google Calendar, per the reconciliation
 * report's §14 rule that the primitive extracts only once two consumers
 * exist.
 *
 * Streams: people, contact_groups.
 *
 * Incremental mechanism: `syncToken` (the real, LIVE People API mechanism —
 * NOT the dead Contacts API v3's `updated-min`). Deletion is in-band via
 * `PersonMetadata.deleted: true`. Google documents sync tokens as expiring 7
 * days after the full sync that produced them, so this connector tracks the
 * token's age explicitly and forces a full resync BEFORE that boundary,
 * defense-in-depth alongside the reactive HTTP 410 handler (Calendar's
 * syncToken expiry is unconfirmed to have the same fixed window, so it relies
 * on 410 alone; Contacts' 7-day window is confirmed, so a proactive check is
 * warranted here) — mirroring YNAB's existing incremental-fallback shape.
 *
 * State shape:
 *   {
 *     people: { sync_token?: string, synced_at?: string, fingerprints: { [resourceName]: sha1 } },
 *     contact_groups: { fingerprints: { [resourceName]: sha1 } }
 *   }
 *
 * Auth: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET (shared Google app
 * registration) + GOOGLE_CONTACTS_REFRESH_TOKEN (this connector's own consent
 * grant, distinct from Calendar's).
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
import { google_contactsPacingProfile } from "../../src/provider-profile.ts";
import type { ConnectionsPage, ContactGroup, Person } from "./api.ts";
import { GooglePeopleClient, PeopleSyncTokenExpiredError } from "./api.ts";
import { validateRecord } from "./schemas.ts";

const REFRESH_TOKEN_ENV_VAR = "GOOGLE_CONTACTS_REFRESH_TOKEN";
const MAX_PAGES = 500;
/** Google documents syncToken validity as 7 days from the full sync that
 *  produced it (reconciliation report §5). Force a resync one day early so a
 *  run landing exactly on day 7 does not race the boundary. */
const SYNC_TOKEN_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;

const httpGovernor = createConnectorHttpGovernor({
  name: "google_contacts",
  maxAttempts: 1,
  profile: google_contactsPacingProfile(),
});

/** See the matching comment in connectors/google_calendar/index.ts: the HTTP
 *  governor wraps a first-attempt throw in RetryExhaustedError. */
function isSyncTokenExpired(error: unknown): boolean {
  if (error instanceof PeopleSyncTokenExpiredError) {
    return true;
  }
  return (
    error instanceof Error &&
    "originalCause" in error &&
    (error as { originalCause?: unknown }).originalCause instanceof PeopleSyncTokenExpiredError
  );
}

interface PeopleState {
  readonly fingerprints?: Record<string, string>;
  readonly sync_token?: string;
  readonly synced_at?: string;
}

interface GoogleContactsState {
  readonly contact_groups?: { fingerprints?: Record<string, string> };
  readonly people?: PeopleState;
}

function displayName(person: Person): string | null {
  return person.names[0]?.displayName ?? null;
}

function personRecord(person: Person): RecordData {
  return {
    id: person.resourceName,
    resource_name: person.resourceName,
    deleted: person.deleted,
    display_name: displayName(person),
    names: person.names.map((n) => ({
      display_name: n.displayName,
      family_name: n.familyName,
      given_name: n.givenName,
    })),
    email_addresses: person.emailAddresses.map((e) => ({ type: e.type, value: e.value })),
    phone_numbers: person.phoneNumbers.map((p) => ({ type: p.type, value: p.value })),
    addresses: person.addresses.map((a) => ({ city: a.city, formatted_value: a.formattedValue, type: a.type })),
    organizations: person.organizations.map((o) => ({ name: o.name, title: o.title })),
    biography: person.biography,
    nickname: person.nickname,
    photo_url: person.photoUrl,
    contact_group_resource_names: person.memberships,
    updated: person.updated,
    source: "google_people_api",
  };
}

function contactGroupRecord(group: ContactGroup): RecordData {
  return {
    id: group.resourceName,
    resource_name: group.resourceName,
    name: group.name,
    member_count: group.memberCount,
    source: "google_people_api",
  };
}

/** `updated` is Google's server-side write timestamp on the person's most
 *  recent source; like Calendar's event `updated`, it can move without a
 *  human-visible content change, so it is excluded from the change signal. */
const PERSON_FINGERPRINT_EXCLUDE = ["updated"] as const;

function syncTokenIsStale(state: PeopleState | undefined, now: () => number): boolean {
  if (!(state?.sync_token && state.synced_at)) {
    return false;
  }
  const syncedAtMs = Date.parse(state.synced_at);
  if (Number.isNaN(syncedAtMs)) {
    return false;
  }
  return now() - syncedAtMs >= SYNC_TOKEN_MAX_AGE_MS;
}

interface PeopleClientLike {
  listConnectionsPage: (options: { pageToken?: string; syncToken?: string }) => Promise<ConnectionsPage>;
  listContactGroups: () => Promise<ContactGroup[]>;
}

interface SyncPeopleResult {
  readonly fullResync: boolean;
  readonly nextSyncToken: string | null;
}

async function syncPeoplePages(args: {
  readonly client: PeopleClientLike;
  readonly ctx: CollectContext;
  readonly cursor: FingerprintCursor;
  readonly syncToken: string | undefined;
}): Promise<SyncPeopleResult> {
  const { client, ctx, cursor, syncToken } = args;
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;
  let pages = 0;
  do {
    const page = await httpGovernor.request(
      () => client.listConnectionsPage({ ...(syncToken ? { syncToken } : {}), ...(pageToken ? { pageToken } : {}) }),
      (value) => ({ status: 200, value })
    );
    pages += 1;
    await ctx.progress(`Fetched Google Contacts connections page ${String(pages)}`, {
      stream: "people",
      count: page.value.people.length,
    });
    for (const person of page.value.people) {
      const record = personRecord(person);
      if (cursor.shouldEmit(record)) {
        await ctx.emitRecord("people", record);
      }
    }
    pageToken = page.value.nextPageToken ?? undefined;
    nextSyncToken = page.value.nextSyncToken ?? nextSyncToken;
  } while (pageToken && pages < MAX_PAGES);
  return { fullResync: !syncToken, nextSyncToken };
}

async function syncPeopleWithFallback(args: {
  readonly client: PeopleClientLike;
  readonly ctx: CollectContext;
  readonly cursor: FingerprintCursor;
  readonly priorState: PeopleState | undefined;
  readonly now: () => number;
}): Promise<SyncPeopleResult> {
  const { client, ctx, cursor, priorState, now } = args;
  const tokenIsStale = syncTokenIsStale(priorState, now);
  const syncToken = tokenIsStale ? undefined : priorState?.sync_token;
  if (tokenIsStale) {
    await ctx.progress("Google Contacts syncToken is past its 7-day validity window — forcing full resync", {
      stream: "people",
    });
  }
  try {
    return await syncPeoplePages({ client, ctx, cursor, syncToken });
  } catch (error) {
    if (!isSyncTokenExpired(error)) {
      throw error;
    }
    await ctx.progress("Google Contacts syncToken rejected by the API (410) — falling back to full resync", {
      stream: "people",
    });
    return await syncPeoplePages({ client, ctx, cursor, syncToken: undefined });
  }
}

interface ContactsCollectOptions {
  readonly clientFactory?: (accessToken: string) => PeopleClientLike;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly getAccessToken?: () => Promise<GoogleAccessToken>;
  readonly now?: () => number;
}

export async function collectGoogleContacts(ctx: CollectContext, options: ContactsCollectOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const getAccessToken =
    options.getAccessToken ??
    (async (): Promise<GoogleAccessToken> => {
      const credentials = resolveGoogleOAuthCredentials(env, REFRESH_TOKEN_ENV_VAR);
      try {
        return await refreshGoogleAccessToken(credentials);
      } catch (error) {
        if (isGoogleOAuthGrantInvalid(error)) {
          throw new Error("google_contacts_auth_failed", { cause: error });
        }
        throw error;
      }
    });

  const wantsPeople = ctx.requested.has("people");
  const wantsGroups = ctx.requested.has("contact_groups");
  if (!(wantsPeople || wantsGroups)) {
    await ctx.progress("No Google Contacts streams requested", { stream: "people" });
    return;
  }

  const { accessToken } = await getAccessToken();
  const client = options.clientFactory ? options.clientFactory(accessToken) : new GooglePeopleClient({ accessToken });
  const state = (ctx.state as GoogleContactsState) ?? {};

  if (wantsGroups) {
    const groups = await httpGovernor.request(
      () => client.listContactGroups(),
      (value) => ({ status: 200, value })
    );
    const groupsCursor = openFingerprintCursor(state.contact_groups);
    for (const group of groups.value) {
      const record = contactGroupRecord(group);
      if (groupsCursor.shouldEmit(record)) {
        await ctx.emitRecord("contact_groups", record);
      }
    }
    groupsCursor.pruneStale();
    await ctx.emit({ type: "STATE", stream: "contact_groups", cursor: { fingerprints: groupsCursor.toState() } });
  }

  if (!wantsPeople) {
    return;
  }

  const peopleCursor = openFingerprintCursor(state.people, { excludeFromFingerprint: [...PERSON_FINGERPRINT_EXCLUDE] });
  const result = await syncPeopleWithFallback({ client, ctx, cursor: peopleCursor, priorState: state.people, now });
  // A syncToken response is a PARTIAL delta; only a full resync (no
  // syncToken, or the fallback path) may prune stale fingerprints — matching
  // the Calendar connector's identical rule.
  if (result.fullResync) {
    peopleCursor.pruneStale();
  }
  const nextPeopleState: PeopleState = {
    ...(result.nextSyncToken ? { sync_token: result.nextSyncToken, synced_at: new Date(now()).toISOString() } : {}),
    fingerprints: peopleCursor.toState(),
  };
  await ctx.emit({ type: "STATE", stream: "people", cursor: nextPeopleState });

  await emitDetailCoverage(ctx, {
    stream: "people",
    stateStream: "people",
    requiredKeys: [],
    hydratedKeys: [],
    considered: peopleCursor.size(),
    covered: peopleCursor.size(),
  });
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "google_contacts",
    validateRecord,
    retryablePattern: /429|5\d\d|timeout|temporar|rate|unavailable|google_people_api_error/i,
    isTombstone: (stream, data) => stream === "people" && data.deleted === true,
    auth: {
      kind: "env",
      required: ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", REFRESH_TOKEN_ENV_VAR],
    },
    collect: (ctx) => collectGoogleContacts(ctx),
  });
}
