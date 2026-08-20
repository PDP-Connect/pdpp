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

import { isMainModule } from "@pdpp/connector-protocol";
import {
  buildFullScanCoverageMessage,
  createConnectorFailure,
  emitDetailCoverage,
  nowIso,
  type RecordData,
  runConnector,
} from "../../src/connector-runtime.ts";
import { type FingerprintCursor, openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import {
  addressbookMultiget,
  addressbookQueryAll,
  CardDavStructuralError,
  listAddressBooks,
  syncCollectionReport,
  type VCardResource,
} from "./carddav-client.ts";
import {
  CardDavDiscoveryError,
  CardDavRedirectOriginError,
  type DiscoveryFetch,
  discoverCardDav,
  nativeFetchAdapter,
} from "./discovery.ts";
import {
  type GroupAnchor,
  groupAnchorVerdict,
  groupMemberUids,
  isGroupVCard,
  partitionVCards,
} from "./group-vcards.ts";
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

/**
 * Classify a caught `davRequest` failure (sync-collection, addressbook-query,
 * or list-addressbooks) into a typed `CARDDAV_REQUEST_FAILED` connector
 * failure. `instanceof CardDavStructuralError` dispatch — never message-text
 * guessing — so a redirect refusal, missing Location, oversized response, or
 * redirect loop is non-retryable at every call site, matching the original
 * `retryablePattern` (which never matched these four structural shapes).
 * Genuinely transient HTTP-status failures (`carddav_sync_collection_failed`,
 * `carddav_addressbook_query_failed`, `carddav_list_addressbooks_failed`)
 * fall through to the caller's own retryable default.
 */
function classifyCardDavRequestFailure(err: unknown, options: { retryableByDefault: boolean }): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof CardDavStructuralError) {
    return createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.CARDDAV_REQUEST_FAILED, message, {
      cause: err,
      retryable: false,
    });
  }
  return createConnectorFailure(APPLE_CONTACTS_ERROR_CODE.CARDDAV_REQUEST_FAILED, message, {
    cause: err,
    retryable: options.retryableByDefault,
  });
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

/**
 * Derive group-membership records from BOTH mechanisms a CardDAV server may
 * use.
 *
 *  1. Apple's group vCards — a resource in the collection carrying
 *     `X-ADDRESSBOOKSERVER-KIND:group` and `X-ADDRESSBOOKSERVER-MEMBER`
 *     lines. This is how iCloud actually stores groups.
 *  2. The vCard-standard `CATEGORIES` property on each contact
 *     (RFC 6350 §6.7.1).
 *
 * Only (2) was previously read. For an iCloud account that meant
 * `contact_groups` — a manifest-REQUIRED stream — could never emit a record
 * no matter how many groups the account had, and the resulting zero was
 * indistinguishable from a genuinely empty address book.
 *
 * A group vCard wins over a same-named CATEGORIES group: the server's own
 * membership list is authoritative over one inferred from contact bodies.
 */
export function deriveGroups(bookUrl: string, cards: ReadonlyArray<{ card: ParsedVCard; uid: string }>): RecordData[] {
  const { contacts, groups } = partitionVCards(cards);

  const membersByGroup = new Map<string, string[]>();
  for (const { card, uid } of contacts) {
    for (const category of categoriesOf(card)) {
      const members = membersByGroup.get(category) ?? [];
      members.push(uid);
      membersByGroup.set(category, members);
    }
  }

  // Apple group vCards are authoritative; they overwrite a CATEGORIES-derived
  // entry of the same name rather than merging into it, so a group's
  // membership is never half server-stated and half inferred.
  for (const { card } of groups) {
    const name = card.fn?.trim();
    if (!name) {
      continue;
    }
    membersByGroup.set(name, groupMemberUids(card));
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
}): Promise<{ result: Awaited<ReturnType<typeof syncCollectionReport>>; fullBoundary: boolean }> {
  const { bookUrl, authHeader, fetchImpl, trustedOrigins, priorSyncToken } = args;
  const first = await syncCollectionReport({
    bookUrl,
    authHeader,
    fetchImpl,
    trustedOrigins,
    priorSyncToken: priorSyncToken ?? "",
  });
  if (first.supportsSyncCollection && first.syncToken === "" && priorSyncToken) {
    return {
      result: await syncCollectionReport({ bookUrl, authHeader, fetchImpl, trustedOrigins, priorSyncToken: "" }),
      fullBoundary: true,
    };
  }
  return { result: first, fullBoundary: priorSyncToken === undefined };
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

async function emitContactGroupsIfRequested(args: {
  bookUrl: string;
  boundaryEstablished: boolean;
  emit: (message: { type: "STATE"; stream: string; cursor: unknown }) => Promise<void>;
  emitRecord: (stream: string, data: RecordData) => Promise<void>;
  requested: Map<string, unknown>;
  seenCards: Array<{ card: ParsedVCard; uid: string }>;
}): Promise<{ emitted: number; anchor: GroupAnchor }> {
  const { bookUrl, boundaryEstablished, emit, emitRecord, requested, seenCards } = args;
  const { contacts, groups } = partitionVCards(seenCards);
  const derivedCategoryGroups = new Set(contacts.flatMap(({ card }) => categoriesOf(card))).size;
  const anchor: GroupAnchor = {
    serverGroupVCards: groups.length,
    derivedCategoryGroups,
    emitted: 0,
    boundaryEstablished,
  };
  if (!(requested.has("contact_groups") && boundaryEstablished)) {
    return { emitted: 0, anchor };
  }

  let groupsEmitted = 0;
  for (const group of deriveGroups(bookUrl, seenCards)) {
    await emitRecord("contact_groups", group);
    groupsEmitted += 1;
  }
  await emit({ type: "STATE", stream: "contact_groups", cursor: { fetched_at: nowIso() } });
  return { emitted: groupsEmitted, anchor: { ...anchor, emitted: groupsEmitted } };
}

/**
 * Fetch and emit vCard bodies for members a sync-collection response
 * enumerated without inlining `address-data` (RFC 6352 §8.7
 * addressbook-multiget). Returns the count of enumerated members whose body
 * the server never handed over, so the caller can keep them in the coverage
 * denominator instead of dropping them.
 */
async function hydrateMissingBodies(args: {
  authHeader: string;
  bookUrl: string;
  emitContactRecord: (resource: VCardResource) => Promise<void>;
  fetchImpl: DiscoveryFetch;
  hrefs: readonly string[];
  progress: (message: string, extra?: { count?: number; stream?: string; total?: number }) => Promise<void>;
  trustedOrigins: string[];
}): Promise<number> {
  const { authHeader, bookUrl, emitContactRecord, fetchImpl, hrefs, progress, trustedOrigins } = args;
  if (hrefs.length === 0) {
    return 0;
  }
  await progress("Fetching contact bodies the sync response did not inline", {
    stream: "contacts",
    count: 0,
    total: hrefs.length,
  });
  const fetched = await addressbookMultiget({ bookUrl, authHeader, fetchImpl, trustedOrigins, hrefs }).catch(
    (err: unknown) => {
      throw classifyCardDavRequestFailure(err, { retryableByDefault: true });
    }
  );
  const fetchedByHref = new Map(fetched.map((resource) => [resource.href, resource]));
  let unfetched = 0;
  for (const href of hrefs) {
    const resource = fetchedByHref.get(href);
    if (resource) {
      await emitContactRecord(resource);
      continue;
    }
    unfetched += 1;
  }
  return unfetched;
}

async function loadFullGroupSnapshot(args: {
  authHeader: string;
  bookUrl: string;
  fetchImpl: DiscoveryFetch;
  trustedOrigins: string[];
}): Promise<{ cards: Array<{ card: ParsedVCard; uid: string }>; complete: boolean }> {
  const { authHeader, bookUrl, fetchImpl, trustedOrigins } = args;
  const resources = await addressbookQueryAll({ bookUrl, authHeader, fetchImpl, trustedOrigins }).catch(
    (err: unknown) => {
      throw classifyCardDavRequestFailure(err, { retryableByDefault: true });
    }
  );
  const cards: Array<{ card: ParsedVCard; uid: string }> = [];
  let complete = true;
  for (const resource of resources) {
    const [card] = parseVCards(resource.vcardText);
    if (!card) {
      complete = false;
      continue;
    }
    cards.push({ card, uid: String(contactRecord(bookUrl, resource, card).id) });
  }
  return { cards, complete };
}

/**
 * Collect one address book: probe sync capability, fetch (sync-collection or
 * bounded full snapshot), emit the address-book entity record plus contact +
 * group records, and advance this book's contacts-stream cursor. Extracted
 * from collect() to keep the top-level function's branching bounded — this
 * is the whole per-book unit of work in one place.
 */
async function collectAddressBook(ctx: AddressBookCollectionCtx): Promise<{
  contactsBoundaryEstablished: boolean;
  contactsConsidered: number;
  contactsCovered: number;
  covered: boolean;
  groupAnchor: GroupAnchor;
  groupsEmitted: number;
  groupsBoundaryEstablished: boolean;
  hadUnparseableResource: boolean;
}> {
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
    // resolveSyncResult throws either the HTTP-status-shaped
    // carddav_sync_collection_failed (transient — retryable, matching the
    // original string-pattern behavior) or one of davRequest's structural
    // CardDavStructuralError shapes (redirect refusal, missing Location,
    // oversized response, redirect loop — never retryable, since none of
    // those matched the original retryablePattern either).
    throw classifyCardDavRequestFailure(err, { retryableByDefault: true });
  });

  const { result: resolvedSyncResult, fullBoundary } = syncResult;
  const supportsSync = resolvedSyncResult.supportsSyncCollection;
  // An incremental sync reports only changes, so its empty resource list is
  // not an empty inventory. Only the initial sync (no prior token) or the
  // non-incremental fallback establishes the full contact boundary.
  //
  // This is a CONTACTS boundary fact as much as a groups one: on an
  // incremental run `resourcesEnumerated` counts changed resources, not the
  // address book's inventory, so a no-change run measures 0 without having
  // enumerated anything. Emitting that as `considered: 0` would hand the
  // coherence contract a fabricated `enumeration_boundary` proof
  // (`packages/reference-contract/src/evidence/coherence.ts` rule 2 reads a
  // measured `considered: 0` as "I enumerated the boundary and it held
  // nothing"). Track the boundary for contacts explicitly and let the caller
  // withhold the claim rather than overstate it.
  const contactsBoundaryEstablished = !supportsSync || fullBoundary;
  let groupsBoundaryEstablished = contactsBoundaryEstablished;
  const bookCovered = await emitAddressBookRecordIfRequested({ book, bookCursor, requested, emitRecord, supportsSync });

  const fingerprintState =
    (state.contacts as Record<string, { fingerprints?: Record<string, string> }>)?.[bookKey] ?? {};
  const entityCursor = openFingerprintCursor(fingerprintState);
  const seenCards: Array<{ card: ParsedVCard; uid: string }> = [];
  let contactCount = 0;
  let resourcesEnumerated = 0;
  let unparseableResources = 0;

  const emitContactRecord = async (resource: VCardResource): Promise<void> => {
    resourcesEnumerated += 1;
    const [card] = parseVCards(resource.vcardText);
    if (!card) {
      // The server enumerated this resource, but its vCard body didn't parse
      // (malformed/truncated/non-vCard <address-data>). It must still count
      // toward `resourcesEnumerated` (the coverage denominator) so a parse
      // failure shows up as considered > covered instead of silently
      // vanishing — see the honest-coverage note on collectAddressBook's
      // return value below.
      unparseableResources += 1;
      return;
    }
    const record = contactRecord(book.url, resource, card);
    // A group vCard is a real resource in this collection, so the
    // enumeration returns it alongside people. Emitting it as a contact
    // creates a phantom whose `display_name` is the group's name and which
    // counts as a covered contact. It is still SEEN (it belongs in
    // `seenCards`, where the group derivation and the group anchor both
    // read it), and it still counts as enumerated — it simply is not a
    // person, so it must not enter the `contacts` stream.
    const isGroup = isGroupVCard(card);
    if (!isGroup && requested.has("contacts") && entityCursor.shouldEmit(record)) {
      await emitRecord("contacts", record);
    }
    if (!isGroup) {
      contactCount += 1;
    }
    seenCards.push({ card, uid: String(record.id) });
  };

  if (supportsSync) {
    for (const resource of resolvedSyncResult.resources) {
      await emitContactRecord(resource);
    }
    // A sync-collection response is only obliged to enumerate members; RFC
    // 6578 §3.2 does not require the server to inline the `address-data` the
    // request asked for, and iCloud returns `getetag` only. Fetch those
    // bodies explicitly (RFC 6352 §8.7 addressbook-multiget) — treating an
    // un-inlined member as absent is what made a populated address book
    // report zero contacts.
    const unfetched = await hydrateMissingBodies({
      authHeader,
      bookUrl: book.url,
      emitContactRecord,
      fetchImpl,
      hrefs: resolvedSyncResult.hrefsMissingBodies,
      progress,
      trustedOrigins,
    });
    // A member the server enumerated but whose body it never returned must
    // stay in the denominator: considered-but-not-covered is an honest
    // partial, where dropping it would fabricate a complete claim.
    resourcesEnumerated += unfetched;
    unparseableResources += unfetched;
    for (const deletedHref of resolvedSyncResult.deletedHrefs) {
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
    // addressbookQueryAll throws either the HTTP-status-shaped
    // carddav_addressbook_query_failed (transient — retryable, matching the
    // original string-pattern behavior) or one of davRequest's structural
    // CardDavStructuralError shapes (never retryable — see
    // classifyCardDavRequestFailure).
    const resources = await addressbookQueryAll({ bookUrl: book.url, authHeader, fetchImpl, trustedOrigins }).catch(
      (err: unknown) => {
        throw classifyCardDavRequestFailure(err, { retryableByDefault: true });
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

  let groupCards = seenCards;
  // A malformed contact means the derived group inventory is incomplete,
  // even when the transport-level scan reached a full boundary.
  groupsBoundaryEstablished = groupsBoundaryEstablished && unparseableResources === 0;
  if (requested.has("contact_groups") && supportsSync && !fullBoundary) {
    // sync-collection is an incremental contact boundary. It cannot prove
    // the complete derived group inventory, so fetch a separate full
    // snapshot for groups while keeping contacts incremental.
    const groupSnapshot = await loadFullGroupSnapshot({
      bookUrl: book.url,
      authHeader,
      fetchImpl,
      trustedOrigins,
    });
    groupCards = groupSnapshot.cards;
    groupsBoundaryEstablished = groupSnapshot.complete;
  }

  // Group membership is a derived full snapshot. Stage its stream only
  // after the source enumeration and derivation complete successfully;
  // this lets a genuine zero-group result prove coverage without turning a
  // failed or unattempted scan into proof.
  const { emitted: groupsEmitted, anchor: groupAnchor } = await emitContactGroupsIfRequested({
    bookUrl: book.url,
    boundaryEstablished: groupsBoundaryEstablished,
    emit,
    emitRecord,
    requested,
    seenCards: groupCards,
  });

  // The `contact_groups` completeness anchor. The verdict is RETURNED rather
  // than emitted here: this scope's `emit` is deliberately narrowed to STATE
  // messages, and widening it just to report a finding would erode a
  // boundary that is doing useful work. The caller owns the full emit.
  await progress("Group inventory checked against the enumerated collection", {
    stream: "contact_groups",
    count: groupsEmitted,
    total: Math.max(groupAnchor.serverGroupVCards, groupsEmitted),
  });

  const contactsState =
    (newState.contacts as Record<string, { sync_token?: string; fingerprints?: Record<string, string> }>) ?? {};
  contactsState[bookKey] = {
    fingerprints: entityCursor.toState(),
    ...(supportsSync && resolvedSyncResult.syncToken ? { sync_token: resolvedSyncResult.syncToken } : {}),
  };
  newState.contacts = contactsState;
  await emit({ type: "STATE", stream: "contacts", cursor: newState.contacts });

  // `contactsConsidered` counts every resource the server actually
  // enumerated (resourcesEnumerated), NOT the successfully-parsed subset —
  // a vCard body that fails to parse still consumed a slot in the server's
  // response and must not silently disappear from the denominator.
  // `contactsCovered` counts only resources this run actually accounted for
  // (emitted, or suppressed as unchanged by the fingerprint cursor;
  // contactCount increments unconditionally above the shouldEmit gate, but
  // ONLY on the parse-succeeded path). When every enumerated resource
  // parsed, considered === covered and the caller's DETAIL_COVERAGE proves
  // complete/verified-empty coverage exactly as before (a genuinely empty
  // address book still proves considered === covered === 0). When one or
  // more resources failed to parse, considered > covered, so the caller
  // reads a real partial instead of a fabricated complete.
  //
  // Group vCards are enumerated resources that are deliberately NOT
  // contacts, so they must leave the contacts denominator too — otherwise
  // excluding them from `contactsCovered` alone would manufacture a
  // permanent considered > covered shortfall out of correct behaviour. They
  // are accounted for by the `contact_groups` anchor above instead.
  return {
    contactsBoundaryEstablished,
    contactsConsidered: resourcesEnumerated - groupAnchor.serverGroupVCards,
    contactsCovered: contactCount,
    hadUnparseableResource: unparseableResources > 0,
    covered: bookCovered,
    groupsEmitted,
    groupsBoundaryEstablished,
    groupAnchor,
  };
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

      // listAddressBooks throws either the HTTP-status-shaped
      // carddav_list_addressbooks_failed — NOT retryable, matching the
      // original string-pattern behavior (that pattern never matched this
      // message) — or one of davRequest's structural CardDavStructuralError
      // shapes (also never retryable). Both land on the same default here,
      // routed through the shared classifier for call-site consistency with
      // the sync/query sites above.
      const books = await listAddressBooks({
        homeUrl: discovery.addressBookHomeUrl,
        authHeader,
        fetchImpl,
        trustedOrigins,
      }).catch((err: unknown) => {
        throw classifyCardDavRequestFailure(err, { retryableByDefault: false });
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
      let groupsBoundaryEstablished = true;
      let contactsConsidered = 0;
      let contactsCovered = 0;
      let contactsBoundaryEstablished = true;
      let anyUnparseableResource = false;

      for (const book of books) {
        considered += 1;
        const {
          contactsBoundaryEstablished: bookContactsBoundaryEstablished,
          contactsConsidered: bookContactsConsidered,
          contactsCovered: bookContactsCovered,
          covered: bookCovered,
          groupAnchor,
          groupsEmitted,
          groupsBoundaryEstablished: bookGroupsBoundaryEstablished,
          hadUnparseableResource,
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
        // The completeness anchor for this book's groups. `short` is the
        // case the connector was previously blind to: the server enumerated
        // group vCards that never became records. It is reported as a
        // SKIP_RESULT here, where the full `emit` is in scope.
        const groupVerdict = groupAnchorVerdict(groupAnchor);
        if (groupVerdict.status === "short") {
          await emit({
            type: "SKIP_RESULT",
            stream: "contact_groups",
            reason: "group_inventory_short",
            message: "The address book holds groups this run did not record",
            diagnostics: {
              considered: groupVerdict.considered,
              covered: groupVerdict.covered,
              missing: groupVerdict.missing,
            },
          });
        }
        // deriveGroups has no drop/filter path: every derived group is
        // unconditionally emitted, so considered === covered === the exact
        // count emitted for this book (including a genuine zero-group book).
        // The anchor above is what checks that claim against the server's
        // own enumeration rather than trusting it.
        groupsConsidered += groupsEmitted;
        groupsBoundaryEstablished = groupsBoundaryEstablished && bookGroupsBoundaryEstablished;
        contactsBoundaryEstablished = contactsBoundaryEstablished && bookContactsBoundaryEstablished;
        contactsConsidered += bookContactsConsidered;
        contactsCovered += bookContactsCovered;
        anyUnparseableResource = anyUnparseableResource || hadUnparseableResource;
      }

      // Withhold the contacts coverage claim entirely when no book established
      // a full boundary this run. An incremental sync-collection delta is a
      // change feed, not an inventory: its `considered` is the number of
      // CHANGED resources, so a quiet run would otherwise emit
      // `considered: 0, covered: 0` and be read as a proven-empty address
      // book. Emitting nothing leaves the stream honestly unproven (the
      // coherence contract's `checkpoint_only`/`no_proof_strategy` -> axis
      // `unknown`) instead of falsely complete. A run that DOES establish the
      // boundary — initial sync, stale-token resync, or the non-incremental
      // fallback — still proves a genuine zero exactly as before.
      if (requested.has("contacts") && contactsBoundaryEstablished) {
        // `considered` counts every resource the server enumerated;
        // `covered` counts only the ones this run successfully parsed and
        // accounted for (emitted, or suppressed as unchanged by the
        // fingerprint cursor). When every enumerated resource parsed,
        // considered === covered and this proves complete/verified-empty
        // coverage, including the genuine-zero-contacts case. When a vCard
        // failed to parse, considered > covered — an honest partial, not a
        // fabricated complete — and PROGRESS surfaces the shape/parse
        // failure so it isn't silently swallowed by the coverage numbers.
        if (anyUnparseableResource) {
          await progress("Some enumerated contacts had unparseable vCard data", {
            stream: "contacts",
            count: contactsCovered,
            total: contactsConsidered,
          });
        }
        await emitDetailCoverage(
          { emit },
          {
            stream: "contacts",
            stateStream: "contacts",
            requiredKeys: [],
            hydratedKeys: [],
            considered: contactsConsidered,
            covered: contactsCovered,
          }
        );
      }

      if (requested.has("contact_groups") && groupsBoundaryEstablished) {
        await emit(buildFullScanCoverageMessage("contact_groups", groupsConsidered));
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
