// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Standards-first CardDAV service discovery (RFC 6764 §5, RFC 5785).
 *
 * Apple documents app-specific-password auth for Contacts
 * (support.apple.com/en-us/102654, support.apple.com/en-us/121539) but does
 * NOT publish the CardDAV hostname or wire contract for iCloud — confirmed
 * absent from every apple.com/support.apple.com page (see
 * connector-primary-reconcile-0807.md §4). The only Apple documentation of
 * CardDAV at all is a generic MDM payload schema that takes an
 * admin-supplied hostname and never names iCloud's own server.
 *
 * This module therefore does NOT hardcode `contacts.icloud.com` as the sole
 * path. It implements the RFC 6764 bootstrap discovery an owner-entered
 * account/server origin is expected to support:
 *
 *   1. GET/PROPFIND `https://<origin>/.well-known/carddav` (RFC 5785 +
 *      RFC 6764 §5) and follow the redirect it returns to the real CardDAV
 *      root — this is the mechanism actively-maintained third-party clients
 *      (DAVx5) use for iCloud precisely because Apple does not publish a
 *      stable hostname. Label: THIRD-PARTY-CORROBORATED, not Apple-official.
 *   2. PROPFIND `current-user-principal` on the resolved root to find the
 *      owner's principal URL (RFC 6764 §6 / RFC 3744 §5.1). RFC 6764 §5
 *      expects the well-known URI to redirect rather than answer inline, but
 *      does not forbid a server from answering it directly; when that
 *      happens and the response's own propstat 404s `current-user-principal`
 *      (RFC 4918 §14.22 — "this resource doesn't carry this property", not
 *      an error), this step retries once against the bare origin root before
 *      failing. Verified live against a real iCloud account: the well-known
 *      URL 207s inline with `current-user-principal` absent, while `/` on
 *      the same origin answers it. This fallback is standards-general (any
 *      RFC 6764 server that inline-answers the well-known URI without the
 *      property benefits), not an iCloud-specific carve-out.
 *   3. PROPFIND `addressbook-home-set` on the principal to find the address
 *      book collection(s) (RFC 6352 §7.1.1).
 *
 * Every redirect hop is validated against an explicit safety rule before
 * being followed. There is NO general "same registrable domain" heuristic —
 * a naive last-two-labels eTLD+1 comparison is actively wrong for public
 * suffixes like `co.uk` (it would treat `attacker.co.uk` and `bank.co.uk` as
 * "the same domain") and was removed after an independent review flagged it
 * as a real redirect-safety bypass. The rule is instead, in order:
 *
 *   1. Exact same origin — always safe, nothing to widen.
 *   2. An explicitly caller-supplied trusted origin (`trustedOrigins`) —
 *      used to remember an origin THIS discovery run already validated via
 *      rule 3, so a later hop back to it doesn't need re-justifying.
 *   3. A narrow, iCloud-specific carve-out: both the redirect source and
 *      target are `icloud.com` itself or a subdomain of it
 *      (`*.icloud.com`), both over HTTPS, neither carries userinfo
 *      (`user:pass@host`), and neither uses a non-default port. This is the
 *      ONLY widening rule, scoped to the one real-world case it exists for
 *      (contacts.icloud.com -> pXX-contacts.icloud.com) — it does not
 *      generalize to "any two hosts sharing a suffix."
 *
 * Anything else is refused. This blocks a malicious `.well-known`
 * responder from redirecting the Basic Auth credential to an
 * attacker-controlled origin — Basic Auth on `fetch` re-sends the
 * Authorization header on same-origin follows only when we build the
 * follow-up request ourselves (this module does NOT rely on `fetch`'s
 * automatic redirect-follow with credentials attached; it reads the
 * `Location` header and re-issues the request itself after validating the
 * target).
 */

import { describeBoundedReadRejection, readBoundedText } from "./bounded-response-read.ts";

export interface DiscoveryFetchResponse {
  body: ReadableStream<Uint8Array> | null;
  headers: { get: (name: string) => string | null };
  status: number;
}

export type DiscoveryFetch = (
  url: string,
  init: { headers: Record<string, string>; method: string; body?: string; redirect?: "manual" }
) => Promise<DiscoveryFetchResponse>;

/** Adapt the global `fetch` to {@link DiscoveryFetch}. `Response` already
 *  structurally satisfies {@link DiscoveryFetchResponse} (a `headers.get`
 *  method and a `body` stream), so this is a plain call-through — no cast
 *  needed, real or double. Shared by the connector and its tests so neither
 *  has to reach for `as unknown as`. */
export const nativeFetchAdapter: DiscoveryFetch = (url, init) => fetch(url, init);

export interface CardDavDiscoveryResult {
  addressBookHomeUrl: string;
  principalUrl: string;
  /** Every origin visited during discovery, in order — surfaced for
   *  diagnostics/tests, never logged with credentials attached. */
  visitedOrigins: string[];
}

export class CardDavRedirectOriginError extends Error {
  constructor(fromOrigin: string, toOrigin: string) {
    super(`carddav_discovery_unsafe_redirect: refused to follow ${fromOrigin} -> ${toOrigin} (origin not trusted)`);
    this.name = "CardDavRedirectOriginError";
  }
}

export class CardDavDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardDavDiscoveryError";
  }
}

const MAX_REDIRECT_HOPS = 5;
/** Ceiling for every authenticated XML/vCard response body this connector
 *  reads (PROPFIND/REPORT multistatus, which embeds vCards, which can embed
 *  a base64 PHOTO). 8 MiB comfortably covers a large address book's full
 *  snapshot or sync-collection page while bounding worst-case memory
 *  against a hostile or misbehaving server. See bounded-response-read.ts. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

function originOf(url: string): string {
  return new URL(url).origin;
}

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** True for IPv4/IPv6-literal hostnames — never eligible for the iCloud
 *  subdomain carve-out below (an IP literal is never "a subdomain of
 *  icloud.com"). */
function isIpLiteralHostname(hostname: string): boolean {
  return IPV4_RE.test(hostname) || hostname.includes(":");
}

const ICLOUD_APEX = "icloud.com";
const ICLOUD_SUBDOMAIN_SUFFIX = ".icloud.com";

/** True iff `hostname` is exactly `icloud.com` or a subdomain of it
 *  (`*.icloud.com`). Deliberately NOT a general eTLD+1/public-suffix
 *  comparison — those are wrong for multi-label public suffixes (`co.uk`,
 *  `github.io`, etc.) where "shares the last two labels" does not mean
 *  "controlled by the same party." This checks one specific, hardcoded
 *  apex domain, which is the only widening case this connector needs
 *  (contacts.icloud.com -> pXX-contacts.icloud.com). */
function isIcloudHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === ICLOUD_APEX || lower.endsWith(ICLOUD_SUBDOMAIN_SUFFIX);
}

/** Default port for a URL's scheme, or null if the URL specifies a
 *  non-default port explicitly. `URL.port` is `""` when the URL uses the
 *  scheme's default port (browsers/undici normalize this), so a non-empty
 *  `port` here always means "explicitly non-default." */
function hasNonDefaultPort(url: URL): boolean {
  return url.port !== "";
}

/** True iff the URL carries userinfo (`user:pass@host` / `user@host`) in
 *  its authority. A redirect target with embedded userinfo is a classic
 *  URL-confusion phishing vector (`https://icloud.com@attacker.example/`
 *  parses with host `attacker.example`, but `url.username` here would be
 *  `icloud.com`) — refusing it outright removes the whole class rather
 *  than relying on `url.hostname` already being attacker-controlled being
 *  caught downstream. */
function hasUserinfo(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/** The narrow iCloud regional-redirect carve-out: both source and target
 *  are exactly `icloud.com` or a subdomain of it, both over HTTPS (or the
 *  test-only loopback carve-out — see isLoopbackUrl), and neither carries
 *  userinfo or a non-default port. Every condition is required; this does
 *  NOT fall back to any broader same-domain heuristic. */
function isIcloudRegionalRedirect(from: URL, to: URL): boolean {
  if (isIpLiteralHostname(from.hostname) || isIpLiteralHostname(to.hostname)) {
    return false;
  }
  if (!(isIcloudHostname(from.hostname) && isIcloudHostname(to.hostname))) {
    return false;
  }
  if (hasUserinfo(from) || hasUserinfo(to)) {
    return false;
  }
  if (hasNonDefaultPort(from) || hasNonDefaultPort(to)) {
    return false;
  }
  return true;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** True for loopback targets, where plaintext HTTP carries no network
 *  eavesdropping risk (used only to let a local fake CardDAV server stand
 *  in for a real HTTPS origin in tests — production redirect targets are
 *  never loopback). */
function isLoopbackUrl(url: URL): boolean {
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Validate that a redirect target is safe to follow with the caller's
 *  credentials still attached. Exported for unit testing independent of
 *  network I/O.
 *
 *  Order of checks, all required, no fallback to a broader heuristic:
 *    1. Scheme must be HTTPS (or loopback, for local test servers only).
 *    2. Userinfo in either URL is refused outright (URL-confusion guard).
 *    3. Exact same origin is always safe.
 *    4. An explicitly caller-supplied trusted origin is safe (a prior hop
 *       this same discovery run already validated).
 *    5. The narrow icloud.com-subdomain carve-out (isIcloudRegionalRedirect)
 *       is the ONLY remaining widening rule. There is no general
 *       "same registrable domain" fallback — see the module doc comment
 *       for why that heuristic was removed. */
export function isSafeRedirectTarget(fromUrl: string, toUrl: string, trustedOrigins: readonly string[]): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(fromUrl);
    to = new URL(toUrl);
  } catch {
    return false;
  }
  if (to.protocol !== "https:" && !isLoopbackUrl(to)) {
    return false;
  }
  if (hasUserinfo(from) || hasUserinfo(to)) {
    return false;
  }
  if (to.origin === from.origin) {
    return true;
  }
  if (trustedOrigins.some((origin) => origin === to.origin)) {
    return true;
  }
  return isIcloudRegionalRedirect(from, to);
}

/**
 * Issue one PROPFIND, following redirects manually with origin validation.
 * Returns the final (validated) URL and response body once a non-redirect
 * status is reached.
 */
async function propfindFollowingRedirects(
  fetchImpl: DiscoveryFetch,
  startUrl: string,
  body: string,
  authHeader: string,
  trustedOrigins: string[],
  depth: string
): Promise<{ finalUrl: string; status: number; text: string; visited: string[] }> {
  let currentUrl = startUrl;
  const visited: string[] = [];
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    visited.push(originOf(currentUrl));
    const res = await fetchImpl(currentUrl, {
      method: "PROPFIND",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/xml; charset=utf-8",
        Depth: depth,
      },
      body,
      // Disable automatic redirect-following: a `fetch` implementation that
      // auto-follows would re-issue the request to the redirect target
      // BEFORE this module gets to validate the target origin, and (per the
      // WHATWG fetch spec) auto-follow strips the Authorization header on a
      // cross-origin redirect — silently downgrading to an unauthenticated
      // follow-up rather than failing loudly. Reading `Location` and
      // re-issuing ourselves, after `isSafeRedirectTarget`, is the whole
      // point of this module.
      redirect: "manual",
    });
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) {
      const location = res.headers.get("location");
      if (!location) {
        throw new CardDavDiscoveryError(`carddav_discovery_redirect_missing_location: ${currentUrl}`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (!isSafeRedirectTarget(currentUrl, nextUrl, trustedOrigins)) {
        throw new CardDavRedirectOriginError(originOf(currentUrl), originOf(nextUrl));
      }
      currentUrl = nextUrl;
      if (hop === MAX_REDIRECT_HOPS) {
        throw new CardDavDiscoveryError(`carddav_discovery_too_many_redirects: started at ${startUrl}`);
      }
      continue;
    }
    const outcome = await readBoundedText(res, MAX_RESPONSE_BYTES);
    if (outcome.kind !== "ok") {
      throw new CardDavDiscoveryError(`carddav_discovery_response_too_large: ${describeBoundedReadRejection(outcome)}`);
    }
    return { finalUrl: currentUrl, status: res.status, text: outcome.text, visited };
  }
  throw new CardDavDiscoveryError(`carddav_discovery_too_many_redirects: started at ${startUrl}`);
}

const HREF_TAG_RE = /<[^:>]*:?href[^>]*>([\s\S]*?)<\/[^:>]*:?href>/i;

/** Extract the first `<href>...</href>` text content under a given
 *  property-local-name in a multistatus XML body. Bounded regex parse —
 *  no XML parser dependency; sufficient for the well-formed, small
 *  PROPFIND responses this connector reads. */
function extractHref(xml: string, propLocalName: string): string | null {
  const propRe = new RegExp(`<[^:>]*:?${propLocalName}[^>]*>([\\s\\S]*?)</[^:>]*:?${propLocalName}>`, "i");
  const propMatch = propRe.exec(xml);
  if (!propMatch?.[1]) {
    return null;
  }
  const hrefMatch = HREF_TAG_RE.exec(propMatch[1]);
  return hrefMatch?.[1]?.trim() ?? null;
}

const CURRENT_USER_PRINCIPAL_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:current-user-principal/>
  </D:prop>
</D:propfind>`;

const ADDRESSBOOK_HOME_SET_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop>
    <C:addressbook-home-set/>
  </D:prop>
</D:propfind>`;

/**
 * Run full RFC 6764 discovery from an owner-entered origin (e.g.
 * `https://contacts.icloud.com` or any CardDAV-capable origin the owner
 * types in). Does not assume iCloud; any RFC 6764-compliant server works.
 */
export async function discoverCardDav(args: {
  authHeader: string;
  fetchImpl: DiscoveryFetch;
  originUrl: string;
}): Promise<CardDavDiscoveryResult> {
  const { authHeader, fetchImpl, originUrl } = args;
  const startOrigin = originOf(originUrl);
  const trustedOrigins: string[] = [startOrigin];
  const visitedOrigins: string[] = [];

  const wellKnownUrl = new URL("/.well-known/carddav", originUrl).toString();
  let principalStep = await propfindFollowingRedirects(
    fetchImpl,
    wellKnownUrl,
    CURRENT_USER_PRINCIPAL_BODY,
    authHeader,
    trustedOrigins,
    "0"
  );
  visitedOrigins.push(...principalStep.visited);
  // Any origin actually reached during well-known resolution becomes
  // trusted for subsequent hops (the resolved regional host, e.g.
  // pXX-contacts.icloud.com) — but only after passing the redirect-origin
  // check on the hop that reached it.
  for (const origin of principalStep.visited) {
    if (!trustedOrigins.includes(origin)) {
      trustedOrigins.push(origin);
    }
  }

  if (principalStep.status === 401 || principalStep.status === 403) {
    throw new CardDavDiscoveryError("carddav_auth_rejected");
  }
  if (principalStep.status < 200 || principalStep.status >= 300) {
    throw new CardDavDiscoveryError(`carddav_discovery_propfind_failed: status=${String(principalStep.status)}`);
  }

  let principalHref = extractHref(principalStep.text, "current-user-principal");
  // RFC 6764 §5 expects the well-known URI to redirect to the real context
  // path; it does not mandate that a server answering the well-known
  // PROPFIND inline (no redirect) must itself carry
  // `current-user-principal` on that exact resource. A server may legally
  // answer 207 there with the property 404'd in its propstat (RFC 4918
  // §14.22: "this resource doesn't have this property") while still
  // honoring the property at the origin root. Observed live against a real
  // iCloud account: `.well-known/carddav` answers inline with
  // current-user-principal absent, while `/` on the same origin returns it
  // populated. When the well-known step never redirected (so the origin
  // root hasn't already been tried) and yielded no principal href, retry
  // once against the bare origin root before giving up — this is a
  // standards-general fallback, not an iCloud-specific carve-out.
  if (!principalHref && principalStep.visited.length === 1) {
    const rootUrl = new URL("/", originUrl).toString();
    if (rootUrl !== wellKnownUrl) {
      const rootStep = await propfindFollowingRedirects(
        fetchImpl,
        rootUrl,
        CURRENT_USER_PRINCIPAL_BODY,
        authHeader,
        trustedOrigins,
        "0"
      );
      visitedOrigins.push(...rootStep.visited);
      for (const origin of rootStep.visited) {
        if (!trustedOrigins.includes(origin)) {
          trustedOrigins.push(origin);
        }
      }
      if (rootStep.status >= 200 && rootStep.status < 300) {
        const rootHref = extractHref(rootStep.text, "current-user-principal");
        if (rootHref) {
          principalStep = rootStep;
          principalHref = rootHref;
        }
      }
    }
  }
  if (!principalHref) {
    throw new CardDavDiscoveryError("carddav_discovery_no_current_user_principal");
  }
  const principalUrl = new URL(principalHref, principalStep.finalUrl).toString();
  if (!isSafeRedirectTarget(principalStep.finalUrl, principalUrl, trustedOrigins)) {
    throw new CardDavRedirectOriginError(originOf(principalStep.finalUrl), originOf(principalUrl));
  }
  if (!trustedOrigins.includes(originOf(principalUrl))) {
    trustedOrigins.push(originOf(principalUrl));
  }

  const homeSetStep = await propfindFollowingRedirects(
    fetchImpl,
    principalUrl,
    ADDRESSBOOK_HOME_SET_BODY,
    authHeader,
    trustedOrigins,
    "0"
  );
  visitedOrigins.push(...homeSetStep.visited);
  if (homeSetStep.status < 200 || homeSetStep.status >= 300) {
    throw new CardDavDiscoveryError(`carddav_discovery_home_set_failed: status=${String(homeSetStep.status)}`);
  }
  const homeHref = extractHref(homeSetStep.text, "addressbook-home-set");
  if (!homeHref) {
    throw new CardDavDiscoveryError("carddav_discovery_no_addressbook_home_set");
  }
  const addressBookHomeUrl = new URL(homeHref, homeSetStep.finalUrl).toString();
  if (!isSafeRedirectTarget(homeSetStep.finalUrl, addressBookHomeUrl, trustedOrigins)) {
    throw new CardDavRedirectOriginError(originOf(homeSetStep.finalUrl), originOf(addressBookHomeUrl));
  }

  return {
    principalUrl,
    addressBookHomeUrl,
    visitedOrigins: [...new Set(visitedOrigins)],
  };
}
