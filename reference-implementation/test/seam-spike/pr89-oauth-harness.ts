// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { canonicalConnectorKeyFromManifest } from "../../server/connector-key.ts";
import { closeDb } from "../../server/db.ts";
import { startServer } from "../../server/index.ts";
import { closePostgresStorage } from "../../server/postgres-storage.ts";
import { ingestRecord } from "../../server/records.ts";
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from "../../server/stores/connector-instance-store.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "../helpers/introspection-test-credentials.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const REDIRECT_URI = "https://client.example/pr89-callback";

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

type IntrospectionInterceptor = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1]
) => Promise<Response>;

export interface Pr89OAuthHarness {
  readonly asUrl: string;
  readonly clientId: string;
  close: () => Promise<void>;
  readonly declaration: Record<string, unknown>;
  disableAuthorizationServer: () => Promise<void>;
  readonly grantId: string;
  ingest: (record: Parameters<typeof ingestRecord>[1]) => Promise<void>;
  readonly instanceId: string;
  readonly rsUrl: string;
  setIntrospectionInterceptor: (interceptor: IntrospectionInterceptor | null) => void;
  readonly token: string;
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

async function closeOne(server: CloseableServer): Promise<void> {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function fetchJson<T = Record<string, unknown>>(url: string | URL, options: RequestInit = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  return { body: (text ? JSON.parse(text) : null) as T, response };
}

function manifest(declaration: Record<string, unknown>, connectorKey: string): Record<string, unknown> {
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: "PR89 Spotify source",
    manifest_uri: `https://implementations.example/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    source_declaration: declaration,
    streams: declaration.streams,
    version: "1.0.0",
  };
}

async function seedInstances(
  connectorManifest: Record<string, unknown>,
  connectorKey: string,
  instanceIds: readonly string[]
): Promise<void> {
  const connectorId = canonicalConnectorKeyFromManifest(connectorManifest);
  assert.equal(connectorId, connectorKey);
  const store = POSTGRES_URL ? createPostgresConnectorInstanceStore() : createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await Promise.all(
    instanceIds.map((instanceId) =>
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

function authorizationUrl(asUrl: string, clientId: string, verifier: string, detail: unknown): URL {
  const url = new URL(`${asUrl}/oauth/authorize`);
  url.searchParams.set("authorization_details", JSON.stringify([detail]));
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("code_challenge", pkceChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", "pr89-seam");
  return url;
}

async function issueToken(
  asUrl: string,
  clientId: string,
  detail: unknown
): Promise<{ grantId: string; token: string }> {
  const verifier = randomBytes(32).toString("base64url");
  const authorize = await fetch(authorizationUrl(asUrl, clientId, verifier, detail), { redirect: "manual" });
  assert.equal(authorize.status, 302, await authorize.clone().text());
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
  assert.equal(review.response.status, 200, JSON.stringify(review.body));
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
  const { body, response } = await fetchJson<{ access_token: string; grant_id: string }>(`${asUrl}/oauth/token`, {
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
  assert.equal(response.status, 200);
  assert.ok(body.access_token);
  assert.ok(body.grant_id);
  return { grantId: body.grant_id, token: body.access_token };
}

export async function startPr89OAuthHarness(): Promise<Pr89OAuthHarness> {
  const tempBase = join(homedir(), ".tmp");
  mkdirSync(tempBase, { recursive: true });
  const tempDir = mkdtempSync(join(tempBase, "pdpp-pr89-seam-"));
  const previousDatabaseUrl = process.env.PDPP_DATABASE_URL;
  if (POSTGRES_URL) {
    process.env.PDPP_DATABASE_URL = POSTGRES_URL;
  } else {
    delete process.env.PDPP_DATABASE_URL;
  }
  let interceptor: IntrospectionInterceptor | null = null;
  const introspectionFetch: typeof fetch = (input, init) =>
    interceptor ? interceptor(input, init) : fetch(input, init);
  let server: RunningServer | null = null;
  try {
    server = await startServer({
      asPort: 0,
      dbPath: join(tempDir, "seam.sqlite"),
      introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
      introspectionFetch,
      ownerAuthPassword: "",
      quiet: true,
      reconcilePolyfillManifests: false,
      rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
      rsPort: 0,
    });
    const asUrl = `http://127.0.0.1:${server.asPort}`;
    const rsUrl = `http://127.0.0.1:${server.rsPort}`;
    const suffix = `${process.pid}-${randomBytes(4).toString("hex")}`;
    const connectorKey = `pr89-seam-${suffix}`;
    const instanceId = `account-a-${suffix}`;
    const optionalInstanceId = `account-b-${suffix}`;
    const declaration = fixture("source.json");
    const declarationSource = declaration.source as Record<string, unknown>;
    declarationSource.id = `https://sources.example/records/spotify/${suffix}`;
    const requestDetail = fixture("rar-request.json");
    requestDetail.source = structuredClone(declarationSource);
    const requestStreams = requestDetail.streams as Record<string, unknown>[];
    requestStreams[0] = { ...requestStreams[0], instance_ids: [instanceId] };
    requestStreams[1] = { ...requestStreams[1], instance_ids: [optionalInstanceId] };
    const connectorManifest = manifest(declaration, connectorKey);
    const registered = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(connectorManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registered.status, 201);
    await seedInstances(connectorManifest, connectorKey, [instanceId, optionalInstanceId]);
    const clientId = await registerClient(asUrl);
    const { grantId, token } = await issueToken(asUrl, clientId, requestDetail);
    let asClosed = false;
    return {
      asUrl,
      clientId,
      close: async () => {
        if (!asClosed) {
          await closeOne(server?.asServer as CloseableServer);
        }
        await closeOne(server?.rsServer as CloseableServer);
        await closePostgresStorage();
        closeDb();
        if (previousDatabaseUrl === undefined) {
          delete process.env.PDPP_DATABASE_URL;
        } else {
          process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
        }
        rmSync(tempDir, { force: true, recursive: true });
      },
      declaration,
      disableAuthorizationServer: async () => {
        if (!asClosed) {
          await closeOne(server?.asServer as CloseableServer);
          asClosed = true;
        }
      },
      grantId,
      ingest: async (record) => {
        await ingestRecord({ connector_id: connectorKey, connector_instance_id: instanceId }, record);
      },
      instanceId,
      rsUrl,
      setIntrospectionInterceptor: (next) => {
        interceptor = next;
      },
      token,
    };
  } catch (error: unknown) {
    if (server) {
      await Promise.all([closeOne(server.asServer), closeOne(server.rsServer)]);
    }
    await closePostgresStorage();
    closeDb();
    if (previousDatabaseUrl === undefined) {
      delete process.env.PDPP_DATABASE_URL;
    } else {
      process.env.PDPP_DATABASE_URL = previousDatabaseUrl;
    }
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
