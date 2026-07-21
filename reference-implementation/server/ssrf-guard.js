/**
 * Shared SSRF primitives: global-unicast address allow policy and send-time
 * address binding.
 *
 * Three callers issue outbound requests to a destination an untrusted party
 * can influence — `cimd.js` (`fetchCimdDocument`, fetching a client's CIMD
 * document), `client-event-delivery-worker.ts` (`defaultHttpTransport`,
 * POSTing to a subscription's `callback_url`), and `web-push-notifications.js`
 * (`defaultSendNotification`, POSTing to an owner-supplied Web Push
 * `endpoint`) — and all three need the same two guarantees:
 *
 * 1. The destination address is a global-unicast address, not merely "not on
 *    a small deny list." A deny list is inherently incomplete: IANA carves
 *    out many special-purpose ranges (benchmarking 198.18.0.0/15, the three
 *    TEST-NET ranges, AS112, AMT, and their IPv6 equivalents, plus IPv6-only
 *    ranges like local-use NAT64 translation and SRv6 SIDs) that are not
 *    globally reachable but also are not RFC 1918 private space, loopback,
 *    or link-local — a hand-maintained "block these known-bad ranges" list
 *    silently passes all of them. This module instead asks "is this address
 *    global unicast?" and denies everything else, using a dated, vendored
 *    snapshot of the actual IANA IPv4/IPv6 Special-Purpose Address
 *    Registries (`server/iana-special-purpose-registry.js`) as the policy
 *    authority. `ipaddr.js` is used only as an IP parser and CIDR-matcher
 *    (`parseCIDR`/`match`/`process`) — its own `range()` classifier is
 *    deliberately NOT used as policy, because it is itself a third-party
 *    snapshot with no documented currency relative to the registries and was
 *    proven stale against several rows the registries added after
 *    `ipaddr.js@2.3.0` shipped (see the research doc cited below). This is a
 *    dated snapshot, not a live feed — see
 *    openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md
 *    for the full registry data, the derivation rules, and the update
 *    procedure. It proves every address in either registry as of that date
 *    is correctly classified; it does not prove a range IANA allocates after
 *    that date will be denied without a snapshot refresh.
 * 2. The network address validated as allowed is the address the connection
 *    actually dials, not merely an address checked beforehand. Resolving a
 *    hostname, checking the result, and then calling `fetch(url)` with the
 *    original hostname is NOT that guarantee: `fetch` (undici) — and
 *    `https.request` (Node's core `https` module, used by the `web-push`
 *    library) — perform their own independent hostname resolution when they
 *    open the socket, so a low-TTL or attacker-controlled DNS record can
 *    answer differently between the validating lookup and the connection
 *    (DNS rebinding). `createPinnedDispatcher` (undici) and
 *    `createPinnedHttpsAgent` (`node:https`) close that gap by constructing a
 *    dispatcher/agent whose connector dials only the literal, already-
 *    validated address(es) — there is no second, independent resolution left
 *    to race.
 *
 * A third property, not present in the address itself: an attacker-controlled
 * DNS answer must not be able to force unbounded connection work. This module
 * caps both how many resolved addresses are retained and how many connection
 * attempts a pinned dispatcher/agent will make, and fails closed (treats the
 * lookup as blocked) rather than silently truncating when a DNS answer
 * exceeds the cap — a silent truncation is itself a behavior a caller could
 * be surprised by; failing loud is easier to reason about and to test.
 *
 * This module intentionally does NOT own scheme validation, loopback/dev
 * exemptions, redirect policy, or error wrapping — each caller keeps that
 * policy local (it differs: CIMD is https-only with no loopback exemption;
 * client-event delivery has a sanctioned http+literal-loopback dev path; Web
 * Push endpoints are owner-authenticated but otherwise unconstrained). Only
 * the address classifier, the resolution bound, and the connection-pinning
 * mechanisms are shared, so there is one set of guarantees to prove instead
 * of three that could drift out of sync.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import https from 'node:https';
import tls from 'node:tls';
import ipaddr from 'ipaddr.js';
import { Agent as UndiciAgent, buildConnector } from 'undici';
import { IPV4_SPECIAL_PURPOSE_ROWS, IPV6_SPECIAL_PURPOSE_ROWS } from './iana-special-purpose-registry.js';

/**
 * Maximum number of DNS-resolved addresses retained (and therefore the
 * maximum number of connection attempts a pinned dispatcher/agent will make)
 * per outbound request. An attacker-controlled DNS answer with more addresses
 * than this is treated as `too_many_addresses` (fails closed) — a small,
 * deliberately conservative cap: legitimate deployments (even multi-region,
 * dual-stack ones) resolve to a handful of addresses, not dozens. See the
 * "P2" finding in tmp/workstreams/ssrf-terra-final-0717.md for the motivating
 * case (a 128-address injected DNS answer accepted in full by the pre-fix
 * guard, forcing unbounded sequential connection attempts).
 */
export const MAX_VALIDATED_ADDRESSES = 8;

// Pre-parsed CIDR blocks for the vendored registry rows, built once. Each
// entry is `[parsedCidr, globallyReachable]`, where `parsedCidr` is
// `ipaddr.js`'s `[address, prefixLength]` pair (from `parseCIDR`) — used only
// for CIDR containment matching (`ip.match(cidr)`), never for its own
// `range()` classification.
const IPV4_CIDR_TABLE = IPV4_SPECIAL_PURPOSE_ROWS.map(([cidr, globallyReachable]) => [
  ipaddr.parseCIDR(cidr),
  globallyReachable,
]);
const IPV6_CIDR_TABLE = IPV6_SPECIAL_PURPOSE_ROWS.map(([cidr, globallyReachable]) => [
  ipaddr.parseCIDR(cidr),
  globallyReachable,
]);

// The 6to4 row (2002::/16) specifically, looked up once, so `isGlobalUnicastAddress`
// can deny it outright before consulting the general table — 6to4 is denied
// unconditionally regardless of its embedded IPv4 payload (see the research
// doc: the registry's own Globally Reachable value for 2002::/16 is N/A, not
// True, so it is not registry-affirmed reachable and must not be
// conditionally allowed based on payload inspection).
const SIX_TO_FOUR_CIDR = ipaddr.parseCIDR('2002::/16');

// The NAT64 global-use row (64:ff9b::/96) specifically — this one IS
// registry-affirmed reachable (Globally Reachable: True) and therefore does
// get its embedded IPv4 payload unwrapped and recursively checked, unlike
// 6to4. 64:ff9b:1::/48 (local-use, RFC 8215) is a *different* CIDR block and
// is denied outright via the general table below, with no unwrapping.
const NAT64_GLOBAL_USE_CIDR = ipaddr.parseCIDR('64:ff9b::/96');

/**
 * Extract the 4 bytes starting at `byteOffset` from an IPv6 address's byte
 * array as a dotted-decimal IPv4 string. Returns null if the address does not
 * have enough bytes at that offset (should not happen for valid IPv6, but
 * guards against a malformed/short byte array rather than throwing).
 */
function extractEmbeddedIpv4(ipv6Addr, byteOffset) {
  const bytes = ipv6Addr.toByteArray();
  if (bytes.length < byteOffset + 4) return null;
  return bytes.slice(byteOffset, byteOffset + 4).join('.');
}

/**
 * Look up `addr` against a vendored CIDR table (IPv4 or IPv6, matching
 * `addr.kind()`). Returns the MOST SPECIFIC matching row's `globallyReachable`
 * value (longest-prefix-match), or `null` if no row in the table contains
 * this address at all (not on any special-purpose row — the default-allow
 * case). Longest-prefix-match is required: the registries themselves carve
 * more specific allocations out of broader blocks with a DIFFERENT
 * reachability value — e.g. `192.0.0.9/32` (Port Control Protocol Anycast,
 * Globally Reachable: true) sits inside `192.0.0.0/24` (IETF Protocol
 * Assignments, Globally Reachable: false); `2001:1::1/128` (PCP Anycast,
 * true) sits inside the broader `2001::/23` (IETF Protocol Assignments,
 * false). Iterating in table-declaration order and returning the first match
 * would silently return the wrong (less specific) row's value for any nested
 * pair. Verified by an exhaustive sweep in test/ssrf-guard.test.js that
 * checks every row in both vendored tables individually.
 */
function lookupSpecialPurposeRow(addr, table) {
  let best = null;
  let bestPrefixLength = -1;
  for (const [cidr, globallyReachable] of table) {
    const [, prefixLength] = cidr;
    if (prefixLength > bestPrefixLength && addr.match(cidr)) {
      best = globallyReachable;
      bestPrefixLength = prefixLength;
    }
  }
  return best;
}

/**
 * Returns true if `ip` is a global-unicast address — reachable in principle
 * over the public Internet, per the IANA IPv4/IPv6 Special-Purpose Address
 * Registries — and false for every address matching a special-purpose row
 * whose registry-published "Globally Reachable" value is not `true`. This is
 * an ALLOW policy, not a deny policy: an address is denied only by matching a
 * row explicitly marked non-globally-reachable in the vendored registry
 * snapshot (`server/iana-special-purpose-registry.js`), and allowed by
 * default otherwise — NOT allowed by matching some third-party library's
 * catch-all `unicast` classification, which is the mistake this
 * implementation replaces (see the research doc cited in this file's module
 * comment for why: a prior revision built this policy on `ipaddr.js`'s own
 * `range()` result, which silently passed several IANA rows the library's
 * hardcoded table predates).
 *
 * Handles every mapped/tunneled representation:
 *  - IPv4-mapped IPv6 (`::ffff:a.b.c.d`, hex form, fully-expanded form) is
 *    unwrapped to its embedded IPv4 by `ipaddr.process()` (a parsing
 *    normalization, not a policy judgment) and classified as that address.
 *  - 6to4 (`2002::/16`) is DENIED OUTRIGHT, unconditionally — the registry's
 *    own Globally Reachable value for this block is `N/A`, not `true`; it is
 *    not registry-affirmed reachable regardless of the embedded IPv4
 *    payload.
 *  - NAT64/RFC 6052 GLOBAL-USE (`64:ff9b::/96` exactly) IS registry-affirmed
 *    reachable and has its embedded IPv4 payload unwrapped and recursively
 *    checked. NAT64 LOCAL-USE (`64:ff9b:1::/48`, RFC 8215) is a distinct,
 *    non-overlapping CIDR block and is denied outright via the general
 *    table, with no unwrapping — it is not registry-affirmed reachable
 *    either way.
 *  - Teredo (`2001::/32`) is denied outright via the general table — its
 *    embedded client/server address is XOR-obscured and not a meaningful
 *    "destination" for this check even if it were unwrapped.
 */
export function isGlobalUnicastAddress(ip) {
  const raw = String(ip || '').trim();
  if (!raw) return false;

  let addr;
  try {
    addr = ipaddr.process(raw);
  } catch {
    return false;
  }

  if (addr.kind() === 'ipv6') {
    if (addr.match(SIX_TO_FOUR_CIDR)) return false;
    if (addr.match(NAT64_GLOBAL_USE_CIDR)) {
      const embedded = extractEmbeddedIpv4(addr, 12);
      return embedded !== null && isGlobalUnicastAddress(embedded);
    }
    const globallyReachable = lookupSpecialPurposeRow(addr, IPV6_CIDR_TABLE);
    return globallyReachable === null ? true : globallyReachable === true;
  }

  const globallyReachable = lookupSpecialPurposeRow(addr, IPV4_CIDR_TABLE);
  return globallyReachable === null ? true : globallyReachable === true;
}

/**
 * Legacy alias retained for call-site continuity:
 * `isForbiddenIp(ip) === !isGlobalUnicastAddress(ip)`. New code should prefer
 * `isGlobalUnicastAddress` directly — the allow-list framing is the actual
 * policy; the deny-list ("forbidden") framing is what produced the P1
 * false-pass gap this rewrite closes (`192.0.0.1`, `198.18.0.1`, TEST-NET-1/2/3
 * all passed a hand-maintained "is this on my list of known-bad ranges?"
 * check because they were never added to the list).
 */
export function isForbiddenIp(ip) {
  return !isGlobalUnicastAddress(ip);
}

/**
 * Resolve `hostname` and classify every returned address against the
 * global-unicast allow policy, bounded to `maxAddresses`
 * (`MAX_VALIDATED_ADDRESSES` by default).
 *
 * Returns `{ ok: true, addresses }` (the literal resolved address strings,
 * `addresses.length <= maxAddresses`) when every address is global-unicast
 * and the DNS answer did not exceed the cap, or `{ ok: false, kind, ... }`
 * when resolution failed (`kind: 'dns_failed'`), returned nothing
 * (`kind: 'no_addresses'`), returned more addresses than the cap
 * (`kind: 'too_many_addresses'`, with `count`/`max` — fails closed; the
 * answer is rejected in full rather than silently truncated to a prefix), or
 * a resolved address is not global-unicast (`kind: 'forbidden_address'`, with
 * the offending `address`). Callers combine this with their own
 * scheme/exemption policy (e.g. skipping the check entirely for a sanctioned
 * loopback dev host) and their own error-message wording — this function
 * only resolves, bounds, and classifies; it does not format messages or know
 * about exemptions.
 */
export async function resolveAllowedAddresses(
  hostname,
  {
    dnsLookupImpl = dnsLookup,
    isGlobalUnicastAddressImpl = isGlobalUnicastAddress,
    maxAddresses = MAX_VALIDATED_ADDRESSES,
  } = {},
) {
  let addrs;
  try {
    addrs = await dnsLookupImpl(hostname, { all: true });
  } catch {
    return { ok: false, kind: 'dns_failed' };
  }
  if (!addrs || addrs.length === 0) {
    return { ok: false, kind: 'no_addresses' };
  }
  if (addrs.length > maxAddresses) {
    return { ok: false, kind: 'too_many_addresses', count: addrs.length, max: maxAddresses };
  }
  for (const addr of addrs) {
    if (!isGlobalUnicastAddressImpl(addr.address)) {
      return { ok: false, kind: 'forbidden_address', address: addr.address };
    }
  }
  return { ok: true, addresses: addrs.map((a) => a.address) };
}

// Bare TCP/TLS connector (no lookup override) — used by the undici pinned
// dispatcher to open sockets directly to addresses that have already been
// validated. Built once; cheap and stateless (undici's buildConnector
// returns a plain function, not a pool).
const rawConnect = buildConnector({});

/**
 * Build a `(opts, callback) => void` connector that dials only the literal
 * addresses in `validatedAddresses` (already bounded by
 * `resolveAllowedAddresses` in every production call chain — see
 * `MAX_VALIDATED_ADDRESSES`), trying each in order on failure — bounded,
 * ordered fallback — and never re-derives an address from a hostname.
 * `dialOne(address, opts, callback)` performs the actual per-transport
 * connection attempt (undici's raw connector for `createPinnedDispatcher`,
 * `node:tls.connect` for `createPinnedHttpsAgent`).
 *
 * This connector ALSO re-enforces `MAX_VALIDATED_ADDRESSES` itself, on
 * `validatedAddresses.length`, independent of whether the caller already
 * bounded the list — belt-and-suspenders: every production caller does
 * bound it via `resolveAllowedAddresses` before ever reaching this function,
 * but the connector factories (`createPinnedDispatcher`,
 * `createPinnedHttpsAgent`) are exported and could in principle be called
 * with an unbounded list directly. Only the FIRST `MAX_VALIDATED_ADDRESSES`
 * entries are attempted if more are supplied — a defensive limit at the
 * connector layer, not a substitute for `resolveAllowedAddresses`'s own
 * fail-closed rejection of an oversized DNS answer (which is unconditional,
 * not a truncation).
 *
 * SINGLE-SETTLEMENT: the outer `callback` is invoked at most once, no matter
 * how many times `dialOne`'s inner callback fires. This matters because
 * `dialOne` implementations are not themselves guaranteed single-settlement
 * (see `createPinnedHttpsAgent`'s TLS adapter, which settles per-attempt but
 * whose underlying socket can still emit a late event after that attempt's
 * callback already fired) — `boundedFallbackConnect` is the last line of
 * defense against a double-fire propagating into "fall back after success"
 * or "report success after fallback already started; two open sockets."
 * Once settled, any further success is destroyed (not silently dropped —
 * `destroy()` releases the underlying resource) rather than propagated or
 * ignored, and fallback never advances past a settled outcome.
 */
function boundedFallbackConnect(validatedAddresses, dialOne) {
  const boundedAddresses = validatedAddresses.slice(0, MAX_VALIDATED_ADDRESSES);
  return (opts, callback) => {
    let index = 0;
    let settled = false;
    const attemptNext = (lastErr) => {
      if (settled) return;
      const address = boundedAddresses[index++];
      if (address === undefined) {
        settled = true;
        callback(lastErr ?? new Error('no validated address could be connected to'), null);
        return;
      }
      dialOne(address, opts, (err, socket) => {
        if (settled) {
          // A late/duplicate callback after this connector already settled
          // (e.g. a socket that fires success then later errors, or vice
          // versa) — never advance fallback or re-report past settlement.
          // A stray successful socket arriving here must be destroyed, not
          // silently ignored, so it does not leak an open connection.
          if (!err && socket && typeof socket.destroy === 'function') {
            socket.destroy();
          }
          return;
        }
        if (err) {
          attemptNext(err);
          return;
        }
        settled = true;
        callback(null, socket);
      });
    };
    attemptNext(null);
  };
}

/**
 * Build an `undici.Agent` whose `connect` dials only the literal addresses in
 * `validatedAddresses` (bounded, ordered fallback — see
 * `boundedFallbackConnect`). `servername` is preserved as the connecting
 * request's own hostname (passed through unchanged by undici) so TLS SNI and
 * certificate hostname verification are unaffected by pinning to an IP.
 *
 * This is what makes the validated address and the connected address the
 * same value by construction: pass the returned Agent as `fetch`'s
 * `dispatcher` and there is no second, independent hostname resolution left
 * for a DNS-rebinding attacker to race.
 */
export function createPinnedDispatcher(validatedAddresses) {
  return new UndiciAgent({
    connect: boundedFallbackConnect(validatedAddresses, (address, opts, cb) => {
      const servername = opts.servername || opts.hostname;
      rawConnect({ ...opts, hostname: address, servername }, cb);
    }),
  });
}

/**
 * Attempt a single TLS connection to `address`, settling `cb` at most once
 * for THIS attempt (independent of `boundedFallbackConnect`'s own outer
 * single-settlement guard — both layers matter: this one prevents a single
 * socket's `secureConnect`-then-`error` (or `error`-then-late-`secureConnect`)
 * ordering from ever invoking `cb` twice for the same attempt in the first
 * place; `boundedFallbackConnect` is the second line of defense in case a
 * caller of `dialOne` were ever less careful).
 *
 * On settlement, the listener for the event that did NOT fire is removed
 * immediately (`secureConnect` settling removes the `error` listener and vice
 * versa) — so a later event on the same socket cannot re-invoke `cb`. On the
 * error path, the socket is destroyed (a handshake that never completed has
 * no connection worth keeping). On success, ownership of the socket passes to
 * the caller; this function does not destroy it.
 */
function dialTlsOnce(address, opts, cb) {
  const servername = opts.servername || opts.host;
  const socket = tls.connect({ ...opts, host: address, servername });
  let settled = false;
  const onSecureConnect = () => {
    if (settled) return;
    settled = true;
    socket.removeListener('error', onError);
    cb(null, socket);
  };
  const onError = (err) => {
    if (settled) return;
    settled = true;
    socket.removeListener('secureConnect', onSecureConnect);
    socket.destroy();
    cb(err, null);
  };
  socket.once('secureConnect', onSecureConnect);
  socket.once('error', onError);
}

/**
 * Build a `node:https.Agent` subclass whose `createConnection` dials only the
 * literal addresses in `validatedAddresses` (bounded, ordered fallback), for
 * callers that use Node's core `https` module directly rather than
 * `fetch`/undici (specifically: the `web-push` npm package, which issues
 * `https.request` internally and accepts a caller-supplied `agent` — the
 * library validates it with `instanceof https.Agent`, so this must be a real
 * subclass, not a duck-typed object). `servername` is preserved as the
 * connecting request's own hostname for TLS SNI/certificate verification,
 * matching `createPinnedDispatcher`.
 *
 * `createConnection` returns `undefined` and signals completion via the
 * `callback(err, socket)` parameter — Node's `https.Agent` supports both the
 * synchronous-return and asynchronous-callback conventions; the callback form
 * is required here because bounded fallback across multiple addresses is
 * inherently asynchronous (must wait for one attempt to fail before trying
 * the next).
 */
export function createPinnedHttpsAgent(validatedAddresses, agentOptions = {}) {
  class PinnedHttpsAgent extends https.Agent {
    createConnection(options, callback) {
      const connect = boundedFallbackConnect(validatedAddresses, dialTlsOnce);
      connect(options, callback);
    }
  }
  return new PinnedHttpsAgent(agentOptions);
}
