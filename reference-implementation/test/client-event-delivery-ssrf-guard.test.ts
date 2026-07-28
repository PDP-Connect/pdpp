const TOP_LEVEL_REGEX_1 = /blocked/i;
const TOP_LEVEL_REGEX_2 = /169\.254\.169\.254/;
const TOP_LEVEL_REGEX_3 = /forbidden|blocked/i;
const TOP_LEVEL_REGEX_4 = /DNS resolution failed/i;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SSRF guard for the client-event delivery transport.
 *
 * `defaultHttpTransport` MUST refuse to POST to a callback whose host resolves
 * to a forbidden (private/loopback/link-local/metadata) address, and MUST NOT
 * follow redirects. The guard runs at delivery time (every attempt) so a host
 * that DNS-rebinds to a forbidden address after subscription-create is still
 * blocked. See openspec/changes/fix-client-event-delivery-ssrf-guard.
 *
 * Most tests below mock `globalThis.fetch` entirely, which proves the
 * block/allow decision but NOT that the validated address is the address
 * actually connected to. A guard that resolves DNS once to decide, then calls
 * `fetch(url)` with the original hostname, has a TOCTOU gap: `fetch` re-resolves
 * the hostname itself, so a low-TTL DNS record (attacker-controlled or
 * rebinding) can return a different address at connect time than the one that
 * was validated — the mocked-fetch tests above cannot see this because they
 * never let a real resolution happen. The "send-time address binding" test
 * below does not mock fetch; it spies on `node:net`'s `connect` (what the real
 * HTTP client calls to open the TCP socket) and asserts the literal address
 * dialed is the validated address, never the original hostname string. A
 * guard with the TOCTOU gap would dial the hostname (and so be vulnerable to
 * rebinding); this test fails under that implementation and passes only when
 * the checked and connected addresses are provably the same value.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import test from "node:test";

import { defaultHttpTransport, type HttpTransportDeps } from "../server/client-event-delivery-worker.ts";

interface DeliveryResult {
  bodyText: string | null;
  errorMessage: string | null;
  latencyMs: number;
  responseHeaders?: Readonly<Record<string, string>>;
  statusCode: number | null;
}

interface DeliveryRequest {
  body: string;
  headers: Record<string, string>;
  method: "POST";
  url: string;
}

// The exported HttpTransport type is deliberately single-arg (the public
// transport-injection surface); defaultHttpTransport's real implementation
// also accepts a second `deps` param for its SSRF-guard test seams. This
// typed wrapper is the one seam where that mismatch is bridged.
const transport = defaultHttpTransport as (req: DeliveryRequest, deps?: HttpTransportDeps) => Promise<DeliveryResult>;

const req = (url: string): DeliveryRequest => ({
  body: "{}",
  headers: { "content-type": "application/cloudevents+json" },
  method: "POST",
  url,
});

// A DNS seam that maps a hostname to a fixed address, so we can simulate a
// public host that resolves (or rebinds) to a forbidden address.
const resolvesTo = (address: string) => async () => [{ address, family: 4 }];

test("blocks delivery when the callback host resolves to link-local metadata (169.254.169.254)", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("ok", { status: 200 });
  };
  try {
    const res = await transport(req("https://rebind.example/hook"), {
      dnsLookupImpl: resolvesTo("169.254.169.254"),
    });
    assert.equal(fetched, false, "must NOT issue the HTTP request");
    assert.equal(res.statusCode, null, "blocked delivery has no status code");
    assert.match(res.errorMessage ?? "", TOP_LEVEL_REGEX_1);
    assert.match(res.errorMessage ?? "", TOP_LEVEL_REGEX_2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("blocks delivery when the callback host resolves to loopback (127.0.0.1)", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("ok", { status: 200 });
  };
  try {
    const res = await transport(req("https://rebind.example/hook"), {
      dnsLookupImpl: resolvesTo("127.0.0.1"),
    });
    assert.equal(fetched, false, "must NOT issue the HTTP request");
    assert.equal(res.statusCode, null);
    assert.match(res.errorMessage ?? "", TOP_LEVEL_REGEX_3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("allows delivery to a public-resolving host and sets redirect: manual", async () => {
  let fetchedUrl: string | URL | Request | null = null;
  let fetchedInit: RequestInit | undefined;
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  globalThis.fetch = async (url, init) => {
    fetchedUrl = url;
    fetchedInit = init;
    return new Response("ok", { headers: { "retry-after": "5" }, status: 202 });
  };
  try {
    const res = await transport(req("https://receiver.example/hook"), {
      dnsLookupImpl: resolvesTo("93.184.216.34"), // public (example.com range)
    });
    assert.equal(fetchedUrl, "https://receiver.example/hook", "public host is fetched normally");
    assert.ok(fetchedInit);
    assert.equal(fetchedInit.redirect, "manual", "delivery must not follow redirects");
    assert.equal(res.statusCode, 202, "response passthrough unchanged");
    assert.equal(res.responseHeaders?.["retry-after"], "5", "retry-after captured unchanged");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("allows the sanctioned http loopback dev callback without an IP check", async () => {
  // http://127.0.0.1 and http://localhost are the exact exception the create-time
  // validator permits; delivery must not block them (the e2e receiver uses this).
  for (const url of ["http://127.0.0.1:5555/hook", "http://localhost:5555/hook", "http://[::1]:5555/hook"]) {
    // biome-ignore lint/suspicious/noEvolvingTypes: test fixture inference is intentionally widened
    let fetchedUrl = null;
    let dnsCalled = false;
    const originalFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
    globalThis.fetch = async (u) => {
      fetchedUrl = u;
      return new Response("ok", { status: 200 });
    };
    try {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const res = await transport(req(url), {
        // If the guard tried to DNS-check the loopback dev host, this would flip.
        // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
        dnsLookupImpl: async () => {
          dnsCalled = true;
          return [{ address: "127.0.0.1" }];
        },
      });
      assert.equal(fetchedUrl, url, `${url} must be delivered`);
      assert.equal(dnsCalled, false, `${url} must be exempt from the DNS/IP check`);
      assert.equal(res.statusCode, 200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test("blocks delivery when the callback host fails to resolve", async () => {
  let fetched = false;
  const originalFetch = globalThis.fetch;
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  globalThis.fetch = async () => {
    fetched = true;
    return new Response("ok", { status: 200 });
  };
  try {
    const res = await transport(req("https://nx.example/hook"), {
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      dnsLookupImpl: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    assert.equal(fetched, false, "must NOT fetch when DNS resolution fails");
    assert.equal(res.statusCode, null);
    assert.match(res.errorMessage ?? "", TOP_LEVEL_REGEX_4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("send-time address binding: the connected address is the validated address, not a re-resolved hostname (TOCTOU/rebinding proof)", async () => {
  // A real HTTP server on loopback stands in for "the address that passed
  // validation." The callback URL's hostname is deliberately unresolvable
  // (.invalid TLD, RFC 2606) so the ONLY way this request can succeed is if
  // the transport connects directly to the validated IP without re-resolving
  // the hostname — exactly the property a split lookup/fetch implementation
  // does not have.
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo");
  const { port } = address;

  const originalConnect = net.connect;
  const dialedHosts: (string | undefined)[] = [];
  // Cast through unknown: net.connect's real signature is a multi-overload
  // union (opts-object vs (port, host, cb) forms) that no single function
  // type can both spy on generically AND forward verbatim via .apply; the
  // spy only needs to read `.host` off a connection-options object, which
  // is what the real HTTP client transport actually passes.
  net.connect = ((opts: { host?: string }, ...rest: unknown[]) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    dialedHosts.push(opts?.host);
    return (originalConnect as (...args: unknown[]) => ReturnType<typeof net.connect>).apply(net, [opts, ...rest]);
  }) as typeof net.connect;

  try {
    const res = await transport(req(`http://rebind-proof.invalid:${port}/hook`), {
      // Simulates the address that passed the SSRF check (a stand-in for a
      // real public address; validation is stubbed to accept it here so the
      // test isolates address-binding from the allow/block decision, which
      // is already covered above).
      dnsLookupImpl: async () => [{ address: "127.0.0.1" }],
      isGlobalUnicastAddressImpl: () => true,
    });

    assert.equal(res.statusCode, 200, "delivery must succeed by reaching the validated address directly");
    assert.deepEqual(
      dialedHosts,
      ["127.0.0.1"],
      "net.connect must be called with the validated IP literal, never the original hostname " +
        '(a re-resolving implementation would dial "rebind-proof.invalid" and fail, since that ' +
        "hostname cannot resolve — or worse, would resolve to whatever a rebinding attacker returns)"
    );
  } finally {
    net.connect = originalConnect;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("send-time address binding: the sanctioned loopback dev exemption is unaffected (no pinning applied)", async () => {
  // The exemption path skips the DNS/IP check entirely (proven above), so it
  // must also skip address pinning and use ordinary resolution — this test
  // proves that not pinning here doesn't silently break the exempt path.
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === "object", "server.address() must return an AddressInfo");
  const { port } = address;

  try {
    const res = await transport(req(`http://127.0.0.1:${port}/hook`), {
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      dnsLookupImpl: async () => {
        throw new Error("must not be called for the exempt path");
      },
    });
    assert.equal(res.statusCode, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
