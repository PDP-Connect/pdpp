#!/usr/bin/env node

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * PDPP Apple Contacts Connector (v0.1.0)
 *
 * Polyfills iCloud/Apple Contacts via CardDAV (RFC 6352) using standards-first
 * RFC 6764/5785 service discovery from an owner-entered account/server
 * origin — NOT a hardcoded `contacts.icloud.com` hostname. See
 * connector-primary-reconcile-0807.md §4 for the authority this is built
 * against:
 *
 *   - App-specific-password auth for Contacts IS Apple-documented
 *     (support.apple.com/en-us/102654, /121539).
 *   - The exact CardDAV hostname/wire operations are NOT Apple-documented.
 *     Discovery (`.well-known/carddav` + redirect resolution) is the
 *     mechanism actively-maintained third-party clients (DAVx5) use for
 *     this reason — labeled THIRD-PARTY-CORROBORATED, not Apple-official.
 *   - Whether the resolved server honors RFC 6578 `sync-collection` is
 *     UNVERIFIABLE without a live probe. This connector probes capability
 *     every run rather than assuming either way; when unsupported it falls
 *     back to a bounded full snapshot gated by a per-record fingerprint
 *     cursor (fingerprint-cursor.ts), the same primitive YNAB/Slack/Gmail
 *     use for full-rescan sources.
 *   - Tombstones are only emitted when the server actually reports a
 *     deletion (sync-collection 404 response, or absence from a full
 *     rescan whose cursor pruning proves the prior id vanished at the
 *     source) — never fabricated.
 *
 * Auth: APPLE_ID (account email) + APPLE_APP_SPECIFIC_PASSWORD, HTTP Basic.
 * Credentials are never logged; vCard bodies are never logged (PROGRESS
 * messages carry only counts/booleans, never contact field values).
 *
 * Streams: address_books, contacts, contact_groups (from vCard CATEGORIES —
 * groups-as-separate-collections are not modeled because CardDAV's group
 * mechanism is server-specific and unconfirmed for iCloud; CATEGORIES is
 * the RFC 6350-standard field every server honors).
 */

import {
  createConnectorFailure,
  emitDetailCoverage,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { isMainModule } from "../../src/is-main-module.ts";
import { addressbookQueryAll, listAddressBooks, syncCollectionReport, type VCardResource } from "./carddav-client.ts";
import {
  CardDavDiscoveryError,
  CardDavRedirectOriginError,
  type DiscoveryFetch,
  discoverCardDav,
  nativeFetchAdapter,
} from "./discovery.ts";
import { validateRecord } from "./schemas.ts";
import { categoriesOf, type ParsedVCard, parseVCards } from "./vcard.ts";

/**
 * Stable, machine-actionable failure classes for this connector's terminal
 * errors. Each maps to a fixed `error.code` on DONE — a typed, non-secret
 * channel the runtime carries verbatim onto `connector_error_code` (see
 * connector-gap-bounding.ts's `boundConnectorErrorCode`), separate from and
 * never a substitute for the free-form, redacted `error.message` text. A
 * code here is attached only by explicit `instanceof`/branch dispatch on a
 * KNOWN failure site below — never derived by pattern-matching an arbitrary
 * caught error's message, which would reintroduce the exact class of bug
 * this taxonomy exists to avoid (a connector-authored string driving what
 * downstream treats as a trusted machine code).
 */
const APPLE_CONTACTS_ERROR_CODE = {
  AUTH_FAILED: "auth_failed",
  CARDDAV_REQUEST_FAILED: "carddav_request_failed",
  DISCOVERY_FAILED: "discovery_failed",
  UNSAFE_REDIRECT_REFUSED: "unsafe_redirect_refused",
} as const;

// discoverCardDav's PROPFIND step (carddav_discovery_propfind_failed) is the
// one CardDavDiscoveryError this connector has always treated as transient
// (an HTTP-status-shaped mid-discovery failure, unlike the structural ones —
// missing redirect location, too-many-redirects, oversized response, no
// current-user-principal, no addressbook-home-set — none of which the
// original retryablePattern matched either). This prefix drives ONLY the
// `retryable` boolean below, never the `code` value (code is always the
// fixed DISCOVERY_FAILED literal via instanceof dispatch) — and the prefix
// itself is a first-party literal this module's own discovery.ts throws
// verbatim, not text a remote server or credential can influence, so this
// is not the "derive code from arbitrary thrown text" pattern being
// avoided elsewhere. Preserved so retry behavior is unchanged by moving
// from string-pattern classification to typed-code classification.
const DISCOVERY_PROPFIND_FAILED_PREFIX = "carddav_discovery_propfind_failed:";

/**
 * Classify a caught discovery-phase error into a typed connector failure.
 * `instanceof` dispatch on the two typed error classes discovery.ts throws
 * (never string-matching an arbitrary caught error's message) plus the one
 * carddav_auth_rejected sentinel discoverCardDav documents as its stable
 * auth-rejection signal.
 */
function classifyDiscoveryFailure(err: unknown): Error {
  if (err instanceof CardDavRedirectOriginError) {
    return createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.UNSAFE_REDIRECT_REFUSED, err.message, { cause: err });
  }
  if (err instanceof CardDavDiscoveryError) {
    if (err.message === "carddav_auth_rejected") {
      return createConnectorFailure(
        APPLE_CONTACTS_ERROR_CODE.AUTH_FAILED,
        "Apple ID or app-specific password was rejected",
        {
          cause: err,
        }
      );
    }
    return createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.DISCOVERY_FAILED, err.message, {
      cause: err,
      retryable: err.message.startsWith(DISCOVERY_PROPFIND_FAILED_PREFIX),
    });
  }
  return err instanceof Error ? err : new Error(String(err));
}

const DEFAULT_ORIGIN = "https://contacts.icloud.com";
const TRAILING_SLASHES_RE = /\/+$/;

function buildAuthHeader(accountEmail: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${accountEmail}:${appPassword}`).toString("base64")}`;
}

function addressBookId(url: string): string {
  return url.replace(TRAILING_SLASHES_RE, "");
}

function contactId(bookUrl: string, href: string): string {
  return `${addressBookId(bookUrl)}::${href}`;
}

/** vCard field id for CATEGORIES-derived group membership. Deterministic
 *  per (addressbook, group name) so re-emitting the same group is a no-op
 *  under the fingerprint cursor. */
function groupId(bookUrl: string, groupName: string): string {
  return `${addressBookId(bookUrl)}::group::${groupName}`;
}

export function addressBookRecord(book: { url: string; displayName?: string }, supportsSync: boolean): RecordData {
  return {
    id: addressBookId(book.url),
    display_name: book.displayName ?? null,
    url: book.url,
    supports_sync_collection: supportsSync,
    deleted: false,
  };
}

export function contactRecord(bookUrl: string, resource: VCardResource, card: ParsedVCard): RecordData {
  return {
    id: contactId(bookUrl, resource.href),
    addressbook_url: bookUrl,
    uid: card.uid ?? null,
    display_name: card.fn ?? null,
    family_name: card.familyName ?? null,
    given_name: card.givenName ?? null,
    org: card.org ?? null,
    title: card.title ?? null,
    note: card.note ?? null,
    birthday: card.birthday ?? null,
    emails: card.emails,
    phones: card.phones,
    addresses: card.addresses.map((a) => ({
      types: a.types,
      value: a.value,
      po_box: a.poBox ?? null,
      extended: a.extended ?? null,
      street: a.street ?? null,
      city: a.city ?? null,
      region: a.region ?? null,
      postal_code: a.postalCode ?? null,
      country: a.country ?? null,
    })),
    has_photo: Boolean(card.photo),
    photo_media_type: card.photo?.mediaType ?? null,
    photo_base64: card.photo?.base64 ?? null,
    etag: resource.etag ?? null,
    rev: card.rev ?? null,
    deleted: false,
  };
}

export function contactTombstone(bookUrl: string, href: string): RecordData {
  return { id: contactId(bookUrl, href), deleted: true };
}

export function groupRecord(bookUrl: string, name: string, memberUids: string[]): RecordData {
  return {
    id: groupId(bookUrl, name),
    addressbook_url: bookUrl,
    name,
    member_uids: memberUids,
    deleted: false,
  };
}

/** Derive group-membership records from every contact's CATEGORIES field.
 *  This is CardDAV/vCard-standard (RFC 6350 §6.7.1), unlike Apple's
 *  proprietary group-vCard mechanism, which is unconfirmed for iCloud. */
export function deriveGroups(bookUrl: string, cards: ReadonlyArray<{ card: ParsedVCard; uid: string }>): RecordData[] {
  const membersByGroup = new Map<string, string[]>();
  for (const { card, uid } of cards) {
    for (const category of categoriesOf(card)) {
      const members = membersByGroup.get(category) ?? [];
      members.push(uid);
      membersByGroup.set(category, members);
    }
  }
  return [...membersByGroup.entries()].map(([name, members]) => groupRecord(bookUrl, name, members));
}

interface AddressBookCollectionCtx {
  authHeader: string;
  book: { url: string; displayName?: string };
  bookCursor: FingerprintCursor;
  emit: (msg: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  fetchImpl: DiscoveryFetch;
  newState: Record<string, unknown>;
  progress: (message: string, extra?: { count?: number; stream?: string; total?: number }) => Promise<void>;
  requested: Map<string, unknown>;
  state: Record<string, unknown>;
  trustedOrigins: string[];
}

/** Probe sync-collection support and resolve the working SyncCollectionResult
 *  for this run, retrying once as an initial sync when the server signals
 *  the prior token is stale (507, or an empty resync directive). */
async function resolveSyncResult(args: {
  authHeader: string;
  bookUrl: string;
  fetchImpl: DiscoveryFetch;
  priorSyncToken: string | undefined;
  trustedOrigins: string[];
}): Promise<Awaited<ReturnType<typeof syncCollectionReport>>> {
  const { bookUrl, authHeader, fetchImpl, trustedOrigins, priorSyncToken } = args;
  const first = await syncCollectionReport({
    bookUrl,
    authHeader,
    fetchImpl,
    trustedOrigins,
    priorSyncToken: priorSyncToken ?? "",
  });
  if (first.supportsSyncCollection && first.syncToken === "" && priorSyncToken) {
    return await syncCollectionReport({ bookUrl, authHeader, fetchImpl, trustedOrigins, priorSyncToken: "" });
  }
  return first;
}

/** Emit the address_books entity record for this book, when requested,
 *  gated by the shared fingerprint cursor. Returns whether the stream was
 *  in scope (the coverage-counter contribution), independent of whether the
 *  fingerprint gate suppressed the emit as unchanged. */
async function emitAddressBookRecordIfRequested(args: {
  book: { url: string; displayName?: string };
  bookCursor: FingerprintCursor;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, unknown>;
  supportsSync: boolean;
}): Promise<boolean> {
  const { book, bookCursor, emitRecord, requested, supportsSync } = args;
  if (!requested.has("address_books")) {
    return false;
  }
  const bookRecord = addressBookRecord(book, supportsSync);
  if (bookCursor.shouldEmit(bookRecord)) {
    await emitRecord("address_books", bookRecord);
  }
  return true;
}

/**
 * Collect one address book: probe sync capability, fetch (sync-collection or
 * bounded full snapshot), emit the address-book entity record plus contact +
 * group records, and advance this book's contacts-stream cursor. Extracted
 * from collect() to keep the top-level function's branching bounded — this
 * is the whole per-book unit of work in one place.
 */
async function collectAddressBook(
  ctx: AddressBookCollectionCtx
): Promise<{ contactsConsidered: number; covered: boolean; groupsEmitted: number }> {
  const {
    book,
    bookCursor,
    authHeader,
    fetchImpl,
    trustedOrigins,
    state,
    newState,
    requested,
    emit,
    emitRecord,
    progress,
  } = ctx;
  const bookKey = addressBookId(book.url);
  const priorSync = (
    state.contacts as Record<string, { sync_token?: string; fingerprints?: Record<string, string> }>
  )?.[bookKey];

  await progress("Probing sync capability", { stream: "contacts" });
  const syncResult = await resolveSyncResult({
    bookUrl: book.url,
    authHeader,
    fetchImpl,
    trustedOrigins,
    priorSyncToken: priorSync?.sync_token,
  }).catch((err: unknown) => {
    // resolveSyncResult only ever throws carddav_sync_collection_failed
    // (an HTTP-status-shaped failure) — retryable, matching the original
    // string-pattern behavior this classification replaces.
    const message = err instanceof Error ? err.message : String(err);
    throw createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.CARDDAV_REQUEST_FAILED, message, {
      cause: err,
      retryable: true,
    });
  });

  const supportsSync = syncResult.supportsSyncCollection;
  const bookCovered = await emitAddressBookRecordIfRequested({ book, bookCursor, requested, emitRecord, supportsSync });

  const fingerprintState =
    (state.contacts as Record<string, { fingerprints?: Record<string, string> }>)?.[bookKey] ?? {};
  const entityCursor = openFingerprintCursor(fingerprintState);
  const seenCards: Array<{ card: ParsedVCard; uid: string }> = [];
  let contactCount = 0;

  const emitContactRecord = async (resource: VCardResource): Promise<void> => {
    const [card] = parseVCards(resource.vcardText);
    if (!card) {
      return;
    }
    const record = contactRecord(book.url, resource, card);
    if (requested.has("contacts") && entityCursor.shouldEmit(record)) {
      await emitRecord("contacts", record);
    }
    contactCount += 1;
    seenCards.push({ card, uid: String(record.id) });
  };

  if (supportsSync) {
    for (const resource of syncResult.resources) {
      await emitContactRecord(resource);
    }
    for (const deletedHref of syncResult.deletedHrefs) {
      if (requested.has("contacts")) {
        await emitRecord("contacts", contactTombstone(book.url, deletedHref));
      }
    }
    await progress("Synced address book via sync-collection", {
      stream: "contacts",
      count: contactCount,
      total: contactCount,
    });
  } else {
    // addressbookQueryAll only ever throws carddav_addressbook_query_failed
    // (an HTTP-status-shaped failure) — retryable, matching the original
    // string-pattern behavior this classification replaces.
    const resources = await addressbookQueryAll({ bookUrl: book.url, authHeader, fetchImpl, trustedOrigins }).catch(
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.CARDDAV_REQUEST_FAILED, message, {
          cause: err,
          retryable: true,
        });
      }
    );
    for (const resource of resources) {
      await emitContactRecord(resource);
    }
    // Full-scan source: prune ids the server no longer returns so a real
    // deletion tombstones instead of silently no-opping forever.
    entityCursor.pruneStale();
    await progress("Synced address book via bounded full snapshot", {
      stream: "contacts",
      count: contactCount,
      total: contactCount,
    });
  }

  let groupsEmitted = 0;
  if (requested.has("contact_groups")) {
    for (const group of deriveGroups(book.url, seenCards)) {
      await emitRecord("contact_groups", group);
      groupsEmitted += 1;
    }
  }

  const contactsState =
    (newState.contacts as Record<string, { sync_token?: string; fingerprints?: Record<string, string> }>) ?? {};
  contactsState[bookKey] = {
    fingerprints: entityCursor.toState(),
    ...(supportsSync && syncResult.syncToken ? { sync_token: syncResult.syncToken } : {}),
  };
  newState.contacts = contactsState;
  await emit({ type: "STATE", stream: "contacts", cursor: newState.contacts });

  // Every enumerated resource is accounted for here regardless of whether the
  // fingerprint cursor suppressed its RECORD emit as unchanged (contactCount
  // increments unconditionally in emitContactRecord, above the shouldEmit
  // gate) — the same considered===covered "proven empty" contract
  // buildFullScanCoverageMessage documents. A genuinely empty address book
  // (contactCount === 0) still proves its own completion this way, rather
  // than reading as `unknown` coverage with no way to distinguish "verified
  // zero contacts" from "never actually enumerated."
  return { contactsConsidered: contactCount, covered: bookCovered, groupsEmitted };
}

if (isMainModule(import.meta.url)) {
  runConnector({
    name: "apple_contacts",
    // Every carddav_*_failed throw site below now goes through
    // createConnectorFailure, which sets its own explicit `retryable` bit
    // (see classifyDiscoveryFailure and the two per-call .catch sites) and
    // is a TerminalError — the runtime's outer catch honors that bit
    // directly and never consults retryablePattern for a TerminalError.
    // This pattern is the fallback for genuinely unclassified throws only
    // (a raw network error from an unwrapped call site, or a bug).
    retryablePattern: /ECONN|ETIMEDOUT|fetch failed/i,
    isTombstone: (_stream, d) => d.deleted === true,
    validateRecord,
    auth: {
      kind: "env",
      required: [["APPLE_ID", "APPLE_ID_EMAIL"], "APPLE_APP_SPECIFIC_PASSWORD"],
    },
    async collect({ state, requested, credentials, emit, emitRecord, progress }) {
      const accountEmail = credentials.APPLE_ID || credentials.APPLE_ID_EMAIL;
      const appPassword = credentials.APPLE_APP_SPECIFIC_PASSWORD;
      if (!(accountEmail && appPassword)) {
        throw createConnectorFailure(
          APPLE_CONTACTS_ERROR_CODE.AUTH_FAILED,
          "APPLE_ID and APPLE_APP_SPECIFIC_PASSWORD credentials were not provided"
        );
      }
      const originUrl = process.env.APPLE_CARDDAV_ORIGIN || DEFAULT_ORIGIN;
      const authHeader = buildAuthHeader(accountEmail, appPassword);
      const fetchImpl = nativeFetchAdapter;

      await progress("Discovering CardDAV service", { stream: "address_books" });
      const discovery = await discoverCardDav({ originUrl, authHeader, fetchImpl }).catch((err: unknown) => {
        throw classifyDiscoveryFailure(err);
      });
      const trustedOrigins = [...new Set(discovery.visitedOrigins)];

      // listAddressBooks only ever throws carddav_list_addressbooks_failed —
      // NOT retryable, matching the original string-pattern behavior (that
      // pattern never matched this message, unlike the sibling sync/query
      // failures below) this classification replaces.
      const books = await listAddressBooks({
        homeUrl: discovery.addressBookHomeUrl,
        authHeader,
        fetchImpl,
        trustedOrigins,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        throw createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.CARDDAV_REQUEST_FAILED, message, { cause: err });
      });
      await progress("Discovered address books", {
        stream: "address_books",
        count: books.length,
        total: books.length,
      });

      const newState: Record<string, unknown> = JSON.parse(JSON.stringify(state));
      const priorBookState = (state.address_books as Record<string, { fingerprints?: Record<string, string> }>) ?? {};
      const bookCursor: FingerprintCursor = openFingerprintCursor({ fingerprints: priorBookState.fingerprints });

      let considered = 0;
      let covered = 0;
      let groupsConsidered = 0;
      let groupsCovered = 0;
      let contactsConsidered = 0;

      for (const book of books) {
        considered += 1;
        const {
          contactsConsidered: bookContactsConsidered,
          covered: bookCovered,
          groupsEmitted,
        } = await collectAddressBook({
          book,
          bookCursor,
          authHeader,
          fetchImpl,
          trustedOrigins,
          state,
          newState,
          requested,
          emit,
          emitRecord,
          progress,
        });
        if (bookCovered) {
          covered += 1;
        }
        // deriveGroups has no drop/filter path: every derived group is
        // unconditionally emitted, so considered === covered === the exact
        // count emitted for this book (including a genuine zero-group book).
        groupsConsidered += groupsEmitted;
        groupsCovered += groupsEmitted;
        contactsConsidered += bookContactsConsidered;
      }

      if (requested.has("contacts")) {
        // Every enumerated contact is accounted for (emitted, or suppressed
        // as unchanged by the fingerprint cursor) — considered === covered,
        // including the genuine-zero-contacts case, per the same
        // proven-empty contract contact_groups already uses below.
        await emitDetailCoverage(
          { emit },
          {
            stream: "contacts",
            stateStream: "contacts",
            requiredKeys: [],
            hydratedKeys: [],
            considered: contactsConsidered,
            covered: contactsConsidered,
          }
        );
      }

      if (requested.has("contact_groups")) {
        await emitDetailCoverage(
          { emit },
          {
            stream: "contact_groups",
            stateStream: "contact_groups",
            requiredKeys: [],
            hydratedKeys: [],
            considered: groupsConsidered,
            covered: groupsCovered,
          }
        );
      }

      if (requested.has("address_books")) {
        bookCursor.pruneStale();
        newState.address_books = { fingerprints: bookCursor.toState(), fetched_at: nowIso() };
        await emit({ type: "STATE", stream: "address_books", cursor: newState.address_books });
        await emitDetailCoverage(
          { emit },
          {
            stream: "address_books",
            stateStream: "address_books",
            requiredKeys: [],
            hydratedKeys: [],
            considered,
            covered,
          }
        );
      }
    },
  });
}
