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
  resources: VCardResource[];
  supportsSyncCollection: boolean;
  syncToken?: string;
  truncated: boolean;
}

const MAX_REDIRECT_HOPS = 5;

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
        throw new Error("carddav_redirect_missing_location");
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isSafeRedirectTarget(currentUrl, nextUrl, trustedOrigins)) {
        throw new Error(`carddav_unsafe_redirect: ${originOf(currentUrl)} -> ${originOf(nextUrl)}`);
      }
      currentUrl = nextUrl;
      continue;
    }
    const outcome = await readBoundedText(res, MAX_RESPONSE_BYTES);
    if (outcome.kind !== "ok") {
      throw new Error(`carddav_response_too_large: ${describeBoundedReadRejection(outcome)}`);
    }
    return { finalUrl: currentUrl, status: res.status, text: outcome.text };
  }
  throw new Error(`carddav_too_many_redirects: ${url}`);
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
    return { resources: [], deletedHrefs: [], supportsSyncCollection: false, truncated: false };
  }
  if (res.status === 507) {
    // Insufficient storage / token too old (RFC 6578 §3.6): server wants a
    // full resync. Signal via empty sync token so the caller re-derives.
    return { resources: [], deletedHrefs: [], supportsSyncCollection: true, truncated: false, syncToken: "" };
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`carddav_sync_collection_failed: status=${String(res.status)}`);
  }
  const newSyncToken = extractTag(res.text, "sync-token");
  if (!newSyncToken) {
    return { resources: [], deletedHrefs: [], supportsSyncCollection: false, truncated: false };
  }
  const resources: VCardResource[] = [];
  const deletedHrefs: string[] = [];
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
    const vcardText = extractTag(block, "address-data");
    if (!vcardText) {
      continue;
    }
    const etag = extractTag(block, "getetag");
    resources.push({
      href: new URL(href, res.finalUrl).toString(),
      ...(etag ? { etag } : {}),
      vcardText: decodeXmlEntities(vcardText),
    });
  }
  return { resources, deletedHrefs, supportsSyncCollection: true, syncToken: newSyncToken, truncated: false };
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

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
