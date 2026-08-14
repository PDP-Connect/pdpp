const TOP_LEVEL_REGEX_1 = /cex_[0-9a-f]{64}/;
const TOP_LEVEL_REGEX_2 = /cex_[0-9a-f]{64}/;
const APPROVAL_REVIEW_REVISION_PATTERN = /name="approval_review_revision" value="([^"]+)"/;
const GRANT_ID_RE = /grt_[a-zA-Z0-9]+/;
const FORCED_ORDINARY_DENIAL_ROLLBACK_RE = /forced ordinary denial rollback/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
// Regression tests for the harden-consent-token-handoff change.
//
// Pins the invariants:
//   1. The HTML branch of POST /consent/approve never embeds the bearer.
//   2. The HTML branch DOES embed an opaque cex_… exchange code.
//   3. POST /consent/exchange redeems the code and returns
//      { grant_id, token, grant }.
//   4. A proofless HTML code is single-use, while a matching out-of-band
//      recovery proof can recover the same result after response loss.
//   5. An expired code fails with a 4xx PDPP error envelope.
//   6. An unknown code fails with a 4xx PDPP error envelope.
//   7. The JSON branch of POST /consent/approve still returns the bearer in
//      its JSON body.
//
// Spec: openspec/changes/harden-consent-token-handoff/specs/
//       reference-implementation-architecture/spec.md
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  type AuthorizationDecisionFaultHook,
  approveGrant,
  consumeConsentExchangeCode,
  createConsentExchangeCode,
  denyGrant,
  getPendingConsent,
  introspect,
  parsePendingConsentRequestUri,
  revokeGrant,
} from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";

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

async function reviewConsent(asUrl: string, requestUri: string): Promise<string> {
  const response = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: OWNER_SUBJECT_ID }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { approval_review_revision?: unknown };
  assert.equal(typeof body.approval_review_revision, "string");
  return body.approval_review_revision as string;
}

async function approveReviewedHtml(asUrl: string, requestUri: string): Promise<Response> {
  const revision = await reviewConsent(asUrl, requestUri);
  return fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({ approval_review_revision: revision, request_uri: requestUri }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
}

async function approveReviewedJson(asUrl: string, requestUri: string): Promise<Response> {
  const revision = await reviewConsent(asUrl, requestUri);
  return fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ approval_review_revision: revision, request_uri: requestUri }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
}

interface HarnessContext {
  asUrl: string;
  spotifyManifest: SpotifyManifest;
}

function createDecisionPause(): { paused: Promise<void>; release: () => void; hook: () => Promise<void> } {
  let release: () => void = () => undefined;
  let markPaused: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    hook: async () => {
      markPaused();
      await resumed;
    },
    paused,
    release,
  };
}

function countConsentEvents(deviceCode: string, eventType: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS count FROM spine_events WHERE object_id = ? AND object_type = 'pending_consent' AND event_type = ?"
    )
    .get(deviceCode, eventType) as { count: number };
  return row.count;
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  ) as SpotifyManifest;
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await seedSpotifyInstance(spotifyManifest);
    await fn({ asUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function seedSpotifyInstance(spotifyManifest: SpotifyManifest): Promise<void> {
  const connectorId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_security_consent_handoff_spotify",
    createdAt: NOW,
    displayName: "Security Consent Handoff Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "security-consent-handoff@example.com" },
    sourceBindingKey: "security-consent-handoff@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

test("security: harden consent token handoff", async (t) => {
  await t.test("HTML approve does not embed the bearer; JSON approve still returns it", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      // First, get a token via the JSON branch (this is the established
      // programmatic contract used by the dashboard and every test).
      const initiateForJson = await initiateGrantRequest(asUrl, spotifyManifest);
      const reviewForJson = await fetch(`${asUrl}/consent/review`, {
        body: JSON.stringify({ request_uri: initiateForJson.request_uri, subject_id: "owner_local" }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      const jsonReviewText = await reviewForJson.text();
      assert.equal(reviewForJson.status, 200, jsonReviewText);
      const jsonReview = JSON.parse(jsonReviewText) as { approval_review_revision: string };
      const jsonResp = await fetch(`${asUrl}/consent/approve`, {
        body: JSON.stringify({
          approval_review_revision: jsonReview.approval_review_revision,
          request_uri: initiateForJson.request_uri,
        }),
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(jsonResp.status, 200);
      assert.equal(jsonResp.headers.get("cache-control"), "no-store");
      assert.equal(jsonResp.headers.get("pragma"), "no-cache");
      const jsonBody = (await jsonResp.json()) as ApproveJsonResponse;
      assert.equal(typeof jsonBody.token, "string", "JSON branch SHALL still return the bearer");
      assert.ok(jsonBody.token.length > 0);
      assert.equal(typeof jsonBody.grant_id, "string");
      assert.equal(typeof jsonBody.grant, "object");
      assert.equal(jsonBody.code, undefined, "JSON branch SHALL NOT include an exchange code");

      // Now drive a fresh approval through the HTML branch.
      const initiateForHtml = await initiateGrantRequest(asUrl, spotifyManifest);
      const reviewForHtml = await fetch(`${asUrl}/consent/review`, {
        body: new URLSearchParams({ request_uri: initiateForHtml.request_uri, subject_id: "owner_local" }).toString(),
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      const htmlReview = await reviewForHtml.text();
      assert.equal(reviewForHtml.status, 200, htmlReview);
      const revisionMatch = htmlReview.match(APPROVAL_REVIEW_REVISION_PATTERN);
      assert.ok(revisionMatch?.[1], "review HTML SHALL carry the approval review revision");
      const htmlResp = await fetch(`${asUrl}/consent/approve`, {
        body: new URLSearchParams({
          approval_review_revision: revisionMatch[1],
          request_uri: initiateForHtml.request_uri,
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
      assert.equal(htmlResp.headers.get("cache-control"), "no-store");
      assert.equal(htmlResp.headers.get("pragma"), "no-cache");
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
        headers: introspectionHeaders(),
        method: "POST",
      });
      assert.equal(exchangeResp.status, 200);
      assert.equal(exchangeResp.headers.get("cache-control"), "no-store");
      assert.equal(exchangeResp.headers.get("pragma"), "no-cache");
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
        headers: introspectionHeaders(),
        method: "POST",
      });
      const intro = (await introResp.json()) as IntrospectResponse;
      assert.equal(intro.active, true);
      assert.equal(intro.grant_id, exchangeBody.grant_id);
    });
  });

  await t.test("manual HTML exchange is single-use without exposing recovery proof", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const review = await fetch(`${asUrl}/consent/review`, {
        body: new URLSearchParams({ request_uri: initiate.request_uri, subject_id: "owner_local" }).toString(),
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      const reviewHtml = await review.text();
      assert.equal(review.status, 200, reviewHtml);
      const revisionMatch = reviewHtml.match(APPROVAL_REVIEW_REVISION_PATTERN);
      assert.ok(revisionMatch?.[1], "review HTML SHALL carry the approval review revision");
      const htmlResp = await fetch(`${asUrl}/consent/approve`, {
        body: new URLSearchParams({
          approval_review_revision: revisionMatch[1],
          request_uri: initiate.request_uri,
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

      const second = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(second.status, 410);
      assert.equal((await second.text()).includes(firstBody.token), false);
    });
  });

  await t.test("response-loss retry with the same out-of-band proof returns the same durable result", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const response = await approveReviewedJson(asUrl, initiate.request_uri);
      assert.equal(response.status, 200);
      const approved = (await response.json()) as ApproveJsonResponse;
      const proof = "same-proof-bound-to-intended-client";
      const code = await createConsentExchangeCode({
        grant: approved.grant as Record<string, unknown>,
        grantId: approved.grant_id,
        recoveryProof: proof,
        token: approved.token,
      });
      const first = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code, proof }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as ExchangeResponse;
      const retry = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code, proof }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(retry.status, 200);
      assert.deepEqual((await retry.json()) as ExchangeResponse, firstBody);
      const wrongProof = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code, proof: "wrong-proof" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(wrongProof.status, 410);
    });
  });

  await t.test("concurrent SQLite redemptions converge on one stored transition", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const approval = await approveReviewedHtml(asUrl, initiate.request_uri);
      const code = (await approval.text()).match(TOP_LEVEL_REGEX_1)?.[0];
      assert.ok(code);
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`${asUrl}/consent/exchange`, {
            body: JSON.stringify({ code }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          })
        )
      );
      assert.equal(responses.filter((response) => response.status === 200).length, 1);
      assert.equal(responses.filter((response) => response.status === 410).length, 7);
      const success = responses.find((response) => response.status === 200);
      assert.ok(success);
      const body = (await success.json()) as ExchangeResponse;
      assert.ok(body.token);
      const stored = getDb()
        .prepare("SELECT COUNT(*) AS n, COUNT(redeemed_at) AS redeemed FROM consent_exchange_codes")
        .get() as { n: number; redeemed: number };
      assert.deepEqual(stored, { n: 1, redeemed: 1 });
    });
  });

  await t.test("reissuing a handoff invalidates older outstanding exchange codes", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const response = await approveReviewedJson(asUrl, initiate.request_uri);
      assert.equal(response.status, 200);
      const approved = (await response.json()) as ApproveJsonResponse;
      const firstCode = await createConsentExchangeCode({
        grant: approved.grant as Record<string, unknown>,
        grantId: approved.grant_id,
        token: approved.token,
      });
      const secondCode = await createConsentExchangeCode({
        grant: approved.grant as Record<string, unknown>,
        grantId: approved.grant_id,
        token: approved.token,
      });
      const first = await consumeConsentExchangeCode(firstCode);
      assert.equal(first.ok, false);
      assert.equal(first.reason, "expired");
      const second = await consumeConsentExchangeCode(secondCode);
      assert.equal(second.ok, true);
      assert.equal(second.token, approved.token);
    });
  });

  await t.test("a revoked grant is not delivered by a stored exchange code", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const approval = await approveReviewedHtml(asUrl, initiate.request_uri);
      const html = await approval.text();
      const code = html.match(TOP_LEVEL_REGEX_1)?.[0];
      const grantId = html.match(GRANT_ID_RE)?.[0];
      assert.ok(code);
      assert.ok(grantId);
      await revokeGrant(grantId);
      const response = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(response.status, 404);
      assert.equal((await response.text()).includes("tok_"), false);
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

  await t.test("expired exchange codes are not redeemable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const response = await approveReviewedJson(asUrl, initiate.request_uri);
      assert.equal(response.status, 200);
      const approved = (await response.json()) as ApproveJsonResponse;
      const code = await createConsentExchangeCode({
        grant: approved.grant as Record<string, unknown>,
        grantId: approved.grant_id,
        token: approved.token,
        ttlMs: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const result = await consumeConsentExchangeCode(code);
      assert.equal(result.ok, false);
      assert.equal(result.reason, "expired");
    });
  });

  await t.test("an already-committed approval can create a fresh HTML handoff", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiate = await initiateGrantRequest(asUrl, spotifyManifest);
      const deviceCode = parsePendingConsentRequestUri(initiate.request_uri);
      assert.ok(deviceCode);
      // Inject the failure boundary directly: commit approval, then do not call
      // the HTML handoff creator or deliver a response.
      const pending = await getPendingConsent(deviceCode, {
        finalizeReview: true,
        subjectId: OWNER_SUBJECT_ID,
      });
      assert.ok(pending);
      assert.ok(pending.reviewRevision);
      const committed = await approveGrant(deviceCode, OWNER_SUBJECT_ID, {
        approval_review_revision: pending.reviewRevision,
      });

      const resumed = await fetch(`${asUrl}/consent/approve`, {
        body: new URLSearchParams({
          approval_review_revision: pending.reviewRevision as string,
          request_uri: initiate.request_uri,
        }).toString(),
        headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(resumed.status, 200);
      const html = await resumed.text();
      const code = html.match(TOP_LEVEL_REGEX_1)?.[0];
      assert.ok(code);
      const exchange = await fetch(`${asUrl}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(exchange.status, 200);
      const resumedBody = (await exchange.json()) as ExchangeResponse;
      assert.equal(resumedBody.grant_id, committed.grant.grant_id);
      assert.equal(resumedBody.token, committed.token);
    });
  });

  await t.test("an exchange code survives a SQLite-backed server restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "pdpp-consent-handoff-restart-"));
    const dbPath = join(directory, "pdpp.sqlite");
    const spotifyManifest = JSON.parse(
      readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
    ) as SpotifyManifest;
    let first: TestServerHandle | null = null;
    let second: TestServerHandle | null = null;
    try {
      first = await startServer({
        asPort: 0,
        dbPath,
        introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
        quiet: true,
        rsPort: 0,
      });
      const firstUrl = `http://localhost:${first.asPort}`;
      const registerResp = await fetch(`${firstUrl}/connectors`, {
        body: JSON.stringify(spotifyManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 201);
      await seedSpotifyInstance(spotifyManifest);
      const initiate = await initiateGrantRequest(firstUrl, spotifyManifest);
      const approval = await approveReviewedHtml(firstUrl, initiate.request_uri);
      assert.equal(approval.status, 200);
      const code = (await approval.text()).match(TOP_LEVEL_REGEX_1)?.[0];
      assert.ok(code);

      await closeServer(first);
      first = null;
      closeDb();

      second = await startServer({
        asPort: 0,
        dbPath,
        introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
        quiet: true,
        rsPort: 0,
      });
      const response = await fetch(`http://localhost:${second.asPort}/consent/exchange`, {
        body: JSON.stringify({ code }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(response.status, 200);
      const result = (await response.json()) as ExchangeResponse;
      assert.ok(result.token);
      assert.ok(result.grant_id);
    } finally {
      if (first) {
        await closeServer(first);
      }
      if (second) {
        await closeServer(second);
      }
      closeDb();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  await t.test("ordinary approval wins a paused denial without contradictory denial evidence", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiated = await initiateGrantRequest(asUrl, spotifyManifest);
      const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
      assert.ok(deviceCode);
      const pending = await getPendingConsent(deviceCode, {
        finalizeReview: true,
        subjectId: OWNER_SUBJECT_ID,
      });
      assert.ok(pending?.reviewRevision);
      const pause = createDecisionPause();
      const denial = denyGrant(deviceCode, { beforeCasHook: pause.hook });
      await pause.paused;
      const approved = await approveGrant(deviceCode, OWNER_SUBJECT_ID, {
        approval_review_revision: pending.reviewRevision,
      });
      pause.release();

      await assert.rejects(
        denial,
        (err: unknown) => err instanceof Error && "code" in err && err.code === "approval_conflict"
      );
      assert.equal((await introspect(approved.token)).active, true);
      assert.equal(countConsentEvents(deviceCode, "consent.approved"), 1);
      assert.equal(countConsentEvents(deviceCode, "consent.denied"), 0);
    });
  });

  await t.test("ordinary denial is terminal and rolls back its event on transaction failure", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const rollbackInitiated = await initiateGrantRequest(asUrl, spotifyManifest);
      const rollbackCode = parsePendingConsentRequestUri(rollbackInitiated.request_uri);
      assert.ok(rollbackCode);
      const faultHook: AuthorizationDecisionFaultHook = (stage) => {
        if (stage === "after_event_before_commit") {
          throw new Error("forced ordinary denial rollback");
        }
      };
      await assert.rejects(denyGrant(rollbackCode, { faultHook }), FORCED_ORDINARY_DENIAL_ROLLBACK_RE);
      assert.ok(await getPendingConsent(rollbackCode), "rolled-back denial remains pending");
      assert.equal(countConsentEvents(rollbackCode, "consent.denied"), 0);

      const deniedInitiated = await initiateGrantRequest(asUrl, spotifyManifest);
      const deniedCode = parsePendingConsentRequestUri(deniedInitiated.request_uri);
      assert.ok(deniedCode);
      const pending = await getPendingConsent(deniedCode, {
        finalizeReview: true,
        subjectId: OWNER_SUBJECT_ID,
      });
      assert.ok(pending?.reviewRevision);
      assert.equal(await denyGrant(deniedCode), true);
      await assert.rejects(
        approveGrant(deniedCode, OWNER_SUBJECT_ID, { approval_review_revision: pending.reviewRevision }),
        (err: unknown) => err instanceof Error && "code" in err && err.code === "approval_conflict"
      );
      assert.equal(countConsentEvents(deniedCode, "consent.denied"), 1);
      assert.equal(countConsentEvents(deniedCode, "consent.approved"), 0);
    });
  });

  await t.test("ordinary mixed approval and denial contention has one terminal outcome", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiated = await initiateGrantRequest(asUrl, spotifyManifest);
      const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
      assert.ok(deviceCode);
      const pending = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: OWNER_SUBJECT_ID });
      assert.ok(pending?.reviewRevision);
      const attempts = await Promise.allSettled(
        Array.from({ length: 16 }, (_, index) =>
          index % 2 === 0
            ? approveGrant(deviceCode, OWNER_SUBJECT_ID, { approval_review_revision: pending.reviewRevision })
            : denyGrant(deviceCode)
        )
      );
      let approvedToken: string | null = null;
      for (const attempt of attempts) {
        if (
          attempt.status === "fulfilled" &&
          typeof attempt.value === "object" &&
          attempt.value !== null &&
          "token" in attempt.value &&
          typeof attempt.value.token === "string"
        ) {
          approvedToken = attempt.value.token;
          break;
        }
      }
      const terminal = (await getDb()
        .prepare("SELECT status, token_id FROM pending_consents WHERE device_code = ?")
        .get(deviceCode)) as { status: string; token_id: string | null };
      assert.ok(terminal.status === "approved" || terminal.status === "denied");
      assert.equal(terminal.status === "approved", approvedToken !== null);
      assert.equal(countConsentEvents(deviceCode, "consent.approved"), terminal.status === "approved" ? 1 : 0);
      assert.equal(countConsentEvents(deviceCode, "consent.denied"), terminal.status === "denied" ? 1 : 0);
      assert.equal(terminal.status === "denied", terminal.token_id === null);
      if (approvedToken) {
        assert.equal((await introspect(approvedToken)).active, true);
      }
    });
  });
});
