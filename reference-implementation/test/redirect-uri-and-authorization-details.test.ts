// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for two UNTESTED helpers in
 * `server/routes/as-consent-ui-helpers.ts`:
 *
 *   - buildHostedMcpAuthorizationDetailsForConnector(connectorId): the wildcard
 *     hosted-MCP authorization-details projection — a single detail granting
 *     `streams: [{name:"*"}]` continuous read for the connector.
 *
 *   - requireRegisteredRedirectUri(client, redirectUri): the redirect-URI
 *     allowlist check. Matches when the requested URI EXACTLY equals a
 *     registered one, OR (RFC 8252) when both are http loopback redirects with
 *     the same host/path/query/hash but a different PORT. Throws
 *     `invalid_request` otherwise (including no registered URIs, a non-loopback
 *     port mismatch, or a scheme mismatch on loopback).
 *
 * These observe consent-flow input shaping; they do not change behavior. Pure —
 * the module has zero imports. No DB, no server, no fixtures.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHostedMcpAuthorizationDetailsForConnector,
  requireRegisteredRedirectUri,
} from "../server/routes/as-consent-ui-helpers.ts";

interface ClientWithRedirectUris {
  readonly metadata?: { redirect_uris?: string[] } | null;
}

function client(redirect_uris: string[]): ClientWithRedirectUris {
  return { metadata: { redirect_uris } };
}

function assertRejects(clientArg: ClientWithRedirectUris | null, redirectUri: string): void {
  assert.throws(
    () => requireRegisteredRedirectUri(clientArg, redirectUri),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const code = "code" in err ? err.code : undefined;
      assert.equal(code, "invalid_request", `code: ${code}`);
      assert.ok(String(err.message).includes("redirect_uri"), `message: ${err.message}`);
      return true;
    }
  );
}

// --- buildHostedMcpAuthorizationDetailsForConnector -------------------------

test("buildHostedMcpAuthorizationDetailsForConnector: wildcard continuous read detail for the connector", () => {
  const details = buildHostedMcpAuthorizationDetailsForConnector("amazon");
  assert.deepEqual(details, [
    {
      access_mode: "continuous",
      purpose_code: "https://pdpp.org/purpose/personal_ai_assistant",
      purpose_description: "Allow this MCP client to read selected personal data through PDPP.",
      source: { id: "amazon", kind: "connector" },
      streams: [{ name: "*" }],
      type: "https://pdpp.org/data-access",
    },
  ]);
});

test("buildHostedMcpAuthorizationDetailsForConnector: threads the connector id into source.id", () => {
  const details = buildHostedMcpAuthorizationDetailsForConnector("gmail");
  // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
  const detail = details[0];
  assert.ok(detail && typeof detail === "object" && "source" in detail);
  assert.deepEqual(detail.source, { id: "gmail", kind: "connector" });
});

// --- requireRegisteredRedirectUri: accept ----------------------------------

test("requireRegisteredRedirectUri: an exact match is accepted", () => {
  assert.equal(
    requireRegisteredRedirectUri(client(["https://app.example.com/cb"]), "https://app.example.com/cb"),
    undefined
  );
});

test("requireRegisteredRedirectUri: a loopback URI matches on a DIFFERENT port (RFC 8252)", () => {
  assert.equal(
    requireRegisteredRedirectUri(client(["http://localhost:1234/cb"]), "http://localhost:5678/cb"),
    undefined,
    "localhost port may differ"
  );
  assert.equal(
    requireRegisteredRedirectUri(client(["http://127.0.0.1:1000/cb"]), "http://127.0.0.1:2000/cb"),
    undefined,
    "127.0.0.1 port may differ"
  );
});

// --- requireRegisteredRedirectUri: reject ----------------------------------

test("requireRegisteredRedirectUri: a non-matching URI is rejected", () => {
  assertRejects(client(["https://app.example.com/cb"]), "https://evil.example.com/cb");
});

test("requireRegisteredRedirectUri: no registered redirect URIs rejects everything", () => {
  assertRejects(client([]), "https://app.example.com/cb");
  assertRejects(null, "https://app.example.com/cb");
  assert.throws(() =>
    Reflect.apply(requireRegisteredRedirectUri, undefined, [
      { metadata: { redirect_uris: "not-an-array" } },
      "https://app.example.com/cb",
    ])
  );
});

test("requireRegisteredRedirectUri: a NON-loopback host with a different port is rejected (no port flex)", () => {
  assertRejects(client(["http://app.example.com:1000/cb"]), "http://app.example.com:2000/cb");
});

test("requireRegisteredRedirectUri: a loopback match requires the same path and scheme", () => {
  // Same loopback host/port-flex but a different path => reject.
  assertRejects(client(["http://localhost:1234/cb"]), "http://localhost:5678/other");
  // Scheme change on loopback (http registered, https requested) => reject.
  assertRejects(client(["http://localhost:1234/cb"]), "https://localhost:1234/cb");
});
