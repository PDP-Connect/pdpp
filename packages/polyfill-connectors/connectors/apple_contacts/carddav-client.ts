// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * CardDAV wire client: address book enumeration, REPORT-based sync, and
 * capability discovery (RFC 6352 CardDAV, RFC 6578 WebDAV sync-collection,
 * RFC 4791-family `getctag`).
 *
 * Whether iCloud's specific CardDAV server implements `sync-collection` is
 * UNVERIFIABLE without a live probe (connector-primary-reconcile-0807.md
 * §4). This client therefore always PROBES capability first — it never
 * assumes either way — and falls back to a bounded full snapshot +
 * fingerprint cursor (via fingerprint-cursor.ts, applied in index.ts) when
 * `sync-collection` REPORT is unsupported (405/501) or absent from the
 * address book's supported-report-set.
 */

import { describeBoundedReadRejection, readBoundedText } from "./bounded-response-read.ts";
import type { DiscoveryFetch, DiscoveryFetchResponse } from "./discovery.ts";
import { isSafeRedirectTarget, MAX_RESPONSE_BYTES } from "./discovery.ts";

export interface AddressBookInfo {
  ctag?: string;
  displayName?: string;
  syncToken?: string;
  url: string;
}

export interface VCardResource {
  etag?: string;
  href: string;
  vcardText: string;
}

export interface SyncCollectionResult {
  deletedHrefs: string[];
  /**
   * Hrefs the REPORT enumerated as present-and-current but for which the
   * server returned NO `address-data` body, even though the request asked for
   * it. RFC 6578 §3.2 does not oblige a server to inline arbitrary properties
   * in a sync-collection response, and iCloud in fact does not: its
   * sync-collection multistatus carries `getetag` only. These hrefs are real
   * members whose bodies must be fetched in a follow-up
   * `addressbook-multiget` (RFC 6352 §8.7) — dropping them silently is how a
   * populated address book reports as empty.
   */
  hrefsMissingBodies: string[];
  resources: VCardResource[];
  supportsSyncCollection: boolean;
  syncToken?: string;
  truncated: boolean;
}

const MAX_REDIRECT_HOPS = 5;

/**
 * A structural, non-transient `davRequest` failure: the server's response
 * shape itself is the problem (missing/unsafe redirect location, oversized
 * body, redirect loop) rather than a status code that might clear on retry.
 * Every `davRequest` call site (sync-collection, addressbook-query,
 * list-addressbooks) throws this same class for these four shapes so
 * retryable-classification can dispatch by `instanceof` once, consistently,
 * instead of re-deriving it from message text at each call site.
 */
export class CardDavStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardDavStructuralError";
  }
}

function originOf(url: string): string {
  return new URL(url).origin;
}

async function davRequest(
  fetchImpl: DiscoveryFetch,
  url: string,
  method: string,
  authHeader: string,
  extraHeaders: Record<string, string>,
  body: string,
  trustedOrigins: string[]
): Promise<{ finalUrl: string; status: number; text: string }> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const res: DiscoveryFetchResponse = await fetchImpl(currentUrl, {
      method,
      headers: { Authorization: authHeader, "Content-Type": "application/xml; charset=utf-8", ...extraHeaders },
      body,
      // See discovery.ts's propfindFollowingRedirects for why auto-follow
      // must stay disabled: it would drop Authorization on a cross-origin
      // follow before this module validates the redirect target.
      redirect: "manual",
    });
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const location = res.headers.get("location");
      if (!location) {
        throw new CardDavStructuralError("carddav_redirect_missing_location");
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isSafeRedirectTarget(currentUrl, nextUrl, trustedOrigins)) {
        throw new CardDavStructuralError(`carddav_unsafe_redirect: ${originOf(currentUrl)} -> ${originOf(nextUrl)}`);
      }
      currentUrl = nextUrl;
      continue;
    }
    const outcome = await readBoundedText(res, MAX_RESPONSE_BYTES);
    if (outcome.kind !== "ok") {
      throw new CardDavStructuralError(`carddav_response_too_large: ${describeBoundedReadRejection(outcome)}`);
    }
    return { finalUrl: currentUrl, status: res.status, text: outcome.text };
  }
  throw new CardDavStructuralError(`carddav_too_many_redirects: ${url}`);
}

function extractAllHrefBlocks(xml: string): string[] {
  const responseRe = /<[^:>]*:?response[^>]*>([\s\S]*?)<\/[^:>]*:?response>/gi;
  const blocks: string[] = [];
  let match: RegExpExecArray | null = responseRe.exec(xml);
  while (match !== null) {
    if (match[1] !== undefined) {
      blocks.push(match[1]);
    }
    match = responseRe.exec(xml);
  }
  return blocks;
}

function extractTag(xml: string, localName: string): string | null {
  const re = new RegExp(`<[^:>]*:?${localName}[^>]*>([\\s\\S]*?)</[^:>]*:?${localName}>`, "i");
  return re.exec(xml)?.[1]?.trim() ?? null;
}

const STATUS_CODE_RE = /\s(\d{3})\s/;

function statusCodeOf(block: string): number | null {
  const statusText = extractTag(block, "status");
  if (!statusText) {
    return null;
  }
  const m = STATUS_CODE_RE.exec(` ${statusText} `);
  return m?.[1] ? Number(m[1]) : null;
}

const ADDRESSBOOK_RESOURCETYPE_RE = /addressbook/i;

const ADDRESSBOOK_SET_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <CS:getctag/>
    <D:sync-token/>
    <D:supported-report-set/>
  </D:prop>
</D:propfind>`;

/** List address book collections under the home-set URL (RFC 6352 §7.1). */
export async function listAddressBooks(args: {
  authHeader: string;
  fetchImpl: DiscoveryFetch;
  homeUrl: string;
  trustedOrigins: string[];
}): Promise<AddressBookInfo[]> {
  const { authHeader, fetchImpl, homeUrl, trustedOrigins } = args;
  const res = await davRequest(
    fetchImpl,
    homeUrl,
    "PROPFIND",
    authHeader,
    { Depth: "1" },
    ADDRESSBOOK_SET_BODY,
    trustedOrigins
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`carddav_list_addressbooks_failed: status=${String(res.status)}`);
  }
  const books: AddressBookInfo[] = [];
  for (const block of extractAllHrefBlocks(res.text)) {
    const resourcetype = extractTag(block, "resourcetype") ?? "";
    if (!ADDRESSBOOK_RESOURCETYPE_RE.test(resourcetype)) {
      continue;
    }
    const href = extractTag(block, "href");
    if (!href) {
      continue;
    }
    const url = new URL(href, res.finalUrl).toString();
    const displayName = extractTag(block, "displayname");
    const ctag = extractTag(block, "getctag");
    const syncToken = extractTag(block, "sync-token");
    books.push({
      url,
      ...(displayName ? { displayName } : {}),
      ...(ctag ? { ctag } : {}),
      ...(syncToken ? { syncToken } : {}),
    });
  }
  return books;
}

const SYNC_COLLECTION_BODY = (syncToken: string): string => `<?xml version="1.0" encoding="utf-8" ?>
<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:sync-token>${syncToken}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
</D:sync-collection>`;

const ADDRESSBOOK_QUERY_ALL_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
</C:addressbook-query>`;

/** Hrefs per addressbook-multiget request. Bounds both the request body and
 *  the response size so one large change set can't produce an unbounded
 *  round-trip (davRequest's MAX_RESPONSE_BYTES would reject it outright). */
const MULTIGET_CHUNK_SIZE = 50;

function xmlEscapeText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Reduce an href to the path form (`/path/to/card.vcf`) a multiget body must
 * carry. `syncCollectionReport` resolves member hrefs to absolute URLs so the
 * rest of the connector can key records by a stable absolute id, but iCloud
 * answers `400 Bad Request` to an absolute `<D:href>` inside an
 * addressbook-multiget and `207` to the path form (probe against
 * p196-contacts.icloud.com, 2026-08-19). RFC 6352 §8.7's own examples use the
 * path form, so this is the interoperable shape, not an Apple workaround.
 * A value that does not parse as a URL is passed through unchanged.
 */
function hrefPathOnly(href: string): string {
  try {
    const url = new URL(href);
    return `${url.pathname}${url.search}`;
  } catch {
    return href;
  }
}

const MULTIGET_BODY = (hrefs: readonly string[]): string => `<?xml version="1.0" encoding="utf-8" ?>
<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <D:getetag/>
    <C:address-data/>
  </D:prop>
${hrefs.map((href) => `  <D:href>${xmlEscapeText(hrefPathOnly(href))}</D:href>`).join("\n")}
</C:addressbook-multiget>`;

/**
 * Attempt RFC 6578 `sync-collection` REPORT. `priorSyncToken` empty string
 * means "initial sync" per RFC 6578 §3.2. Returns
 * `supportsSyncCollection: false` (never throws for this reason) when the
 * server responds 405/501/415 or omits a `sync-token` in the multistatus —
 * the caller falls back to a full `addressbook-query` snapshot.
 */
export async function syncCollectionReport(args: {
  authHeader: string;
  bookUrl: string;
  fetchImpl: DiscoveryFetch;
  priorSyncToken: string;
  trustedOrigins: string[];
}): Promise<SyncCollectionResult> {
  const { authHeader, bookUrl, fetchImpl, priorSyncToken, trustedOrigins } = args;
  const res = await davRequest(
    fetchImpl,
    bookUrl,
    "REPORT",
    authHeader,
    { Depth: "1" },
    SYNC_COLLECTION_BODY(priorSyncToken),
    trustedOrigins
  );
  if (res.status === 405 || res.status === 501 || res.status === 415) {
    return {
      resources: [],
      deletedHrefs: [],
      hrefsMissingBodies: [],
      supportsSyncCollection: false,
      truncated: false,
    };
  }
  if (res.status === 507) {
    // Insufficient storage / token too old (RFC 6578 §3.6): server wants a
    // full resync. Signal via empty sync token so the caller re-derives.
    return {
      resources: [],
      deletedHrefs: [],
      hrefsMissingBodies: [],
      supportsSyncCollection: true,
      truncated: false,
      syncToken: "",
    };
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`carddav_sync_collection_failed: status=${String(res.status)}`);
  }
  const newSyncToken = extractTag(res.text, "sync-token");
  if (!newSyncToken) {
    return {
      resources: [],
      deletedHrefs: [],
      hrefsMissingBodies: [],
      supportsSyncCollection: false,
      truncated: false,
    };
  }
  const resources: VCardResource[] = [];
  const deletedHrefs: string[] = [];
  const hrefsMissingBodies: string[] = [];
  for (const block of extractAllHrefBlocks(res.text)) {
    const href = extractTag(block, "href");
    if (!href) {
      continue;
    }
    const status = statusCodeOf(block);
    if (status === 404) {
      deletedHrefs.push(new URL(href, res.finalUrl).toString());
      continue;
    }
    const absoluteHref = new URL(href, res.finalUrl).toString();
    // The collection's own href appears in the multistatus alongside its
    // members (iCloud reports the collection with its own getetag). It is not
    // a contact resource, so it must not be queued for a body fetch.
    if (isSameCollection(absoluteHref, res.finalUrl)) {
      continue;
    }
    const vcardText = extractTag(block, "address-data");
    if (!vcardText) {
      // Enumerated member with no inlined body: record it for the multiget
      // follow-up rather than dropping it.
      hrefsMissingBodies.push(absoluteHref);
      continue;
    }
    const etag = extractTag(block, "getetag");
    resources.push({
      href: absoluteHref,
      ...(etag ? { etag } : {}),
      vcardText: decodeXmlEntities(vcardText),
    });
  }
  return {
    resources,
    deletedHrefs,
    hrefsMissingBodies,
    supportsSyncCollection: true,
    syncToken: newSyncToken,
    truncated: false,
  };
}

/** True when two URLs name the same collection, ignoring a trailing slash.
 *  iCloud reports the collection itself as `.../card` while the request URL is
 *  `.../card/`, so a bare string compare would miss it. */
function isSameCollection(candidate: string, collectionUrl: string): boolean {
  const strip = (u: string): string => u.replace(TRAILING_SLASH_RE, "");
  return strip(candidate) === strip(collectionUrl);
}

const TRAILING_SLASH_RE = /\/+$/;

/**
 * Fetch vCard bodies for an explicit set of member hrefs
 * (RFC 6352 §8.7 `addressbook-multiget`). This is the companion to
 * `syncCollectionReport` for servers — iCloud among them — that enumerate
 * members in a sync-collection response without inlining `address-data`.
 *
 * Requests are chunked so a large change set cannot produce a single
 * unbounded request or response body.
 */
export async function addressbookMultiget(args: {
  authHeader: string;
  bookUrl: string;
  fetchImpl: DiscoveryFetch;
  hrefs: readonly string[];
  trustedOrigins: string[];
}): Promise<VCardResource[]> {
  const { authHeader, bookUrl, fetchImpl, hrefs, trustedOrigins } = args;
  if (hrefs.length === 0) {
    return [];
  }
  const resources: VCardResource[] = [];
  for (let start = 0; start < hrefs.length; start += MULTIGET_CHUNK_SIZE) {
    const chunk = hrefs.slice(start, start + MULTIGET_CHUNK_SIZE);
    const res = await davRequest(
      fetchImpl,
      bookUrl,
      "REPORT",
      authHeader,
      { Depth: "1" },
      MULTIGET_BODY(chunk),
      trustedOrigins
    );
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`carddav_addressbook_multiget_failed: status=${String(res.status)}`);
    }
    for (const block of extractAllHrefBlocks(res.text)) {
      const href = extractTag(block, "href");
      const vcardText = extractTag(block, "address-data");
      if (!(href && vcardText)) {
        continue;
      }
      const etag = extractTag(block, "getetag");
      resources.push({
        href: new URL(href, res.finalUrl).toString(),
        ...(etag ? { etag } : {}),
        vcardText: decodeXmlEntities(vcardText),
      });
    }
  }
  return resources;
}

/** Bounded full snapshot via `addressbook-query` (RFC 6352 §8.6) — the
 *  fallback path when sync-collection is unsupported. "Bounded" here means
 *  the caller (index.ts) applies the fingerprint cursor to the full result;
 *  this function itself does not paginate because CardDAV has no
 *  standardized paging mechanism (unlike CalDAV time-range limits) — an
 *  owner's address book is expected to be small enough (hundreds to low
 *  thousands of contacts) for one full multistatus response. */
export async function addressbookQueryAll(args: {
  authHeader: string;
  bookUrl: string;
  fetchImpl: DiscoveryFetch;
  trustedOrigins: string[];
}): Promise<VCardResource[]> {
  const { authHeader, bookUrl, fetchImpl, trustedOrigins } = args;
  const res = await davRequest(
    fetchImpl,
    bookUrl,
    "REPORT",
    authHeader,
    { Depth: "1" },
    ADDRESSBOOK_QUERY_ALL_BODY,
    trustedOrigins
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`carddav_addressbook_query_failed: status=${String(res.status)}`);
  }
  const resources: VCardResource[] = [];
  for (const block of extractAllHrefBlocks(res.text)) {
    const href = extractTag(block, "href");
    const vcardText = extractTag(block, "address-data");
    if (!(href && vcardText)) {
      continue;
    }
    const etag = extractTag(block, "getetag");
    resources.push({
      href: new URL(href, res.finalUrl).toString(),
      ...(etag ? { etag } : {}),
      vcardText: decodeXmlEntities(vcardText),
    });
  }
  return resources;
}

const NUMERIC_XML_ENTITY_RE = /&#(?:x([0-9a-fA-F]+)|([0-9]+));/g;

function decodeNumericXmlEntity(entity: string, hexadecimal: string | undefined, decimal: string | undefined): string {
  const codePoint = Number.parseInt(hexadecimal ?? decimal ?? "", hexadecimal === undefined ? 10 : 16);
  if (!(Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10_ff_ff)) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(NUMERIC_XML_ENTITY_RE, decodeNumericXmlEntity)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
