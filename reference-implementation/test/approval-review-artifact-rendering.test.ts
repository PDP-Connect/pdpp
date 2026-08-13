// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parsePendingConsentRequestUri, registerConnector, seedPreRegisteredClients } from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_ID = "approval_artifact_rendering_client";
const INSTANCE_ID = "cin_approval_artifact_spotify";
const SOURCE_ID = "https://sources.example.test/approval-artifact/spotify";
const BATCH_DRIFT_RE = /REJECTED SOURCE PURPOSE|MUTABLE BATCH|MUTABLE CATALOG DRIFT/;
const BATCH_FINAL_FIELDS_RE = /name="approved_source_indexes"|name="narrow_streams_/;
const MUTABLE_BATCH_CLAIM_RE = /MUTABLE BATCH CLAIM/;
const CONFIRM_REVIEWED_DECISION_RE = /name="confirm_reviewed_decision"/;
const CLIENT_CLAIM_DISCLAIMER_RE = /not enforced by your server/i;
const CONCERT_RECOMMENDATIONS_RE = /Only use this for concert recommendations/;
const MUTABLE_CLAIM_DRIFT_RE = /MUTABLE CLAIM DRIFT/;
const REGEXP_SPECIAL_CHARACTERS_RE = /[.*+?^${}()|[\]\\]/g;
const SINGLE_DRIFT_RE = /MUTABLE REQUEST|MUTABLE CATALOG DRIFT|drift\.example\.test/;
const SINGLE_FROZEN_FIELDS_RE = /name="subject_id"|name="ai_training_consented"/;

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  abortStartupBackfill: (reason: string) => void;
  asPort: number;
  asServer: TestHttpServer;
  rsServer: TestHttpServer;
  schedulerManager?: { stop: () => void };
  startupBackfillDone: Promise<unknown>;
  startupRunHistoryBackfillDone: Promise<unknown>;
  startupSummaryEvidenceSweepDone: Promise<unknown>;
  stopBrowserSurfaceLeaseSweep: () => void;
  stopClientEventDeliveryWorker: () => Promise<void>;
  stopConnectorMaintenanceSweep: () => void;
}

interface ReviewStream {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string };
}

interface ReviewSource {
  access_mode: string;
  client_claims?: { commitments?: string[] } | null;
  index: number;
  purpose_description: string | null;
  resolved_streams: ReviewStream[];
  source: { id: string; kind: string };
  source_declaration: { digest: string; version: string };
}

interface ReviewArtifact {
  access_mode: string | null;
  approved_source_indexes?: number[];
  client: { client_id: string };
  client_claims?: { commitments?: string[] } | null;
  purpose_description?: string | null;
  resolved_streams?: ReviewStream[];
  source?: { id: string; kind: string };
  source_declaration?: { digest: string; version: string };
  source_narrowing?: Record<string, unknown>;
  sources?: ReviewSource[];
  subject: { id: string };
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.abortStartupBackfill("approval artifact rendering test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.stopConnectorMaintenanceSweep();
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (target: TestHttpServer) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      target.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([
    closeOne(server.asServer),
    closeOne(server.rsServer),
    server.startupBackfillDone,
    server.startupRunHistoryBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

function loadSpotifyManifest(): Record<string, unknown> & { connector_id: string } {
  return JSON.parse(readFileSync(join(__dirname, "../manifests/spotify.json"), "utf8"));
}

function sourceManifest() {
  const manifest = loadSpotifyManifest();
  const topArtists = (manifest.streams as Record<string, unknown>[]).find((stream) => stream.name === "top_artists");
  assert.ok(topArtists);
  const {
    coverage_strategy: _coverageStrategy,
    freshness_strategy: _freshnessStrategy,
    incremental: _incremental,
    ...declarationStream
  } = topArtists;
  return {
    ...manifest,
    source_declaration: {
      declaration_version: "approval-artifact-declaration-v1",
      display: { name: "Approval artifact Spotify" },
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example.test/approval-artifact" },
      source: { id: SOURCE_ID, kind: "connector" },
      streams: [declarationStream],
    },
  };
}

async function setup(): Promise<{ asUrl: string; server: TestServerHandle }> {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServerHandle;
  const asUrl = `http://localhost:${server.asPort}`;
  const manifest = loadSpotifyManifest();
  const registered = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(registered.status, 201, await registered.text());
  await registerConnector(sourceManifest());
  await seedPreRegisteredClients([
    {
      client_id: CLIENT_ID,
      client_name: "Frozen approval client",
      client_uri: "https://client.example.test/frozen",
      registration_mode: "pre_registered_public",
    },
  ]);
  const connectorId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
  const now = new Date().toISOString();
  await createSqliteConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: INSTANCE_ID,
    createdAt: now,
    displayName: "Frozen approval account",
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: INSTANCE_ID },
    sourceBindingKey: INSTANCE_ID,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  return { asUrl, server };
}

async function stage(asUrl: string, details: Record<string, unknown>[]): Promise<string> {
  const response = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({ authorization_details: details, client_id: CLIENT_ID }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const body = JSON.parse(text) as { request_uri?: string };
  assert.ok(body.request_uri);
  return body.request_uri;
}

function selection(purposeDescription: string, claims?: { commitments: string[] }): Record<string, unknown> {
  return {
    access_mode: "continuous",
    ...(claims ? { client_claims: claims } : {}),
    purpose_code: "https://pdpp.dev/purpose/personalization",
    purpose_description: purposeDescription,
    retention: { max_duration: "P30D", on_expiry: "delete" },
    source: { id: SOURCE_ID, kind: "connector" },
    streams: [
      {
        fields: ["id", "name", "genres"],
        instance_ids: [INSTANCE_ID],
        name: "top_artists",
        resources: ["artist-frozen-42"],
        time_range: { since: "2026-01-01T00:00:00Z", until: "2026-07-01T00:00:00Z" },
      },
    ],
    type: "https://pdpp.dev/data-access",
  };
}

async function finalizeJsonReview(
  asUrl: string,
  requestUri: string,
  body: Record<string, unknown> = {}
): Promise<{ artifact: ReviewArtifact; revision: string }> {
  const response = await fetch(`${asUrl}/consent/review`, {
    body: JSON.stringify({ ...body, request_uri: requestUri, subject_id: "owner_local" }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const parsed = JSON.parse(text) as { approval_review: ReviewArtifact; approval_review_revision: string };
  assert.equal(typeof parsed.approval_review_revision, "string");
  return { artifact: parsed.approval_review, revision: parsed.approval_review_revision };
}

async function approveJson(asUrl: string, requestUri: string, revision: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ approval_review_revision: revision, request_uri: requestUri }),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text) as Record<string, unknown>;
}

function grantRights(grant: Record<string, unknown>): Record<string, unknown> {
  return {
    access_mode: grant.access_mode,
    client: grant.client,
    purpose_code: grant.purpose_code,
    purpose_description: grant.purpose_description,
    retention: grant.retention,
    source: grant.source,
    source_declaration: grant.source_declaration,
    streams: grant.streams,
    subject: grant.subject,
    version: grant.version,
  };
}

function mutateStagedRequest(deviceCode: string, mutate: (request: Record<string, unknown>) => void): void {
  const row = getDb()
    .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
    .get<{ params_json: string }>(deviceCode);
  assert.ok(row);
  const request = JSON.parse(row.params_json) as Record<string, unknown>;
  mutate(request);
  getDb()
    .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
    .run(JSON.stringify(request), deviceCode);
  getDb().prepare("UPDATE connectors SET manifest = replace(manifest, 'Spotify', 'MUTABLE CATALOG DRIFT')").run();
}

test.afterEach(() => {
  closeDb();
});

test("resumed single HTML renders the same validated artifact as JSON despite request and catalog drift", async () => {
  const { asUrl, server } = await setup();
  try {
    const requestUri = await stage(asUrl, [selection("FROZEN SINGLE PURPOSE")]);
    const { artifact } = await finalizeJsonReview(asUrl, requestUri);
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    assert.ok(deviceCode);
    const [stream] = artifact.resolved_streams ?? [];
    assert.ok(stream);
    assert.ok(artifact.source);
    assert.ok(artifact.source_declaration);

    mutateStagedRequest(deviceCode, (request) => {
      request.client = { client_id: "MUTABLE REQUEST CLIENT", registration_mode: "pre_registered_public" };
      const requestSelection = request.selection as Record<string, unknown>;
      requestSelection.purpose_description = "MUTABLE REQUEST PURPOSE";
      request.source_binding = { id: "https://drift.example.test/source", kind: "provider_native" };
    });

    const resumed = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
    const html = await resumed.text();
    assert.equal(resumed.status, 200, html);
    for (const fact of [
      artifact.client.client_id,
      artifact.subject.id,
      artifact.source.id,
      artifact.source.kind,
      artifact.source_declaration.version,
      artifact.source_declaration.digest,
      artifact.purpose_description,
      stream.name,
      ...stream.instance_ids,
      ...stream.fields,
      ...(stream.resources ?? []),
      stream.time_constraint?.field,
      stream.time_constraint?.since,
      stream.time_constraint?.until,
    ]) {
      assert.match(html, new RegExp(String(fact).replace(REGEXP_SPECIAL_CHARACTERS_RE, "\\$&")));
    }
    assert.doesNotMatch(html, SINGLE_DRIFT_RE);
    assert.doesNotMatch(html, SINGLE_FROZEN_FIELDS_RE);
  } finally {
    await closeServer(server);
  }
});

test("resumed batch HTML renders only approved frozen sources, order, and narrowing", async () => {
  const { asUrl, server } = await setup();
  try {
    const batchClaims = { commitments: ["Only use this approved source for batch recommendations"] };
    const requestUri = await stage(asUrl, [
      selection("REJECTED SOURCE PURPOSE"),
      selection("FROZEN BATCH PURPOSE", batchClaims),
    ]);
    const { artifact } = await finalizeJsonReview(asUrl, requestUri, {
      approved_source_indexes: [1],
      source_narrowing: {
        1: {
          fields: { top_artists: ["id", "name"] },
          since: { top_artists: "2026-02-01T00:00:00Z" },
          streams: ["top_artists"],
        },
      },
    });
    assert.deepEqual(artifact.approved_source_indexes, [1]);
    assert.equal(artifact.sources?.length, 1);
    const source = artifact.sources?.[0];
    assert.ok(source);
    assert.deepEqual(source.client_claims, batchClaims);
    const [stream] = source.resolved_streams;
    assert.ok(stream);
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    assert.ok(deviceCode);

    mutateStagedRequest(deviceCode, (request) => {
      request.client = { client_id: "MUTABLE BATCH CLIENT", registration_mode: "pre_registered_public" };
      const entries = request.entries as Record<string, unknown>[];
      (entries[1]?.selection as Record<string, unknown>).purpose_description = "MUTABLE BATCH PURPOSE";
      (entries[1]?.selection as Record<string, unknown>).client_claims = { commitments: ["MUTABLE BATCH CLAIM"] };
    });

    const resumed = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
    const html = await resumed.text();
    assert.equal(resumed.status, 200, html);
    for (const fact of [
      artifact.client.client_id,
      artifact.subject.id,
      source.purpose_description,
      source.source.id,
      source.source_declaration.version,
      source.source_declaration.digest,
      stream.name,
      ...stream.instance_ids,
      ...stream.fields,
      ...(stream.resources ?? []),
      "2026-02-01T00:00:00Z",
      "Staged source index",
      "Approval order",
      batchClaims.commitments[0],
    ]) {
      assert.match(html, new RegExp(String(fact).replace(REGEXP_SPECIAL_CHARACTERS_RE, "\\$&")));
    }
    assert.doesNotMatch(html, BATCH_DRIFT_RE);
    assert.doesNotMatch(html, MUTABLE_BATCH_CLAIM_RE);
    assert.doesNotMatch(html, BATCH_FINAL_FIELDS_RE);
    assert.match(html, CONFIRM_REVIEWED_DECISION_RE);
    assert.match(html, CLIENT_CLAIM_DISCLAIMER_RE);
  } finally {
    await closeServer(server);
  }
});

test("resumed GET fails closed when the persisted artifact or digest is corrupt", async () => {
  const { asUrl, server } = await setup();
  try {
    const requestUri = await stage(asUrl, [selection("FROZEN CORRUPTION PURPOSE")]);
    await finalizeJsonReview(asUrl, requestUri);
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    assert.ok(deviceCode);
    getDb()
      .prepare("UPDATE pending_consents SET approval_review_digest = ? WHERE device_code = ?")
      .run("sha256:corrupt", deviceCode);
    const digestMismatch = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(digestMismatch.status, 400, await digestMismatch.text());

    getDb()
      .prepare("UPDATE pending_consents SET approval_review_json = ? WHERE device_code = ?")
      .run("{not-json", deviceCode);
    const malformed = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`, {
      headers: { Accept: "application/json" },
    });
    assert.equal(malformed.status, 400, await malformed.text());
  } finally {
    await closeServer(server);
  }
});

test("client claims are frozen in final review evidence without becoming grant rights", async () => {
  const { asUrl, server } = await setup();
  try {
    const firstClaims = { commitments: ["Only use this for concert recommendations"] };
    const secondClaims = { commitments: ["Only use this for playlist cleanup"] };
    const firstRequestUri = await stage(asUrl, [selection("FROZEN CLAIM PURPOSE", firstClaims)]);
    const secondRequestUri = await stage(asUrl, [selection("FROZEN CLAIM PURPOSE", secondClaims)]);

    const firstReview = await finalizeJsonReview(asUrl, firstRequestUri);
    const secondReview = await finalizeJsonReview(asUrl, secondRequestUri);
    assert.notEqual(firstReview.revision, secondReview.revision, "client_claims must affect the review digest");
    assert.deepEqual(firstReview.artifact.client_claims, firstClaims);
    assert.deepEqual(secondReview.artifact.client_claims, secondClaims);

    const firstDeviceCode = parsePendingConsentRequestUri(firstRequestUri);
    assert.ok(firstDeviceCode);
    mutateStagedRequest(firstDeviceCode, (request) => {
      const requestSelection = request.selection as Record<string, unknown>;
      requestSelection.client_claims = { commitments: ["MUTABLE CLAIM DRIFT"] };
    });
    const resumed = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(firstRequestUri)}`);
    const html = await resumed.text();
    assert.equal(resumed.status, 200, html);
    assert.match(html, CONCERT_RECOMMENDATIONS_RE);
    assert.match(html, CLIENT_CLAIM_DISCLAIMER_RE);
    assert.doesNotMatch(html, MUTABLE_CLAIM_DRIFT_RE);

    const staleApprove = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ approval_review_revision: firstReview.revision, request_uri: firstRequestUri }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(staleApprove.status, 400, await staleApprove.text());

    const thirdRequestUri = await stage(asUrl, [selection("FROZEN CLAIM PURPOSE", firstClaims)]);
    const thirdReview = await finalizeJsonReview(asUrl, thirdRequestUri);
    const firstApproved = await approveJson(asUrl, thirdRequestUri, thirdReview.revision);
    const secondApproved = await approveJson(asUrl, secondRequestUri, secondReview.revision);
    const firstGrant = firstApproved.grant as Record<string, unknown>;
    const secondGrant = secondApproved.grant as Record<string, unknown>;
    assert.ok(firstGrant);
    assert.ok(secondGrant);
    assert.equal(firstGrant.client_claims, undefined);
    assert.equal(secondGrant.client_claims, undefined);
    assert.deepEqual(grantRights(firstGrant), grantRights(secondGrant));
  } finally {
    await closeServer(server);
  }
});
