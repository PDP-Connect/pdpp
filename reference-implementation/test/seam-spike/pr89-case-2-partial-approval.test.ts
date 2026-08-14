// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { executeStreamDetail, StreamDetailVisibilityError } from "../../operations/rs-streams-detail/index.ts";
import { canonicalConnectorKeyFromManifest } from "../../server/connector-key.ts";
import { closeDb } from "../../server/db.ts";
import { startServer } from "../../server/index.ts";
import { basicIntrospectionAuthorization } from "../../server/introspection-http.ts";
import { closePostgresStorage } from "../../server/postgres-storage.ts";
import {
  parseGrantedAuthorizationDetail,
  parseResolvedGrantApprovedAuthorization,
} from "../../server/source-approved-authorization.ts";
import { resolveSourceIntrospectionContext } from "../../server/source-introspection-context.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../../server/stores/connector-instance-store.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "../helpers/introspection-test-credentials.ts";
import { writePr89CaseOutput } from "./pr89-case-output.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_KEY = "pr89-spotify-source-case2";
const INSTANCE_A = "pr89-case2-account-a";
const INSTANCE_B = "pr89-case2-account-b";
const REDIRECT_URI = "https://client.example/pr89-callback";
const SOURCE_ID = "https://sources.example/records/spotify/case-2";

interface CloseableServer {
  close: (callback: () => void) => unknown;
  closeAllConnections?: () => void;
}

interface RunningServer {
  asPort: number;
  asServer: CloseableServer;
  rsPort: number;
  rsServer: CloseableServer;
}

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`./fixtures/pr89/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function closeServer(server: RunningServer): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  await Promise.all([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(url: string | URL, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { body: (text ? JSON.parse(text) : null) as T, response };
}

function connectorManifest(declaration: Record<string, unknown>): Record<string, unknown> {
  return {
    capabilities: { human_interaction: [] },
    connector_id: CONNECTOR_KEY,
    connector_key: CONNECTOR_KEY,
    display_name: "PR89 Spotify source",
    manifest_uri: `https://implementations.example/connectors/${CONNECTOR_KEY}`,
    protocol_version: "0.1.0",
    source_declaration: declaration,
    streams: declaration.streams,
    version: "1.0.0",
  };
}

async function seedInstances(manifest: Record<string, unknown>): Promise<void> {
  const connectorId = canonicalConnectorKeyFromManifest(manifest);
  assert.equal(connectorId, CONNECTOR_KEY);
  const store = POSTGRES_URL ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await Promise.all(
    [INSTANCE_A, INSTANCE_B].map((instanceId) =>
      store.upsert({
        connectorId,
        connectorInstanceId: instanceId,
        createdAt: now,
        displayName: instanceId,
        ownerSubjectId: "owner_local",
        sourceBinding: { account: instanceId },
        sourceBindingKey: instanceId,
        sourceKind: "account",
        status: "active",
        updatedAt: now,
      })
    )
  );
}

async function registerClient(asUrl: string): Promise<string> {
  const { body, response } = await fetchJson<{ client_id: string }>(`${asUrl}/oauth/register`, {
    body: JSON.stringify({
      application_type: "web",
      client_name: "PR89 seam client",
      grant_types: ["authorization_code"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(response.status, 201);
  assert.ok(body.client_id);
  return body.client_id;
}

function authorizeUrl(asUrl: string, clientId: string, verifier: string, detail: unknown): URL {
  const url = new URL(`${asUrl}/oauth/authorize`);
  url.searchParams.set("authorization_details", JSON.stringify([detail]));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", "pr89-case-2");
  return url;
}

test("real authorization-code PKCE flow preserves narrowed approval and policy terms", async (t) => {
  const tempBase = join(homedir(), ".tmp");
  mkdirSync(tempBase, { recursive: true });
  const tempDir = mkdtempSync(join(tempBase, "pdpp-pr89-case2-"));
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  if (POSTGRES_URL) {
    process.env.PDPP_DATABASE_URL = POSTGRES_URL;
  } else {
    delete process.env.PDPP_DATABASE_URL;
  }

  let server: RunningServer | null = null;
  try {
    server = await startServer({
      asPort: 0,
      dbPath: join(tempDir, "case-2.sqlite"),
      introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
      ownerAuthPassword: "",
      quiet: true,
      reconcilePolyfillManifests: false,
      rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
      rsPort: 0,
    });
    const asUrl = `http://127.0.0.1:${server.asPort}`;
    const declaration = fixture("source.json");
    (declaration.source as Record<string, unknown>).id = SOURCE_ID;
    const requestDetail = fixture("rar-request.json");
    requestDetail.source = structuredClone(declaration.source);
    const requestStreams = requestDetail.streams as Record<string, unknown>[];
    requestStreams[0] = { ...requestStreams[0], instance_ids: [INSTANCE_A] };
    requestStreams[1] = { ...requestStreams[1], instance_ids: [INSTANCE_B] };
    const invalidDetail = fixture("rar-request-invalid.json");
    invalidDetail.source = structuredClone(declaration.source);
    const manifest = connectorManifest(declaration);
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201);
    await seedInstances(manifest);
    const clientId = await registerClient(asUrl);
    const verifier = randomBytes(32).toString("base64url");

    const invalidResponse = await fetch(authorizeUrl(asUrl, clientId, verifier, invalidDetail), {
      redirect: "manual",
    });
    const invalidBody = (await invalidResponse.json()) as { error: string };
    await t.test("invalid Source selection maps to invalid_authorization_details", () => {
      assert.equal(invalidResponse.status, 400, JSON.stringify(invalidBody));
      assert.equal(invalidBody.error, "invalid_authorization_details");
    });

    const authorize = await fetch(authorizeUrl(asUrl, clientId, verifier, requestDetail), {
      redirect: "manual",
    });
    assert.equal(authorize.status, 302);
    const consentLocation = authorize.headers.get("location");
    assert.ok(consentLocation);
    const requestUri = new URL(consentLocation, asUrl).searchParams.get("request_uri");
    assert.ok(requestUri);

    const review = await fetchJson<{ approval_review_revision: string }>(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        request_uri: requestUri,
        source_narrowing: { "0": { streams: ["top_artists"] } },
        subject_id: "owner_local",
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(review.response.status, 200);
    assert.equal(typeof review.body.approval_review_revision, "string");

    const approval = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: review.body.approval_review_revision,
        request_uri: requestUri,
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      redirect: "manual",
    });
    assert.equal(approval.status, 302);
    const callbackLocation = approval.headers.get("location");
    assert.ok(callbackLocation);
    const code = new URL(callbackLocation).searchParams.get("code");
    assert.ok(code);

    const { body: tokenBody, response: tokenResponse } = await fetchJson<{
      access_token: string;
      authorization_details: unknown[];
      grant_id: string;
    }>(`${asUrl}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    });
    assert.equal(tokenResponse.status, 200);
    assert.equal(tokenBody.authorization_details.length, 1);
    const [grantedDetail] = tokenBody.authorization_details;
    assert.ok(grantedDetail);
    const parsedDetail = parseGrantedAuthorizationDetail(grantedDetail, declaration);
    assert.deepEqual(parsedDetail.detail.retention, { max_duration: "P30D", on_expiry: "delete" });
    assert.equal(parsedDetail.detail.purpose_description, "Build a personal listening summary");
    assert.deepEqual(
      parsedDetail.authorization.streams.map((stream) => stream.name),
      ["top_artists"]
    );

    const { body: introspected, response: introspectionResponse } = await fetchJson<{
      active: boolean;
      authorization_details: unknown[];
      pdpp: unknown;
    }>(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token: tokenBody.access_token }).toString(),
      headers: {
        Authorization: basicIntrospectionAuthorization(TEST_RS_INTROSPECTION_CREDENTIALS),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    assert.equal(introspectionResponse.status, 200);
    assert.equal(introspected.active, true);
    const introspectionContext = resolveSourceIntrospectionContext(introspected);
    assert.deepEqual(
      parseResolvedGrantApprovedAuthorization(introspectionContext.grant, declaration),
      parsedDetail.authorization
    );

    await assert.rejects(
      () =>
        executeStreamDetail(
          {
            actor: {
              client_id: clientId,
              grant_id: tokenBody.grant_id,
              kind: "client",
              subject_id: "owner_local",
            },
            streamName: "recently_played",
          },
          {
            buildStreamMetadata: () => Promise.reject(new Error("declined stream reached metadata assembly")),
            getSourceDescriptor: () => declaration.source as { id: string; kind: "connector" },
            hasManifestStream: () => Promise.resolve(true),
            isStreamInGrant: (name) => parsedDetail.authorization.streams.some((stream) => stream.name === name),
          }
        ),
      (error: unknown) => error instanceof StreamDetailVisibilityError && error.code === "grant_stream_not_allowed"
    );

    writePr89CaseOutput({
      case_id: "case-2",
      observations: [
        "declined_stream_unqueryable",
        "partial_approval_preserved",
        "policy_terms_preserved",
        "source_error_mapped",
      ],
      oracle_code: "partial_approval",
      response_envelopes: [
        {
          authorization_details: tokenBody.authorization_details,
          status: tokenResponse.status,
        },
        { error: invalidBody.error, status: invalidResponse.status },
        { error: "grant_stream_not_allowed", status: 403 },
      ],
      schema: "pdpp.pr89.case-output.v1",
    });
  } finally {
    if (server) {
      await closeServer(server);
    }
    await closePostgresStorage();
    closeDb();
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
    rmSync(tempDir, { force: true, recursive: true });
  }
});
