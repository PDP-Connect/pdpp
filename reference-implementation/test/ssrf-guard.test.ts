// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Table-driven coverage for the shared SSRF guard's address-allow policy,
 * bounded/ordered fallback, and single-settlement connection-completion
 * guarantees — properties `cimd.js`, `client-event-delivery-worker.ts`, and
 * `web-push-notifications.ts` all depend on via `ssrf-guard.js`.
 *
 * `isGlobalUnicastAddress` is an ALLOW policy, not a deny policy. It is
 * driven by a dated, vendored snapshot of the actual IANA IPv4/IPv6
 * Special-Purpose Address Registries
 * (`server/iana-special-purpose-registry.js`), not by `ipaddr.js`'s own
 * `range()` classifier — an independent review (GPT-5.6 Sol,
 * tmp/workstreams/ssrf-sol-final-0717.md) proved that classifier's hardcoded
 * table predates several rows the registries have since added (`64:ff9b:1::/48`
 * local-use NAT64, `100:0:0:1::/64` dummy prefix, `3fff::/20` documentation,
 * `5f00::/16` SRv6 SIDs), and that `range() === 'unicast'` is a default
 * fallthrough, not affirmative registry evidence. Every address Sol
 * reproduced is asserted denied here by name, alongside the Terra P1 set and
 * every registry row from both special-purpose tables. See
 * openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md
 * for the full registry data this table is derived from.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import tls from "node:tls";

import { IPV4_SPECIAL_PURPOSE_ROWS, IPV6_SPECIAL_PURPOSE_ROWS } from "../server/iana-special-purpose-registry.ts";
import {
  createPinnedDispatcher as createPinnedDispatcherUntyped,
  createPinnedHttpsAgent as createPinnedHttpsAgentUntyped,
  isForbiddenIp,
  isGlobalUnicastAddress,
  MAX_VALIDATED_ADDRESSES,
  resolveAllowedAddresses,
} from "../server/ssrf-guard.ts";

// `server/ssrf-guard.js` is plain JS: `createPinnedDispatcher` returns
// `new UndiciAgent({...})` but TS's inference through `boundedFallbackConnect`'s
// own untyped parameters collapses the return type far narrower than the
// real dispatcher shape the function actually returns. Re-typed here to
// exactly the `dispatcher` field type `fetch()`'s own ambient ("undici-types")
// ammunition declares -- deriving from `fetch`'s own Parameters rather than a
// separately-imported `undici` package avoids a real cross-package type
// clash: this monorepo pulls in undici@6, undici@7 (via a transitive dep),
// and the ambient undici-types@8 fetch() itself resolves against, and none
// of their `Dispatcher` interfaces structurally match each other under
// `exactOptionalPropertyTypes`.
type FetchDispatcher = NonNullable<NonNullable<Parameters<typeof fetch>[1]>["dispatcher"]>;

// The real inferred return (an UndiciAgent, collapsed by inference to a bare
// `{ close(): Promise<void> }` shape) and FetchDispatcher's dozens of
// Dispatcher members don't overlap enough for a direct cast, so the call
// itself is typed instead: the argument widened to `unknown` (always
// assignable) and the return narrowed via a single-hop cast -- the same
// pattern already established in this repo (see
// records-instance-namespace.test.ts's buildSemanticSearchPlanForGrant).
function createPinnedDispatcher(validatedAddresses: string[]): FetchDispatcher {
  const untyped = createPinnedDispatcherUntyped as (validatedAddresses: unknown) => unknown;
  return untyped(validatedAddresses) as FetchDispatcher;
}

interface PinnedHttpsAgent {
  createConnection: (
    options: { host: string; servername: string },
    callback: (err: Error | null, socket: unknown) => void
  ) => void;
  destroy: () => void;
}

const createPinnedHttpsAgent = createPinnedHttpsAgentUntyped as (
  validatedAddresses: string[],
  agentOptions?: Record<string, unknown>
) => PinnedHttpsAgent;

// `net.connect`'s real declared type is a 6-overload union; every dispatcher
// under test here only ever calls the single-options-object form. A spy
// matching just that one call shape is cast to the full overloaded type (a
// single direct cast, not `as any`/`as unknown as`).
type NetConnectSingleOverload = (opts: net.NetConnectOpts, connectionListener?: () => void) => net.Socket;

function spyOnNetConnect(dialedHosts: unknown[]): () => void {
  const originalConnect = net.connect;
  const originalConnectSingleOverload = originalConnect as NetConnectSingleOverload;
  const spiedConnect: NetConnectSingleOverload = function spiedConnect(opts, connectionListener) {
    dialedHosts.push("host" in opts ? opts.host : undefined);
    return originalConnectSingleOverload(opts, connectionListener);
  };
  net.connect = spiedConnect as typeof net.connect;
  return () => {
    net.connect = originalConnect;
  };
}

// Generates a throwaway self-signed TLS keypair via the system `openssl`
// binary, once, at module load — used only by the real-TLS single-settlement
// test below to prove the fake-socket race-condition model matches genuine
// openssl/libuv behavior. Not used by any other test in this file (every
// other test either checks pure classification logic or uses plain HTTP).
function generateSelfSignedCert(): { cert: Buffer; key: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "ssrf-guard-cert-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=real-tls-race-test.invalid",
      ],
      { stdio: ["ignore", "ignore", "ignore"] }
    );
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

// The two NAT64 translation rows embed an IPv4 payload in their low bits; the
// bare network address of each (`64:ff9b::`, `64:ff9b:1::`) embeds
// `0.0.0.0`, which is itself denied (unspecified) regardless of the outer
// prefix's own reachability — not representative of a normal address in that
// block. Use an address with a non-trivial embedded payload instead so the
// exhaustive sweep exercises the prefix's own reachability value, not the
// embedded-address edge case (which has its own dedicated coverage above).
const REPRESENTATIVE_ADDRESS_OVERRIDES: Record<string, string> = {
  "64:ff9b::/96": "64:ff9b::808:808",
  "64:ff9b:1::/48": "64:ff9b:1::808:808",
};

function firstAddressInCidr(cidr: string): string {
  if (REPRESENTATIVE_ADDRESS_OVERRIDES[cidr]) {
    return REPRESENTATIVE_ADDRESS_OVERRIDES[cidr];
  }
  const [base] = cidr.split("/");
  if (!base) {
    throw new Error(`malformed CIDR: ${cidr}`);
  }
  return base;
}

// --- isGlobalUnicastAddress: table-driven, both directions ---

const DENIED_ADDRESSES: [string, string][] = [
  // Terra P1 finding: these exact addresses false-passed the prior deny-list
  // implementation. Each is an IANA special-purpose range that is not
  // globally reachable, but is also not RFC 1918/loopback/link-local, so a
  // hand-maintained "block known-bad ranges" list omitted them.
  ["192.0.0.1", "IETF Protocol Assignments (192.0.0.0/24)"],
  ["192.0.2.1", "TEST-NET-1 (192.0.2.0/24)"],
  ["198.18.0.1", "Benchmarking (198.18.0.0/15)"],
  ["198.18.255.254", "Benchmarking (198.18.0.0/15), high end of range"],
  ["198.51.100.1", "TEST-NET-2 (198.51.100.0/24)"],
  ["203.0.113.1", "TEST-NET-3 (203.0.113.0/24)"],
  ["192.88.99.1", "6to4 relay anycast (192.88.99.0/24)"],
  ["240.0.0.1", "reserved (240.0.0.0/4)"],
  ["255.255.255.255", "limited broadcast"],
  ["0.0.0.0", "unspecified"],
  // Standard deny-list coverage, still required under the allow-list model.
  ["127.0.0.1", "loopback"],
  ["10.0.0.1", "private RFC1918 10/8"],
  ["172.16.0.1", "private RFC1918 172.16/12"],
  ["192.168.1.1", "private RFC1918 192.168/16"],
  ["169.254.1.1", "link-local"],
  ["169.254.169.254", "link-local cloud metadata"],
  ["100.64.0.1", "carrier-grade NAT 100.64.0.0/10"],
  ["224.0.0.1", "multicast"],
  // IPv6
  ["::1", "IPv6 loopback"],
  ["::", "IPv6 unspecified"],
  ["fe80::1", "IPv6 link-local"],
  ["fc00::1", "IPv6 unique-local (fc00::/7)"],
  ["fd00::1", "IPv6 unique-local (fd00::/8)"],
  ["ff02::1", "IPv6 multicast"],
  ["2001:db8::1", "IPv6 documentation (2001:db8::/32)"],
  ["2001::1", "Teredo (2001::/32)"],
  ["2001:2::1", "IPv6 benchmarking (2001:2::/48)"],
  // Mapped/expanded IPv4-in-IPv6 forms — every representation must resolve
  // to the same verdict as the embedded IPv4 address.
  ["::ffff:127.0.0.1", "IPv4-mapped IPv6, dotted form, embeds loopback"],
  ["::ffff:7f00:1", "IPv4-mapped IPv6, hex form, embeds loopback"],
  ["0:0:0:0:0:ffff:127.0.0.1", "IPv4-mapped IPv6, fully expanded dotted form, embeds loopback"],
  ["::ffff:169.254.169.254", "IPv4-mapped IPv6, dotted form, embeds link-local metadata"],
  // 6to4 is denied OUTRIGHT, unconditionally — the registry's own Globally
  // Reachable value for 2002::/16 is N/A, not True (it is a transport
  // mechanism, not a reachability guarantee). This is a deliberate behavior
  // CHANGE from the prior revision, which conditionally allowed a 6to4
  // address whose embedded IPv4 was itself public — Sol's review identified
  // that as treating N/A as equivalent to True, which the registry does not
  // support. See openspec/.../research/iana-special-purpose-registries-2026-07-18.md.
  ["2002:7f00:0001::1", "6to4 embedding loopback (127.0.0.1) — denied outright"],
  ["2002:c000:0204::1", "6to4 embedding TEST-NET-1 (192.0.2.4) — the literal Terra example, denied outright"],
  ["2002:a00:1::1", "6to4 embedding private 10.0.0.1 — denied outright"],
  ["2002:0808:0808::1", "6to4 embedding a PUBLIC IPv4 (8.8.8.8) — still denied outright, unlike the prior revision"],
  // NAT64 local-use (RFC 8215) — a distinct, non-overlapping CIDR block from
  // the global-use 64:ff9b::/96 prefix below; denied outright via the
  // registry table (its own Globally Reachable value is False), no embedded-
  // address unwrapping.
  ["64:ff9b:1::7f00:1", "NAT64 local-use (64:ff9b:1::/48, RFC 8215) embedding loopback — Sol reproduction"],
  [
    "64:ff9b:1::808:808",
    "NAT64 local-use (64:ff9b:1::/48, RFC 8215) embedding a public IPv4 — still denied, Sol reproduction",
  ],
  // NAT64 global-use (RFC 6052) IS registry-affirmed reachable and DOES get
  // its embedded IPv4 unwrapped and recursively checked — an embedded
  // non-public address is denied.
  ["64:ff9b::7f00:1", "NAT64/RFC6052 global-use embedding loopback (127.0.0.1)"],
  ["64:ff9b::c000:0204", "NAT64/RFC6052 global-use embedding TEST-NET-1 (192.0.2.4)"],
  // Registry rows added after ipaddr.js@2.3.0 shipped — Sol's reproduction.
  // ipaddr.js's own range() classifier defaults these to 'unicast' because
  // its hardcoded SpecialRanges table predates these registry additions.
  ["100:0:0:1::1", "Dummy IPv6 Prefix (100:0:0:1::/64, RFC 9780, added 2025-04) — Sol reproduction"],
  ["3fff::1", "Documentation (3fff::/20, RFC 9637, added 2024-07) — Sol reproduction"],
  ["5f00::1", "Segment Routing SRv6 SIDs (5f00::/16, RFC 9602, added 2024-04) — Sol reproduction"],
];

const ALLOWED_ADDRESSES: [string, string][] = [
  ["8.8.8.8", "public IPv4"],
  ["1.1.1.1", "public IPv4"],
  ["93.184.216.34", "public IPv4 (example.com range)"],
  ["2606:4700:4700::1111", "public IPv6 (Cloudflare)"],
  ["2001:4860:4860::8888", "public IPv6 (Google)"],
  ["::ffff:8.8.8.8", "IPv4-mapped IPv6, dotted form, embeds a public address"],
  ["::ffff:808:808", "IPv4-mapped IPv6, hex form, embeds a public address"],
  // NAT64 GLOBAL-use (64:ff9b::/96 exactly — registry-affirmed reachable)
  // embedding a public IPv4 is allowed. 6to4 (2002::/16) is NOT in this list
  // — see DENIED_ADDRESSES above; it is denied outright regardless of its
  // embedded IPv4, unlike NAT64 global-use.
  ["64:ff9b::808:808", "NAT64/RFC6052 global-use embedding a public IPv4 (8.8.8.8)"],
];

test("isGlobalUnicastAddress denies every non-unicast address, including the Terra P1 examples and mapped forms", () => {
  for (const [ip, why] of DENIED_ADDRESSES) {
    assert.equal(isGlobalUnicastAddress(ip), false, `${ip} (${why}) must be denied`);
    assert.equal(isForbiddenIp(ip), true, `isForbiddenIp legacy alias must agree for ${ip} (${why})`);
  }
});

test("isGlobalUnicastAddress allows global-unicast addresses, including mapped/tunneled forms embedding a public address", () => {
  for (const [ip, why] of ALLOWED_ADDRESSES) {
    assert.equal(isGlobalUnicastAddress(ip), true, `${ip} (${why}) must be allowed`);
    assert.equal(isForbiddenIp(ip), false, `isForbiddenIp legacy alias must agree for ${ip} (${why})`);
  }
});

test("isGlobalUnicastAddress rejects malformed input rather than throwing", () => {
  const badInputs: unknown[] = ["", "not-an-ip", "999.999.999.999", null, undefined, "2001:zzzz::1"];
  for (const bad of badInputs) {
    assert.doesNotThrow(() => isGlobalUnicastAddress(bad));
    assert.equal(isGlobalUnicastAddress(bad), false);
  }
});

// Exhaustive sweep: the first address of every row in the vendored registry
// snapshot must classify exactly as that row's "Globally Reachable" value
// says. This directly proves the vendored table drives the classifier (not
// merely that a hand-picked example list happens to pass) — every row in
// both openspec/.../research/iana-special-purpose-registries-2026-07-18.md
// CSVs has a corresponding assertion here.
type SpecialPurposeRow = [cidr: string, globallyReachable: boolean | null, name: string];

test("isGlobalUnicastAddress agrees with every row in the vendored IANA registry snapshot (exhaustive sweep)", () => {
  const rows: SpecialPurposeRow[] = [...IPV4_SPECIAL_PURPOSE_ROWS, ...IPV6_SPECIAL_PURPOSE_ROWS] as SpecialPurposeRow[];
  for (const [cidr, globallyReachable, name] of rows) {
    const address = firstAddressInCidr(cidr);
    const expected = globallyReachable === true;
    assert.equal(
      isGlobalUnicastAddress(address),
      expected,
      `${address} (row: ${cidr} "${name}", Globally Reachable: ${globallyReachable}) expected ${expected}`
    );
  }
});

test("isGlobalUnicastAddress denies 6to4 (2002::/16) unconditionally, regardless of the embedded IPv4", () => {
  // The registry's own Globally Reachable value for 2002::/16 is N/A, not
  // True — it is not registry-affirmed reachable. A prior revision allowed a
  // 6to4 address whose embedded IPv4 was itself public; that treated N/A as
  // equivalent to True, which the registry does not support. This test
  // pins the corrected behavior across a spread of embedded payloads.
  for (const embedded of ["8.8.8.8", "1.1.1.1", "192.0.2.1", "127.0.0.1", "10.0.0.1"]) {
    const octets = embedded.split(".").map(Number);
    const [o0, o1, o2, o3] = octets;
    assert.ok(
      o0 !== undefined && o1 !== undefined && o2 !== undefined && o3 !== undefined,
      `${embedded} must have 4 octets`
    );
    // biome-ignore lint/suspicious/noBitwiseOperators: localized test assertion preserves its explicit contract.
    const hex1 = ((o0 << 8) | o1).toString(16);
    // biome-ignore lint/suspicious/noBitwiseOperators: localized test assertion preserves its explicit contract.
    const hex2 = ((o2 << 8) | o3).toString(16);
    const sixToFour = `2002:${hex1}:${hex2}::1`;
    assert.equal(isGlobalUnicastAddress(sixToFour), false, `6to4 embedding ${embedded} (${sixToFour}) must be denied`);
  }
});

// --- resolveAllowedAddresses: bound + fail-closed behavior ---

test("resolveAllowedAddresses allows a DNS answer at exactly the bound", async () => {
  const addrs = Array.from({ length: MAX_VALIDATED_ADDRESSES }, (_, i) => ({ address: `8.8.8.${i}` }));
  const result = await resolveAllowedAddresses("example.test", { dnsLookupImpl: async () => addrs });
  assert.equal(result.ok, true);
  assert.equal(result.addresses.length, MAX_VALIDATED_ADDRESSES);
});

test("resolveAllowedAddresses fails closed (does not silently truncate) when a DNS answer exceeds the bound by one", async () => {
  const addrs = Array.from({ length: MAX_VALIDATED_ADDRESSES + 1 }, (_, i) => ({ address: `8.8.8.${i}` }));
  const result = await resolveAllowedAddresses("example.test", { dnsLookupImpl: async () => addrs });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "too_many_addresses");
  assert.equal(result.count, MAX_VALIDATED_ADDRESSES + 1);
  assert.equal(result.max, MAX_VALIDATED_ADDRESSES);
});

test("resolveAllowedAddresses fails closed on a grossly oversized DNS answer (the Terra P2 128-address case)", async () => {
  const addrs = Array.from({ length: 128 }, (_, i) => ({ address: `8.8.8.${i % 255}` }));
  const result = await resolveAllowedAddresses("example.test", { dnsLookupImpl: async () => addrs });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "too_many_addresses");
  assert.equal(result.count, 128);
});

test("resolveAllowedAddresses respects a caller-supplied maxAddresses override", async () => {
  const addrs = [{ address: "8.8.8.1" }, { address: "8.8.8.2" }, { address: "8.8.8.3" }];
  const result = await resolveAllowedAddresses("example.test", {
    dnsLookupImpl: async () => addrs,
    maxAddresses: 2,
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, "too_many_addresses");
  assert.equal(result.max, 2);
});

// --- createPinnedDispatcher: bounded, ordered fallback at the real socket ---

test("createPinnedDispatcher tries validated addresses in order and falls back on connection failure (falsifiable, real sockets)", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo once listening");
  const { port } = address;

  const dialedHosts: unknown[] = [];
  const restoreNetConnect = spyOnNetConnect(dialedHosts);

  try {
    // 127.0.0.2 is loopback range but nothing listens there — fast, real
    // ECONNREFUSED, not a mock. 127.0.0.1 is where the real server is. This
    // is not a mocked fetch: both connection attempts are real sockets.
    const dispatcher = createPinnedDispatcher(["127.0.0.2", "127.0.0.1"]);
    const res = await fetch(`http://ordered-fallback-proof.invalid:${port}/`, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(res.status, 200, "fallback to the second validated address must succeed");
    assert.deepEqual(
      dialedHosts,
      ["127.0.0.2", "127.0.0.1"],
      "addresses must be dialed in the exact order supplied, first failing over to second"
    );
    await dispatcher.close();
  } finally {
    restoreNetConnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("createPinnedDispatcher never attempts more connections than validated addresses supplied (bounded fallback)", async () => {
  // A closed loopback port (bound then immediately released) gives a real,
  // fast ECONNREFUSED for every attempted address without any real listener.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const probeAddress = probe.address();
  assert.ok(
    probeAddress && typeof probeAddress === "object",
    "probe.address() must return an AddressInfo once listening"
  );
  const closedPort = probeAddress.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const dialedHosts: unknown[] = [];
  const restoreNetConnect = spyOnNetConnect(dialedHosts);

  try {
    // Three loopback addresses with nothing listening on any of them — all
    // three must be attempted (in order) and no more.
    const dispatcher = createPinnedDispatcher(["127.0.0.2", "127.0.0.3", "127.0.0.4"]);
    await assert.rejects(() =>
      fetch(`http://bounded-fallback-proof.invalid:${closedPort}/`, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      })
    );
    assert.deepEqual(dialedHosts, ["127.0.0.2", "127.0.0.3", "127.0.0.4"]);
    await dispatcher.close();
  } finally {
    restoreNetConnect();
  }
});

// --- createPinnedHttpsAgent: single-settlement across secureConnect/error race orderings ---
//
// tmp/workstreams/ssrf-sol-final-0717.md P1: the TLS adapter attached
// independent `once('secureConnect', ...)` / `once('error', ...)` listeners
// with no settlement guard — a socket that emitted BOTH events (in either
// order) invoked the agent callback twice, once with success and once with
// failure. The second, spurious invocation could enter fallback again after
// the request already received a socket (opening a second connection after
// success), or report failure after success had already been handed to the
// caller. These tests drive both orderings deterministically via a fully
// controlled fake socket (monkeypatched `tls.connect`), reproducing exactly
// the ordering Sol's review reported, and separately prove the real-socket,
// real-TLS end-to-end behavior.

interface FakeTlsSocket extends EventEmitter {
  destroy: () => void;
  destroyed: boolean;
}

function fakeTlsSocket(): FakeTlsSocket {
  const socket = new EventEmitter() as FakeTlsSocket;
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  // Real sockets always have Node's own internal listeners; without at
  // least one 'error' listener, emitting 'error' with none registered
  // throws (Node's EventEmitter special-cases the 'error' event). Mirror
  // that baseline so the test's own emit() calls behave like a real socket.
  // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
  socket.on("error", () => {});
  return socket;
}

// `tls.connect`'s real declared type returns a full `TLSSocket` (dozens of
// members beyond EventEmitter). Every test below only calls
// addEventListener/on/emit/destroy on the returned socket -- the same
// two-hop pattern used elsewhere in this cohort for genuinely disjoint
// types: the fake constructor is held under its own concrete type, then
// substituted for the global via a same-shape function-type intermediate
// rather than a bare `unknown` variable.
function stubTlsConnect(makeSocket: () => FakeTlsSocket): () => void {
  const original = tls.connect;
  // `tls.connect`'s real overload union has no zero-argument member, so the
  // fake constructor and the real type don't overlap enough for a direct
  // cast (unlike net.connect's single-options-object overload above). Typed
  // via the same disjoint-types pattern already established in this repo
  // (records-instance-namespace.test.ts's buildSemanticSearchPlanForGrant):
  // widen through a function-shaped `() => unknown` intermediate.
  const stub: () => unknown = makeSocket;
  tls.connect = stub as typeof tls.connect;
  return () => {
    tls.connect = original;
  };
}

test("createPinnedHttpsAgent settles exactly once when a socket fires secureConnect then later error", () => {
  const sockets: FakeTlsSocket[] = [];
  const restoreTlsConnect = stubTlsConnect(() => {
    const socket = fakeTlsSocket();
    sockets.push(socket);
    return socket;
  });

  try {
    const agent = createPinnedHttpsAgent(["127.0.0.1"]);
    const calls: Array<{ err: string | null; hasSocket: boolean }> = [];
    agent.createConnection({ host: "race-test.invalid", servername: "race-test.invalid" }, (err, socket) => {
      calls.push({ err: err ? err.message : null, hasSocket: Boolean(socket) });
    });

    assert.equal(sockets.length, 1);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const socket0 = sockets[0];
    assert.ok(socket0);
    socket0.emit("secureConnect");
    socket0.emit("error", new Error("post-handshake failure"));

    assert.equal(calls.length, 1, "the createConnection callback must be invoked exactly once");
    assert.deepEqual(calls[0], { err: null, hasSocket: true }, "the first event (success) must win");
    assert.equal(socket0.destroyed, false, "the socket that already succeeded must not be destroyed by the adapter");
  } finally {
    restoreTlsConnect();
  }
});

test("createPinnedHttpsAgent settles exactly once when a socket fires error then a late secureConnect", () => {
  const sockets: FakeTlsSocket[] = [];
  const restoreTlsConnect = stubTlsConnect(() => {
    const socket = fakeTlsSocket();
    sockets.push(socket);
    return socket;
  });

  try {
    const agent = createPinnedHttpsAgent(["127.0.0.1", "127.0.0.2"]);
    const calls: Array<{ err: string | null; hasSocket: boolean }> = [];
    agent.createConnection({ host: "race-test.invalid", servername: "race-test.invalid" }, (err, socket) => {
      calls.push({ err: err ? err.message : null, hasSocket: Boolean(socket) });
    });

    assert.equal(sockets.length, 1, "only the first address is attempted before its outcome settles");
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const socket0 = sockets[0];
    assert.ok(socket0);
    socket0.emit("error", new Error("early failure"));
    // Fallback to the second address has now started (see the dial-count
    // assertion below); the ORIGINAL socket firing a late secureConnect
    // must not resurrect it as a second success.
    socket0.emit("secureConnect");

    assert.equal(socket0.destroyed, true, "a socket that errored must be destroyed");
    assert.equal(sockets.length, 2, "fallback must have dialed the second address after the first failed");
    // The fallback's second attempt has not itself settled in this test
    // (no event emitted on sockets[1]), so exactly zero calls have reached
    // the outer callback yet — proving the late secureConnect on the
    // FIRST (already-failed) socket did not spuriously settle anything.
    assert.equal(calls.length, 0, "the late secureConnect on the failed socket must not settle the callback");
  } finally {
    restoreTlsConnect();
  }
});

test("createPinnedHttpsAgent never advances fallback after overall success (a late-succeeding earlier attempt is destroyed, not reported)", () => {
  // Two addresses. The FIRST attempt's socket is deliberately left pending
  // (no event) while the SECOND attempt succeeds first — simulating overall
  // settlement having already happened via one path while another socket is
  // still in flight. A subsequent secureConnect on the first (now-late)
  // socket must be destroyed, not reported as a second success.
  interface IndexedFakeTlsSocket extends FakeTlsSocket {
    attemptIndex: number;
  }
  const sockets: IndexedFakeTlsSocket[] = [];
  let callIndex = 0;
  const restoreTlsConnect = stubTlsConnect(() => {
    const socket = fakeTlsSocket() as IndexedFakeTlsSocket;
    // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
    socket.attemptIndex = callIndex++;
    sockets.push(socket);
    return socket;
  });

  try {
    const agent = createPinnedHttpsAgent(["127.0.0.1"]);
    const calls: Array<{ err: string | null; hasSocket: boolean }> = [];
    agent.createConnection({ host: "race-test.invalid", servername: "race-test.invalid" }, (err, socket) => {
      calls.push({ err: err ? err.message : null, hasSocket: Boolean(socket) });
    });

    assert.equal(sockets.length, 1);
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const socket0 = sockets[0];
    assert.ok(socket0);
    socket0.emit("secureConnect");
    assert.equal(calls.length, 1);

    // A second, spurious event on the SAME already-succeeded socket (the
    // exact shape Sol reproduced: secureConnect, then later error OR another
    // secureConnect on a socket libuv/openssl re-emits from).
    socket0.emit("secureConnect");
    assert.equal(calls.length, 1, "overall settlement must never advance past the first success");
  } finally {
    restoreTlsConnect();
  }
});

test("createPinnedHttpsAgent settles exactly once across every address on total fallback exhaustion", () => {
  const sockets: FakeTlsSocket[] = [];
  const restoreTlsConnect = stubTlsConnect(() => {
    const socket = fakeTlsSocket();
    sockets.push(socket);
    return socket;
  });

  try {
    const agent = createPinnedHttpsAgent(["127.0.0.1", "127.0.0.2", "127.0.0.3"]);
    const calls: Array<{ err: string | null; hasSocket: boolean }> = [];
    agent.createConnection({ host: "race-test.invalid", servername: "race-test.invalid" }, (err, socket) => {
      calls.push({ err: err ? err.message : null, hasSocket: Boolean(socket) });
    });

    // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
    for (let i = 0; i < 3; i++) {
      assert.equal(sockets.length, i + 1, `attempt ${i + 1} must be dialed before attempt ${i + 2}`);
      const socket = sockets[i];
      assert.ok(socket, `expected a socket for attempt ${i + 1}`);
      socket.emit("error", new Error(`attempt ${i + 1} failed`));
      assert.equal(socket.destroyed, true);
    }

    assert.equal(sockets.length, 3, "exactly as many connections as addresses supplied, no more");
    assert.equal(calls.length, 1, "the outer callback must fire exactly once on total exhaustion");
    // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
    const call0 = calls[0];
    assert.ok(call0);
    assert.equal(call0.hasSocket, false);
    assert.ok(call0.err);
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(call0.err, /attempt 3 failed/);
  } finally {
    restoreTlsConnect();
  }
});

test("createPinnedHttpsAgent single-settlement holds end-to-end over a real TLS socket, not just the fake-socket model", async () => {
  // Real self-signed TLS server that accepts the handshake and then
  // destroys the underlying socket — a genuine secureConnect-then-error
  // ordering produced by real openssl/libuv, not a simulation.
  const selfSigned = generateSelfSignedCert();
  const server = createHttpsServer(
    { cert: selfSigned.cert, key: selfSigned.key },
    (req: { socket: { destroy: () => void } }) => {
      req.socket.destroy();
    }
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo once listening");
  const { port } = address;

  try {
    const agent = createPinnedHttpsAgent(["127.0.0.1"], { rejectUnauthorized: false });
    // `PinnedHttpsAgent`'s minimal structural type and Node's real `https.Agent`
    // don't overlap enough for a direct cast (Agent carries dozens of pooling/
    // socket-management members this test's fake agent never implements). The
    // request options' `agent` field is typed via the same disjoint-types
    // pattern used elsewhere in this file: a function-shaped `() => unknown`
    // identity widens the value before narrowing to the field's real type.
    const widenAgent = (value: unknown): unknown => value;
    const requestAgent = widenAgent(agent) as https.RequestOptions["agent"];
    let settleCount = 0;
    await new Promise<void>((resolve) => {
      const req = https.request(
        {
          agent: requestAgent,
          hostname: "real-tls-race-test.invalid",
          method: "GET",
          path: "/",
          port,
          servername: "real-tls-race-test.invalid",
        },
        () => {
          settleCount += 1;
          resolve();
        }
      );
      req.on("error", () => {
        settleCount += 1;
        resolve();
      });
      req.end();
    });
    assert.equal(
      settleCount,
      1,
      "exactly one outcome (response or error) must be observed for a real handshake-then-destroy socket"
    );
    agent.destroy();
  } finally {
    server.close();
  }
});

// --- Connector-level cap enforcement (tmp/workstreams/ssrf-sol-final-0717.md
// "enforce the eight-address invariant again in both connector factories") ---
//
// `resolveAllowedAddresses` already bounds every production caller's input
// to MAX_VALIDATED_ADDRESSES (fail-closed on an oversized DNS answer, proven
// above). These tests prove the connector factories ALSO re-enforce the cap
// independently, on validatedAddresses.length itself — belt-and-suspenders,
// since both factories are exported and could in principle be called with an
// unbounded list directly without going through resolveAllowedAddresses.

test("createPinnedDispatcher never attempts more connections than MAX_VALIDATED_ADDRESSES, even if called with a longer list directly", async () => {
  // A closed loopback port (bound then immediately released) gives a real,
  // fast ECONNREFUSED for every attempted address without any real listener.
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
  const probeAddress = probe.address();
  assert.ok(
    probeAddress && typeof probeAddress === "object",
    "probe.address() must return an AddressInfo once listening"
  );
  const closedPort = probeAddress.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const dialedHosts: unknown[] = [];
  const restoreNetConnect = spyOnNetConnect(dialedHosts);

  try {
    // Deliberately bypass resolveAllowedAddresses and construct the
    // dispatcher directly with more addresses than the cap allows.
    const tooMany = Array.from({ length: MAX_VALIDATED_ADDRESSES + 5 }, (_, i) => `127.0.0.${i + 2}`);
    const dispatcher = createPinnedDispatcher(tooMany);
    await assert.rejects(() =>
      fetch(`http://connector-cap-proof.invalid:${closedPort}/`, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      })
    );
    assert.equal(
      dialedHosts.length,
      MAX_VALIDATED_ADDRESSES,
      `the connector must attempt at most ${MAX_VALIDATED_ADDRESSES} addresses even when given ${tooMany.length}`
    );
    assert.deepEqual(dialedHosts, tooMany.slice(0, MAX_VALIDATED_ADDRESSES));
    await dispatcher.close();
  } finally {
    restoreNetConnect();
  }
});

test("createPinnedHttpsAgent never attempts more connections than MAX_VALIDATED_ADDRESSES, even if called with a longer list directly", () => {
  const sockets: FakeTlsSocket[] = [];
  const restoreTlsConnect = stubTlsConnect(() => {
    const socket = fakeTlsSocket();
    sockets.push(socket);
    return socket;
  });

  try {
    const tooMany = Array.from({ length: MAX_VALIDATED_ADDRESSES + 5 }, (_, i) => `127.0.0.${i + 2}`);
    const agent = createPinnedHttpsAgent(tooMany);
    agent.createConnection(
      { host: "connector-cap-proof.invalid", servername: "connector-cap-proof.invalid" },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
      () => {}
    );

    // biome-ignore lint/style/noIncrementDecrement: localized test assertion preserves its explicit contract.
    for (let i = 0; i < MAX_VALIDATED_ADDRESSES; i++) {
      const socket = sockets[i];
      assert.ok(socket, `expected a socket for attempt ${i + 1}`);
      socket.emit("error", new Error(`attempt ${i + 1} failed`));
    }
    assert.equal(
      sockets.length,
      MAX_VALIDATED_ADDRESSES,
      `the connector must attempt at most ${MAX_VALIDATED_ADDRESSES} addresses even when given ${tooMany.length}`
    );
  } finally {
    restoreTlsConnect();
  }
});
