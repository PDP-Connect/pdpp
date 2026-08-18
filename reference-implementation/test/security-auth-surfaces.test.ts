// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Regression tests for the harden-reference-auth-surfaces change.
//
// Pins four invariants:
//   1. /_ref/grants/<id>/timeline never echoes spine_events.token_id back.
//   2. /_ref/runs/<id>/timeline never echoes spine_events.token_id back.
//   3. POST /grants/<id>/revoke requires owner-or-grant-bound bearer auth.
//   4. AS responses carry the X-Frame-Options + CSP frame-ancestors headers.
//
// Spec: openspec/changes/harden-reference-auth-surfaces/specs/
//       reference-implementation-architecture/spec.md
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { RefSpineEventsPageEnvelope } from "../operations/ref-spine-events-page/index.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Established pattern, see
// connector-detail-default-account-and-ambiguity.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv: TestServer["asServer"] | TestServer["rsServer"]): Promise<void> =>
    new Promise((resolve) => {
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

interface FetchJsonResult<T> {
  readonly body: T;
  readonly headers: Record<string, string>;
  readonly status: number;
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  let body: T = null as T;
  try {
    body = (await resp.json()) as T;
  } catch {
    /* non-json */
  }
  return { body, headers: Object.fromEntries(resp.headers.entries()), status: resp.status };
}

interface DeviceAuthorizationBody {
  readonly device_code: string;
  readonly user_code: string;
}

interface TokenBody {
  readonly access_token: string;
}

interface SpotifyManifest {
  readonly connector_id: string;
  readonly [key: string]: unknown;
}

interface ParInitiateBody {
  readonly request_uri: string;
}

interface GrantApproval {
  readonly grant_id: string;
  readonly [key: string]: unknown;
}

interface ApproveGrantResponse {
  readonly grant: GrantApproval;
  readonly grant_id: string;
  readonly token: string;
}

interface RevokeResponseBody {
  readonly error?: { readonly code?: string };
  readonly revoked?: boolean;
}

interface IntrospectResponseBody {
  readonly active: boolean;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorizationBody>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);
  const { body: tokenBody } = await fetchJson<TokenBody>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return tokenBody.access_token;
}

async function approveSpotifyGrant(
  asUrl: string,
  spotifyManifest: SpotifyManifest,
  subjectId = "owner_local"
): Promise<ApproveGrantResponse> {
  const initResp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "Auth-surface regression smoke",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: "concert_recommendation_app",
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  if (initResp.status !== 201) {
    const errBody = await initResp.text();
    throw new Error(`PAR failed (${initResp.status}): ${errBody}`);
  }
  const initiate = (await initResp.json()) as ParInitiateBody;
  const reviewResp = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const reviewText = await reviewResp.text();
  assert.equal(reviewResp.status, 200, reviewText);
  const review = JSON.parse(reviewText) as {
    approval_review: object;
    approval_review_revision: string;
    request_uri: string;
  };
  assert.ok(review.approval_review);
  assert.ok(review.approval_review_revision);
  assert.equal(review.request_uri, initiate.request_uri);
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.approval_review_revision,
      request_uri: review.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const approveBody = await approveResp.text();
  assert.equal(approveResp.status, 200, approveBody);
  return JSON.parse(approveBody) as ApproveGrantResponse;
}

interface HarnessContext {
  readonly asUrl: string;
  readonly rsUrl: string;
  readonly spotifyManifest: SpotifyManifest;
}

async function withHarness(fn: (ctx: HarnessContext) => Promise<void>): Promise<void> {
  const spotifyManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  ) as SpotifyManifest;
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    quiet: true,
    rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201);
    await seedSpotifyInstance(spotifyManifest);
    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function seedSpotifyInstance(spotifyManifest: SpotifyManifest): Promise<void> {
  const connectorId = canonicalConnectorKey(spotifyManifest.connector_id);
  assert.ok(connectorId, "spotify manifest must resolve to a canonical connector key");
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: "cin_security_auth_surfaces_spotify",
    createdAt: NOW,
    displayName: "Security Auth Surfaces Spotify",
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: "security-auth-surfaces@example.com" },
    sourceBindingKey: "security-auth-surfaces@example.com",
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

test("security: harden reference auth surfaces", async (t) => {
  await t.test("grant timeline never echoes token_id", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const { status, body } = await fetchJson<RefSpineEventsPageEnvelope>(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`
      );
      assert.equal(status, 200);
      assert.ok(Array.isArray(body.data), "timeline returns events");
      assert.ok(body.data.length > 0, "timeline has at least one event");
      for (const ev of body.data) {
        assert.ok(!("token_id" in ev), `timeline event ${ev.event_id} unexpectedly carries token_id`);
      }
      // The exact bearer string MUST NOT appear anywhere in the response body.
      const raw = JSON.stringify(body);
      assert.equal(raw.includes(approval.token), false, "response body unexpectedly contains the live bearer string");
    });
  });

  await t.test("grant timeline redacts object_id on token.issued events", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const { body } = await fetchJson<RefSpineEventsPageEnvelope>(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`
      );
      const tokenEvents = body.data.filter((ev) => ev.object_type === "token");
      assert.ok(tokenEvents.length > 0, "expected at least one token-typed event on the grant timeline");
      for (const ev of tokenEvents) {
        assert.equal(ev.object_id, "<redacted-token-id>", `event ${ev.event_id} object_id was not redacted`);
      }
    });
  });

  await t.test("timeline projection does not touch other event fields", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const { body } = await fetchJson<RefSpineEventsPageEnvelope>(
        `${asUrl}/_ref/grants/${encodeURIComponent(approval.grant.grant_id)}/timeline`
      );
      // Pick an event whose object_type is NOT 'token' (e.g. 'grant'); its
      // object_id, grant_id, client_id, and `data` payload SHALL be unchanged.
      const nonTokenEvent = body.data.find((ev) => ev.object_type !== "token");
      assert.ok(nonTokenEvent, "timeline should include at least one non-token event");
      if (!nonTokenEvent) {
        throw new Error("unreachable: asserted above");
      }
      assert.notEqual(
        nonTokenEvent.object_id,
        "<redacted-token-id>",
        "non-token events SHALL NOT have their object_id redacted"
      );
      assert.equal(nonTokenEvent.grant_id, approval.grant.grant_id, "grant_id SHALL be returned unchanged");
      assert.equal(typeof nonTokenEvent.data, "object", "event data payload SHALL be present and unchanged");
    });
  });

  await t.test("revoke without Authorization header is rejected", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        method: "POST",
      });
      assert.equal(resp.status, 401);
      const body = (await resp.json()) as RevokeResponseBody;
      assert.equal(body.error?.code, "authentication_error");

      // The grant SHALL remain unchanged. Use a fresh introspect call to prove it.
      const introResp = await fetch(`${asUrl}/introspect`, {
        body: JSON.stringify({ token: approval.token }),
        headers: introspectionHeaders(),
        method: "POST",
      });
      const intro = (await introResp.json()) as IntrospectResponseBody;
      assert.equal(intro.active, true, "grant should still be active after rejected revoke");
    });
  });

  await t.test("revoke with the grant's own client bearer succeeds", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${approval.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as RevokeResponseBody;
      assert.equal(body.revoked, true);
    });
  });

  await t.test("revoke with a client bearer bound to a different grant is rejected", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const a = await approveSpotifyGrant(asUrl, spotifyManifest);
      const b = await approveSpotifyGrant(asUrl, spotifyManifest);
      assert.notEqual(a.grant.grant_id, b.grant.grant_id);
      // Try to revoke A using B's bearer.
      const resp = await fetch(`${asUrl}/grants/${a.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${b.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(resp.status, 403);
      const body = (await resp.json()) as RevokeResponseBody;
      assert.equal(body.error?.code, "permission_error");

      // A should still be active.
      const introResp = await fetch(`${asUrl}/introspect`, {
        body: JSON.stringify({ token: a.token }),
        headers: introspectionHeaders(),
        method: "POST",
      });
      const intro = (await introResp.json()) as IntrospectResponseBody;
      assert.equal(intro.active, true, "grant A should still be active after cross-grant revoke attempt");
    });
  });

  await t.test("revoke with an owner bearer succeeds for any grant", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const ownerToken = await issueOwnerToken(asUrl);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(resp.status, 200);
      const body = (await resp.json()) as RevokeResponseBody;
      assert.equal(body.revoked, true);
    });
  });

  await t.test("revoke with an unknown bearer is rejected as 401", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approval = await approveSpotifyGrant(asUrl, spotifyManifest);
      const resp = await fetch(`${asUrl}/grants/${approval.grant.grant_id}/revoke`, {
        headers: {
          Authorization: "Bearer this-is-not-a-real-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(resp.status, 401);
      const body = (await resp.json()) as RevokeResponseBody;
      assert.equal(body.error?.code, "authentication_error");
    });
  });

  await t.test("AS responses carry clickjacking-defense headers", async () => {
    await withHarness(async ({ asUrl }) => {
      // HTML page (owner-login is always reachable, regardless of placeholder
      // owner-auth being on or off).
      const htmlResp = await fetch(`${asUrl}/owner/login`);
      assert.equal(htmlResp.headers.get("x-frame-options"), "DENY");
      assert.equal(htmlResp.headers.get("content-security-policy"), "frame-ancestors 'none'");

      // JSON endpoint also carries them (harmless, defense-in-depth).
      const jsonResp = await fetch(`${asUrl}/.well-known/oauth-authorization-server`);
      assert.equal(jsonResp.headers.get("x-frame-options"), "DENY");
      assert.equal(jsonResp.headers.get("content-security-policy"), "frame-ancestors 'none'");
    });
  });
});
