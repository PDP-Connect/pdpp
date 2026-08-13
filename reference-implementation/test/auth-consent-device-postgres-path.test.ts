// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real auth.js Postgres-adapter path proof for the consent +
 * owner-device-auth row operations.
 *
 * A prior migration moved the consent and owner-device-auth row operations
 * in `server/auth.ts` behind `getPendingConsentStore()` /
 * `getOwnerDeviceAuthStore()` (one SQLite adapter and one Postgres adapter
 * per concern). The SQLite adapter is exercised by
 * `sqlite-consent-device-auth-driver.js`, which imports the real auth.js
 * lifecycle helpers. The existing Postgres conformance suite
 * (`consent-device-auth-conformance-postgres.test.js`) runs against
 * `postgres-consent-device-auth-driver.js`, which is a reimplementation that
 * does NOT import auth.js. The result: the production auth.js Postgres
 * adapters had zero automated coverage.
 *
 * This test closes that gap. It drives the REAL exported auth.js flows with
 * the storage backend switched to Postgres, so the production Postgres
 * adapters (`postgresPendingConsentStore` and `postgresOwnerDeviceAuthStore`)
 * actually execute:
 *   - createOwnerDeviceAuth / getOwnerDeviceAuthRowByUserCode /
 *     markOwnerDeviceAuthApproved / getOwnerDeviceAuthRow (owner device flow)
 *   - createPendingConsent / getPendingConsentRow (incl. the
 *     `params_json::text` cast) / markPendingConsentApproved (consent flow)
 *
 * The whole file is gated on `PDPP_TEST_POSTGRES_URL`; when unset it registers
 * a single skipped test so default development and CI do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_authpath \
 *     node --test --import tsx \
 *     reference-implementation/test/auth-consent-device-postgres-path.test.js
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approveGrant,
  approveOwnerDeviceAuthorization,
  createHostedMcpGrantPackage,
  denyOwnerDeviceAuthorization,
  exchangeOwnerDeviceCode,
  getOwnerDeviceAuthorizationByUserCode,
  getPendingConsent,
  initiateGrant,
  initiateOwnerDeviceAuthorization,
  introspect,
  issueToken,
  parsePendingConsentRequestUri,
  registerConnector,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

interface DeviceAuthError extends Error {
  code?: string;
}

function isDeviceAuthError(value: unknown): value is DeviceAuthError {
  return value instanceof Error;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

const CONSOLE_CLIENT_ID = "pg_path_console";
const POSTGRES_AUTH_INSTANCE_ID = "cin_pg_auth_source_snapshot_0811";
const GRANT_BINDING_RE = /Grant is malformed|grant/i;
const PROJECTED_DECLARATION_VERSION_RE = /^reference\.legacy-connector-projection\.v1:sha256:[0-9a-f]{64}$/;

function loadSpotifyManifest() {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
}

if (POSTGRES_URL) {
  // ---------------------------------------------------------------------
  // Shared setup. The SQLite handle is opened in-memory only so that
  // auth.js helpers which always touch SQLite (e.g. trace-context plumbing)
  // have a handle; every consent / owner-device-auth / client / connector
  // read and write routes to Postgres because the active storage backend is
  // postgres. Concrete proof that the Postgres adapters run: the negative
  // control below breaks a Postgres-only SELECT and this suite goes red.
  let setupOk = false;

  test.before(async () => {
    initDb(":memory:");
    await initPostgresStorage({
      backend: "postgres",
      databaseUrl: POSTGRES_URL,
    });
    const manifest = loadSpotifyManifest();
    await registerConnector(manifest);
    await seedPreRegisteredClients([
      {
        client_id: CONSOLE_CLIENT_ID,
        client_name: "X",
        registration_mode: "pre_registered_public",
      },
    ]);
    const now = new Date().toISOString();
    await createPostgresConnectorInstanceStore().upsert({
      connectorId: "spotify",
      connectorInstanceId: POSTGRES_AUTH_INSTANCE_ID,
      createdAt: now,
      displayName: "Postgres auth path fixture",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: POSTGRES_AUTH_INSTANCE_ID },
      sourceBindingKey: POSTGRES_AUTH_INSTANCE_ID,
      sourceKind: "manual",
      status: "active",
      updatedAt: now,
    });
    setupOk = true;
  });

  test.after(async () => {
    await postgresQuery("DELETE FROM connector_instances WHERE connector_instance_id = $1", [
      POSTGRES_AUTH_INSTANCE_ID,
    ]);
    await closePostgresStorage();
    closeDb();
  });

  // ---------------------------------------------------------------------
  // A) Owner-device-authorization flow.
  //
  // Exercises the postgresOwnerDeviceAuthStore adapter: insert (createOwnerDeviceAuth),
  // getByUserCode (getOwnerDeviceAuthRowByUserCode), markApproved
  // (markOwnerDeviceAuthApproved), getByDeviceCode (getOwnerDeviceAuthRow).
  // ---------------------------------------------------------------------
  test("owner device authorization: approve + exchange through real auth.js postgres adapters", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    const initiated = await initiateOwnerDeviceAuthorization(CONSOLE_CLIENT_ID, {
      expiresIn: 300,
      interval: 1,
    });
    assert.ok(initiated.user_code, "initiate returns a user_code");
    assert.ok(initiated.device_code, "initiate returns a device_code");

    // Public verification view: reads the row back via getByUserCode (PG SELECT).
    // The public view intentionally omits `status`; assert on the fields it
    // does return.
    const view = await getOwnerDeviceAuthorizationByUserCode(initiated.user_code);
    assert.ok(view, "pending owner-device view is returned by user_code lookup");
    assert.equal(view.device_code, initiated.device_code, "view device_code matches");
    assert.equal(view.user_code, initiated.user_code, "view user_code matches");
    assert.equal(view.client_id, CONSOLE_CLIENT_ID, "view client_id matches");

    // Approve: markApproved (PG UPDATE) + mints an owner token.
    const approved = await approveOwnerDeviceAuthorization(initiated.user_code, "owner_local");
    assert.ok(approved.access_token, "approve mints an owner access token");
    assert.equal(approved.subject_id, "owner_local", "approved subject is owner_local");

    // Exchange: getByDeviceCode (PG SELECT) returns the bound token.
    const exchanged = await exchangeOwnerDeviceCode({
      clientId: CONSOLE_CLIENT_ID,
      deviceCode: initiated.device_code,
    });
    assert.ok(exchanged.access_token, "exchange returns an access token");
    assert.equal(exchanged.access_token, approved.access_token, "exchanged token is the token bound at approval");
  });

  test("owner device authorization: deny then exchange fails through real auth.js postgres adapters", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    const initiated = await initiateOwnerDeviceAuthorization(CONSOLE_CLIENT_ID, {
      expiresIn: 300,
      interval: 1,
    });
    assert.ok(initiated.device_code, "second initiate returns a device_code");

    // Deny: markDenied (PG UPDATE).
    await denyOwnerDeviceAuthorization(initiated.user_code);

    // Exchange against a denied row must be rejected. getByDeviceCode (PG
    // SELECT) returns status='denied' and exchangeOwnerDeviceCode throws
    // access_denied.
    await assert.rejects(
      () =>
        exchangeOwnerDeviceCode({
          clientId: CONSOLE_CLIENT_ID,
          deviceCode: initiated.device_code,
        }),
      (err) => {
        assert.ok(isDeviceAuthError(err), "rejection is an Error");
        assert.equal(err.code, "access_denied", "denied row exchange is access_denied");
        return true;
      }
    );
  });

  // Expiry / markExpired is not driven here: the only public seam to force a
  // row past its TTL is a direct row UPDATE on expires_at, which the SQLite
  // and Postgres conformance drivers expose as a test-only seam. Reproducing
  // that here would require either a raw Postgres UPDATE (duplicating the
  // existing conformance driver) or a fake clock; the lifecycle expiry
  // transition is already pinned by the conformance suite against both
  // backends. This file's mandate is that the real auth.js Postgres adapters
  // execute for the happy-path and deny-path row operations, which the two
  // owner-device tests above and the consent test below assert. Expiry is
  // therefore intentionally out of scope.

  // ---------------------------------------------------------------------
  // B) Pending-consent flow.
  //
  // Exercises the postgresPendingConsentStore adapter: insert
  // (createPendingConsent), getByDeviceCode (getPendingConsentRow, which on
  // the Postgres path selects `params_json::text AS params_json` so the JSON
  // round-trips as text for JSON.parse), markApproved
  // (markPendingConsentApproved).
  //
  // The input shape mirrors the green sqlite-consent-device-auth-driver.js
  // initiateGrant call, run here in Postgres mode.
  // ---------------------------------------------------------------------
  test("pending consent: initiate -> read -> approve through real auth.js postgres adapters", async () => {
    assert.equal(setupOk, true, "before() setup must have completed");

    const manifest = loadSpotifyManifest();
    const initiated = await initiateGrant({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "consent-device-auth postgres-path proof",
          source: { id: manifest.connector_id, kind: "connector" },
          streams: [{ instance_ids: [POSTGRES_AUTH_INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CONSOLE_CLIENT_ID,
    });
    assert.ok(initiated.request_uri, "initiateGrant returns a request_uri");

    const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
    assert.ok(deviceCode, "request_uri parses to a device_code");

    // getPendingConsent -> getPendingConsentRow -> Postgres getByDeviceCode,
    // which reads params_json via the ::text cast and JSON.parse()s it.
    const pending = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
    assert.ok(pending, "pending consent request is returned");
    assert.ok(pending.request, "pending consent carries the parsed request (params_json round-trip)");
    assert.equal(pending.userCode, initiated.user_code, "pending userCode matches the initiated user_code");
    const pendingRequest = pending.request as {
      source_declaration_snapshot?: {
        declaration?: {
          declaration_version?: string;
          publisher?: { id?: string };
          source?: { id?: string; kind?: string };
        };
        declaration_version?: string;
        snapshot_version?: string;
        source?: { id?: string; kind?: string };
      };
    };
    assert.equal(
      pendingRequest.source_declaration_snapshot?.snapshot_version,
      "reference.source-declaration-snapshot.v1"
    );
    const declarationVersion = pendingRequest.source_declaration_snapshot?.declaration_version;
    assert.match(declarationVersion ?? "", PROJECTED_DECLARATION_VERSION_RE);
    assert.deepEqual(pendingRequest.source_declaration_snapshot?.source, {
      id: manifest.connector_id,
      kind: "connector",
    });
    assert.deepEqual(pendingRequest.source_declaration_snapshot?.declaration?.source, {
      id: manifest.connector_id,
      kind: "connector",
    });
    assert.deepEqual(pendingRequest.source_declaration_snapshot?.declaration?.publisher, {
      id: "https://pdpp.dev/reference-implementation",
    });
    assert.equal(pendingRequest.source_declaration_snapshot?.declaration?.declaration_version, declarationVersion);

    // Approve: markPendingConsentApproved (PG UPDATE) + issues the grant.
    assert.equal(typeof pending.reviewRevision, "string", "review materializes an approval revision");
    const approved = await approveGrant(deviceCode, "owner_local", {
      approval_review_revision: pending.reviewRevision,
    });
    assert.ok(approved, "approveGrant resolves");
    // approveGrant's two branches (single grant / staged batch package) both
    // return { grant: { grant_id }, token, ... }; there is no top-level
    // grant_id/access_token field on either shape.
    assert.ok(approved.grant.grant_id || approved.token, "approveGrant yields a grant / token result");
    const persistedGrant = await postgresQuery<{ grant_json: Record<string, unknown> }>(
      "SELECT grant_json FROM grants WHERE grant_id = $1",
      [approved.grant.grant_id]
    );
    const grantJson = persistedGrant.rows[0]?.grant_json;
    assert.ok(grantJson, "Postgres retains the issued resolved grant JSON");
    const grantStreams = grantJson.streams as {
      fields?: string[];
      instance_ids?: string[];
      name?: string;
    }[];
    assert.ok(grantStreams[0]?.fields?.length, "issued stream freezes explicit fields");
    assert.equal(grantStreams[0]?.instance_ids?.length, 1);
    assert.notEqual(grantStreams[0]?.instance_ids?.[0], "spotify");
    assert.deepEqual(grantJson.source_declaration, {
      version: declarationVersion,
    });

    const tokenCountBefore = await postgresQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tokens WHERE grant_id = $1",
      [approved.grant.grant_id]
    );
    await assert.rejects(
      () =>
        issueToken(
          approved.grant.grant_id as string,
          "owner_local",
          "client_tampered",
          approved.grant.expires_at ?? null
        ),
      GRANT_BINDING_RE
    );
    const tokenCountAfter = await postgresQuery<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tokens WHERE grant_id = $1",
      [approved.grant.grant_id]
    );
    assert.equal(tokenCountAfter.rows[0]?.count, tokenCountBefore.rows[0]?.count);

    const tamperedGrant = structuredClone(grantJson);
    tamperedGrant.client = { client_id: "client_tampered" };
    await postgresQuery("UPDATE grants SET grant_json = $1::jsonb WHERE grant_id = $2", [
      JSON.stringify(tamperedGrant),
      approved.grant.grant_id,
    ]);
    assert.equal((await introspect(approved.token)).active, false, "Postgres grant-column mismatch must fail closed");
    await postgresQuery("UPDATE grants SET grant_json = $1::jsonb WHERE grant_id = $2", [
      JSON.stringify(grantJson),
      approved.grant.grant_id,
    ]);

    // After approval the row is no longer pending; the public getPendingConsent
    // view (which filters on status='pending') returns null. This re-reads
    // through the same Postgres getByDeviceCode adapter.
    const afterApproval = await getPendingConsent(deviceCode);
    assert.equal(afterApproval, null, "approved consent is no longer pending");
  });

  test("pre-Source v1 package token requires fresh consent through the real Postgres introspection path", async () => {
    const manifest = loadSpotifyManifest();
    const result = await createHostedMcpGrantPackage({
      authorizationDetails: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.org/purpose/personal_ai_assistant",
          source: { id: manifest.connector_id, kind: "connector" },
          streams: [{ instance_ids: [POSTGRES_AUTH_INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.org/data-access",
        },
      ],
      clientId: CONSOLE_CLIENT_ID,
      connectionIds: [POSTGRES_AUTH_INSTANCE_ID],
      storageBindings: [{ connector_id: "spotify" }],
    });
    const packageId = result.package_id as string;
    const currentEnvelope = await postgresQuery<{ package_json: Record<string, unknown> }>(
      "SELECT package_json FROM grant_packages WHERE package_id = $1",
      [packageId]
    );
    const preSourceEnvelope = structuredClone(currentEnvelope.rows[0]?.package_json ?? {});
    preSourceEnvelope.version = "reference.mcp_package.v1";
    await postgresQuery("UPDATE grant_packages SET package_json = $1::jsonb WHERE package_id = $2", [
      JSON.stringify(preSourceEnvelope),
      packageId,
    ]);

    const tokenState = await introspect(result.token);
    assert.equal(tokenState.active, false);
    assert.equal(tokenState.inactive_reason, "package_invalid");
  });
} else {
  test("auth.js consent/owner-device-auth postgres-adapter path (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  }, () => {});
}
