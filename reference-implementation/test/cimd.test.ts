// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import tls from "node:tls";

import {
  CIMD_MAX_BODY_BYTES,
  type FetchCimdOptions,
  type FetchCimdResult,
  fetchCimdDocument,
  isCimdClientId,
  isForbiddenIp,
  validateCimdRedirectUris,
  validateCimdUrl,
} from "../server/cimd.ts";

const TOP_LEVEL_REGEX_1 = /https scheme/;
const TOP_LEVEL_REGEX_2 = /userinfo/;
const TOP_LEVEL_REGEX_3 = /non-empty path/;
const TOP_LEVEL_REGEX_4 = /dot-segments/;
const TOP_LEVEL_REGEX_5 = /fragment/;
const TOP_LEVEL_REGEX_6 = /does not share origin/;
const TOP_LEVEL_REGEX_7 = /exceeds 5 KB size limit/;
const TOP_LEVEL_REGEX_8 = /resolves to private\/loopback/;
const TOP_LEVEL_REGEX_9 = /CIMD fetch failed.*aborted by test timeout/;
const TOP_LEVEL_REGEX_10 = /rejected redirect/;
const TOP_LEVEL_REGEX_11 = /not valid JSON/;
const TOP_LEVEL_REGEX_12 = /client_id mismatch/;
const TOP_LEVEL_REGEX_13 = /unsupported token_endpoint_auth_method/;
const TOP_LEVEL_REGEX_14 = /CIMD fetch failed/;

const publicDns: NonNullable<FetchCimdOptions["dnsLookupImpl"]> = () => Promise.resolve([{ address: "93.184.216.34" }]);

/**
 * Typed wrapper matching fetchCimdDocument's real (but untyped-JS-inferred)
 * usage contract. server/cimd.js is untyped JS, so TS infers its options
 * param from destructured defaults rather than an authored interface; this
 * is the single seam where that mismatch is bridged, isolated from every
 * call site.
 */
function fetchCimd(clientId: string, options: FetchCimdOptions): Promise<FetchCimdResult> {
  return fetchCimdDocument(clientId, options);
}

function jsonResponse(body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    status: 200,
    ...init,
  });
}

test("CIMD URL classification and prefetch validation reject unsafe client_ids", () => {
  assert.equal(isCimdClientId("https://client.example/.well-known/oauth-client"), true);
  assert.equal(isCimdClientId("http://client.example/metadata"), false);
  assert.equal(isCimdClientId("pdpp-cli"), false);

  assert.throws(() => validateCimdUrl("http://client.example/metadata"), TOP_LEVEL_REGEX_1);
  assert.throws(() => validateCimdUrl("https://user:pass@client.example/metadata"), TOP_LEVEL_REGEX_2);
  assert.throws(() => validateCimdUrl("https://client.example"), TOP_LEVEL_REGEX_3);
  assert.throws(() => validateCimdUrl("https://client.example/a/../b"), TOP_LEVEL_REGEX_4);
  assert.throws(() => validateCimdUrl("https://client.example/metadata#frag"), TOP_LEVEL_REGEX_5);
});

test("CIMD IP guard blocks loopback private and link-local ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "100.127.255.255",
    "172.16.1.2",
    "192.168.1.3",
    "169.254.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:100.64.0.1",
    "::ffff:169.254.1.1",
    "::ffff:255.255.255.255",
    "0:0:0:0:0:ffff:192.168.1.3",
  ]) {
    assert.equal(isForbiddenIp(ip), true, `${ip} should be forbidden`);
  }
  assert.equal(isForbiddenIp("93.184.216.34"), false);
  assert.equal(isForbiddenIp("::ffff:93.184.216.34"), false);
  assert.equal(isForbiddenIp("2606:2800:220:1:248:1893:25c8:1946"), false);
});

test("CIMD IP guard blocks hex-form IPv4-mapped and 6to4 addresses encoding private ranges", () => {
  // Hex-form IPv4-mapped: ::ffff:HHHH:HHHH where the two hextets are the IPv4 in hex
  // ::ffff:7f00:1 == ::ffff:127.0.0.1 == 127.0.0.1 (loopback)
  assert.equal(isForbiddenIp("::ffff:7f00:1"), true, "::ffff:7f00:1 (127.0.0.1) should be forbidden");
  // ::ffff:0a00:1 == 10.0.0.1 (private)
  assert.equal(isForbiddenIp("::ffff:0a00:1"), true, "::ffff:0a00:1 (10.0.0.1) should be forbidden");
  // ::ffff:c0a8:101 == 192.168.1.1 (private)
  assert.equal(isForbiddenIp("::ffff:c0a8:101"), true, "::ffff:c0a8:101 (192.168.1.1) should be forbidden");
  // ::ffff:a9fe:101 == 169.254.1.1 (link-local)
  assert.equal(isForbiddenIp("::ffff:a9fe:101"), true, "::ffff:a9fe:101 (169.254.1.1) should be forbidden");
  // ::ffff:6440:1 == 100.64.0.1 (CGNAT)
  assert.equal(isForbiddenIp("::ffff:6440:1"), true, "::ffff:6440:1 (100.64.0.1) should be forbidden");

  // Public address in hex-form IPv4-mapped should be allowed
  // ::ffff:5db8:d822 == 93.184.216.34 (example.com)
  assert.equal(isForbiddenIp("::ffff:5db8:d822"), false, "::ffff:5db8:d822 (93.184.216.34) should be allowed");

  // 6to4: 2002:HHHH:HHHH:: embeds IPv4 in bits 16-47
  // 2002:7f00:0001:: embeds 127.0.0.1 (loopback)
  assert.equal(isForbiddenIp("2002:7f00:0001::"), true, "2002:7f00:0001:: (127.0.0.1) should be forbidden");
  // 2002:0a00:0001:: embeds 10.0.0.1 (private)
  assert.equal(isForbiddenIp("2002:0a00:0001::"), true, "2002:0a00:0001:: (10.0.0.1) should be forbidden");
  // 2002:c0a8:0101:: embeds 192.168.1.1 (private)
  assert.equal(isForbiddenIp("2002:c0a8:0101::"), true, "2002:c0a8:0101:: (192.168.1.1) should be forbidden");
  // 2002:a9fe:0101:: embeds 169.254.1.1 (link-local)
  assert.equal(isForbiddenIp("2002:a9fe:0101::"), true, "2002:a9fe:0101:: (169.254.1.1) should be forbidden");

  // 6to4 is denied OUTRIGHT, unconditionally — the IANA IPv6 Special-Purpose
  // Address Registry's own "Globally Reachable" value for 2002::/16 is N/A,
  // not True (it is a transport mechanism, not a reachability guarantee), so
  // even a 6to4 address whose embedded IPv4 is itself public must still be
  // forbidden. See tmp/workstreams/ssrf-sol-final-0717.md P1 and
  // openspec/changes/fix-client-event-delivery-ssrf-guard/research/iana-special-purpose-registries-2026-07-18.md.
  // 2002:5db8:d822:: embeds 93.184.216.34 (example.com) but is still forbidden.
  assert.equal(
    isForbiddenIp("2002:5db8:d822::"),
    true,
    "2002:5db8:d822:: (embeds a public IPv4) must still be forbidden — 6to4 is denied outright"
  );
});

test("CIMD redirect_uris must be same-origin except listed localhost development redirects", () => {
  const clientId = "https://client.example/oauth/client.json";
  validateCimdRedirectUris(
    {
      redirect_uris: [
        "https://client.example/callback",
        "http://localhost:1455/callback",
        "http://127.0.0.1:1455/callback",
        "http://[::1]:1455/callback",
      ],
    },
    clientId
  );
  assert.throws(
    () => validateCimdRedirectUris({ redirect_uris: ["https://evil.example/callback"] }, clientId),
    TOP_LEVEL_REGEX_6
  );
});

test("fetchCimdDocument enforces the CIMD-01 5 KB response cap before parsing", async () => {
  assert.equal(CIMD_MAX_BODY_BYTES, 5 * 1024);
  const clientId = "https://client.example/oauth/client.json";
  await assert.rejects(
    () =>
      fetchCimd(clientId, {
        dnsLookupImpl: publicDns,
        fetchImpl: async () =>
          new Response(" ".repeat(CIMD_MAX_BODY_BYTES + 1), {
            headers: { "Content-Type": "application/json" },
            status: 200,
          }),
      }),
    TOP_LEVEL_REGEX_7
  );
});

test("fetchCimdDocument validates and caches a public-client metadata document", async () => {
  const clientId = "https://client.example/oauth/client-valid.json";
  let fetchCount = 0;
  const fetchImpl = () => {
    fetchCount += 1;
    return Promise.resolve(
      jsonResponse(
        {
          client_id: clientId,
          client_name: "Claude Code",
          redirect_uris: ["https://client.example/callback", "http://localhost:1455/callback"],
          token_endpoint_auth_method: "none",
        },
        { headers: { "Cache-Control": "max-age=3600" } }
      )
    );
  };

  const first = await fetchCimd(clientId, { dnsLookupImpl: publicDns, fetchImpl });
  const second = await fetchCimd(clientId, { dnsLookupImpl: publicDns, fetchImpl });

  assert.equal(fetchCount, 1);
  assert.equal(first.fromCache, false);
  assert.equal(second.fromCache, true);
  assert.equal(first.doc.client_name, "Claude Code");
  assert.equal(first.securityHash, second.securityHash);
});

test("fetchCimdDocument blocks forbidden DNS resolutions before issuing HTTP", async () => {
  let called = false;
  await assert.rejects(
    () =>
      fetchCimd("https://private.example/oauth/client.json", {
        dnsLookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
        fetchImpl: () => {
          called = true;
          return Promise.resolve(jsonResponse({}));
        },
      }),
    TOP_LEVEL_REGEX_8
  );
  assert.equal(called, false);
});

test("fetchCimdDocument aborts slow metadata fetches", async () => {
  const clientId = "https://client.example/oauth/client-timeout.json";
  await assert.rejects(
    () =>
      fetchCimd(clientId, {
        dnsLookupImpl: publicDns,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            assert.ok(init?.signal, "fetchImpl must receive an abort signal");
            init.signal.addEventListener("abort", () => reject(new Error("aborted by test timeout")));
          }),
        timeoutMs: 1,
      }),
    TOP_LEVEL_REGEX_9
  );
});

test("fetchCimdDocument rejects redirects, malformed JSON, client_id mismatch, and unsupported auth", async () => {
  await assert.rejects(
    () =>
      fetchCimd("https://client.example/oauth/client-redirect.json", {
        dnsLookupImpl: publicDns,
        fetchImpl: async () => Response.json("https://client.example/next", { status: 303 }),
      }),
    TOP_LEVEL_REGEX_10
  );

  await assert.rejects(
    () =>
      fetchCimd("https://client.example/oauth/client-malformed.json", {
        dnsLookupImpl: publicDns,
        fetchImpl: async () => new Response("{not json", { status: 200 }),
      }),
    TOP_LEVEL_REGEX_11
  );

  await assert.rejects(
    () =>
      fetchCimd("https://client.example/oauth/client-mismatch.json", {
        dnsLookupImpl: publicDns,
        fetchImpl: async () =>
          jsonResponse({
            client_id: "https://client.example/oauth/other.json",
            redirect_uris: ["https://client.example/callback"],
            token_endpoint_auth_method: "none",
          }),
      }),
    TOP_LEVEL_REGEX_12
  );

  await assert.rejects(
    () =>
      fetchCimd("https://client.example/oauth/client-secret.json", {
        dnsLookupImpl: publicDns,
        fetchImpl: async () =>
          jsonResponse({
            client_id: "https://client.example/oauth/client-secret.json",
            redirect_uris: ["https://client.example/callback"],
            token_endpoint_auth_method: "client_secret_basic",
          }),
      }),
    TOP_LEVEL_REGEX_13
  );
});

test("fetchCimdDocument reports security-relevant metadata changes after cache expiry", async () => {
  const clientId = "https://client.example/oauth/client-security-change.json";
  let body = {
    client_id: clientId,
    client_name: "Codex",
    redirect_uris: ["https://client.example/callback"],
    token_endpoint_auth_method: "none",
  };
  const changes: {
    clientId: string;
    previousDoc: { redirect_uris: string[] };
    nextDoc: { redirect_uris: string[] };
  }[] = [];
  const fetchImpl = async () => jsonResponse(body, { headers: { "Cache-Control": "max-age=0" } });

  const first = await fetchCimd(clientId, { dnsLookupImpl: publicDns, fetchImpl, nowMs: 0 });
  assert.equal(first.securityRelevantMetadataChanged, false);

  body = {
    ...body,
    redirect_uris: ["https://client.example/callback-v2"],
  };
  const second = await fetchCimd(clientId, {
    dnsLookupImpl: publicDns,
    fetchImpl,
    nowMs: 60_001,
    onSecurityRelevantMetadataChange: (event) => {
      const redirectUris = (document: { redirect_uris?: unknown }): string[] =>
        Array.isArray(document.redirect_uris)
          ? document.redirect_uris.filter((uri): uri is string => typeof uri === "string")
          : [];
      changes.push({
        clientId: event.clientId,
        nextDoc: { redirect_uris: redirectUris(event.nextDoc) },
        previousDoc: { redirect_uris: redirectUris(event.previousDoc) },
      });
    },
  });

  assert.equal(second.securityRelevantMetadataChanged, true);
  assert.equal(changes.length, 1);
  const [change] = changes;
  assert.ok(change, "a security-relevant change was recorded");
  assert.equal(change.clientId, clientId);
  assert.deepEqual(change.previousDoc.redirect_uris, ["https://client.example/callback"]);
  assert.deepEqual(change.nextDoc.redirect_uris, ["https://client.example/callback-v2"]);
});

test("send-time address binding: fetchCimdDocument connects to the validated address, not a re-resolved hostname (TOCTOU/rebinding proof)", async () => {
  // Uses the REAL fetchImpl (globalThis.fetch), not a stub, so the actual
  // socket layer is exercised. `validateCimdUrl` requires https:, so the
  // connect path goes through node:tls, not node:net (contrast with the
  // client-event-delivery-worker version of this test, which spies on
  // node:net for its http/https-exempt path).
  //
  // The client_id hostname is deliberately unresolvable (.invalid TLD, RFC
  // 2606) so the only way `tls.connect` can be reached at all is if the
  // transport dials the validated IP directly, without re-resolving the
  // hostname. Nothing is listening on the validated address, so the TLS
  // handshake itself is expected to fail (ECONNREFUSED) — this test proves
  // WHERE the connection attempt was aimed, not that a full CIMD document
  // fetch succeeds.
  const originalTlsConnect = tls.connect;
  const dialedHosts: { host: string | undefined; servername: string | undefined }[] = [];
  // Cast through unknown: tls.connect's real signature is a 5-overload union
  // (opts-object vs (port, host, opts) vs plain callback forms) that no
  // single function type can both spy on generically AND forward verbatim
  // via `.apply`; the spy only needs to read `.host`/`.servername` off a
  // connection-options object, which every call in this codebase's transport
  // path actually passes.
  tls.connect = ((opts: { host?: string; servername?: string }, ...rest: unknown[]) => {
    dialedHosts.push({ host: opts.host, servername: opts.servername });
    return (originalTlsConnect as (...args: unknown[]) => ReturnType<typeof tls.connect>).apply(tls, [opts, ...rest]);
  }) as typeof tls.connect;

  const clientId = "https://rebind-proof.invalid/oauth/client.json";
  try {
    await assert.rejects(
      () =>
        fetchCimd(clientId, {
          // Simulates the address that passed the SSRF check (a stand-in for a
          // real public address; the address itself does not need to be
          // publicly routable — nothing needs to accept the TLS handshake for
          // this test, only receive the connection attempt).
          // isGlobalUnicastAddressImpl is stubbed to accept it so this test
          // isolates address-binding from the allow/block decision, which
          // "CIMD IP guard blocks loopback..." above already covers with the
          // real classifier.
          dnsLookupImpl: async () => [{ address: "127.0.0.1", family: 4 }],
          isGlobalUnicastAddressImpl: () => true,
          timeoutMs: 2000,
        }),
      TOP_LEVEL_REGEX_14
    );
    assert.equal(dialedHosts.length, 1, "tls.connect must be attempted exactly once");
    const [dialed] = dialedHosts;
    assert.ok(dialed, "tls.connect was spied on at least once");
    assert.equal(
      dialed.host,
      "127.0.0.1",
      "tls.connect must be called with the validated IP literal, never the original hostname " +
        '(a re-resolving implementation would dial "rebind-proof.invalid" and fail before ever ' +
        "reaching tls.connect, since that hostname cannot resolve — or worse, would resolve to " +
        "whatever a rebinding attacker returns)"
    );
    assert.equal(
      dialed.servername,
      "rebind-proof.invalid",
      "TLS SNI/certificate hostname verification must still use the original hostname, even though the socket dials the pinned IP"
    );
  } finally {
    tls.connect = originalTlsConnect;
  }
});
