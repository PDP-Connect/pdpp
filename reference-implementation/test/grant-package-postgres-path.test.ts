// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real auth.js Postgres-adapter path proof for the hosted-MCP grant-package
 * lifecycle.
 *
 * The grant-package row operations in `server/auth.ts` (issuePackageToken,
 * getGrantPackageRow, persistChildGrantForPackage, createGrantPackage,
 * getGrantPackageMembers, listGrantPackagesByParent,
 * listActiveGrantPackageMembersForRevocation, markGrantPackageMemberRevoked,
 * markGrantPackageRevoked) each carry a Postgres adapter behind
 * `isPostgresStorageBackend()`. The existing SQLite lifecycle proof
 * (`ref-grant-packages.test.js`) runs against in-memory SQLite, so the
 * production Postgres adapters had zero automated coverage.
 *
 * This test closes that gap. It boots the REAL reference server with the
 * storage backend switched to Postgres, issues a multi-source hosted MCP
 * grant package through the real HTTP picker flow (which drives
 * createHostedMcpGrantPackage -> persistChildGrantForPackage (grants INSERT)
 * -> issuePackageToken (tokens INSERT) -> grant_package_members INSERT, all
 * on the Postgres adapters), then drives the exported owner-facing reads and
 * the revoke cascade directly:
 *   - listGrantPackagesForOwner / getGrantPackageForOwner /
 *     getGrantPackageAccess (Postgres SELECT adapters: getGrantPackageRow,
 *     getGrantPackageMembers, the active-members join)
 *   - getGrantPackageIdForGrant (Postgres member-by-grant SELECT)
 *   - revokeGrantPackage (markGrantPackageMemberRevoked +
 *     markGrantPackageRevoked Postgres UPDATE cascade)
 *
 * The whole file is gated on `PDPP_TEST_POSTGRES_URL`; when unset it registers
 * a single skipped test so default development and CI do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_gp \
 *     node --test --import tsx \
 *     reference-implementation/test/grant-package-postgres-path.test.ts
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  getGrantPackageAccess,
  getGrantPackageForOwner,
  getGrantPackageIdForGrant,
  listGrantPackagesForOwner,
  revokeGrantPackage,
} from "../server/auth.ts";
import { canonicalConnectorKey, canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { closeDb } from "../server/db.ts";
import { encodeHostedMcpSelection } from "../server/hosted-mcp-selection.ts";
import { startServer } from "../server/index.ts";
import { basicIntrospectionAuthorization } from "../server/introspection-http.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createPostgresConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "token_hash",
  "package_secret",
  "package_token",
  "client_secret",
  "token",
]);

function assertNoSecretMaterial(value: unknown, path = "$"): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    // biome-ignore lint/suspicious/useIterableCallbackReturn: Callback intentionally performs side effects only.
    value.forEach((v, i) => assertNoSecretMaterial(v, `${path}[${i}]`));
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    assert.ok(!SECRET_KEYS.has(key), `secret-shaped field "${key}" surfaced at ${path}.${key}`);
    assertNoSecretMaterial(v, `${path}.${key}`);
  }
}

function renderedHostedMcpStreamValues(html: string): string[] {
  return [...html.matchAll(/<input[^>]*name="stream"[^>]*value="([^"]+)"[^>]*data-hosted-mcp-stream-checkbox[^>]*>/g)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
}

// startServer is imported from checkJs:false JS; TS's structural inference
// for app.listen()'s return widens asServer/rsServer to a type missing
// closeAllConnections (a real Node http.Server method the source's own
// shutdown path uses elsewhere -- opts here never requests TLS, so at
// runtime this is always a plain http.Server). Matches the established
// pattern in records-cursor-fallback.test.ts.
interface CloseableServer {
  close: (callback?: (err?: Error) => void) => unknown;
  closeAllConnections: () => void;
}

type StartedServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: CloseableServer;
  rsServer: CloseableServer;
};

async function closeServer(server: StartedServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

interface JsonResult {
  body: unknown;
  resp: Response;
  status: number;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<JsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const body = text ? JSON.parse(text) : null;
  return { body, resp, status: resp.status };
}

function requireObject(value: unknown, description: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), description);
  return Object.fromEntries(Object.entries(value));
}

function requireString(value: unknown, description: string): string {
  assert.ok(typeof value === "string", description);
  return value;
}

function requireNumber(value: unknown, description: string): number {
  assert.ok(typeof value === "number", description);
  return value;
}

function requireArray(value: unknown, description: string): unknown[] {
  assert.ok(Array.isArray(value), description);
  return value;
}

interface GrantPackageChild {
  grant_id: string;
  grant_status: string;
  member_status: string;
  revoked_at: string | null;
  source: unknown;
}

interface GrantPackageDetail {
  children: GrantPackageChild[];
  member_count: number;
  package_id: string;
  revoked_at: string | null;
  status: string;
}

function grantPackageDetail(value: unknown): GrantPackageDetail {
  const record = requireObject(value, "package detail must be an object");
  const revokedAt = record.revoked_at;
  assert.ok(revokedAt === null || typeof revokedAt === "string", "package revoked_at must be string or null");
  return {
    // biome-ignore lint/suspicious/noShadow: Shadowed name mirrors the protocol field being asserted.
    children: requireArray(record.children, "package detail children must be an array").map((value) => {
      const child = requireObject(value, "package child must be an object");
      const childRevokedAt = child.revoked_at;
      assert.ok(
        childRevokedAt === null || typeof childRevokedAt === "string",
        "package child revoked_at must be string or null"
      );
      return {
        grant_id: requireString(child.grant_id, "package child grant_id must be a string"),
        grant_status: requireString(child.grant_status, "package child grant_status must be a string"),
        member_status: requireString(child.member_status, "package child member_status must be a string"),
        revoked_at: childRevokedAt,
        source: child.source,
      };
    }),
    member_count: requireNumber(record.member_count, "package detail member_count must be a number"),
    package_id: requireString(record.package_id, "package detail package_id must be a string"),
    revoked_at: revokedAt,
    status: requireString(record.status, "package detail status must be a string"),
  };
}

interface GrantPackageAccessMember {
  grant: unknown;
  grant_id: string;
  package_id: string;
  token: string;
}

interface GrantPackageAccess {
  members: GrantPackageAccessMember[];
  package: { package_id: string };
}

function grantPackageAccess(value: unknown): GrantPackageAccess {
  const record = requireObject(value, "package access must be an object");
  const packageRecord = requireObject(record.package, "package access package must be an object");
  return {
    // biome-ignore lint/suspicious/noShadow: Shadowed name mirrors the protocol field being asserted.
    members: requireArray(record.members, "package access members must be an array").map((value) => {
      const member = requireObject(value, "package access member must be an object");
      return {
        grant: member.grant,
        grant_id: requireString(member.grant_id, "package access member grant_id must be a string"),
        package_id: requireString(member.package_id, "package access member package_id must be a string"),
        token: requireString(member.token, "package access member token must be a string"),
      };
    }),
    package: { package_id: requireString(packageRecord.package_id, "package access package_id must be a string") },
  };
}

interface GrantPackageRevokeResult {
  not_revoked_child_grants: string[];
  package_id: string;
  revoked_at: string | null;
  revoked_child_grants: string[];
  status: string;
}

function grantPackageRevokeResult(value: unknown): GrantPackageRevokeResult {
  const record = requireObject(value, "package revoke result must be an object");
  const revokedAt = record.revoked_at;
  assert.ok(revokedAt === null || typeof revokedAt === "string", "revoke result revoked_at must be string or null");
  const readGrantIds = (field: "revoked_child_grants" | "not_revoked_child_grants") =>
    requireArray(record[field], `${field} must be an array`).map((grantId) =>
      requireString(grantId, `${field} entries must be strings`)
    );
  return {
    not_revoked_child_grants: readGrantIds("not_revoked_child_grants"),
    package_id: requireString(record.package_id, "revoke result package_id must be a string"),
    revoked_at: revokedAt,
    revoked_child_grants: readGrantIds("revoked_child_grants"),
    status: requireString(record.status, "revoke result status must be a string"),
  };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

interface Manifest {
  connector_id: string;
  [key: string]: unknown;
}

function packageInstanceId(connectorId: string): string {
  return `cin_pkg_pg_${connectorId}`;
}

async function seedPackageInstance(connectorId: string): Promise<void> {
  const now = new Date().toISOString();
  const connectorInstanceId = packageInstanceId(connectorId);
  await createPostgresConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId,
    createdAt: now,
    displayName: `${connectorId} package fixture`,
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "manual",
    status: "active",
    updatedAt: now,
  });
}

async function registerConnector(asUrl: string, name: string): Promise<Manifest> {
  const raw = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, `fixtures/seed-manifests/${name}.json`), "utf8")) as Manifest;
  const canonical = canonicalConnectorKeyFromManifest(raw);
  const manifest: Manifest = !canonical || canonical === raw.connector_id ? raw : { ...raw, connector_id: canonical };
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return manifest;
}

interface AuthCodeClient {
  client_id: string;
  [key: string]: unknown;
}

async function registerAuthCodeClient(asUrl: string): Promise<AuthCodeClient> {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "grant-package-postgres-path test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return body as AuthCodeClient;
}

async function completeMultiSourcePackageFlow({
  asUrl,
  client,
  connectorIds,
}: {
  asUrl: string;
  client: AuthCodeClient;
  connectorIds: string[];
}): Promise<{ accessToken: string; expiresIn: number | undefined; packageId: string; refreshToken: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const state = "pkg-pg-test-state";
  const challenge = pkceChallenge(verifier);

  const authorizeUrl = new URL(`${asUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", client.client_id);
  authorizeUrl.searchParams.set("redirect_uri", "https://client.example/callback");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const pickerResp = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(pickerResp.status, 200);
  const pickerHtml = await pickerResp.text();

  const params = new URLSearchParams();
  params.append("client_id", client.client_id);
  params.append("redirect_uri", "https://client.example/callback");
  params.append("response_type", "code");
  params.append("state", state);
  params.append("code_challenge", challenge);
  params.append("code_challenge_method", "S256");
  for (const id of connectorIds) {
    params.append("selection", encodeHostedMcpSelection({ connectionId: packageInstanceId(id), connectorId: id }));
  }
  for (const streamValue of renderedHostedMcpStreamValues(pickerHtml)) {
    params.append("stream", streamValue);
  }

  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    body: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  const approveBody = await approveResp.text();
  assert.equal(approveResp.status, 302, approveBody);
  const location = approveResp.headers.get("location");
  assert.ok(location, "the picker-approval redirect carries a location header");
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const { status, body: rawBody } = await fetchJson(`${asUrl}/oauth/token`, {
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
  const body = rawBody as {
    access_token?: string;
    expires_in?: number;
    grant_package_id?: string;
    refresh_token?: string;
  };
  assert.ok(body.grant_package_id);
  assert.ok(body.access_token);
  assert.ok(body.refresh_token);
  return {
    accessToken: body.access_token,
    expiresIn: body.expires_in,
    packageId: body.grant_package_id,
    refreshToken: body.refresh_token,
  };
}

if (POSTGRES_URL) {
  // One server for the whole file. Issuing happens over HTTP against the
  // Postgres-backed AS; the owner-facing reads and the revoke cascade run by
  // calling the real exported auth.js functions directly, which select the
  // Postgres adapters because the active storage backend is postgres. Concrete
  // proof the Postgres adapters run: the negative control breaks a
  // Postgres-only grant-package SELECT and this suite goes red.
  let server: StartedServer | undefined;
  let asUrl = "";
  let client: AuthCodeClient | undefined;
  let spotify: Manifest | undefined;
  let github: Manifest | undefined;

  test.before(async () => {
    const serverOptions = {
      asPort: 0,
      databaseUrl: POSTGRES_URL,
      dbPath: ":memory:",
      introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
      ownerAuthPassword: "",
      quiet: true,
      reconcilePolyfillManifests: false,
      rsPort: 0,
      storageBackend: "postgres" as const,
    };
    server = (await startServer(serverOptions)) as StartedServer;
    asUrl = `http://localhost:${server.asPort}`;
    spotify = await registerConnector(asUrl, "spotify");
    github = await registerConnector(asUrl, "github");
    await seedPackageInstance(spotify.connector_id);
    await seedPackageInstance(github.connector_id);
    client = await registerAuthCodeClient(asUrl);
  });

  test.after(async () => {
    if (server) {
      await closeServer(server);
    }
    await closePostgresStorage();
    closeDb();
  });

  // ---------------------------------------------------------------------
  // A) Issue + list + detail through the real Postgres adapters.
  //
  // Exercises (write path, via HTTP): createHostedMcpGrantPackage ->
  // grant_packages INSERT, persistChildGrantForPackage -> grants INSERT,
  // grant_package_members INSERT, issuePackageToken -> tokens INSERT.
  // Exercises (read path, via exported fns): listGrantPackagesForOwner,
  // getGrantPackageForOwner (getGrantPackageRow SELECT + getGrantPackageMembers
  // join), getGrantPackageAccess (active-members join),
  // getGrantPackageIdForGrant (member-by-grant SELECT).
  // ---------------------------------------------------------------------
  test("issue -> list -> detail -> access through real auth.js postgres adapters", async () => {
    assert.ok(client && spotify && github, "premise: test.before registered the client and connectors");
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    // listGrantPackagesForOwner: grant_packages SELECT with member_count
    // subquery (Postgres listing adapter).
    const list = await listGrantPackagesForOwner({ limit: 50 });
    assert.ok(Array.isArray(list.data));
    const listed = list.data.find((row) => row.package_id === packageId);
    assert.ok(listed, "newly issued package appears in the owner listing");
    assert.equal(listed.status, "active");
    assert.equal(listed.member_count, 2);
    assert.equal(typeof listed.subject_id, "string");
    assert.equal(typeof listed.client_id, "string");
    assertNoSecretMaterial(list);

    // getGrantPackageForOwner: getGrantPackageRow SELECT + the all-members
    // join (Postgres detail adapters).
    const detailResponse = await getGrantPackageForOwner(packageId);
    assert.ok(detailResponse, "detail returns the package");
    const detail = grantPackageDetail(detailResponse);
    assert.equal(detail.package_id, packageId);
    assert.equal(detail.status, "active");
    assert.equal(detail.member_count, 2);
    assert.equal(detail.children.length, 2);
    for (const child of detail.children) {
      assert.equal(typeof child.grant_id, "string");
      assert.equal(child.grant_status, "active");
      assert.equal(child.member_status, "active");
      assert.ok(child.source, "each child carries a parsed source");
    }
    assertNoSecretMaterial(detail);

    // getGrantPackageAccess: the active-members join (Postgres fan-out
    // adapter). Returns child grant + token for each active member.
    const accessResponse = await getGrantPackageAccess(packageId);
    assert.ok(accessResponse, "access returns an active package");
    const access = grantPackageAccess(accessResponse);
    assert.equal(access.package.package_id, packageId);
    assert.equal(access.members.length, 2);
    for (const member of access.members) {
      assert.equal(member.package_id, packageId);
      assert.equal(typeof member.grant_id, "string");
      assert.equal(typeof member.token, "string", "member exposes its child grant token");
      assert.ok(member.grant, "member carries the parsed child grant");
      const grant = requireObject(member.grant, "member grant must be an object");
      const source = requireObject(grant.source, "member source must be an object");
      const sourceId = requireString(source.id, "member source id must be a string");
      const storageConnectorId = canonicalConnectorKey(sourceId);
      assert.ok(storageConnectorId, "member public source id maps to its local fulfillment key");
      for (const streamValue of requireArray(grant.streams, "member grant streams must be an array")) {
        const stream = requireObject(streamValue, "member grant stream must be an object");
        assert.deepEqual(stream.instance_ids, [packageInstanceId(storageConnectorId)]);
      }
    }

    const memberIdentityRows = await postgresQuery<{
      grant_id: string;
      grant_json: Record<string, unknown>;
      token_id: string;
    }>(
      `SELECT gm.grant_id, gm.token_id, g.grant_json
         FROM grant_package_members gm
         JOIN grants g ON g.grant_id = gm.grant_id
        WHERE gm.package_id = $1
        ORDER BY gm.grant_id
        LIMIT 1`,
      [packageId]
    );
    const [memberIdentity] = memberIdentityRows.rows;
    assert.ok(memberIdentity);
    const originalGrant = structuredClone(memberIdentity.grant_json);
    const foreignGrant = structuredClone(originalGrant);
    foreignGrant.subject = { id: "owner_foreign_package_member" };
    await postgresQuery("UPDATE grants SET subject_id = $1, grant_json = $2::jsonb WHERE grant_id = $3", [
      "owner_foreign_package_member",
      JSON.stringify(foreignGrant),
      memberIdentity.grant_id,
    ]);
    await postgresQuery("UPDATE tokens SET subject_id = $1 WHERE token_id = $2", [
      "owner_foreign_package_member",
      memberIdentity.token_id,
    ]);
    const foreignAccessResponse = await getGrantPackageAccess(packageId);
    assert.ok(foreignAccessResponse);
    assert.equal(
      grantPackageAccess(foreignAccessResponse).members.length,
      1,
      "the package omits a valid child whose subject no longer matches its parent"
    );
    const packageSubject = requireString(
      requireObject(requireObject(accessResponse, "package access").package, "package envelope").subject_id,
      "package subject_id must be a string"
    );
    await postgresQuery("UPDATE grants SET subject_id = $1, grant_json = $2::jsonb WHERE grant_id = $3", [
      packageSubject,
      JSON.stringify(originalGrant),
      memberIdentity.grant_id,
    ]);
    await postgresQuery("UPDATE tokens SET subject_id = $1 WHERE token_id = $2", [
      packageSubject,
      memberIdentity.token_id,
    ]);
    const restoredAccess = await getGrantPackageAccess(packageId);
    assert.ok(restoredAccess);
    assert.equal(grantPackageAccess(restoredAccess).members.length, 2);

    // getGrantPackageIdForGrant: member-by-grant SELECT. Every child grant
    // resolves back to this package; the package token (NULL grant_id) does
    // not participate.
    for (const child of detail.children) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
      const resolved = await getGrantPackageIdForGrant(child.grant_id);
      assert.equal(resolved, packageId, "child grant resolves to its package");
    }
  });

  test("package refresh replay deactivates every family-linked bearer through real postgres adapters", async () => {
    assert.ok(client && spotify && github, "premise: test.before registered the client and connectors");
    const packageClient = client;
    const issued = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });
    assert.ok(issued.expiresIn && issued.expiresIn <= 600, "family-linked package bearer has a short lifetime");

    const rotate = async (refreshToken: string) =>
      fetchJson(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: packageClient.client_id,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
    const attacker = await rotate(issued.refreshToken);
    assert.equal(attacker.status, 200, JSON.stringify(attacker.body));
    const attackerBody = requireObject(attacker.body, "attacker refresh response must be an object");
    assert.ok(
      requireNumber(attackerBody.expires_in, "attacker bearer expires_in must be a number") <= 600,
      "refresh-derived package bearer has a short lifetime"
    );
    assert.ok(typeof attackerBody.access_token === "string");
    assert.ok(typeof attackerBody.refresh_token === "string");

    const replay = await rotate(issued.refreshToken);
    assert.equal(replay.status, 400);
    const replayBody = requireObject(replay.body, "replay response must be an object");
    assert.equal(replayBody.error, "invalid_grant");
    assert.equal(replayBody.fresh_authorization_required, true);

    const family = await postgresQuery<{ family_id: string }>(
      `SELECT family_id
         FROM oauth_refresh_tokens
        WHERE refresh_token_hash = $1`,
      [createHash("sha256").update(issued.refreshToken).digest("base64url")]
    );
    const familyId = requireString(family.rows[0]?.family_id, "refresh family id must be persisted");
    const bearers = await postgresQuery<{ expires_at: string | null; revoked: boolean; token_id: string }>(
      `SELECT token_id, expires_at, revoked
         FROM tokens
        WHERE refresh_family_id = $1
        ORDER BY created_at, token_id`,
      [familyId]
    );
    assert.equal(bearers.rows.length, 2, "the initial and attacker-minted package bearers share the family");
    const introspectionHeaders = {
      Authorization: basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS),
      "Content-Type": "application/x-www-form-urlencoded",
    };
    for (const bearer of bearers.rows) {
      assert.equal(bearer.revoked, true, "replay revokes every family-linked package bearer row");
      assert.ok(bearer.expires_at, "every family-linked package bearer has an expiry");
      // biome-ignore lint/performance/noAwaitInLoops: Each persisted family bearer is an independent security assertion.
      const introspection = await fetchJson(`${asUrl}/introspect`, {
        body: new URLSearchParams({ token: bearer.token_id }).toString(),
        headers: introspectionHeaders,
        method: "POST",
      });
      assert.equal(introspection.status, 200);
      assert.equal(requireObject(introspection.body, "introspection body must be an object").active, false);
    }

    const successor = await rotate(requireString(attackerBody.refresh_token, "attacker successor must be a string"));
    assert.equal(successor.status, 400, "family replay revokes the attacker successor");
  });

  // ---------------------------------------------------------------------
  // B) Revoke cascade through the real Postgres adapters.
  //
  // Exercises listActiveGrantPackageMembersForRevocation (active-members
  // join), markGrantPackageMemberRevoked (member UPDATE), and
  // markGrantPackageRevoked (the 4-statement Postgres revocation cascade:
  // grant_packages + tokens + grant_package_members + oauth_refresh_tokens).
  // ---------------------------------------------------------------------
  test("revoke cascade flips package and every child to revoked through real auth.js postgres adapters", async () => {
    assert.ok(client && spotify && github, "premise: test.before registered the client and connectors");
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const beforeResponse = await getGrantPackageForOwner(packageId);
    assert.ok(beforeResponse, "the newly issued package is readable back");
    const before = grantPackageDetail(beforeResponse);
    assert.equal(before.status, "active");
    assert.equal(before.children.length, 2);
    for (const child of before.children) {
      assert.equal(child.grant_status, "active");
      assert.equal(child.member_status, "active");
    }

    const revoke = grantPackageRevokeResult(await revokeGrantPackage(packageId));
    assert.equal(revoke.package_id, packageId);
    assert.equal(revoke.status, "revoked");
    assert.ok(revoke.revoked_at);
    assert.equal(revoke.revoked_child_grants.length, 2);
    assert.deepEqual(revoke.not_revoked_child_grants, []);
    assertNoSecretMaterial(revoke);

    // Detail now shows revoked status on the package row and on every child
    // grant + member binding (markGrantPackageRevoked cascade UPDATEs).
    const afterResponse = await getGrantPackageForOwner(packageId);
    assert.ok(afterResponse, "the revoked package is still readable back");
    const after = grantPackageDetail(afterResponse);
    assert.equal(after.status, "revoked");
    assert.ok(after.revoked_at);
    for (const child of after.children) {
      assert.equal(child.grant_status, "revoked");
      assert.equal(child.member_status, "revoked");
      assert.ok(child.revoked_at, "revoked member carries a revoked_at");
    }

    // getGrantPackageAccess hides revoked packages entirely.
    const access = await getGrantPackageAccess(packageId);
    assert.equal(access, null, "a revoked package is not returned by the fan-out access read");
  });
} else {
  test("grant-package postgres-adapter path (skipped: PDPP_TEST_POSTGRES_URL unset)", { skip: true }, () => {
    /* intentionally empty */
  });
}
