// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Spec-consistency test for spec-core.md §8 "Get stream metadata" and
 * §9 Resource Server conformance items 14-15.
 *
 * Core now defines the stream-metadata endpoint response as actor-specific:
 *   - owner token: full current metadata (schema, query, views, relationships).
 *   - client token: a closed projection of the frozen grant (granted fields
 *     only, no current query/view/relationship/expansion capability), and a
 *     source-declaration change made after grant issuance MUST NOT become
 *     visible to that grant.
 *
 * This pins those three normative claims against the same RS this repo
 * ships, so a future change to either the prose or the implementation that
 * breaks the correspondence fails loudly here rather than only in a design
 * note.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

interface JsonObject {
  [key: string]: any;
}

interface CloseableServer {
  close: (callback?: (error?: Error) => void) => void;
  closeAllConnections: () => void;
}

function requireCloseableServer(value: unknown, description: string): CloseableServer {
  if (
    typeof value !== "object" ||
    value === null ||
    !("close" in value) ||
    typeof (value as { close?: unknown }).close !== "function" ||
    !("closeAllConnections" in value) ||
    typeof (value as { closeAllConnections?: unknown }).closeAllConnections !== "function"
  ) {
    throw new TypeError(`${description} must be closeable`);
  }
  return value as CloseableServer;
}

async function fetchJson(url: string, opts: RequestInit = {}): Promise<{ status: number; body: JsonObject }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: JsonObject = {};
  try {
    body = text ? (JSON.parse(text) as JsonObject) : {};
  } catch {
    body = { raw: text };
  }
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "spec_metadata_owner"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
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

async function approveGrant(asUrl: string, subjectId: string, params: JsonObject) {
  const initiate = await fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: params.source || { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(initiate.status, 201, JSON.stringify(initiate.body));

  const review = await fetchJson(`${asUrl}/consent/review`, {
    body: JSON.stringify({ request_uri: initiate.body.request_uri, subject_id: subjectId }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(review.status, 200, JSON.stringify(review.body));

  const approved = await fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      approval_review_revision: review.body.approval_review_revision,
      request_uri: initiate.body.request_uri,
    }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return approved.body;
}

async function materializeConnection({
  connectorId,
  connectorInstanceId,
  displayName,
  ownerSubjectId,
}: {
  connectorId: string;
  connectorInstanceId: string;
  displayName: string;
  ownerSubjectId: string;
}): Promise<void> {
  const now = "2026-01-01T00:00:00.000Z";
  const canonicalId = canonicalConnectorKey(connectorId);
  assert.ok(canonicalId, `connectorId "${connectorId}" must canonicalize`);
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: canonicalId,
    connectorInstanceId,
    createdAt: now,
    displayName,
    ownerSubjectId,
    sourceBinding: { kind: "test_account", label: connectorInstanceId },
    sourceBindingKey: connectorInstanceId,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

async function withHarness(fn: (handles: { asUrl: string; rsUrl: string; manifest: JsonObject }) => Promise<void>) {
  const server = await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const manifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
  try {
    const registerResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(registerResp.status, 201, "register connector");
    await fn({ asUrl, manifest, rsUrl });
  } finally {
    const asServer = requireCloseableServer(server.asServer, "authorization server");
    const rsServer = requireCloseableServer(server.rsServer, "resource server");
    asServer.closeAllConnections();
    rsServer.closeAllConnections();
    await Promise.allSettled([
      new Promise<void>((resolve, reject) => asServer.close((error) => (error ? reject(error) : resolve()))),
      new Promise<void>((resolve, reject) => rsServer.close((error) => (error ? reject(error) : resolve()))),
    ]);
  }
}

test("spec-core §8: owner-token stream metadata returns full current schema, query, and relationships", async () => {
  await withHarness(async ({ asUrl, manifest, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body, status } = await fetchJson(
      `${rsUrl}/v1/streams/top_artists?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );

    assert.equal(status, 200);
    assert.equal(body.object, "stream_metadata");
    // Full current schema: every manifest-declared field, not a grant subset.
    for (const fieldName of Object.keys(
      manifest.streams.find((s: JsonObject) => s.name === "top_artists").schema.properties
    )) {
      assert.ok(
        Object.hasOwn(body.schema.properties, fieldName),
        `owner metadata must expose current field "${fieldName}"`
      );
    }
    // Full current query capabilities, not emptied.
    assert.deepEqual(body.query.range_filters?.source_updated_at, ["gte", "gt", "lte", "lt"]);
  });
});

test("spec-core §8: client-token stream metadata is a closed projection of the frozen grant", async () => {
  await withHarness(async ({ asUrl, manifest, rsUrl }) => {
    await materializeConnection({
      connectorId: manifest.connector_id,
      connectorInstanceId: "cin_spec_metadata_spotify",
      displayName: "Spotify",
      ownerSubjectId: "spec_metadata_client_owner",
    });
    const approved = await approveGrant(asUrl, "spec_metadata_client_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "closed-projection spec consistency test",
      source: { id: manifest.connector_id, kind: "connector" },
      streams: [{ fields: ["id", "name", "source_updated_at"], name: "top_artists" }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);

    const { body, status } = await fetchJson(`${rsUrl}/v1/streams/top_artists`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.equal(body.object, "stream_metadata");
    // Granted fields remain visible.
    assert.ok(body.schema?.properties?.name, "granted field name remains visible");
    assert.ok(body.schema?.properties?.source_updated_at, "granted field source_updated_at remains visible");
    // Ungranted current field is not exposed as a usable capability.
    assert.equal(body.field_capabilities.popularity, undefined, "ungranted field must not carry a capability entry");
    // Current query capabilities (declared on the manifest, not on the grant)
    // MUST NOT be reported to a client token.
    assert.deepEqual(body.query, {}, "client projection must not carry current query capabilities");
    // No frozen relationship/expansion vocabulary is part of a v0.1 grant, so
    // none may be surfaced.
    assert.deepEqual(body.expand_capabilities, [], "client projection must not carry current expand capabilities");
  });
});

test("spec-core §8: a post-grant declaration addition never becomes visible to an already-issued client grant", async () => {
  await withHarness(async ({ asUrl, manifest, rsUrl }) => {
    await materializeConnection({
      connectorId: manifest.connector_id,
      connectorInstanceId: "cin_spec_metadata_spotify_postgrant",
      displayName: "Spotify",
      ownerSubjectId: "spec_metadata_postgrant_owner",
    });
    const approved = await approveGrant(asUrl, "spec_metadata_postgrant_owner", {
      access_mode: "continuous",
      client_id: "longview",
      purpose_code: "https://pdpp.dev/purpose/analytics",
      purpose_description: "post-grant declaration addition must stay invisible",
      source: { id: manifest.connector_id, kind: "connector" },
      streams: [{ fields: ["id", "name"], name: "top_artists" }],
    });
    assert.ok(approved.token, `expected issued grant token, got ${JSON.stringify(approved)}`);

    // Simulate a source-declaration change after the grant was issued: add a
    // new field to the manifest and re-register (a manifest upsert).
    const updatedManifest = JSON.parse(JSON.stringify(manifest));
    updatedManifest.version = "0.2.0";
    const topArtists = updatedManifest.streams.find((s: JsonObject) => s.name === "top_artists");
    topArtists.schema.properties.newly_declared_field = { type: "string" };

    const reregisterResp = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(updatedManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(reregisterResp.status, 201, "re-register connector with an added field");

    const { body, status } = await fetchJson(`${rsUrl}/v1/streams/top_artists`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });

    assert.equal(status, 200);
    assert.ok(
      !Object.hasOwn(body.schema?.properties ?? {}, "newly_declared_field"),
      "a field declared after grant issuance must not appear in the client projection"
    );
    assert.equal(
      body.field_capabilities.newly_declared_field,
      undefined,
      "a field declared after grant issuance must not carry a capability entry"
    );
  });
});
