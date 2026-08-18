// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `_ref/grant-packages` operator visibility surface: owner-session-gated
 * list, detail, and revoke endpoints introduced by the OpenSpec change
 * `add-grant-package-operator-visibility`.
 *
 * These tests drive the real reference server (in-memory SQLite, owner
 * auth disabled via `ownerAuthPassword: ''`), run a multi-source hosted
 * MCP picker flow to issue a package, then probe:
 *
 *   1. `GET /_ref/grant-packages` lists the package with member count
 *      and exposes no token/secret material.
 *   2. `GET /_ref/grant-packages/:id` returns the child cascade with
 *      `grant_id`, `grant_status`, `source`, and timestamps, and never
 *      includes secret fields.
 *   3. `GET /_ref/grant-packages/:id` returns a typed `not_found` 404
 *      envelope for unknown ids.
 *   4. `POST /_ref/grant-packages/:id/revoke` revokes every child,
 *      flips the package to `revoked`, and names every revoked child in
 *      the revoke-result envelope.
 *   5. The same revoke endpoint returns `409 already_revoked` on a
 *      second call.
 *   6. `GET /_ref/grants` rows whose grant id is a package member
 *      surface `grant_package_id` on the spine row; non-package grants
 *      omit the field.
 *   7. Partial package-revoke failure returns a non-2xx envelope naming
 *      which child grant revoked and which did not.
 */

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalConnectorKeyFromManifest } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer as startServerUntyped } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const OWNER_SUBJECT_ID = "owner_local";
const NOW = "2026-05-31T00:00:00.000Z";

const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "token_hash",
  "package_secret",
  "package_token",
  "client_secret",
  "token",
]);

/**
 * `server/index.js` is still plain JS (not migrated) and exports no types.
 * TypeScript's `allowJs`-without-`checkJs` inference on `startServer`'s
 * default-valued `opts = {}` parameter collapses to `{}`, and its returned
 * `asServer`/`rsServer` infer as `Http2SecureServer` (missing
 * `closeAllConnections`), both are inference artifacts of the untyped
 * source, not the real runtime shape (real `http.Server` instances from
 * `asApp.listen(...)` / `rsApp.listen(...)`). Mirrors the same pattern used
 * in test/ref-client-event-subscriptions-routes.test.ts.
 */
interface TestServerOptions {
  readonly asPort?: number;
  readonly dbPath?: string;
  readonly ownerAuthPassword?: string;
  readonly quiet?: boolean;
  readonly rsPort?: number;
}

interface TestHttpServer {
  close: (callback: (err?: Error) => void) => void;
  closeAllConnections: () => void;
}

interface TestServerHandle {
  readonly asPort: number;
  readonly asServer: TestHttpServer;
  readonly rsPort: number;
  readonly rsServer: TestHttpServer;
}

function isHttpServerLike(value: unknown): value is TestHttpServer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { closeAllConnections?: unknown }).closeAllConnections === "function" &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function assertHttpServerLike(value: unknown, label: string): TestHttpServer {
  assert.ok(isHttpServerLike(value), `${label} does not expose the expected server shape`);
  return value;
}

async function startServer(opts: TestServerOptions): Promise<TestServerHandle> {
  const server = await startServerUntyped(opts);
  return {
    asPort: server.asPort,
    asServer: assertHttpServerLike(server.asServer, "asServer"),
    rsPort: server.rsPort,
    rsServer: assertHttpServerLike(server.rsServer, "rsServer"),
  };
}

// `fetchJson`'s body is genuinely-unknown wire JSON (the reference server's
// HTTP responses have no exported response types); each call site casts the
// `unknown` body to a small locally-defined shape describing only the fields
// that call site reads.
interface FetchJsonResult {
  readonly body: unknown;
  readonly resp: Response;
  readonly status: number;
}

interface RegisteredClient {
  readonly client_id: string;
}

// Wire-response shapes this test reads back from `_ref/grant-packages` and
// `_ref/grants`. These describe only the fields the assertions below touch;
// the routes themselves stay untyped JS (server/index.js), so each fetchJson
// call site casts its genuinely-unknown JSON body to the shape it expects.
interface GrantPackageSummary {
  readonly client_id: string;
  readonly member_count: number;
  readonly object: string;
  readonly package_id: string;
  readonly status: string;
  readonly subject_id: string;
}

interface GrantPackageList {
  readonly data: readonly GrantPackageSummary[];
  readonly has_more?: boolean;
  readonly next_cursor?: string;
  readonly object: string;
}

interface GrantPackageChild {
  readonly grant_id: string;
  readonly grant_status: string;
  readonly member_status: string;
  readonly object: string;
  readonly revoked_at?: string | null;
  readonly source?: unknown;
}

interface GrantPackageDetail {
  readonly children: readonly GrantPackageChild[];
  readonly member_count: number;
  readonly object: string;
  readonly package_id: string;
  readonly revoked_at?: string | null;
  readonly status: string;
}

interface ErrorEnvelope {
  readonly error: { readonly code?: string } | string;
}

interface RevokeResultChildError {
  readonly error: { readonly code: string };
  readonly grant_id: string;
}

interface RevokeResult {
  readonly not_revoked_child_count: number;
  readonly not_revoked_child_grants: readonly RevokeResultChildError[];
  readonly object: string;
  readonly package_id: string;
  readonly revoked_at: string | null;
  readonly revoked_child_count: number;
  readonly revoked_child_grants: readonly string[];
  readonly status: string;
}

interface GrantSpineRow {
  readonly grant_id: string;
  readonly grant_package_id?: string;
}

interface GrantsList {
  readonly data: readonly GrantSpineRow[];
}

// Minimal manifest shape this test reads/rewrites; manifests on disk carry
// many more fields that pass through untouched via the spread below.
interface ConnectorManifestFixture {
  readonly connector_id: string;
  readonly [key: string]: unknown;
}

function assertNoSecretMaterial(value: unknown, path = "$"): void {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    // biome-ignore lint/suspicious/useIterableCallbackReturn: localized test assertion preserves its explicit contract.
    value.forEach((v, i) => assertNoSecretMaterial(v, `${path}[${i}]`));
    return;
  }
  if (typeof value !== "object") {
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    assert.ok(
      !SECRET_KEYS.has(key),
      `secret-shaped field "${key}" surfaced at ${path}.${key}: operator surfaces must not leak token material`
    );
    assertNoSecretMaterial(v, `${path}.${key}`);
  }
}

function renderedHostedMcpStreamValues(html: string): string[] {
  return [
    ...html.matchAll(/<input[^>]*name="stream"[^>]*value="([^"]+)"[^>]*data-hosted-mcp-stream-checkbox[^>]*>/g),
  ].map((match) => {
    const [, value] = match;
    assert.ok(value, "stream checkbox input must carry a value attribute");
    return value;
  });
}

function renderedHostedMcpSourceValues(html: string): string[] {
  return [
    ...html.matchAll(/<input[^>]*name="selection"[^>]*value="([^"]+)"[^>]*data-hosted-mcp-source-checkbox[^>]*>/g),
  ].map((match) => {
    const [, value] = match;
    assert.ok(value, "source checkbox input must carry a value attribute");
    return value;
  });
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  const body: unknown = text ? JSON.parse(text) : null;
  return { body, resp, status: resp.status };
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

// Register a first-party connector fixture with the AS using its canonical
// short connector key. The fixture manifests on disk still ship URL-shaped
// `connector_id` values; the AS storage and the hosted MCP picker key
// everything by canonical connector key now that `canonicalize-connector-keys`
// has landed. Returning the manifest with `connector_id` rewritten to the
// canonical form keeps `manifest.connector_id` consistent with the value the
// picker emits and the AS validates.
async function registerConnector(asUrl: string, name: string): Promise<ConnectorManifestFixture> {
  const raw = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, `fixtures/seed-manifests/${name}.json`), "utf8")
  ) as ConnectorManifestFixture;
  const canonical = canonicalConnectorKeyFromManifest(raw);
  const manifest: ConnectorManifestFixture =
    !canonical || canonical === raw.connector_id ? raw : { ...raw, connector_id: canonical };
  const { status } = await fetchJson(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  await seedConnectorInstance(manifest, name);
  return manifest;
}

async function seedConnectorInstance(manifest: ConnectorManifestFixture, name: string): Promise<void> {
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: manifest.connector_id,
    connectorInstanceId: `cin_ref_grant_packages_${name}`,
    createdAt: NOW,
    displayName: `Ref Grant Packages ${name}`,
    ownerSubjectId: OWNER_SUBJECT_ID,
    sourceBinding: { account_hint: `${name}@ref-grant-packages.example.com` },
    sourceBindingKey: `${name}@ref-grant-packages.example.com`,
    sourceKind: "account",
    status: "active",
    updatedAt: NOW,
  });
}

async function registerAuthCodeClient(asUrl: string): Promise<RegisteredClient> {
  const { status, body } = await fetchJson(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "ref-grant-packages test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(status, 201);
  return body as RegisteredClient;
}

interface CompleteMultiSourcePackageFlowInput {
  readonly asUrl: string;
  readonly client: RegisteredClient;
  readonly connectorIds: readonly string[];
}

async function completeMultiSourcePackageFlow({
  asUrl,
  client,
  connectorIds,
}: CompleteMultiSourcePackageFlowInput): Promise<{ packageId: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const state = "pkg-test-state";
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
  const selectedConnectorIds = new Set(connectorIds);
  for (const sourceValue of renderedHostedMcpSourceValues(pickerHtml)) {
    const decoded = JSON.parse(Buffer.from(sourceValue, "base64url").toString("utf8")) as { connector_id?: string };
    if (decoded.connector_id && selectedConnectorIds.has(decoded.connector_id)) {
      params.append("selection", sourceValue);
    }
  }
  // Mirror explicit whole-source approval: submit every stream value for the
  // selected sources. Narrowing cases construct their own form submissions.
  for (const streamValue of renderedHostedMcpStreamValues(pickerHtml)) {
    params.append("stream", streamValue);
  }

  const approveResp = await fetch(`${asUrl}/oauth/authorize/mcp-package`, {
    body: params.toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "manual",
  });
  const approveBody = await approveResp.clone().text();
  assert.equal(approveResp.status, 302, approveBody);
  const location = approveResp.headers.get("location");
  assert.ok(location, "approve response must carry a redirect location");
  const callback = new URL(location);
  const code = callback.searchParams.get("code");
  assert.ok(code);

  const { status, body } = await fetchJson(`${asUrl}/oauth/token`, {
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
  const tokenBody = body as { grant_package_id?: string };
  const packageId = tokenBody.grant_package_id;
  assert.ok(packageId);
  return { packageId };
}

function startTestServer() {
  return startServer({
    asPort: 0,
    dbPath: ":memory:",
    ownerAuthPassword: "",
    quiet: true,
    rsPort: 0,
  });
}

test("GET /_ref/grant-packages lists the package with no secret material", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, "spotify");
    const github = await registerConnector(asUrl, "github");
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });
    const { packageId: secondPackageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const { status, body } = await fetchJson(`${asUrl}/_ref/grant-packages`);
    assert.equal(status, 200);
    const list = body as GrantPackageList;
    assert.equal(list.object, "list");
    assert.ok(Array.isArray(list.data));
    const row = list.data.find((r) => r.package_id === packageId);
    assert.ok(row, "newly issued package must appear in the list");
    assert.equal(row.object, "grant_package_summary");
    assert.equal(row.status, "active");
    assert.equal(row.member_count, 2);
    assert.equal(typeof row.subject_id, "string");
    assert.equal(typeof row.client_id, "string");
    assertNoSecretMaterial(list);

    const firstPage = await fetchJson(`${asUrl}/_ref/grant-packages?limit=1`);
    assert.equal(firstPage.status, 200);
    const firstPageList = firstPage.body as GrantPackageList;
    assert.equal(firstPageList.data.length, 1);
    assert.equal(firstPageList.has_more, true);
    assert.equal(typeof firstPageList.next_cursor, "string");
    const nextCursor = firstPageList.next_cursor;
    assert.ok(nextCursor);

    const secondPage = await fetchJson(`${asUrl}/_ref/grant-packages?limit=1&cursor=${encodeURIComponent(nextCursor)}`);
    assert.equal(secondPage.status, 200);
    const secondPageList = secondPage.body as GrantPackageList;
    assert.equal(secondPageList.data.length, 1);
    const [firstPageRow] = firstPageList.data;
    const [secondPageRow] = secondPageList.data;
    assert.ok(firstPageRow);
    assert.ok(secondPageRow);
    const pagedIds = new Set([firstPageRow.package_id, secondPageRow.package_id]);
    assert.deepEqual(pagedIds, new Set([packageId, secondPackageId]));
  } finally {
    await closeServer(server);
  }
});

test("GET /_ref/grant-packages/:id returns the child cascade with no secret material", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, "spotify");
    const github = await registerConnector(asUrl, "github");
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const { status, body } = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`);
    assert.equal(status, 200);
    const detail = body as GrantPackageDetail;
    assert.equal(detail.object, "grant_package");
    assert.equal(detail.package_id, packageId);
    assert.equal(detail.status, "active");
    assert.equal(detail.member_count, 2);
    assert.ok(Array.isArray(detail.children));
    assert.equal(detail.children.length, 2);
    for (const child of detail.children) {
      assert.equal(child.object, "grant_package_child");
      assert.equal(typeof child.grant_id, "string");
      assert.equal(typeof child.grant_status, "string");
      assert.equal(typeof child.member_status, "string");
      assert.ok(child.source, "each child carries a parsed source");
    }
    assertNoSecretMaterial(detail);
  } finally {
    await closeServer(server);
  }
});

test("GET /_ref/grant-packages/:id returns typed not_found for an unknown id", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const { status, body } = await fetchJson(`${asUrl}/_ref/grant-packages/gpkg_does_not_exist`);
    assert.equal(status, 404);
    assert.ok(body && typeof body === "object" && "error" in body);
    const errorBody = body as ErrorEnvelope;
    const errorCode = typeof errorBody.error === "string" ? errorBody.error : errorBody.error.code;
    assert.equal(errorCode ?? errorBody.error, "not_found");
  } finally {
    await closeServer(server);
  }
});

test("POST /_ref/grant-packages/:id/revoke cascades revocation; second call returns 409 already_revoked", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, "spotify");
    const github = await registerConnector(asUrl, "github");
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const revoke = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}/revoke`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(revoke.status, 200);
    const revokeResult = revoke.body as RevokeResult;
    assert.equal(revokeResult.object, "grant_package_revoke_result");
    assert.equal(revokeResult.package_id, packageId);
    assert.equal(revokeResult.status, "revoked");
    assert.ok(revokeResult.revoked_at);
    assert.equal(revokeResult.revoked_child_count, 2);
    assert.equal(revokeResult.not_revoked_child_count, 0);
    assert.equal(revokeResult.revoked_child_grants.length, 2);
    assert.deepEqual(revokeResult.not_revoked_child_grants, []);
    assertNoSecretMaterial(revokeResult);

    // Detail now shows revoked status on the package row and on every
    // child grant and member binding.
    const detail = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`);
    assert.equal(detail.status, 200);
    const revokedDetail = detail.body as GrantPackageDetail;
    assert.equal(revokedDetail.status, "revoked");
    assert.ok(revokedDetail.revoked_at);
    for (const child of revokedDetail.children) {
      assert.equal(child.grant_status, "revoked");
      assert.equal(child.member_status, "revoked");
      assert.ok(child.revoked_at, "revoked member must carry a revoked_at");
    }

    const again = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}/revoke`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(again.status, 409);
    const againBody = again.body as ErrorEnvelope;
    const againErrorCode = typeof againBody.error === "string" ? againBody.error : againBody.error.code;
    assert.equal(againErrorCode ?? againBody.error, "already_revoked");
  } finally {
    await closeServer(server);
  }
});

test("POST /_ref/grant-packages/:id/revoke surfaces partial child failure without reporting success", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, "spotify");
    const github = await registerConnector(asUrl, "github");
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const before = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`);
    assert.equal(before.status, 200);
    const beforeDetail = before.body as GrantPackageDetail;
    assert.equal(beforeDetail.children.length, 2);
    const [brokenChild, healthyChild] = beforeDetail.children;
    assert.ok(brokenChild?.grant_id);
    assert.ok(healthyChild?.grant_id);

    getDb()
      .prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?")
      .run('{"not":"a valid persisted grant"}', brokenChild.grant_id);

    const revoke = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}/revoke`, {
      body: "{}",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(revoke.status, 500);
    const revokeResult = revoke.body as RevokeResult;
    assert.equal(revokeResult.object, "grant_package_revoke_result");
    assert.equal(revokeResult.package_id, packageId);
    assert.equal(revokeResult.status, "partial_failure");
    assert.equal(revokeResult.revoked_at, null);
    assert.deepEqual(revokeResult.revoked_child_grants, [healthyChild.grant_id]);
    assert.equal(revokeResult.revoked_child_count, 1);
    assert.equal(revokeResult.not_revoked_child_count, 1);
    const [notRevokedChild] = revokeResult.not_revoked_child_grants;
    assert.ok(notRevokedChild);
    assert.equal(notRevokedChild.grant_id, brokenChild.grant_id);
    assert.equal(notRevokedChild.error.code, "grant_invalid");
    assertNoSecretMaterial(revokeResult);

    const detail = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`);
    assert.equal(detail.status, 200);
    const activeDetail = detail.body as GrantPackageDetail;
    assert.equal(activeDetail.status, "active");
    const childrenByGrant = new Map(activeDetail.children.map((child) => [child.grant_id, child]));
    const healthyChildRow = childrenByGrant.get(healthyChild.grant_id);
    const brokenChildRow = childrenByGrant.get(brokenChild.grant_id);
    assert.ok(healthyChildRow);
    assert.ok(brokenChildRow);
    assert.equal(healthyChildRow.grant_status, "revoked");
    assert.equal(healthyChildRow.member_status, "revoked");
    assert.equal(brokenChildRow.grant_status, "active");
    assert.equal(brokenChildRow.member_status, "active");
  } finally {
    await closeServer(server);
  }
});

test("GET /_ref/grants surfaces grant_package_id on package-member child rows and omits it otherwise", async () => {
  const server = await startTestServer();
  const asUrl = `http://localhost:${server.asPort}`;

  try {
    const spotify = await registerConnector(asUrl, "spotify");
    const github = await registerConnector(asUrl, "github");
    const client = await registerAuthCodeClient(asUrl);
    const { packageId } = await completeMultiSourcePackageFlow({
      asUrl,
      client,
      connectorIds: [spotify.connector_id, github.connector_id],
    });

    const detail = await fetchJson(`${asUrl}/_ref/grant-packages/${encodeURIComponent(packageId)}`);
    const packageDetail = detail.body as GrantPackageDetail;
    const childGrantIds = new Set(packageDetail.children.map((c) => c.grant_id));
    assert.equal(childGrantIds.size, 2);

    const grantsList = await fetchJson(`${asUrl}/_ref/grants?limit=50`);
    assert.equal(grantsList.status, 200);
    const grantsBody = grantsList.body as GrantsList;
    const packageBound = grantsBody.data.filter((g) => childGrantIds.has(g.grant_id));
    assert.equal(packageBound.length, 2, "both child grants appear on the spine row list");
    for (const row of packageBound) {
      assert.equal(row.grant_package_id, packageId, "package-bound child row carries grant_package_id");
    }
    const nonPackage = grantsBody.data.filter((g) => !childGrantIds.has(g.grant_id));
    for (const row of nonPackage) {
      assert.equal(row.grant_package_id, undefined, `non-package grant ${row.grant_id} must omit grant_package_id`);
    }
    assertNoSecretMaterial(grantsBody);
  } finally {
    await closeServer(server);
  }
});
