// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin Google People API v1 client.
 *
 * Scope confirmed against the reconciliation report (§5): `people.connections.list`
 * (the current, live incremental mechanism — NOT the dead Contacts API v3's
 * `updated-min`) and `contactGroups.list`. Deletion is in-band:
 * `PersonMetadata.deleted === true` when the request carries a `syncToken`.
 * `nextSyncToken` expires 7 days after the full sync that produced it — the
 * connector (not this client) is responsible for treating an expired token as
 * a full-resync trigger, matching the report's explicit callout that this
 * constraint is easy to miss.
 *
 * Photo URLs are time-limited per the report — this client returns the URL
 * as-is; the connector must not persist it across runs as if durable.
 *
 * Docs: https://developers.google.com/people/api/rest/v1/people.connections/list
 *       https://developers.google.com/people/legacy/limits (no static quota table)
 */

const DEFAULT_BASE_URL = "https://people.googleapis.com/v1";
const CONNECTIONS_PAGE_SIZE = 1000;
const TRAILING_SLASHES = /\/+$/;
const PERSON_FIELDS =
  "names,emailAddresses,phoneNumbers,addresses,organizations,biographies,nicknames,birthdays,events,urls,imClients,memberships,photos,metadata";

export type PeopleFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface PeopleClientOptions {
  readonly accessToken: string;
  readonly baseUrl?: string;
  readonly fetch?: PeopleFetch;
}

export class PeopleApiError extends Error {
  readonly bodySnippet: string;
  readonly status: number;
  constructor(status: number, bodySnippet: string) {
    super(`google_people_api_error: ${status}`);
    this.name = "PeopleApiError";
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

/** Thrown when Google reports the syncToken is no longer valid (HTTP 410
 *  GONE) — the documented behavior once a token ages past its 7-day
 *  validity window. */
export class PeopleSyncTokenExpiredError extends Error {
  constructor() {
    super("google_people_sync_token_expired");
    this.name = "PeopleSyncTokenExpiredError";
  }
}

export interface PersonName {
  readonly displayName: string | null;
  readonly familyName: string | null;
  readonly givenName: string | null;
}

export interface PersonEmail {
  readonly type: string | null;
  readonly value: string | null;
}

export interface PersonPhone {
  readonly type: string | null;
  readonly value: string | null;
}

export interface PersonAddress {
  readonly city: string | null;
  readonly formattedValue: string | null;
  readonly type: string | null;
}

export interface PersonOrganization {
  readonly name: string | null;
  readonly title: string | null;
}

export interface Person {
  readonly addresses: readonly PersonAddress[];
  readonly biography: string | null;
  readonly deleted: boolean;
  readonly emailAddresses: readonly PersonEmail[];
  readonly memberships: readonly string[];
  readonly names: readonly PersonName[];
  readonly nickname: string | null;
  readonly organizations: readonly PersonOrganization[];
  readonly phoneNumbers: readonly PersonPhone[];
  readonly photoUrl: string | null;
  readonly resourceName: string;
  readonly updated: string | null;
}

export interface ConnectionsPage {
  readonly nextPageToken: string | null;
  readonly nextSyncToken: string | null;
  readonly people: readonly Person[];
}

export interface ContactGroup {
  readonly memberCount: number;
  readonly name: string | null;
  readonly resourceName: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toName(value: unknown): PersonName {
  const obj = asObject(value);
  return {
    displayName: asString(obj.displayName),
    familyName: asString(obj.familyName),
    givenName: asString(obj.givenName),
  };
}

function toEmail(value: unknown): PersonEmail {
  const obj = asObject(value);
  return { type: asString(obj.type), value: asString(obj.value) };
}

function toPhone(value: unknown): PersonPhone {
  const obj = asObject(value);
  return { type: asString(obj.type), value: asString(obj.value) };
}

function toAddress(value: unknown): PersonAddress {
  const obj = asObject(value);
  return { city: asString(obj.city), formattedValue: asString(obj.formattedValue), type: asString(obj.type) };
}

function toOrganization(value: unknown): PersonOrganization {
  const obj = asObject(value);
  return { name: asString(obj.name), title: asString(obj.title) };
}

function firstPhotoUrl(value: unknown): string | null {
  const first = asObject(asArray(value)[0]);
  return asString(first.url);
}

function firstBiography(value: unknown): string | null {
  const first = asObject(asArray(value)[0]);
  return asString(first.value);
}

function firstNickname(value: unknown): string | null {
  const first = asObject(asArray(value)[0]);
  return asString(first.value);
}

function membershipGroupIds(value: unknown): string[] {
  const out: string[] = [];
  for (const membership of asArray(value)) {
    const obj = asObject(membership);
    const groupMembership = asObject(obj.contactGroupMembership);
    const groupId = asString(groupMembership.contactGroupResourceName);
    if (groupId) {
      out.push(groupId);
    }
  }
  return out;
}

function toPerson(value: unknown): Person | null {
  const obj = asObject(value);
  const metadata = asObject(obj.metadata);
  const resourceName = asString(obj.resourceName);
  if (!resourceName) {
    return null;
  }
  return {
    addresses: asArray(obj.addresses).map(toAddress),
    biography: firstBiography(obj.biographies),
    deleted: metadata.deleted === true,
    emailAddresses: asArray(obj.emailAddresses).map(toEmail),
    memberships: membershipGroupIds(obj.memberships),
    names: asArray(obj.names).map(toName),
    nickname: firstNickname(obj.nicknames),
    organizations: asArray(obj.organizations).map(toOrganization),
    phoneNumbers: asArray(obj.phoneNumbers).map(toPhone),
    photoUrl: firstPhotoUrl(obj.photos),
    resourceName,
    updated: asString(metadata.sources ? asObject(asArray(metadata.sources)[0]).updateTime : null),
  };
}

function toContactGroup(value: unknown): ContactGroup | null {
  const obj = asObject(value);
  const resourceName = asString(obj.resourceName);
  if (!resourceName) {
    return null;
  }
  return {
    memberCount: asNumber(obj.memberCount),
    name: asString(obj.name),
    resourceName,
  };
}

export class GooglePeopleClient {
  private readonly accessToken: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: PeopleFetch;

  constructor(options: PeopleClientOptions) {
    const trimmed = options.accessToken.trim();
    if (!trimmed) {
      throw new Error("google_people_access_token_missing");
    }
    this.accessToken = trimmed;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(TRAILING_SLASHES, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * GET /people/me/connections, one page. `syncToken` requests an
   * incremental delta (deleted contacts surface with `PersonMetadata.deleted:
   * true`); its absence requests a full listing. Throws
   * `PeopleSyncTokenExpiredError` on HTTP 410 — Google's documented signal
   * that the (up-to-7-day-old) syncToken is no longer valid.
   */
  async listConnectionsPage(options: { pageToken?: string; syncToken?: string } = {}): Promise<ConnectionsPage> {
    const url = new URL(`${this.baseUrl}/people/me/connections`);
    url.searchParams.set("pageSize", String(CONNECTIONS_PAGE_SIZE));
    url.searchParams.set("personFields", PERSON_FIELDS);
    if (options.syncToken) {
      url.searchParams.set("syncToken", options.syncToken);
      // requestSyncToken must stay set on every incremental page request too —
      // Google only returns nextSyncToken on the response that carries it.
      url.searchParams.set("requestSyncToken", "true");
    } else {
      url.searchParams.set("requestSyncToken", "true");
    }
    if (options.pageToken) {
      url.searchParams.set("pageToken", options.pageToken);
    }
    let body: Record<string, unknown>;
    try {
      body = asObject(await this.request(url));
    } catch (error) {
      if (error instanceof PeopleApiError && error.status === 410) {
        // biome-ignore lint/style/useErrorCause: intentional — this is a typed control-flow signal (expired syncToken), not a diagnostic; the caller matches on `instanceof`, not on wrapped detail
        throw new PeopleSyncTokenExpiredError();
      }
      throw error;
    }
    const people = asArray(body.connections)
      .map(toPerson)
      .filter((person): person is Person => person !== null);
    return {
      nextPageToken: asString(body.nextPageToken),
      nextSyncToken: asString(body.nextSyncToken),
      people,
    };
  }

  /** GET /contactGroups — the owner's contact groups (labels). Not
   *  incremental; small collection, re-enumerated each run. */
  async listContactGroups(): Promise<ContactGroup[]> {
    const out: ContactGroup[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL(`${this.baseUrl}/contactGroups`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      const body = asObject(await this.request(url));
      for (const item of asArray(body.contactGroups)) {
        const group = toContactGroup(item);
        if (group) {
          out.push(group);
        }
      }
      pageToken = asString(body.nextPageToken) ?? undefined;
    } while (pageToken);
    return out;
  }

  private async request(url: URL): Promise<unknown> {
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    const text = await response.text();
    if (!response.ok) {
      throw new PeopleApiError(response.status, text.slice(0, 500));
    }
    return text ? JSON.parse(text) : {};
  }
}
