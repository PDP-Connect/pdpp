// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real auth.js Postgres-adapter path proof for the token / oauth-authorization-code /
 * oauth-refresh-token row operations.
 *
 * The token, oauth_authorization_codes, and oauth_refresh_tokens row operations
 * in `server/auth.ts` each carry a Postgres adapter behind
 * `isPostgresStorageBackend()`. Before this file, the only PG-path coverage was
 * indirect: the consent + device-auth path test exercises `issueToken`'s
 * FOR-UPDATE transaction branch and the grant-package path test exercises
 * `issuePackageToken`. The dialect-only seams that the seam-march collapses into
 * `getOAuthCodeStore()` / `getRefreshTokenStore()` / `getTokenStore()` had no
 * direct Postgres-path test.
 *
 * This test closes that gap. It boots the REAL reference server with the storage
 * backend switched to Postgres and drives the exported OAuth authorization-code +
 * refresh-token grant flows over HTTP, so the production Postgres adapters
 * actually execute end to end:
 *   - issueOAuthAuthorizationCodeForDeviceCode  (oauth_authorization_codes
 *     SELECT-by-device + the issue UPDATE), during POST /consent/approve
 *   - exchangeOAuthAuthorizationCode  (oauth_authorization_codes SELECT-by-code +
 *     the consume UPDATE), during POST /oauth/token grant_type=authorization_code
 *   - issueOAuthRefreshToken  (oauth_refresh_tokens INSERT), minted alongside the
 *     access token when the client supports refresh_token
 *   - exchangeOAuthRefreshToken  (oauth_refresh_tokens family rotation),
 *     during POST /oauth/token grant_type=refresh_token
 *   - introspect  (the tokens SELECT join), via GET /oauth/introspect and the
 *     internal exchange validation
 *   - issueOwnerTokenRecord  (tokens INSERT-owner), via the owner device flow
 *
 * `issueToken` (the grants FOR-UPDATE multi-statement transaction) and the
 * grant-revoke / package-revoke cascades are intentionally NOT migrated by the
 * seam-march and are covered elsewhere; they are exercised incidentally here but
 * are not this file's mandate.
 *
 * The whole file is gated on `PDPP_TEST_POSTGRES_URL`; when unset it registers a
 * single skipped test so default development and CI do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_tok \
 *     node --test --import tsx \
 *     reference-implementation/test/token-refresh-postgres-path.test.js
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateResponse } from "@pdpp/reference-contract";

import {
  issueOAuthAuthorizationCodeForDeviceCode,
  issueOAuthAuthorizationCodeForPackageDeviceCode,
  issueToken,
  revokeGrant,
  stageOAuthAuthorizationCodeRequest,
} from "../server/auth.ts";
import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { basicIntrospectionAuthorization } from "../server/introspection-http.ts";
import { bootstrapPostgresSchema, closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const NOT_RECOVERABLE_OR_INVALID = /not recoverable|invalid/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const SPOTIFY_INSTANCE_ID = "cin_pr89_token_refresh_spotify";
const V01_LEGACY_BYTES = readFileSync(
  join(REFERENCE_IMPL_DIR, "test/seam-spike/fixtures/pr89/legacy-grant-v01.bytes"),
  "utf8"
).trim();

interface CloseableHttpServer {
  close: (callback: () => void) => unknown;
  closeAllConnections?: () => void;
}

interface TestServer {
  asPort: number;
  asServer: CloseableHttpServer;
  rsPort: number;
  rsServer: CloseableHttpServer;
}

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(() => resolve(undefined))),
    new Promise((resolve) => server.rsServer.close(() => resolve(undefined))),
  ]);
}

interface FetchJsonResult<T> {
  body: T;
  resp: Response;
  status: number;
}

async function fetchJson<T = Record<string, unknown>>(
  url: string | URL,
  opts: RequestInit = {}
): Promise<FetchJsonResult<T>> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const body = text ? JSON.parse(text) : null;
  return { body: body as T, resp, status: resp.status };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function refreshTokenHash(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("base64url");
}

const INTROSPECTION_HEADERS = {
  Authorization: basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS),
  "Content-Type": "application/x-www-form-urlencoded",
};

interface ConnectorManifest {
  connector_id: string;
  [extension: string]: unknown;
}

async function registerConnector(asUrl: string, name: string): Promise<ConnectorManifest> {
  const raw: ConnectorManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `manifests/${name}.json`), "utf8"));
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(raw),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return raw;
}

async function seedActiveConnectorInstance(manifest: ConnectorManifest): Promise<void> {
  const connectorId = canonicalConnectorKeyFromManifest(manifest);
  assert.ok(connectorId, "registered manifest has a canonical storage connector key");
  const now = new Date().toISOString();
  await createPostgresConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: SPOTIFY_INSTANCE_ID,
    createdAt: now,
    displayName: "PR89 token refresh fixture",
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: SPOTIFY_INSTANCE_ID },
    sourceBindingKey: SPOTIFY_INSTANCE_ID,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

interface RegisteredClient {
  client_id: string;
  grant_types: string[];
  [extension: string]: unknown;
}

async function registerAuthCodeClient(asUrl: string, { refreshToken = true } = {}): Promise<RegisteredClient> {
  const grantTypes = refreshToken ? ["authorization_code", "refresh_token"] : ["authorization_code"];
  const { status, body } = await fetchJson<RegisteredClient>(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "token-refresh-postgres-path test client",
      grant_types: grantTypes,
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  assert.deepEqual(body.grant_types, grantTypes);
  return body;
}

interface OauthCodeFlowResult {
  accessToken: string;
  code: string;
  expiresIn: number | undefined;
  grantId: string;
  refreshToken: string | null;
  verifier: string;
}

interface PreparedOauthCodeFlow {
  code: string;
  verifier: string;
}

// Single-source authorization-code flow. Drives the oauth-code issue +
// consume seams and (when the client supports refresh) the refresh-token
// INSERT. Returns the access token, the refresh token, the grant id, and the
// code so callers can assert single-use replay.
async function prepareOauthCodeFlow({
  accessMode = "continuous",
  asUrl,
  client,
  manifest,
}: {
  accessMode?: "continuous" | "single_use";
  asUrl: string;
  client: RegisteredClient;
  manifest: ConnectorManifest;
}): Promise<PreparedOauthCodeFlow> {
  const verifier = randomBytes(32).toString("base64url");
  const authorizationDetails = [
    {
      access_mode: accessMode,
      purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
      purpose_description: "token-refresh postgres-path proof",
      source: { id: manifest.connector_id, kind: "connector" },
      streams: [{ name: "*" }],
      type: "https://pdpp.dev/data-access",
    },
  ];
  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", "state-tok");
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("authorization_details", JSON.stringify(authorizationDetails));

  const authorizeResp = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorizeResp.status, 302);
  const authorizeLocation = authorizeResp.headers.get("location");
  assert.ok(authorizeLocation, "authorize redirect carries a location header");
  const consentUrl = new URL(authorizeLocation, asUrl);
  const requestUri = consentUrl.searchParams.get("request_uri");
  assert.ok(requestUri, "authorize redirect carries a request_uri");

  const review = await fetchJson<{ approval_review_revision?: unknown }>(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: "owner_local" }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));
  assert.equal(typeof review.body.approval_review_revision, "string", "consent review returns a revision");
  const reviewRevision = review.body.approval_review_revision as string;
  // POST /consent/approve drives issueOAuthAuthorizationCodeForDeviceCode:
  // the oauth_authorization_codes SELECT-by-device + the issue UPDATE.
  const approveResp = await fetch(`${asUrl}/consent/approve`, {
    body: new URLSearchParams({
      approval_review_revision: reviewRevision,
      request_uri: requestUri,
    }).toString(),
    headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  assert.equal(approveResp.status, 302);
  const approveLocation = approveResp.headers.get("location");
  assert.ok(approveLocation, "approve response carries a location header");
  const callback = new URL(approveLocation);
  assert.equal(callback.origin, "https://client.example");
  assert.equal(callback.searchParams.get("state"), "state-tok");
  const code = callback.searchParams.get("code");
  assert.ok(code, "approve callback carries an authorization code");

  return { code, verifier };
}

async function completeOauthCodeFlow({
  accessMode = "continuous",
  asUrl,
  client,
  manifest,
}: {
  accessMode?: "continuous" | "single_use";
  asUrl: string;
  client: RegisteredClient;
  manifest: ConnectorManifest;
}): Promise<OauthCodeFlowResult> {
  const { code, verifier } = await prepareOauthCodeFlow({ accessMode, asUrl, client, manifest });

  // POST /oauth/token grant_type=authorization_code drives
  // exchangeOAuthAuthorizationCode (oauth_authorization_codes SELECT-by-code +
  // the consume UPDATE), introspect (the tokens SELECT join), and, when the
  // client supports refresh, issueOAuthRefreshToken (oauth_refresh_tokens
  // INSERT).
  interface TokenResponseBody {
    access_token: string;
    expires_in?: number;
    grant_id: string;
    refresh_token?: string;
    token_type: string;
  }
  const { status, body } = await fetchJson<TokenResponseBody>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: "https://client.example/callback",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.ok(body.access_token, "code exchange returns an access token");
  return {
    accessToken: body.access_token,
    code,
    expiresIn: body.expires_in,
    grantId: body.grant_id,
    refreshToken: body.refresh_token || null,
    verifier,
  };
}

if (POSTGRES_URL) {
  // One server for the whole file. Every token / oauth-code / refresh-token
  // read and write routes to Postgres because the active storage backend is
  // postgres. Concrete proof the Postgres adapters run: the negative control
  // breaks a Postgres-only adapter and this suite goes red.
  let server: TestServer | undefined;
  let asUrl = "";
  let rsUrl = "";
  let client: RegisteredClient | undefined;
  let spotify: ConnectorManifest | undefined;

  test.before(async () => {
    const databaseUrl = POSTGRES_URL;
    assert.ok(databaseUrl, "Postgres URL is configured when this test runs");
    process.env.PDPP_DATABASE_URL = databaseUrl;
    server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
      ownerAuthPassword: "",
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
    });
    asUrl = `http://localhost:${server.asPort}`;
    rsUrl = `http://localhost:${server.rsPort}`;
    spotify = await registerConnector(asUrl, "spotify");
    await seedActiveConnectorInstance(spotify);
    client = await registerAuthCodeClient(asUrl);
  });

  test.after(async () => {
    if (server) {
      await closeServer(server);
    }
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [SPOTIFY_INSTANCE_ID]);
    await closePostgresStorage();
    closeDb();
  });

  // ---------------------------------------------------------------------
  // A) Owner device flow -> owner token INSERT + introspection.
  //
  // Exercises issueOwnerTokenRecord (tokens INSERT-owner) and introspect (the
  // tokens SELECT join) through the real device-authorization flow.
  // ---------------------------------------------------------------------
  test("owner device flow mints + introspects an owner token through real auth.js postgres adapters", async () => {
    // cli_longview is the owner CLI client that startServer pre-seeds at boot;
    // bare owner device authorization (no resource / authorization_details) is
    // only accepted for a known client.
    interface DeviceAuthorizationBody {
      device_code: string;
      user_code: string;
    }
    interface OwnerTokenBody {
      access_token: string;
    }
    interface IntrospectBody {
      active: boolean;
      subject_id?: string;
    }

    const ownerClientId = "cli_longview";
    const { body: device } = await fetchJson<DeviceAuthorizationBody>(`${asUrl}/oauth/device_authorization`, {
      body: new URLSearchParams({ client_id: ownerClientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.ok(device.device_code, "device authorization returns a device_code");

    const approveResp = await fetch(`${asUrl}/device/approve`, {
      body: new URLSearchParams({
        subject_id: "owner_local",
        user_code: device.user_code,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(approveResp.status, 200);

    // grant_type=device_code drives issueOwnerTokenRecord (tokens INSERT-owner).
    const { body: tokenBody } = await fetchJson<OwnerTokenBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: ownerClientId,
        device_code: device.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.ok(tokenBody.access_token, "owner device exchange returns an owner token");

    // Introspect the owner token: the tokens SELECT join (PG introspect adapter).
    const introspectResp = await fetchJson<IntrospectBody>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: tokenBody.access_token }).toString(),
      headers: INTROSPECTION_HEADERS,
      method: "POST",
    });
    assert.equal(introspectResp.status, 200);
    assert.equal(introspectResp.body.active, true, "owner token introspects as active");
    assert.equal(introspectResp.body.subject_id, "owner_local", "introspection subject is owner_local");
  });

  // ---------------------------------------------------------------------
  // B) Authorization-code + refresh-token lifecycle.
  //
  // Exercises the oauth_authorization_codes seams (issue + consume), the
  // oauth_refresh_tokens INSERT, the introspect tokens SELECT, and the
  // refresh-token exchange and atomic family rotation.
  // ---------------------------------------------------------------------
  test("authorization-code redemption has one PostgreSQL race winner", async () => {
    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const registeredClient = client;
    const prepared = await prepareOauthCodeFlow({ asUrl, client: registeredClient, manifest: spotify });
    const redeem = () =>
      fetchJson<{ access_token?: string; error?: string }>(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: registeredClient.client_id,
          code: prepared.code,
          code_verifier: prepared.verifier,
          grant_type: "authorization_code",
          redirect_uri: "https://client.example/callback",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

    const results = await Promise.all([redeem(), redeem()]);
    assert.deepEqual(
      results.map(({ status }) => status).sort(),
      [200, 400],
      "one redemption succeeds and one loses the atomic consume"
    );
    assert.equal(results.find(({ status }) => status === 400)?.body.error, "invalid_grant");

    const persisted = await postgresQuery<{
      consumed_at: string | null;
      status: string;
      token_count: number;
    }>(
      `SELECT c.consumed_at, c.status, COUNT(t.token_id)::int AS token_count
         FROM oauth_authorization_codes c
         LEFT JOIN tokens t ON t.token_id = c.token_id
        WHERE c.code = $1
        GROUP BY c.consumed_at, c.status`,
      [prepared.code]
    );
    assert.equal(persisted.rows[0]?.status, "consumed");
    assert.ok(persisted.rows[0]?.consumed_at, "winner records the consumption timestamp");
    assert.equal(persisted.rows[0]?.token_count, 1, "the code remains bound to exactly one bearer row");

    const sequentialReplay = await redeem();
    assert.equal(sequentialReplay.status, 400);
    assert.equal(sequentialReplay.body.error, "invalid_grant");
  });

  test("authorization-code failure rolls back PostgreSQL consumption with initial refresh issuance", async () => {
    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const registeredClient = client;
    const prepared = await prepareOauthCodeFlow({ asUrl, client: registeredClient, manifest: spotify });
    await postgresQuery(`
      CREATE OR REPLACE FUNCTION fail_initial_refresh_issuance()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'injected initial refresh failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await postgresQuery(`
      CREATE TRIGGER fail_initial_refresh_issuance
      BEFORE INSERT ON oauth_refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION fail_initial_refresh_issuance()
    `);
    const redeem = () =>
      fetchJson<{ error?: string; refresh_token?: string }>(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: registeredClient.client_id,
          code: prepared.code,
          code_verifier: prepared.verifier,
          grant_type: "authorization_code",
          redirect_uri: "https://client.example/callback",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

    const failed = await redeem();
    assert.notEqual(failed.status, 200);
    const afterFailure = await postgresQuery<{ consumed_at: string | null; status: string }>(
      "SELECT status, consumed_at FROM oauth_authorization_codes WHERE code = $1",
      [prepared.code]
    );
    assert.deepEqual(afterFailure.rows[0], { consumed_at: null, status: "issued" });

    await postgresQuery("DROP TRIGGER fail_initial_refresh_issuance ON oauth_refresh_tokens");
    await postgresQuery("DROP FUNCTION fail_initial_refresh_issuance()");
    const retried = await redeem();
    assert.equal(retried.status, 200);
    assert.equal(typeof retried.body.refresh_token, "string");
  });

  test("authorization-code delivery converges and recovers on PostgreSQL", async () => {
    assert.ok(client, "client must be registered in test.before");
    const challenge = pkceChallenge(randomBytes(32).toString("base64url"));
    const redirectUri = "https://client.example/callback";
    const exercise = async (
      kind: "grant" | "package",
      deviceCode: string,
      binding: { grantId: string; token: string } | { packageId: string; token: string }
    ) => {
      await stageOAuthAuthorizationCodeRequest({
        clientId: client?.client_id,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
        deviceCode,
        redirectUri,
      });
      const issue = () =>
        kind === "grant"
          ? issueOAuthAuthorizationCodeForDeviceCode(deviceCode, binding as { grantId: string; token: string })
          : issueOAuthAuthorizationCodeForPackageDeviceCode(
              deviceCode,
              binding as { packageId: string; token: string }
            );
      const issued = await Promise.all([issue(), issue()]);
      assert.deepEqual(issued[1], issued[0]);
      assert.equal(issued[0]?.redirect_uri, redirectUri);
      assert.equal(typeof issued[0]?.code, "string");
      return issued[0];
    };

    const grantDeviceCode = `device_delivery_grant_${randomBytes(6).toString("hex")}`;
    const grantCode = await exercise("grant", grantDeviceCode, {
      grantId: "grt_delivery",
      token: "tok_delivery",
    });
    await postgresQuery(
      "UPDATE oauth_authorization_codes SET status = 'consumed', consumed_at = NOW() WHERE code = $1",
      [grantCode?.code]
    );
    await assert.rejects(
      () =>
        issueOAuthAuthorizationCodeForDeviceCode(grantDeviceCode, {
          grantId: "grt_delivery",
          token: "tok_delivery",
        }),
      NOT_RECOVERABLE_OR_INVALID
    );
    await exercise("package", `device_delivery_package_${randomBytes(6).toString("hex")}`, {
      packageId: "gpkg_delivery",
      token: "tok_package_delivery",
    });
  });

  test("single-use grant issuance has one PostgreSQL race winner", async () => {
    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const registeredClient = client;
    const grantId = `grt_pr89_single_use_${randomBytes(8).toString("hex")}`;
    const connectorId = canonicalConnectorKeyFromManifest(spotify);
    assert.ok(connectorId, "spotify manifest has a canonical storage connector key");
    const sourceId = spotify.connector_id;
    await postgresQuery(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, status, consumed, issued_at, expires_at
       ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, 'single_use', 'active', FALSE, $6, NULL)`,
      [
        grantId,
        "owner_local",
        registeredClient.client_id,
        JSON.stringify({ connector_id: connectorId }),
        JSON.stringify({
          access_mode: "single_use",
          client: { client_id: registeredClient.client_id },
          grant_id: grantId,
          issued_at: "2026-08-11T12:00:00Z",
          purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
          source: { id: sourceId, kind: "connector" },
          source_declaration: { version: "1.0.0" },
          streams: [{ fields: ["id", "name"], instance_ids: [SPOTIFY_INSTANCE_ID], name: "top_artists" }],
          subject: { id: "owner_local" },
          version: "0.1.0",
        }),
        "2026-08-11T12:00:00Z",
      ]
    );

    const issue = () => issueToken(grantId, "owner_local", registeredClient.client_id, null, { source: "pr89_seam" });
    const results = await Promise.allSettled([issue(), issue()]);
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
    const loser = results.find(({ status }) => status === "rejected");
    assert.ok(loser?.status === "rejected");
    assert.equal((loser.reason as { code?: string }).code, "grant_consumed");

    const persisted = await postgresQuery<{ consumed: boolean; token_count: number }>(
      `SELECT g.consumed, COUNT(t.token_id)::int AS token_count
         FROM grants g
         LEFT JOIN tokens t ON t.grant_id = g.grant_id
        WHERE g.grant_id = $1
        GROUP BY g.consumed`,
      [grantId]
    );
    assert.equal(persisted.rows[0]?.consumed, true);
    assert.equal(persisted.rows[0]?.token_count, 1);
  });

  test("migrated pre-family PostgreSQL refresh rows fail closed without reconstruction", async () => {
    assert.ok(client, "client must be registered in test.before");
    const legacyToken = `rt_${randomBytes(32).toString("base64url")}`;
    const legacyHash = refreshTokenHash(legacyToken);
    await postgresQuery("ALTER TABLE oauth_refresh_tokens ALTER COLUMN family_id DROP NOT NULL");
    await postgresQuery("ALTER TABLE oauth_refresh_tokens ALTER COLUMN generation DROP NOT NULL");
    try {
      await postgresQuery(
        `INSERT INTO oauth_refresh_tokens(
           refresh_token_hash, family_id, generation, parent_generation,
           client_id, grant_id, subject_id, status, created_at
         ) VALUES($1, NULL, NULL, NULL, $2, $3, $4, 'active', $5)`,
        [legacyHash, client.client_id, "grt_pre_family", "owner_local", "2026-08-11T12:00:00Z"]
      );
      const response = await fetchJson<{ error?: string }>(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: legacyToken,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.error, "invalid_grant");
      const row = await postgresQuery<{
        family_id: string | null;
        generation: number | null;
        parent_generation: number | null;
        status: string;
      }>(
        `SELECT family_id, generation, parent_generation, status
           FROM oauth_refresh_tokens
          WHERE refresh_token_hash = $1`,
        [legacyHash]
      );
      assert.deepEqual(row.rows[0], {
        family_id: null,
        generation: null,
        parent_generation: null,
        status: "active",
      });
    } finally {
      await postgresQuery("DELETE FROM oauth_refresh_tokens WHERE refresh_token_hash = $1", [legacyHash]);
      await postgresQuery("ALTER TABLE oauth_refresh_tokens ALTER COLUMN family_id SET NOT NULL");
      await postgresQuery("ALTER TABLE oauth_refresh_tokens ALTER COLUMN generation SET NOT NULL");
    }
  });

  test("pre-v0.1 PostgreSQL grant bytes fail before the RS route", async () => {
    assert.ok(client, "client must be registered in test.before");
    const suffix = randomBytes(8).toString("hex");
    const grantId = `grt_legacy_${suffix}`;
    const token = `tok_legacy_${suffix}`;
    await postgresQuery(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, status, consumed, issued_at
       ) VALUES($1, $2, $3, NULL, $4::jsonb, 'continuous', 'active', FALSE, $5)`,
      [
        grantId,
        "owner_local",
        client.client_id,
        V01_LEGACY_BYTES.replace("grt_legacy", grantId).replace("legacy_client", client.client_id),
        "2026-08-11T12:00:00Z",
      ]
    );
    await postgresQuery(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at, revoked)
       VALUES($1, $2, $3, $4, 'client', NULL, FALSE)`,
      [token, grantId, "owner_local", client.client_id]
    );

    const introspection = await fetchJson<{
      active: boolean;
      inactive_reason?: string;
    }>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token }).toString(),
      headers: INTROSPECTION_HEADERS,
      method: "POST",
    });
    assert.equal(introspection.status, 200);
    assert.equal(introspection.body.active, false);
    assert.equal(introspection.body.inactive_reason, "authorization_state.unsupported_legacy_shape");

    const route = await fetchJson<{ error?: { code?: string } }>(`${rsUrl}/v1/schema`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(route.status, 401);
    assert.equal(route.body.error?.code, "authorization_state.unsupported_legacy_shape");
  });

  test("PostgreSQL migration revokes unlinked legacy refresh families and bound bearers", async () => {
    const suffix = randomBytes(8).toString("hex");
    const grantId = `grt_legacy_family_${suffix}`;
    const familyId = `rtf_legacy_family_${suffix}`;
    const tokenId = `tok_legacy_family_${suffix}`;
    await postgresQuery(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind)
       VALUES($1, $2, 'owner_local', 'client_legacy', 'client')`,
      [tokenId, grantId]
    );
    await postgresQuery(
      `INSERT INTO oauth_refresh_tokens(
         refresh_token_hash, family_id, generation, client_id, grant_id,
         subject_id, status, created_at
       ) VALUES($1, $2, 0, 'client_legacy', $3, 'owner_local', 'active', NOW())`,
      [`hash_legacy_family_${suffix}`, familyId, grantId]
    );

    await bootstrapPostgresSchema();

    const refresh = await postgresQuery<{ revoked_at: string | null; status: string }>(
      "SELECT status, revoked_at FROM oauth_refresh_tokens WHERE family_id = $1",
      [familyId]
    );
    const bearer = await postgresQuery<{ refresh_family_id: string | null; revoked: boolean }>(
      "SELECT refresh_family_id, revoked FROM tokens WHERE token_id = $1",
      [tokenId]
    );
    assert.equal(refresh.rows[0]?.status, "revoked", "unlinked pre-migration family requires fresh authorization");
    assert.ok(refresh.rows[0]?.revoked_at);
    assert.deepEqual(bearer.rows[0], { refresh_family_id: null, revoked: true });
  });

  test("PostgreSQL supersede failure rolls back the newly inserted family bearer", async () => {
    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(issued.refreshToken, "supersede-fault flow receives generation zero");
    const generationZero = issued.refreshToken;

    await postgresQuery(`
      CREATE OR REPLACE FUNCTION pdpp_test_fail_refresh_supersede()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF OLD.status = 'active' AND NEW.status = 'superseded' THEN
          RAISE EXCEPTION 'injected refresh supersede failure';
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await postgresQuery(`
      CREATE TRIGGER fail_refresh_supersede
      BEFORE UPDATE OF status ON oauth_refresh_tokens
      FOR EACH ROW EXECUTE FUNCTION pdpp_test_fail_refresh_supersede()
    `);
    try {
      const failure = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: generationZero,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.notEqual(failure.status, 200);
    } finally {
      await postgresQuery("DROP TRIGGER IF EXISTS fail_refresh_supersede ON oauth_refresh_tokens");
      await postgresQuery("DROP FUNCTION IF EXISTS pdpp_test_fail_refresh_supersede() ");
    }

    const family = await postgresQuery<{ generation: number; status: string }>(
      `SELECT generation, status
         FROM oauth_refresh_tokens
        WHERE family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY generation`,
      [refreshTokenHash(generationZero)]
    );
    assert.deepEqual(family.rows, [{ generation: 0, status: "active" }]);
    const bearers = await postgresQuery<{ revoked: boolean }>(
      `SELECT revoked
         FROM tokens
        WHERE refresh_family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )`,
      [refreshTokenHash(generationZero)]
    );
    assert.deepEqual(bearers.rows, [{ revoked: false }], "failed supersede leaves no orphan bearer");

    const retried = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: generationZero,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(retried.status, 200, "generation zero remains usable after rollback");
  });

  test("PostgreSQL token lifetime and refresh eligibility follow the persisted grant contract", async () => {
    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const noRefreshClient = await registerAuthCodeClient(asUrl, { refreshToken: false });
    const indefinite = await completeOauthCodeFlow({ asUrl, client: noRefreshClient, manifest: spotify });
    assert.equal(indefinite.refreshToken, null, "client without refresh capability receives no refresh token");
    assert.equal(indefinite.expiresIn, undefined, "token response omits expires_in when storage has no expiry");
    const indefiniteIntrospection = await fetchJson<{ active: boolean; exp?: number }>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: indefinite.accessToken }).toString(),
      headers: INTROSPECTION_HEADERS,
      method: "POST",
    });
    assert.equal(indefiniteIntrospection.body.active, true);
    assert.equal(
      Object.hasOwn(indefiniteIntrospection.body, "exp"),
      false,
      "RFC 7662 response omits exp when the token has no expiration"
    );

    const singleUse = await completeOauthCodeFlow({ accessMode: "single_use", asUrl, client, manifest: spotify });
    assert.equal(singleUse.refreshToken, null, "single_use grant receives no refresh token");
    assert.ok(singleUse.expiresIn && singleUse.expiresIn > 600, "single_use token keeps its persisted grant lifetime");
  });

  test("authorization-code exchange + refresh rotation through real auth.js postgres adapters", async () => {
    interface IntrospectBody {
      active: boolean;
      exp?: number;
    }
    interface TokenExchangeBody {
      access_token?: string;
      error?: string;
      expires_in?: number;
      fresh_authorization_required?: boolean;
      refresh_token?: string;
    }

    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(issued.refreshToken, "refresh-capable client receives a refresh token");
    assert.ok(issued.expiresIn && issued.expiresIn <= 600, "family-linked access token has a short lifetime");
    const issuedRefreshToken = issued.refreshToken;

    // Introspect the access token: the tokens SELECT join (PG introspect adapter).
    const introspectResp = await fetchJson<IntrospectBody>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: issued.accessToken }).toString(),
      headers: INTROSPECTION_HEADERS,
      method: "POST",
    });
    assert.equal(introspectResp.status, 200);
    assert.equal(introspectResp.body.active, true, "issued access token introspects as active");
    assert.equal(typeof introspectResp.body.exp, "number", "persisted access expiry is exposed through introspection");

    // Replaying the consumed code must fail: the consume UPDATE flipped the
    // row to status=consumed and the SELECT-by-code adapter reads it back.
    const replay = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        code: issued.code,
        code_verifier: issued.verifier,
        grant_type: "authorization_code",
        redirect_uri: "https://client.example/callback",
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(replay.status, 400, "replaying a consumed code is rejected");
    assert.equal(replay.body.error, "invalid_grant");

    // grant_type=refresh_token atomically supersedes the presented generation,
    // inserts its successor, and mints a fresh access token via issueToken.
    const refreshed = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: issuedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(refreshed.status, 200, `refresh exchange succeeds: ${JSON.stringify(refreshed.body)}`);
    assert.ok(refreshed.body.access_token, "refresh returns a new access token");
    assert.notEqual(refreshed.body.access_token, issued.accessToken, "refresh mints a distinct access token");
    assert.ok(refreshed.body.refresh_token, "refresh returns a successor refresh token");
    assert.ok(
      refreshed.body.expires_in && refreshed.body.expires_in <= 600,
      "refresh-derived access token reports its actual short lifetime"
    );
    assert.notEqual(refreshed.body.refresh_token, issuedRefreshToken, "refresh rotates the presented token");

    // The new access token introspects as active (tokens SELECT join again).
    assert.ok(refreshed.body.access_token, "refresh must have returned an access token to introspect");
    const refreshedIntrospect = await fetchJson<IntrospectBody>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: refreshed.body.access_token }).toString(),
      headers: INTROSPECTION_HEADERS,
      method: "POST",
    });
    assert.equal(refreshedIntrospect.body.active, true, "refreshed access token is active");

    // A wrong-client refresh must be rejected without consuming the successor.
    const wrongClient = await fetchJson(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: "not-the-issuing-client",
        grant_type: "refresh_token",
        refresh_token: refreshed.body.refresh_token,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(wrongClient.status, 400, "refresh with the wrong client is rejected");
    assert.equal(wrongClient.body.error, "invalid_grant");

    const reuse = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: issuedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(reuse.status, 400, "reusing a superseded generation is rejected");
    assert.equal(reuse.body.error, "invalid_grant");
    assert.equal(reuse.body.fresh_authorization_required, true);
    assert.deepEqual(validateResponse("exchangeOwnerDeviceToken", { body: reuse.body, status: reuse.status }), {
      ok: true,
      skipped: false,
    });

    const family = await postgresQuery<{
      family_id: string;
      generation: number;
      parent_generation: number | null;
      status: string;
    }>(
      `SELECT family_id, generation, parent_generation, status
         FROM oauth_refresh_tokens
        WHERE family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY generation`,
      [refreshTokenHash(issuedRefreshToken)]
    );
    assert.deepEqual(
      family.rows.map(({ generation, parent_generation: parentGeneration, status }) => ({
        generation,
        parentGeneration,
        status,
      })),
      [
        { generation: 0, parentGeneration: null, status: "revoked" },
        { generation: 1, parentGeneration: 0, status: "revoked" },
      ]
    );

    const familyAccessTokens = await postgresQuery<{
      expires_at: string | null;
      refresh_family_id: string;
      revoked: boolean;
      token_id: string;
    }>(
      `SELECT token_id, refresh_family_id, expires_at, revoked
         FROM tokens
        WHERE refresh_family_id = $1
        ORDER BY created_at, token_id`,
      [family.rows[0]?.family_id]
    );
    assert.deepEqual(
      familyAccessTokens.rows.map(({ revoked }) => revoked),
      [true, true],
      "replay revokes the initial and attacker-minted access tokens"
    );
    for (const bearer of familyAccessTokens.rows) {
      assert.ok(bearer.expires_at, "every family-derived access token has an expiry");
      // biome-ignore lint/performance/noAwaitInLoops: Each persisted family bearer is an independent security assertion.
      const introspection = await fetchJson<IntrospectBody>(`${asUrl}/introspect`, {
        body: new URLSearchParams({ token: bearer.token_id }).toString(),
        headers: INTROSPECTION_HEADERS,
        method: "POST",
      });
      assert.equal(introspection.body.active, false, "every family bearer introspects inactive after replay");
    }

    const successorAfterReuse = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: refreshed.body.refresh_token,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(successorAfterReuse.status, 400, "family reuse revokes the active successor");
    assert.equal(successorAfterReuse.body.error, "invalid_grant");

    const concurrent = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(concurrent.refreshToken, "concurrency flow receives a refresh token");
    const concurrentClientId = client.client_id;
    const concurrentRefreshToken = concurrent.refreshToken;
    const exchangeConcurrently = () =>
      fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: concurrentClientId,
          grant_type: "refresh_token",
          refresh_token: concurrentRefreshToken,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    const concurrentResults = await Promise.all([exchangeConcurrently(), exchangeConcurrently()]);
    assert.deepEqual(
      concurrentResults.map(({ status }) => status).sort(),
      [200, 400],
      "exactly one concurrent refresh rotates"
    );
    const concurrentFailure = concurrentResults.find(({ status }) => status === 400);
    assert.equal(concurrentFailure?.body.error, "invalid_grant");
    assert.equal(concurrentFailure?.body.fresh_authorization_required, true);

    const concurrentFamily = await postgresQuery<{ generation: number; status: string }>(
      `SELECT generation, status
         FROM oauth_refresh_tokens
        WHERE family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY generation`,
      [refreshTokenHash(concurrentRefreshToken)]
    );
    assert.deepEqual(
      concurrentFamily.rows.map(({ generation, status }) => ({ generation, status })),
      [
        { generation: 0, status: "revoked" },
        { generation: 1, status: "revoked" },
      ],
      "reuse detection leaves no active successor"
    );
    const concurrentBearers = await postgresQuery<{ active_count: number }>(
      `SELECT COUNT(*) FILTER (WHERE revoked = FALSE)::int AS active_count
         FROM tokens
        WHERE refresh_family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )`,
      [refreshTokenHash(concurrentRefreshToken)]
    );
    assert.equal(concurrentBearers.rows[0]?.active_count, 0, "same-generation replay leaves no active family bearer");

    const crossGeneration = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(crossGeneration.refreshToken, "cross-generation race receives generation zero");
    const generationZero = crossGeneration.refreshToken;
    const generationOneResponse = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: generationZero,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(generationOneResponse.status, 200);
    assert.ok(generationOneResponse.body.refresh_token, "first rotation returns generation one");
    const generationOne = generationOneResponse.body.refresh_token;
    const crossGenerationClientId = client.client_id;
    const exchangeRefresh = (refreshToken: string) =>
      fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: crossGenerationClientId,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    const [generationZeroReplay, generationOneRotation] = await Promise.all([
      exchangeRefresh(generationZero),
      exchangeRefresh(generationOne),
    ]);
    assert.equal(generationZeroReplay.status, 400);
    assert.equal(generationZeroReplay.body.error, "invalid_grant");
    assert.equal(generationZeroReplay.body.fresh_authorization_required, true);
    assert.ok(
      generationOneRotation.status === 200 || generationOneRotation.status === 400,
      "generation one either rotates before replay wins or observes family revocation"
    );

    const crossGenerationFamily = await postgresQuery<{ generation: number; status: string }>(
      `SELECT generation, status
         FROM oauth_refresh_tokens
        WHERE family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY generation`,
      [refreshTokenHash(generationZero)]
    );
    assert.ok(crossGenerationFamily.rows.length === 2 || crossGenerationFamily.rows.length === 3);
    assert.equal(
      crossGenerationFamily.rows.some(({ status }) => status === "active"),
      false,
      "family lock prevents an active successor surviving cross-generation replay"
    );
    assert.equal(
      crossGenerationFamily.rows.every(({ status }) => status === "revoked"),
      true
    );
    const crossGenerationBearers = await postgresQuery<{ active_count: number }>(
      `SELECT COUNT(*) FILTER (WHERE revoked = FALSE)::int AS active_count
         FROM tokens
        WHERE refresh_family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )`,
      [refreshTokenHash(generationZero)]
    );
    assert.equal(crossGenerationBearers.rows[0]?.active_count, 0, "cross-generation replay leaves no active bearer");

    const failedReplay = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(failedReplay.refreshToken, "replay-fault flow receives generation zero");
    const failedReplayGenerationZero = failedReplay.refreshToken;
    const failedReplayRotation = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: failedReplayGenerationZero,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(failedReplayRotation.status, 200);
    assert.ok(failedReplayRotation.body.refresh_token, "replay-fault flow receives generation one");
    await postgresQuery(`
      CREATE OR REPLACE FUNCTION pdpp_test_fail_family_bearer_revoke()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF OLD.revoked = FALSE AND NEW.revoked = TRUE AND NEW.refresh_family_id IS NOT NULL THEN
          RAISE EXCEPTION 'injected family bearer revoke failure';
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await postgresQuery(`
      CREATE TRIGGER fail_family_bearer_revoke
      BEFORE UPDATE ON tokens
      FOR EACH ROW EXECUTE FUNCTION pdpp_test_fail_family_bearer_revoke()
    `);
    try {
      const replayFailure = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: failedReplayGenerationZero,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.notEqual(replayFailure.status, 200, "failed bearer revoke cannot commit partial family revocation");
    } finally {
      await postgresQuery("DROP TRIGGER IF EXISTS fail_family_bearer_revoke ON tokens");
      await postgresQuery("DROP FUNCTION IF EXISTS pdpp_test_fail_family_bearer_revoke() ");
    }
    const replayFailureFamily = await postgresQuery<{ generation: number; status: string }>(
      `SELECT generation, status
         FROM oauth_refresh_tokens
        WHERE family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY generation`,
      [refreshTokenHash(failedReplayGenerationZero)]
    );
    assert.deepEqual(
      replayFailureFamily.rows.map(({ generation, status }) => ({ generation, status })),
      [
        { generation: 0, status: "superseded" },
        { generation: 1, status: "active" },
      ],
      "failed containment rolls the refresh-family revocation back atomically"
    );
    const replayFailureBearers = await postgresQuery<{ revoked: boolean }>(
      `SELECT revoked
         FROM tokens
        WHERE refresh_family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY created_at, token_id`,
      [refreshTokenHash(failedReplayGenerationZero)]
    );
    assert.deepEqual(
      replayFailureBearers.rows.map(({ revoked }) => revoked),
      [false, false],
      "failed containment rolls bearer revocation back atomically"
    );
    const successorAfterFailedReplay = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: failedReplayRotation.body.refresh_token,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(successorAfterFailedReplay.status, 200, "rolled-back successor remains usable");

    const failedIssuance = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(failedIssuance.refreshToken, "fault flow receives a refresh token");
    const activeBeforeFailure = await postgresQuery<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM tokens WHERE grant_id = $1 AND revoked = FALSE",
      [failedIssuance.grantId]
    );
    await postgresQuery(`
      CREATE OR REPLACE FUNCTION pdpp_test_fail_refresh_token_event()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        IF NEW.event_type = 'token.issued'
           AND NEW.data_json::jsonb ->> 'issuance_path' = 'oauth_refresh_token' THEN
          RAISE EXCEPTION 'injected refresh token event failure';
        END IF;
        RETURN NEW;
      END
      $function$
    `);
    await postgresQuery(`
      CREATE TRIGGER fail_refresh_token_issued_event
      BEFORE INSERT ON spine_events
      FOR EACH ROW EXECUTE FUNCTION pdpp_test_fail_refresh_token_event()
    `);
    try {
      const failedRefresh = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: client.client_id,
          grant_type: "refresh_token",
          refresh_token: failedIssuance.refreshToken,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(failedRefresh.status, 400);
    } finally {
      await postgresQuery("DROP TRIGGER IF EXISTS fail_refresh_token_issued_event ON spine_events");
      await postgresQuery("DROP FUNCTION IF EXISTS pdpp_test_fail_refresh_token_event() ");
    }

    const failedFamily = await postgresQuery<{ generation: number; status: string }>(
      `SELECT generation, status
         FROM oauth_refresh_tokens
        WHERE family_id = (
          SELECT family_id FROM oauth_refresh_tokens WHERE refresh_token_hash = $1
        )
        ORDER BY generation`,
      [refreshTokenHash(failedIssuance.refreshToken)]
    );
    assert.deepEqual(
      failedFamily.rows.map(({ generation, status }) => ({ generation, status })),
      [{ generation: 0, status: "active" }]
    );
    const activeAfterFailure = await postgresQuery<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM tokens WHERE grant_id = $1 AND revoked = FALSE",
      [failedIssuance.grantId]
    );
    assert.equal(
      activeAfterFailure.rows[0]?.count,
      activeBeforeFailure.rows[0]?.count,
      "failed refresh does not leave an active bearer"
    );
  });

  // ---------------------------------------------------------------------
  // C) Revoke the grant -> the bound access token and refresh token both die.
  //
  // revokeGrant's token cascade is NOT migrated by the seam-march, but driving
  // it proves the introspect SELECT adapter reports the revoked row and the
  // refresh SELECT adapter sees the revoked refresh row.
  // ---------------------------------------------------------------------
  test("revoking the grant deactivates the issued access + refresh tokens through real auth.js postgres adapters", async () => {
    interface IntrospectBody {
      active: boolean;
    }
    interface TokenExchangeBody {
      error?: string;
    }

    assert.ok(client, "client must be registered in test.before");
    assert.ok(spotify, "spotify manifest must be registered in test.before");
    const issued = await completeOauthCodeFlow({ asUrl, client, manifest: spotify });
    assert.ok(issued.grantId, "code exchange exposes the grant_id");
    assert.ok(issued.refreshToken, "refresh token issued for the revoke test");
    const issuedRefreshToken = issued.refreshToken;

    await revokeGrant(issued.grantId, { request_id: "tok-pg-path-revoke" });

    // Introspection now reports inactive (tokens SELECT join reads revoked=TRUE).
    const introspectResp = await fetchJson<IntrospectBody>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: issued.accessToken }).toString(),
      headers: INTROSPECTION_HEADERS,
      method: "POST",
    });
    assert.equal(introspectResp.body.active, false, "revoked grant token introspects as inactive");

    // The refresh token bound to the revoked grant can no longer be exchanged
    // (refresh SELECT-by-hash reads status=revoked).
    const afterRevoke = await fetchJson<TokenExchangeBody>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: client.client_id,
        grant_type: "refresh_token",
        refresh_token: issuedRefreshToken,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(afterRevoke.status, 400, "refresh against a revoked grant is rejected");
    assert.equal(afterRevoke.body.error, "invalid_grant");
  });
} else {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  test("auth.js token/refresh postgres-adapter path (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {});
}
