// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// F1 wiring regression — the hosted-MCP package adapter must forward its
// child-grant self-calls to the configured INTERNAL resource-server base,
// while the advertised `resource`, discovery metadata, and
// `mcpServerOptions.providerUrl` stay the PUBLIC origin.
//
// Spec: openspec/changes/route-hosted-mcp-adapter-self-calls-internally/
//
// Background (F1): `handleHostedMcp` built the child RsClient fetch base from
// `resolvePublicUrl(...)` (the public origin). Server-internal self-calls could
// therefore hairpin through an external edge with a narrower method policy.
// The fix passes the EXPLICITLY-configured internal base (`opts.rsInternalUrl`
// or the operator's `PDPP_RS_URL`, plumbed by `startServer` — NOT the bare
// `referenceTopology` default `http://localhost:7663`, which is intentionally
// skipped) to `createPackageRsClient` as the child fetch base, falling back to
// the public resource when no internal base is configured. Advertised identity
// stays public. (`INTERNAL_BASE` below is an explicitly-configured value, as a
// real deployment's `PDPP_RS_URL` would be.)
//
// This test drives `handleHostedMcp` through `mountRsHostedMcp` against a
// hand-built fake app + context. It captures the `providerUrl` that reaches
// `createPackageRsClient` and the `providerUrl` advertised on
// `mcpServerOptions`. PRE-fix both equal the public resource (this test fails
// on `assertEqual(internal)`); POST-fix the child base is the internal base
// and the advertised value remains public.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { MountRsHostedMcpContext } from "../server/routes/rs-hosted-mcp.ts";
import { mountRsHostedMcp } from "../server/routes/rs-hosted-mcp.ts";

type RouteHandler = (req: unknown, res: unknown) => unknown | Promise<unknown>;
type HostedMcpApp = Parameters<typeof mountRsHostedMcp>[0];
interface FakeApp extends HostedMcpApp {
  routes: Record<string, RouteHandler[]>;
}

const PUBLIC_RESOURCE = "https://pdpp.test"; // advertised; edge 405s PATCH
const INTERNAL_BASE = "http://localhost:7663"; // configured internal RS base

// Minimal fake app that records the handlers mounted for each verb so the test
// can invoke the final handler (`handleHostedMcp`) directly, skipping the auth
// middleware chain (auth posture is exercised by hosted-mcp-oauth.test.js).
function makeFakeApp(): FakeApp {
  const routes: Record<string, RouteHandler[]> = {};
  const register =
    (verb: string): HostedMcpApp["get"] =>
    (path, ...handlers) => {
      routes[`${verb} ${path}`] = handlers as unknown as RouteHandler[];
      return app;
    };
  const app: FakeApp = { delete: register("delete"), get: register("get"), post: register("post"), routes };
  return app;
}

// Minimal shape rs-hosted-mcp.ts consumes for a request's `get`/`headers` etc.
interface FakeRequest {
  get: (name: string) => string | undefined;
  headers: Record<string, string>;
  method: string;
  path: string;
  protocol: string;
  raw: { url: string };
  tokenInfo: { grant_id?: string; grant_package_id?: string; pdpp_token_kind: string };
}

interface FakeResponse {
  end: () => void;
  headers: Record<string, string>;
  locals: Record<string, unknown>;
  send: () => void;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => FakeResponse;
  statusCode: number | null;
}

// Fake request mirroring the shape rs-hosted-mcp.ts consumes. With a
// non-loopback `explicitResource` and no x-forwarded-* headers, resolvePublicUrl
// returns the explicit URL verbatim — a deterministic public origin.
function makePackageRequest(): FakeRequest {
  return {
    get(name: string) {
      const lc = name.toLowerCase();
      return lc === "host" ? "pdpp.test" : undefined;
    },
    headers: { authorization: "Bearer pkg_inbound_token", host: "pdpp.test" },
    method: "POST",
    path: "/mcp",
    protocol: "https",
    raw: { url: "/mcp" },
    tokenInfo: { grant_package_id: "gp_1", pdpp_token_kind: "mcp_package" },
  };
}

// Single-grant (`client`-token) request — exercises the `else` branch.
function makeClientRequest(): FakeRequest {
  return {
    get(name: string) {
      const lc = name.toLowerCase();
      return lc === "host" ? "pdpp.test" : undefined;
    },
    headers: { authorization: "Bearer client_inbound_token", host: "pdpp.test" },
    method: "POST",
    path: "/mcp",
    protocol: "https",
    raw: { url: "/mcp" },
    tokenInfo: { grant_id: "grant_single", pdpp_token_kind: "client" },
  };
}

function makeFakeResponse(): FakeResponse {
  return {
    end() {
      /* intentionally empty */
    },
    headers: {},
    locals: {},
    send() {
      /* intentionally empty */
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    statusCode: null,
  };
}

interface Seen {
  advertisedProviderUrl: string | null;
  childProviderUrl: string | null;
  singleGrantProviderUrl: string | null;
}

// Build a context whose `createPackageRsClient` records the providerUrl it
// receives, and whose `handleStreamableHttpRequest` records the providerUrl it
// is advertised. `internalResource` is the fix's injected internal base.
function makeContext({ internalResource }: { internalResource: string | null | undefined }): {
  ctx: MountRsHostedMcpContext;
  seen: Seen;
} {
  const seen: Seen = { advertisedProviderUrl: null, childProviderUrl: null, singleGrantProviderUrl: null };
  return {
    ctx: {
      createPackageRsClient({ providerUrl }) {
        seen.childProviderUrl = providerUrl;
        return { __fakePackageRsClient: true };
      },
      createRsClient({ providerUrl }) {
        seen.singleGrantProviderUrl = providerUrl;
        return { __fakeRsClient: true };
      },
      explicitResource: PUBLIC_RESOURCE,
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async getGrantPackageAccess() {
        return {
          members: [
            { accessToken: "tok_A", grantId: "grant_A" },
            { accessToken: "tok_B", grantId: "grant_B" },
          ],
        };
      },
      // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
      async handleStreamableHttpRequest(_request, options) {
        seen.advertisedProviderUrl = options.providerUrl;
        return new Response("{}", { headers: { "content-type": "application/json" }, status: 200 });
      },
      // `exactOptionalPropertyTypes` forbids assigning `undefined` directly to
      // an optional `string | null` property; spread the key in only when a
      // value (including explicit `undefined` from the fallback test) needs
      // representing, matching the "key omitted" shape the fallback exercises.
      ...(internalResource === undefined ? {} : { internalResource }),
      pdppError(res, status, code, message) {
        res.status(status).send({ error: { code, message } });
      },
      referenceRevision: "test-rev",
      requireClientOrMcpPackage: (_req, _res, next) => next(),
      requireToken: (_req, _res, next) => next(),
      trustedMetadataHosts: null,
    },
    seen,
  };
}

async function driveHandler({
  internalResource,
  makeRequest = makePackageRequest,
}: {
  internalResource: string | null | undefined;
  makeRequest?: () => FakeRequest;
}): Promise<Seen> {
  const app = makeFakeApp();
  const { ctx, seen } = makeContext({ internalResource });
  mountRsHostedMcp(app, ctx);
  // The handler is the last entry in the mounted chain for POST /mcp.
  const chain = app.routes["post /mcp"];
  assert.ok(chain, "post /mcp route must be mounted");
  const handler = chain.at(-1);
  assert.ok(handler, "post /mcp handler chain must not be empty");
  const res = makeFakeResponse();
  await handler(makeRequest(), res);
  return seen;
}

test("F1 wiring: package adapter forwards child self-calls to the internal base; advertised stays public", async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE });
  // Child RsClient fetch base is the INTERNAL base (the fix).
  assert.equal(seen.childProviderUrl, INTERNAL_BASE, "child RsClient fetch base must be the internal RS base");
  // Advertised providerUrl on the MCP server stays the PUBLIC origin.
  assert.equal(seen.advertisedProviderUrl, PUBLIC_RESOURCE, "advertised providerUrl must remain the public origin");
});

test("F1 wiring fallback: with no internal base configured, child self-calls fall back to the public resource", async () => {
  const seenNull = await driveHandler({ internalResource: null });
  assert.equal(
    seenNull.childProviderUrl,
    PUBLIC_RESOURCE,
    "fallback: child base is the public resource when internal base is unset"
  );
  assert.equal(
    seenNull.advertisedProviderUrl,
    PUBLIC_RESOURCE,
    "advertised providerUrl remains public in the fallback path"
  );

  const seenUndef = await driveHandler({ internalResource: undefined });
  assert.equal(
    seenUndef.childProviderUrl,
    PUBLIC_RESOURCE,
    "fallback: undefined internal base also yields the public resource"
  );
});

test("F1 wiring (single-grant): client-token self-calls use the internal base; advertised stays public", async () => {
  const seen = await driveHandler({ internalResource: INTERNAL_BASE, makeRequest: makeClientRequest });
  // The single-bearer RsClient's fetch base is the INTERNAL base (the
  // single-grant extension — parity with the package path).
  assert.equal(
    seen.singleGrantProviderUrl,
    INTERNAL_BASE,
    "single-grant RsClient fetch base must be the internal RS base"
  );
  // Advertised providerUrl on the MCP server stays the PUBLIC origin.
  assert.equal(
    seen.advertisedProviderUrl,
    PUBLIC_RESOURCE,
    "advertised providerUrl must remain the public origin (single-grant)"
  );
  // The package-only recorder was not touched on the client path.
  assert.equal(seen.childProviderUrl, null, "package createPackageRsClient must not be invoked for a client token");
});

test("F1 wiring (single-grant) fallback: no internal base → client self-calls use the public resource", async () => {
  const seen = await driveHandler({ internalResource: null, makeRequest: makeClientRequest });
  assert.equal(
    seen.singleGrantProviderUrl,
    PUBLIC_RESOURCE,
    "fallback: single-grant base is the public resource when internal base is unset"
  );
  assert.equal(
    seen.advertisedProviderUrl,
    PUBLIC_RESOURCE,
    "advertised providerUrl remains public in the single-grant fallback"
  );
});
