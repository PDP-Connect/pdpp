// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import type { DiscoveryFetchResponse } from "./discovery.ts";
import {
  CardDavDiscoveryError,
  CardDavRedirectOriginError,
  discoverCardDav,
  isSafeRedirectTarget,
  nativeFetchAdapter,
} from "./discovery.ts";
import { startFakeCardDavServer } from "./test-carddav-server.ts";

/** Build a synthetic `DiscoveryFetchResponse` for tests that intercept a
 *  hop instead of hitting the fake network server — matches the real
 *  `body: ReadableStream` shape `readBoundedText` consumes. */
function syntheticResponse(status: number, headers: Record<string, string | null>, text = ""): DiscoveryFetchResponse {
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

test("isSafeRedirectTarget: allows same-origin redirect", () => {
  assert.equal(isSafeRedirectTarget("https://a.example.com/x", "https://a.example.com/y", []), true);
});

test("isSafeRedirectTarget: allows the narrow icloud.com subdomain carve-out", () => {
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "https://p05-contacts.icloud.com/y", []), true);
});

test("isSafeRedirectTarget: allows icloud.com apex <-> subdomain in either direction", () => {
  assert.equal(isSafeRedirectTarget("https://icloud.com/x", "https://contacts.icloud.com/y", []), true);
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "https://icloud.com/y", []), true);
});

test("isSafeRedirectTarget: allows an explicitly trusted origin", () => {
  assert.equal(
    isSafeRedirectTarget("https://contacts.icloud.com/x", "https://totally-different.example/y", [
      "https://totally-different.example",
    ]),
    true
  );
});

test("isSafeRedirectTarget: refuses an unrelated, untrusted domain", () => {
  assert.equal(
    isSafeRedirectTarget("https://contacts.icloud.com/x", "https://attacker.example/steal-creds", []),
    false
  );
});

test("isSafeRedirectTarget: refuses downgrade to plain http on a non-loopback host", () => {
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "http://contacts.icloud.com/y", []), false);
});

test("isSafeRedirectTarget: allows plain http same-origin loopback (test-server carve-out)", () => {
  assert.equal(isSafeRedirectTarget("http://127.0.0.1:9999/x", "http://127.0.0.1:9999/y", []), true);
});

test("isSafeRedirectTarget: loopback carve-out does not bypass origin trust for cross-origin targets", () => {
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "http://127.0.0.1:9999/y", []), false);
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "http://attacker.example/y", []), false);
});

test("isSafeRedirectTarget: refuses a malformed URL", () => {
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "not a url", []), false);
});

// ─── Adversarial: public-suffix / lookalike / port / userinfo ────────────
// These pin down exactly why the old last-two-labels eTLD+1 heuristic was
// wrong and had to be replaced with a hardcoded icloud.com check plus
// explicit-trust, not a smarter general-purpose domain-similarity rule.

test("isSafeRedirectTarget: refuses a co.uk-style public-suffix false-positive", () => {
  // A naive last-two-labels comparison would say "attacker.co.uk" and
  // "bank.co.uk" share a registrable domain ("co.uk") and are therefore
  // the same party — they are not; co.uk is a public suffix, not a single
  // organization's domain. Neither host is icloud.com or a subdomain of
  // it, so this must be refused outright regardless of shared suffix.
  assert.equal(isSafeRedirectTarget("https://bank.co.uk/x", "https://attacker.co.uk/y", []), false);
});

test("isSafeRedirectTarget: refuses an icloud.com lookalike domain", () => {
  // "icloud.com.attacker.example" ends with "icloud.com" as a SUBSTRING
  // but is not a subdomain of icloud.com (the actual parent domain is
  // attacker.example) — the suffix check must be label-boundary aware,
  // not a bare string suffix match.
  assert.equal(
    isSafeRedirectTarget("https://contacts.icloud.com/x", "https://icloud.com.attacker.example/y", []),
    false
  );
});

test("isSafeRedirectTarget: refuses a hyphenated icloud.com lookalike domain", () => {
  // "notreallyicloud.com" shares no label boundary with "icloud.com" at
  // all; a substring-based check (rather than exact-apex-or-dot-suffix)
  // could wrongly match this.
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "https://notreallyicloud.com/y", []), false);
});

test("isSafeRedirectTarget: refuses icloud.com carve-out with a non-default port on the target", () => {
  assert.equal(
    isSafeRedirectTarget("https://contacts.icloud.com/x", "https://p05-contacts.icloud.com:8443/y", []),
    false
  );
});

test("isSafeRedirectTarget: refuses icloud.com carve-out with a non-default port on the source", () => {
  assert.equal(
    isSafeRedirectTarget("https://contacts.icloud.com:8443/x", "https://p05-contacts.icloud.com/y", []),
    false
  );
});

test("isSafeRedirectTarget: refuses icloud.com carve-out with userinfo on the target (URL-confusion phishing)", () => {
  // https://icloud.com@attacker.example/ parses with hostname
  // "attacker.example" and username "icloud.com" — a naive display-string
  // check could be fooled by this; isSafeRedirectTarget must refuse any
  // userinfo outright, independent of what url.hostname resolves to.
  assert.equal(
    isSafeRedirectTarget("https://contacts.icloud.com/x", "https://icloud.com@attacker.example/y", []),
    false
  );
});

test("isSafeRedirectTarget: refuses userinfo on the source even when hostnames are both icloud.com", () => {
  assert.equal(
    isSafeRedirectTarget("https://user:pass@contacts.icloud.com/x", "https://p05-contacts.icloud.com/y", []),
    false
  );
});

test("isSafeRedirectTarget: refuses the icloud.com carve-out for an IP-literal host", () => {
  assert.equal(isSafeRedirectTarget("https://contacts.icloud.com/x", "https://93.184.216.34/y", []), false);
});

test("discoverCardDav: full RFC 6764 bootstrap against a same-origin server", async () => {
  const server = await startFakeCardDavServer({ username: "owner@example.com", password: "app-specific-pw" });
  try {
    const result = await discoverCardDav({
      originUrl: server.origin,
      authHeader: `Basic ${Buffer.from("owner@example.com:app-specific-pw").toString("base64")}`,
      fetchImpl: nativeFetchAdapter,
    });
    assert.equal(result.principalUrl, server.url("/principals/owner/"));
    assert.equal(result.addressBookHomeUrl, server.url("/addressbooks/owner/"));
  } finally {
    await server.close();
  }
});

test("discoverCardDav: follows a redirect to a regional host under the icloud.com carve-out", async () => {
  // The real-world case this guards: contacts.icloud.com's well-known
  // redirects to p05-contacts.icloud.com — a different DNS hostname, both
  // exactly icloud.com or a subdomain of it. Model that with a fetchImpl
  // proxy that maps two fake icloud.com-style origins onto two real
  // loopback listeners, so the test exercises discoverCardDav's actual
  // production carve-out (not a generic same-suffix heuristic — that
  // heuristic no longer exists).
  const primaryFakeOrigin = "https://contacts.icloud.com";
  const regionalFakeOrigin = "https://p05-contacts.icloud.com";
  const server = await startFakeCardDavServer({
    username: "owner@example.com",
    password: "app-specific-pw",
    regionalHost: true,
  });
  try {
    const remap = (url: string): string =>
      url.replace(regionalFakeOrigin, server.regionalOrigin as string).replace(primaryFakeOrigin, server.origin);
    const proxyFetch: Parameters<typeof discoverCardDav>[0]["fetchImpl"] = async (url, init) => {
      const res = await nativeFetchAdapter(remap(url), init);
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        // Rewrite the real regional origin back to the fake icloud.com-style
        // origin discoverCardDav sees, so its own origin-safety check runs
        // against the DNS names being modeled, not the loopback ports.
        const rewrittenLocation =
          location && server.regionalOrigin && location.startsWith(server.regionalOrigin)
            ? location.replace(server.regionalOrigin, regionalFakeOrigin)
            : location;
        return syntheticResponse(res.status, { location: rewrittenLocation });
      }
      return res;
    };

    const result = await discoverCardDav({
      originUrl: primaryFakeOrigin,
      authHeader: `Basic ${Buffer.from("owner@example.com:app-specific-pw").toString("base64")}`,
      fetchImpl: proxyFetch,
    });
    assert.equal(result.principalUrl, `${regionalFakeOrigin}/principals/owner/`);
    assert.ok(result.visitedOrigins.includes(regionalFakeOrigin));
  } finally {
    await server.close();
  }
});

test("discoverCardDav: rejects on 401 with a stable auth-rejected error", async () => {
  const server = await startFakeCardDavServer({ username: "owner@example.com", password: "app-specific-pw" });
  try {
    await assert.rejects(
      discoverCardDav({
        originUrl: server.origin,
        authHeader: `Basic ${Buffer.from("owner@example.com:WRONG").toString("base64")}`,
        fetchImpl: nativeFetchAdapter,
      }),
      (err: unknown) => err instanceof CardDavDiscoveryError && err.message === "carddav_auth_rejected"
    );
    assert.equal(server.authRejectedCount > 0, true);
  } finally {
    await server.close();
  }
});

test("discoverCardDav: refuses to follow a well-known redirect to an untrusted origin", async () => {
  // A malicious well-known responder points at a completely unrelated
  // origin. discoverCardDav must refuse to follow it with credentials
  // attached, rather than silently leaking Basic Auth cross-origin.
  const attacker = await startFakeCardDavServer({ username: "owner@example.com", password: "app-specific-pw" });
  const legit = await startFakeCardDavServer({ username: "owner@example.com", password: "app-specific-pw" });
  try {
    // Simulate legit's well-known pointing at attacker's unrelated origin by
    // constructing a fetchImpl wrapper that rewrites the first redirect.
    const maliciousFetch: Parameters<typeof discoverCardDav>[0]["fetchImpl"] = async (url, init) => {
      const res = await nativeFetchAdapter(url, init);
      if (String(url).endsWith("/.well-known/carddav")) {
        return syntheticResponse(302, { location: `${attacker.origin}/principals/owner/` });
      }
      return res;
    };
    await assert.rejects(
      discoverCardDav({
        originUrl: legit.origin,
        authHeader: `Basic ${Buffer.from("owner@example.com:app-specific-pw").toString("base64")}`,
        fetchImpl: maliciousFetch,
      }),
      (err: unknown) => err instanceof CardDavRedirectOriginError
    );
  } finally {
    await attacker.close();
    await legit.close();
  }
});
