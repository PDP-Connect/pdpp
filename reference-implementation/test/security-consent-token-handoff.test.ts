const TOP_LEVEL_REGEX_1 = /cex_[0-9a-f]{64}/;
const TOP_LEVEL_REGEX_2 = /cex_[0-9a-f]{64}/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Regression tests for the harden-consent-token-handoff change.
//
// Pins the invariants:
//   1. The HTML branch of POST /consent/approve never embeds the bearer.
//   2. The HTML branch DOES embed an opaque cex_… exchange code.
//   3. POST /consent/exchange redeems the code once and returns
//      { grant_id, token, grant }.
//   4. A second redemption attempt fails with a 4xx PDPP error envelope and
//      does not leak the bearer.
//   5. An expired code fails with a 4xx PDPP error envelope.
//   6. An unknown code fails with a 4xx PDPP error envelope.
//   7. The JSON branch of POST /consent/approve still returns the bearer in
//      its JSON body.
//
// Spec: openspec/changes/harden-consent-token-handoff/specs/
//       reference-implementation-architecture/spec.md
import test from "node:test";
import { fileURLToPath } from "node:url";
import { consumeConsentExchangeCode, createConsentExchangeCode } from "../server/auth.ts";
import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asPort: number;
  asServer: TestHttpServer;
  rsServer: TestHttpServer;
}

interface SpotifyManifest {
  connector_id: string;
}

interface InitiateGrantResponse {
  request_uri: string;
}

interface ApproveJsonResponse {
  code?: string;
  grant: object;
  grant_id: string;
  token: string;
}

interface ExchangeResponse {
  grant: object;
  grant_id: string;
  token: string;
}

interface IntrospectResponse {
  active: boolean;
  grant_id: string;
}

interface PdppErrorEnvelope {
  error?: { code: string };
}

interface FetchJsonResult {
  body: PdppErrorEnvelope | null;
  headers: Record<string, string>;
  status: number;
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: TestHttpServer) =>
    new Promise<void>((resolve) => {
      let settled = false;
      const t = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      srv.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(t);
          resolve();
        }
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  let body: PdppErrorEnvelope | null = null;
  try {
    body = (await resp.json()) as PdppErrorEnvelope;
  } catch {
    /* non-json */
  }
  return { body, headers: Object.fromEntries(resp.headers.entries()), status: resp.status };
}

async function initiateGrantRequest(asUrl: string, spotifyManifest: SpotifyManifest): Promise<InitiateGrantResponse> {
  const initResp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Consent token handoff regression",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "concert_recommendation_app",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (initResp.status !== 201) {
    throw new Error(`PAR failed (${initResp.status}): ${await initResp.text()}`);
  }
  return initResp.json() as Promise<InitiateGrantResponse>;
}

interface HarnessContext {
  asUrl: string;
  spotifyManifest: SpotifyManifest;
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  ) as SpotifyManifest;
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await fn({ asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

test("security: harden consent token handoff", async (t) => {
  await t.test("HTML approve does not embed the bearer; JSON approve still returns it", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      // First, get a token via the JSON branch (this is the established
      // programmatic contract used by the dashboard and every test).
      const initiateForJson = await initiateGrantRequest(asUrl, spotifyManifest);
      const jsonResp = await fetch(`${asUrl}/consent/approve`, {
        body: JSON.stringify({ request_uri: initiateForJson.request_uri, subject_id: "owner_local" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(jsonResp.status, 200);
      const jsonBody = (await jsonResp.json()) as ApproveJsonResponse;
      assert.equal(typeof jsonBody.token, "string", "JSON branch SHALL still return the bearer");
      assert.ok(jsonBody.token.length > 0);
      assert.equal(typeof jsonBody.grant_id, "string");
      assert.equal(typeof jsonBody.grant, "object");
      assert.equal(jsonBody.code, undefined, "JSON branch SHALL NOT include an exchange code");

      // Now drive a fresh approval through the HTML branch.
      const initiateForHtml = await initiateGrantRequest(asUrl, spotifyManifest);
      const htmlResp = await fetch(`${asUrl}/consent/approve`, {
        body: new URLSearchParams({
          request_uri: initiateForHtml.request_uri,
          subject_id: "owner_local",
        }).toString(),
        headers: {
          // Negotiate HTML explicitly; the route uses
          // req.is('application/json') || req.accepts(['html','json']) === 'json'
          // to choose JSON, so we explicitly say HTML here.
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
      assert.equal(htmlResp.status, 200);
      const htmlText = await htmlResp.text();
      assert.ok(htmlText.includes("<html"), "HTML branch SHALL render an HTML document");
      // The bearer minted for the JSON approval is unrelated to this approval,
      // but the bearer minted for THIS approval must not appear anywhere.
      // Mint a second JSON approval to discover the bearer for the HTML one?
      // No — by construction we have already issued the HTML grant; we can
      // verify by inspecting the page for the exchange code, redeeming it,
      // and then asserting the redeemed bearer is not present in the original
      // HTML body.
      const codeMatch = htmlText.match(TOP_LEVEL_REGEX_1);
      assert.ok(codeMatch, "HTML body SHALL embed a cex_… exchange code");
      // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
      const code = codeMatch[0];

      // Redeem and confirm we got a bearer.
      const exchangeResp = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(exchangeResp.status, 200);
      const exchangeBody = (await exchangeResp.json()) as ExchangeResponse;
      assert.equal(typeof exchangeBody.token, "string");
      assert.ok(exchangeBody.token.length > 0);
      assert.equal(typeof exchangeBody.grant_id, "string");
      assert.equal(typeof exchangeBody.grant, "object");

      // The bearer the HTML approval ultimately bound to its grant SHALL NOT
      // appear in the HTML response body.
      assert.equal(
        htmlText.includes(exchangeBody.token),
        false,
        "HTML approval body unexpectedly contains the live bearer string"
      );

      // Defense-in-depth: the prior JSON-branch bearer also SHALL NOT appear
      // in the HTML body.
      assert.equal(htmlText.includes(jsonBody.token), false);

      // The redeemed bearer SHALL introspect as active for the same grant.
      const introResp = await fetch(`${asUrl}/introspect`, {
        body: JSON.stringify({ token: exchangeBody.token }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const intro = (await introResp.json()) as IntrospectResponse;
      assert.equal(intro.active, true);
      assert.equal(intro.grant_id, exchangeBody.grant_id);
    });
  });

  await t.test("a consumed exchange code cannot be redeemed again", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const htmlResp = await fetch(`${asUrl}/consent/approve`, {
        body: new URLSearchParams({
          request_uri: initiate.request_uri,
          subject_id: "owner_local",
        }).toString(),
        headers: {
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
      });
      const htmlText = await htmlResp.text();
      const codeMatch = htmlText.match(TOP_LEVEL_REGEX_2);
      assert.ok(codeMatch, "HTML body SHALL embed a cex_… exchange code");
      // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
      const code = codeMatch[0];

      // First redemption succeeds.
      const first = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as ExchangeResponse;
      assert.ok(firstBody.token.length > 0);

      // Second redemption fails; bearer SHALL NOT appear in the failure body.
      const second = await fetchJson(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.ok(second.status >= 400 && second.status < 500, `expected 4xx, got ${second.status}`);
      assert.equal(typeof second.body?.error?.code, "string", "failure SHALL be a PDPP error envelope");
      assert.equal(JSON.stringify(second.body).includes(firstBody.token), false);
    });
  });

  await t.test("an unknown exchange code is rejected", async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetchJson(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code: "cex_does_not_exist" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.ok(resp.status >= 400 && resp.status < 500);
      assert.equal(typeof resp.body?.error?.code, "string");
    });
  });

  await t.test("a missing code is rejected with 400", async () => {
    await withHarness(async ({ asUrl }) => {
      const resp = await fetchJson(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(resp.status, 400);
      assert.equal(resp.body?.error?.code, "invalid_request");
    });
  });

  // Direct unit-level coverage of the in-memory store: TTL expiry. We use the
  // exported helpers so we do not need to mock time inside the HTTP route.
  await t.test("expired exchange codes are not redeemable", () => {
    const fakeGrant = { client: { client_id: "cli_test" }, grant_id: "grt_test" };
    const code = createConsentExchangeCode({
      grant: fakeGrant,
      grantId: "grt_test",
      token: "tok_for_expiry_test",
      ttlMs: 1, // immediate expiry
    });
    // Wait one tick past TTL.
    return new Promise((resolve) =>
      setTimeout(() => {
        const result = consumeConsentExchangeCode(code);
        assert.equal(result.ok, false);
        assert.equal(result.reason, "expired");
        resolve();
      }, 5)
    );
  });
});
