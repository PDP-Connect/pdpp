// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { startServer } from "../server/index.ts";
// biome-ignore lint/performance/noNamespaceImport: test drives the admission-race seam on the production route.
import * as recordsModule from "../server/records.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const NOW = "2026-05-18T12:00:00.000Z";

interface ErrorBody {
  error: { code: string; message?: string };
}

interface StateBody {
  connector_instance_id?: string;
  state: { top_artists: { cursor: string } };
}

interface IngestBody {
  connector_instance_id?: string;
  errors?: readonly string[];
  records_accepted: number;
  records_rejected?: number;
}

interface StreamRecordBody {
  connection_id: string;
  connector_instance_id: string;
  data: { name: string };
}

interface BlobUploadBody {
  blob_id: string;
  object: string;
}

interface RefConnectionSummary {
  connector_instance_id: string;
  display_name: string;
  schedule: { enabled: boolean };
}

interface RefConnectionListBody {
  data: RefConnectionSummary[];
  object: string;
}

interface RefConnectionDetailBody {
  connector_id: string;
  connector_instance_id: string;
  display_name: string;
  object: string;
}

interface RefScheduleBody {
  connector_id?: string;
  connector_instance_id: string;
  enabled: boolean;
}

// `startServer`'s inferred asServer/rsServer type comes from a framework
// `.listen()` call whose TS overload resolves to an http2-shaped type, but at
// runtime these are plain node:http/https servers (the framework never
// negotiates ALPN in this reference stack) — so `closeAllConnections` (added
// Node 18.2+) and the single-error-arg `close` callback genuinely exist and
// are safe to declare here. Established pattern, see
// connector-failure-diagnostics-control-plane.test.ts.
type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(() => resolve())),
    new Promise<void>((resolve) => server.rsServer.close(() => resolve())),
  ]);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  opts: RequestInit = {}
): Promise<{ status: number; body: T | null }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: T | string | null = null;
  try {
    body = text ? (JSON.parse(text) as T) : null;
  } catch {
    body = text;
  }
  return { body: body as T | null, status: resp.status };
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<{ device_code: string; user_code: string }>(
    `${asUrl}/oauth/device_authorization`,
    {
      body: new URLSearchParams({ client_id: clientId }).toString(),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      method: "POST",
    }
  );
  assert.ok(device, "device_authorization should return a body");
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<{ access_token: string }>(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.ok(tokenBody?.access_token, "device exchange should issue an owner token");
  return tokenBody.access_token;
}

async function registerSpotify(asUrl: string): Promise<{ connector_id: string }> {
  const manifest: { connector_id: string } = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8")
  );
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(resp.status, 201);
  return manifest;
}

async function seedTwoSpotifyInstances(connectorId: string): Promise<void> {
  const store = createSqliteConnectorInstanceStore();
  // connector_instances.connector_id references connectors(connector_id),
  // which registerConnector stores under the canonical key (the manifest's
  // URL-shaped connector_id is canonicalized to `spotify`). Seed instances
  // under that same canonical key so the FK resolves and the route's
  // canonical admission lookup finds them. See canonicalize-connector-keys
  // Decision 1: connector instances bind to canonical keys only.
  const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
  await store.upsert({
    connectorId: canonicalId,
    connectorInstanceId: "cin_spotify_personal",
    createdAt: NOW,
    displayName: "Spotify - personal",
    ownerSubjectId: "owner_local",
    sourceBinding: { account_hint: "personal" },
    sourceBindingKey: "acct_personal",
    sourceKind: "account",
    updatedAt: NOW,
  });
  await store.upsert({
    connectorId: canonicalId,
    connectorInstanceId: "cin_spotify_work",
    createdAt: NOW,
    displayName: "Spotify - work",
    ownerSubjectId: "owner_local",
    sourceBinding: { account_hint: "work" },
    sourceBindingKey: "acct_work",
    sourceKind: "account",
    updatedAt: NOW,
  });
}

async function seedDraftSpotifyInstance(
  connectorId: string
): Promise<ReturnType<typeof createSqliteConnectorInstanceStore>> {
  const store = createSqliteConnectorInstanceStore();
  const canonicalId = canonicalConnectorKey(connectorId) ?? connectorId;
  await store.upsert({
    connectorId: canonicalId,
    connectorInstanceId: "cin_spotify_draft",
    createdAt: NOW,
    displayName: "Spotify - draft",
    ownerSubjectId: "owner_local",
    sourceBinding: { kind: "manual_upload_draft" },
    sourceBindingKey: "draft_upload",
    sourceKind: "manual",
    status: "draft",
    updatedAt: NOW,
  });
  return store;
}

test("owner-auth state route rejects ambiguous connector-only admission", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);

    const resp = await fetchJson<ErrorBody>(`${rsUrl}/v1/state/${encodeURIComponent(connectorId)}`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });

    assert.equal(resp.status, 400);
    assert.ok(resp.body, "expected an error body");
    assert.equal(resp.body.error.code, "ambiguous_connector_instance");
  } finally {
    await closeServer(server);
  }
});

test("owner-auth state route admits explicit draft instance for first-run checkpointing", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    const store = await seedDraftSpotifyInstance(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);
    const draftUrl = `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_draft`;

    const put = await fetchJson<StateBody>(draftUrl, {
      body: JSON.stringify({ state: { top_artists: { cursor: "draft-checkpoint" } } }),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    assert.equal(put.status, 200);
    assert.ok(put.body, "expected a state body");
    assert.deepEqual(put.body.state.top_artists, { cursor: "draft-checkpoint" });

    const get = await fetchJson<StateBody>(draftUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(get.status, 200);
    assert.ok(get.body, "expected a state body");
    assert.deepEqual(get.body.state.top_artists, { cursor: "draft-checkpoint" });
    const draftInstance = await store.get("cin_spotify_draft");
    assert.ok(draftInstance, "expected the draft instance to exist");
    assert.equal(draftInstance.status, "draft");
  } finally {
    await closeServer(server);
  }
});

test("owner-auth state route uses explicit connector_instance_id for migrated sync state", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const draftStore = await seedDraftSpotifyInstance(connectorId);
    const seededDraftInstance = await draftStore.get("cin_spotify_draft");
    assert.ok(seededDraftInstance, "expected the draft instance to exist");
    assert.equal(seededDraftInstance.status, "draft");
    const ownerToken = await issueOwnerToken(asUrl);

    const workUrl = `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_work`;
    const personalUrl = `${rsUrl}/v1/state/${encodeURIComponent(connectorId)}?connector_instance_id=cin_spotify_personal`;

    const workPut = await fetchJson<StateBody>(workUrl, {
      body: JSON.stringify({ state: { top_artists: { cursor: "work" } } }),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    assert.equal(workPut.status, 200);
    assert.ok(workPut.body, "expected a state body");
    assert.equal(workPut.body.connector_instance_id, undefined);
    assert.deepEqual(workPut.body.state.top_artists, { cursor: "work" });

    const personalPut = await fetchJson<StateBody>(personalUrl, {
      body: JSON.stringify({ state: { top_artists: { cursor: "personal" } } }),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    assert.equal(personalPut.status, 200);
    assert.ok(personalPut.body, "expected a state body");
    assert.equal(personalPut.body.connector_instance_id, undefined);
    assert.deepEqual(personalPut.body.state.top_artists, { cursor: "personal" });

    const workGet = await fetchJson<StateBody>(workUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(workGet.status, 200);
    assert.ok(workGet.body, "expected a state body");
    assert.equal(workGet.body.connector_instance_id, undefined);
    assert.deepEqual(workGet.body.state.top_artists, { cursor: "work" });

    const personalGet = await fetchJson<StateBody>(personalUrl, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(personalGet.status, 200);
    assert.ok(personalGet.body, "expected a state body");
    assert.equal(personalGet.body.connector_instance_id, undefined);
    assert.deepEqual(personalGet.body.state.top_artists, { cursor: "personal" });
  } finally {
    await closeServer(server);
  }
});

test("owner-auth ingest route stores same record key under explicit connector instances", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const ownerToken = await issueOwnerToken(asUrl);

    const ambiguousIngest = await fetchJson<ErrorBody>(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}`,
      {
        body: `${JSON.stringify({ data: { id: "artist_1", name: "ambiguous" }, key: "artist_1" })}\n`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    assert.equal(ambiguousIngest.status, 400);
    assert.ok(ambiguousIngest.body, "expected an error body");
    assert.equal(ambiguousIngest.body.error.code, "ambiguous_connector_instance");

    for (const [connectorInstanceId, name] of [
      ["cin_spotify_personal", "personal artist"],
      ["cin_spotify_work", "work artist"],
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered test setup is intentionally sequential
      const ingestResp = await fetchJson<IngestBody>(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${connectorInstanceId}`,
        {
          body: `${JSON.stringify({ data: { id: "artist_1", name }, key: "artist_1" })}\n`,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );
      assert.equal(ingestResp.status, 200);
      assert.ok(ingestResp.body, "expected an ingest body");
      assert.equal(ingestResp.body.records_accepted, 1);
      assert.equal(ingestResp.body.connector_instance_id, undefined);
    }

    const personalRecord = await fetchJson<StreamRecordBody>(
      `${rsUrl}/v1/streams/top_artists/records/artist_1?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_personal`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(personalRecord.status, 200);
    assert.ok(personalRecord.body, "expected a stream record body");
    // Public read contract (expose-connection-identity-on-public-read):
    // records carry canonical `connection_id` and the deprecated alias
    // `connector_instance_id` mirrored to the same value during the
    // migration window. The previous baseline asserted these were absent;
    // that pre-dated the canonicalization tranche.
    assert.equal(personalRecord.body.connection_id, "cin_spotify_personal");
    assert.equal(personalRecord.body.connector_instance_id, "cin_spotify_personal");
    assert.equal(personalRecord.body.data.name, "personal artist");

    const workRecord = await fetchJson<StreamRecordBody>(
      `${rsUrl}/v1/streams/top_artists/records/artist_1?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(workRecord.status, 200);
    assert.ok(workRecord.body, "expected a stream record body");
    assert.equal(workRecord.body.connection_id, "cin_spotify_work");
    assert.equal(workRecord.body.connector_instance_id, "cin_spotify_work");
    assert.equal(workRecord.body.data.name, "work artist");
  } finally {
    await closeServer(server);
  }
});

test("owner-auth ingest fails systemically when a post-resolution revoke prevents a durable rejection receipt", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  let releaseWriter: (() => void) | undefined;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const store = createSqliteConnectorInstanceStore();
    const ownerToken = await issueOwnerToken(asUrl);
    const connectorInstanceId = "cin_spotify_personal";
    let resolveAdmissionPreCheck: (() => void) | undefined;
    const admissionPreCheckReached = new Promise<void>((resolve) => {
      resolveAdmissionPreCheck = resolve;
    });
    recordsModule.__setAdmissionPreCheckPhaseHookForTest(async (point: string, context: Record<string, unknown>) => {
      if (point !== "after-admission-pre-check" || context.connectorInstanceId !== connectorInstanceId) {
        return;
      }
      resolveAdmissionPreCheck?.();
      await new Promise<void>((resume) => {
        releaseWriter = resume;
      });
    });

    const ingest = fetchJson<ErrorBody>(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=${connectorInstanceId}`,
      {
        body: `${JSON.stringify({ data: { id: "artist_revoked_race", name: "revoked race" }, key: "artist_revoked_race" })}\n`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        admissionPreCheckReached,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("owner route did not opt into connection admission")), 1000);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    await store.updateStatus(connectorInstanceId, { revokedAt: NOW, status: "revoked", updatedAt: NOW });
    assert.ok(releaseWriter, "the owner route must reach its transaction-native admission check");
    releaseWriter();

    const response = await ingest;
    assert.equal(response.status, 503);
    assert.ok(response.body, "expected the fail-closed systemic error");
    assert.equal(response.body.error.code, "ingest_batch_storage_error");
    assert.equal(response.body.error.message, "Ingest failed due to a transient storage error; retry later.");
  } finally {
    releaseWriter?.();
    recordsModule.__setAdmissionPreCheckPhaseHookForTest(null);
    await closeServer(server);
  }
});

test("owner-auth ingest admits explicit paused instances and still rejects revoked instances", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const store = createSqliteConnectorInstanceStore();
    const ownerToken = await issueOwnerToken(asUrl);

    await store.updateStatus("cin_spotify_personal", { status: "paused", updatedAt: NOW });
    const pausedIngest = await fetchJson<IngestBody>(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_personal`,
      {
        body: `${JSON.stringify({ data: { id: "artist_paused", name: "paused artist" }, key: "artist_paused" })}\n`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    assert.equal(pausedIngest.status, 200);
    assert.ok(pausedIngest.body, "expected an ingest body");
    assert.equal(pausedIngest.body.records_accepted, 1);
    assert.equal(pausedIngest.body.records_rejected, 0);

    await store.updateStatus("cin_spotify_work", { revokedAt: NOW, status: "revoked", updatedAt: NOW });
    const revokedIngest = await fetchJson<ErrorBody>(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      {
        body: `${JSON.stringify({ data: { id: "artist_revoked", name: "revoked artist" }, key: "artist_revoked" })}\n`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    assert.equal(revokedIngest.status, 400);
    assert.ok(revokedIngest.body, "expected an error body");
    assert.equal(revokedIngest.body.error.code, "connector_instance_inactive");
  } finally {
    await closeServer(server);
  }
});

test("owner-auth blob upload and read route through explicit connector instance bindings", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);
    const draftStore = await seedDraftSpotifyInstance(connectorId);
    const seededDraftInstance = await draftStore.get("cin_spotify_draft");
    assert.ok(seededDraftInstance, "expected the draft instance to exist");
    assert.equal(seededDraftInstance.status, "draft");
    const ownerToken = await issueOwnerToken(asUrl);

    const ambiguousUpload = await fetchJson<ErrorBody>(
      `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}&stream=top_artists&record_key=artist_blob`,
      {
        body: "ambiguous blob",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "text/plain",
        },
        method: "POST",
      }
    );
    assert.equal(ambiguousUpload.status, 400);
    assert.ok(ambiguousUpload.body, "expected an error body");
    assert.equal(ambiguousUpload.body.error.code, "ambiguous_connector_instance");

    const uploadResp = await fetchJson<BlobUploadBody>(
      `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work&stream=top_artists&record_key=artist_blob`,
      {
        body: "work blob",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "text/plain",
        },
        method: "POST",
      }
    );
    assert.equal(uploadResp.status, 200);
    assert.ok(uploadResp.body, "expected a blob upload body");
    assert.equal(uploadResp.body.object, "blob");

    const ingestResp = await fetchJson(
      `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      {
        body: `${JSON.stringify({
          data: {
            blob_ref: { blob_id: uploadResp.body.blob_id },
            id: "artist_blob",
            name: "work blob artist",
          },
          key: "artist_blob",
        })}\n`,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    assert.equal(ingestResp.status, 200);

    const workRead = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadResp.body.blob_id)}?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_work`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(workRead.status, 200);
    assert.equal(await workRead.text(), "work blob");

    const personalRead = await fetchJson<ErrorBody>(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadResp.body.blob_id)}?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_personal`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(personalRead.status, 404);
    assert.ok(personalRead.body, "expected an error body");
    assert.equal(personalRead.body.error.code, "blob_not_found");
    const draftInstanceBeforeUpload = await draftStore.get("cin_spotify_draft");
    assert.ok(draftInstanceBeforeUpload, "expected the draft instance to exist");
    assert.equal(draftInstanceBeforeUpload.status, "draft");

    const draftUploadResp = await fetchJson<BlobUploadBody>(
      `${rsUrl}/v1/blobs?connector_id=${encodeURIComponent(connectorId)}&connector_instance_id=cin_spotify_draft&stream=top_artists&record_key=draft_blob`,
      {
        body: "draft blob",
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "text/plain",
        },
        method: "POST",
      }
    );
    assert.equal(draftUploadResp.status, 200, JSON.stringify(draftUploadResp.body));
    assert.ok(draftUploadResp.body, "expected a blob upload body");
    assert.equal(draftUploadResp.body.object, "blob");
    const draftInstanceAfterUpload = await draftStore.get("cin_spotify_draft");
    assert.ok(draftInstanceAfterUpload, "expected the draft instance to exist");
    assert.equal(draftInstanceAfterUpload.status, "draft");
  } finally {
    await closeServer(server);
  }
});

test("reference run and schedule actions reject ambiguous connector-only admission", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    await seedTwoSpotifyInstances(connectorId);

    const scheduleReadResp = await fetchJson<ErrorBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`
    );
    assert.equal(scheduleReadResp.status, 400);
    assert.ok(scheduleReadResp.body, "expected an error body");
    assert.equal(scheduleReadResp.body.error.code, "ambiguous_connector_instance");

    const runResp = await fetchJson<ErrorBody>(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/run`, {
      method: "POST",
    });
    assert.equal(runResp.status, 400);
    assert.ok(runResp.body, "expected an error body");
    assert.equal(runResp.body.error.code, "ambiguous_connector_instance");

    const scheduleResp = await fetchJson<ErrorBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
      {
        body: JSON.stringify({ interval_seconds: 3600 }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }
    );
    assert.equal(scheduleResp.status, 400);
    assert.ok(scheduleResp.body, "expected an error body");
    assert.equal(scheduleResp.body.error.code, "ambiguous_connector_instance");

    const pauseResp = await fetchJson<ErrorBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/pause`,
      {
        method: "POST",
      }
    );
    assert.equal(pauseResp.status, 400);
    assert.ok(pauseResp.body, "expected an error body");
    assert.equal(pauseResp.body.error.code, "ambiguous_connector_instance");

    const resumeResp = await fetchJson<ErrorBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule/resume`,
      {
        method: "POST",
      }
    );
    assert.equal(resumeResp.status, 400);
    assert.ok(resumeResp.body, "expected an error body");
    assert.equal(resumeResp.body.error.code, "ambiguous_connector_instance");

    const deleteResp = await fetchJson<ErrorBody>(
      `${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`,
      {
        method: "DELETE",
      }
    );
    assert.equal(deleteResp.status, 400);
    assert.ok(deleteResp.body, "expected an error body");
    assert.equal(deleteResp.body.error.code, "ambiguous_connector_instance");
  } finally {
    await closeServer(server);
  }
});

test("reference connections list and detail expose owner-facing instance labels", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    // The wire exposes the canonical operational key, not the manifest's
    // URL-shaped connector_id (canonicalize-connector-keys Decision 1).
    const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    await seedTwoSpotifyInstances(connectorId);

    const listResp = await fetchJson<RefConnectionListBody>(
      `${asUrl}/_ref/connections?connector_id=${encodeURIComponent(connectorId)}`
    );
    assert.equal(listResp.status, 200);
    assert.ok(listResp.body, "expected a connections list body");
    assert.equal(listResp.body.object, "list");
    assert.deepEqual(
      listResp.body.data.map((connection) => [connection.connector_instance_id, connection.display_name]),
      [
        ["cin_spotify_personal", "Spotify - personal"],
        ["cin_spotify_work", "Spotify - work"],
      ]
    );

    const detailResp = await fetchJson<RefConnectionDetailBody>(`${asUrl}/_ref/connections/cin_spotify_work`);
    assert.equal(detailResp.status, 200);
    assert.ok(detailResp.body, "expected a connection detail body");
    assert.equal(detailResp.body.object, "ref_connection");
    assert.equal(detailResp.body.connector_id, canonicalConnectorId);
    assert.equal(detailResp.body.connector_instance_id, "cin_spotify_work");
    assert.equal(detailResp.body.display_name, "Spotify - work");
  } finally {
    await closeServer(server);
  }
});

test("reference connection schedule actions target one connector instance", async () => {
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServer;
  try {
    const asUrl = `http://localhost:${server.asPort}`;
    const manifest = await registerSpotify(asUrl);
    const connectorId = manifest.connector_id;
    const canonicalConnectorId = canonicalConnectorKey(connectorId) ?? connectorId;
    await seedTwoSpotifyInstances(connectorId);

    const personalPut = await fetchJson<RefScheduleBody>(`${asUrl}/_ref/connections/cin_spotify_personal/schedule`, {
      body: JSON.stringify({ enabled: true, interval_seconds: 3600 }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    assert.equal(personalPut.status, 200);
    assert.ok(personalPut.body, "expected a schedule body");
    assert.equal(personalPut.body.connector_id, canonicalConnectorId);
    assert.equal(personalPut.body.connector_instance_id, "cin_spotify_personal");
    assert.equal(personalPut.body.enabled, true);

    const workPut = await fetchJson<RefScheduleBody>(`${asUrl}/_ref/connections/cin_spotify_work/schedule`, {
      body: JSON.stringify({ enabled: true, interval_seconds: 7200 }),
      headers: { "Content-Type": "application/json" },
      method: "PUT",
    });
    assert.equal(workPut.status, 200);
    assert.ok(workPut.body, "expected a schedule body");
    assert.equal(workPut.body.connector_instance_id, "cin_spotify_work");

    const pauseResp = await fetchJson<RefScheduleBody>(`${asUrl}/_ref/connections/cin_spotify_work/schedule/pause`, {
      method: "POST",
    });
    assert.equal(pauseResp.status, 200);
    assert.ok(pauseResp.body, "expected a schedule body");
    assert.equal(pauseResp.body.connector_instance_id, "cin_spotify_work");
    assert.equal(pauseResp.body.enabled, false);

    const listResp = await fetchJson<RefConnectionListBody>(
      `${asUrl}/_ref/connections?connector_id=${encodeURIComponent(connectorId)}`
    );
    assert.equal(listResp.status, 200);
    assert.ok(listResp.body, "expected a connections list body");
    const schedules = new Map(
      listResp.body.data.map((connection) => [connection.connector_instance_id, connection.schedule])
    );
    const personalSchedule = schedules.get("cin_spotify_personal");
    const workSchedule = schedules.get("cin_spotify_work");
    assert.ok(personalSchedule, "expected a personal connection schedule");
    assert.ok(workSchedule, "expected a work connection schedule");
    assert.equal(personalSchedule.enabled, true);
    assert.equal(workSchedule.enabled, false);
  } finally {
    await closeServer(server);
  }
});
