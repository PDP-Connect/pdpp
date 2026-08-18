// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/performance/useTopLevelRegex: This focused test keeps assertion regexes local to each oracle.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateResponse } from "@pdpp/reference-contract";

import {
  approveGrant,
  getPendingConsent,
  initiateGrant,
  parsePendingConsentRequestUri,
  registerConnector,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createRequestConnectorInstanceStore } from "../server/request-store-factories.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const CLIENT_ID = "approval_review_fixture_client";
const INSTANCE_ID = "cin_approval_review_spotify";
const SOURCE_ID = "https://sources.example.test/approval-review/spotify";
const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

type Backend = "sqlite" | "postgres";

interface PendingReviewView {
  request?: { source_binding?: unknown };
}

interface TestHttpServer {
  close: (callback: () => void) => void;
  closeAllConnections?: () => void;
}

interface TestServerHandle {
  asPort: number;
  asServer: TestHttpServer;
  rsServer: TestHttpServer;
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const closeOne = (srv: TestHttpServer) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      srv.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

function loadSpotifyManifest(): Record<string, unknown> & { connector_id: string } {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "fixtures/seed-manifests/spotify.json"), "utf8"));
}

async function setup(backend: Backend = "sqlite", databaseUrl = POSTGRES_URL) {
  process.env.PDPP_TEST_CURRENT_BACKEND = backend;
  if (backend === "postgres") {
    if (!databaseUrl) {
      throw new Error("PDPP_TEST_POSTGRES_URL is required for postgres approval seam setup");
    }
    await initPostgresStorage({ backend: "postgres", databaseUrl });
  } else {
    initDb(":memory:");
  }
  const manifest = loadSpotifyManifest();
  await registerConnector(manifest);
  await seedPreRegisteredClients([
    {
      client_id: CLIENT_ID,
      client_name: "Approval Review Fixture",
      registration_mode: "pre_registered_public",
    },
  ]);
  const now = new Date().toISOString();
  const connectorId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
  await createRequestConnectorInstanceStore().upsert({
    connectorId,
    connectorInstanceId: INSTANCE_ID,
    createdAt: now,
    displayName: "Approval review Spotify",
    ownerSubjectId: "owner_local",
    sourceBinding: { fixture: INSTANCE_ID },
    sourceBindingKey: INSTANCE_ID,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
  return manifest;
}

async function countRows(tableName: string): Promise<number> {
  if (process.env.PDPP_TEST_CURRENT_BACKEND === "postgres") {
    const result = await postgresQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM ${tableName}`);
    return Number(result.rows[0]?.n ?? 0);
  }
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM ${tableName}`).get() as { n: number }).n;
}

async function pendingStatus(deviceCode: string): Promise<{ review: string | null; status: string } | null> {
  if (process.env.PDPP_TEST_CURRENT_BACKEND === "postgres") {
    const result = await postgresQuery<{ approval_review_revision: string | null; status: string }>(
      "SELECT status, approval_review_revision FROM pending_consents WHERE device_code = $1",
      [deviceCode]
    );
    const [row] = result.rows;
    return row ? { review: row.approval_review_revision, status: row.status } : null;
  }
  const row = getDb()
    .prepare("SELECT status, approval_review_revision FROM pending_consents WHERE device_code = ?")
    .get<{ approval_review_revision: string | null; status: string }>(deviceCode);
  return row ? { review: row.approval_review_revision, status: row.status } : null;
}

function nativeManifest() {
  const manifest = loadSpotifyManifest();
  return {
    ...manifest,
    source_declaration: {
      declaration_version: "approval-review-test-v1",
      display: { name: "Spotify" },
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example.test/reference" },
      source: { id: SOURCE_ID, kind: "connector" },
      streams: [
        {
          name: "top_artists",
          primary_key: ["id"],
          schema: { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" },
          selection: { fields: true, resources: false },
          semantics: "mutable_state",
          views: [{ fields: ["id", "name"], id: "basic", label: "Basic" }],
        },
      ],
    },
    storage_binding: { connector_id: canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id },
  };
}

async function stage(stream: Record<string, unknown> = { name: "top_artists", view: "basic" }) {
  const initiated = await initiateGrant(
    {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          purpose_description: "approval review seam",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [stream],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    },
    { nativeManifest: nativeManifest() }
  );
  const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
  assert.ok(deviceCode);
  return deviceCode;
}

async function stageBatch(accessMode: "continuous" | "single_use" = "continuous"): Promise<string> {
  const initiated = await initiateGrant(
    {
      authorization_details: [
        {
          access_mode: accessMode,
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
        {
          access_mode: accessMode,
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    },
    { nativeManifest: nativeManifest() }
  );
  const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
  assert.ok(deviceCode);
  return deviceCode;
}

async function issuedGrantRows(): Promise<{ consumed: number; expires_at: string | null }[]> {
  if (process.env.PDPP_TEST_CURRENT_BACKEND === "postgres") {
    const result = await postgresQuery<{ consumed: boolean; expires_at: string | null }>(
      "SELECT consumed, expires_at FROM grants ORDER BY grant_id"
    );
    return result.rows.map((row) => ({ consumed: row.consumed ? 1 : 0, expires_at: row.expires_at }));
  }
  return getDb().prepare("SELECT consumed, expires_at FROM grants ORDER BY grant_id").all() as {
    consumed: number;
    expires_at: string | null;
  }[];
}

async function stageHttpBatch(asUrl: string, sourceId: string): Promise<string> {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: sourceId, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: sourceId, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  assert.equal(resp.status, 201, text);
  const body = JSON.parse(text) as { request_uri?: string };
  assert.ok(body.request_uri);
  return body.request_uri;
}

async function stageHttpSingle(asUrl: string, sourceId: string): Promise<string> {
  const resp = await fetch(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: sourceId, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  assert.equal(resp.status, 201, text);
  const body = JSON.parse(text) as { request_uri?: string };
  assert.ok(body.request_uri);
  return body.request_uri;
}

function extractReviewRevision(html: string): string {
  const match = /name="approval_review_revision" value="([^"]+)"/.exec(html);
  assert.ok(match?.[1], "rendered final review must include approval_review_revision");
  return match[1];
}

test.afterEach(async () => {
  delete process.env.PDPP_TEST_CURRENT_BACKEND;
  closeDb();
  await closePostgresStorage();
});

test("staged batch approval requires and binds finalized batch review revision", async () => {
  await setup();
  const deviceCode = await stageBatch();
  const initial = await getPendingConsent(deviceCode, { subjectId: "owner_local" });
  assert.equal(initial?.reviewRevision, null, "initial batch GET must not persist an approve-all review");
  await assert.rejects(
    () => approveGrant(deviceCode, "owner_local", { approvedSourceIndexes: [0, 1] }),
    /approval_review_revision is required/
  );
  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [0, 1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  assert.equal(typeof review?.reviewRevision, "string");
  assert.match(String(review?.reviewRevision), /^reference\.batch-approval-review\.v1:/);
  const artifact = getDb()
    .prepare("SELECT approval_review_json FROM pending_consents WHERE device_code = ?")
    .get<{ approval_review_json: string }>(deviceCode);
  assert.ok(artifact?.approval_review_json);
  assert.match(artifact.approval_review_json, /approved_source_indexes/);
  assert.match(artifact.approval_review_json, /resolved_streams/);
  const approved = await approveGrant(deviceCode, "owner_local", {
    approval_review_revision: review?.reviewRevision,
    approvedSourceIndexes: [0, 1],
  });
  assert.equal(approved.grant.package, true);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM grant_packages").get() as { n: number }).n, 1);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM grant_package_members").get() as { n: number }).n, 2);
});

test("single-use SQLite atomic approval marks the grant consumed", async () => {
  await setup();
  const initiated = await initiateGrant(
    {
      authorization_details: [
        {
          access_mode: "single_use",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    },
    { nativeManifest: nativeManifest() }
  );
  const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
  assert.ok(deviceCode);
  const review = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
  const approved = await approveGrant(deviceCode, "owner_local", {
    approval_review_revision: review?.reviewRevision,
  });
  const row = getDb()
    .prepare("SELECT consumed FROM grants WHERE grant_id = ?")
    .get<{ consumed: number }>(approved.grant.grant_id as string);
  assert.equal(row?.consumed, 1);
});

test("batch final review binds changed source indexes before issuing", async () => {
  await setup();
  const deviceCode = await stageBatch();
  await assert.rejects(
    () => approveGrant(deviceCode, "owner_local", { approvedSourceIndexes: [1] }),
    /approval_review_revision is required/
  );
  assert.equal(await countRows("grant_packages"), 0);
  assert.equal(await countRows("grants"), 0);

  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  assert.equal(typeof review?.reviewRevision, "string");
  const artifact = getDb()
    .prepare("SELECT approval_review_json FROM pending_consents WHERE device_code = ?")
    .get<{ approval_review_json: string }>(deviceCode);
  assert.ok(artifact?.approval_review_json);
  assert.match(artifact.approval_review_json, /"approved_source_indexes":\[1\]/);

  const approved = await approveGrant(deviceCode, "owner_local", {
    approval_review_revision: review?.reviewRevision,
    approvedSourceIndexes: [1],
  });
  assert.equal(approved.grant.package, true);
  assert.equal(await countRows("grant_package_members"), 1);
});

test("single-use batch approval preserves reviewed expiry and consumes child grants", async () => {
  await setup();
  const deviceCode = await stageBatch("single_use");
  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [0, 1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  const artifact = getDb()
    .prepare("SELECT approval_review_json FROM pending_consents WHERE device_code = ?")
    .get<{ approval_review_json: string }>(deviceCode);
  assert.ok(artifact?.approval_review_json);
  const reviewed = JSON.parse(artifact.approval_review_json) as { expires_at: string };
  assert.equal(typeof reviewed.expires_at, "string");
  const approved = await approveGrant(deviceCode, "owner_local", {
    approval_review_revision: review?.reviewRevision,
  });
  assert.equal(approved.grant.package, true);
  const grants = await issuedGrantRows();
  assert.equal(grants.length, 2);
  assert.deepEqual(
    grants.map((row) => row.expires_at),
    [reviewed.expires_at, reviewed.expires_at]
  );
  assert.deepEqual(
    grants.map((row) => row.consumed),
    [1, 1]
  );
});

test("approval requires the persisted reviewed revision", async () => {
  await setup();
  const deviceCode = await stage({ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" });

  await assert.rejects(() => approveGrant(deviceCode, "owner_local"), /approval_review_revision is required/);

  const review = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
  assert.equal(typeof review?.reviewRevision, "string");
  const approved = await approveGrant(deviceCode, "owner_local", {
    approval_review_revision: review?.reviewRevision,
  });
  assert.ok(approved.grant.grant_id);
});

test("malformed persisted single review rejects as invalid_request without issuing", async () => {
  await setup();
  const deviceCode = await stage({ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" });
  const review = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
  getDb()
    .prepare("UPDATE pending_consents SET approval_review_json = ? WHERE device_code = ?")
    .run("{not-json", deviceCode);
  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
      }),
    /malformed|review/i
  );
  assert.equal(await countRows("grants"), 0);
  assert.equal(await countRows("tokens"), 0);
});

test("malformed persisted batch review rejects as invalid_request without issuing", async () => {
  await setup();
  const deviceCode = await stageBatch();
  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [0, 1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  getDb()
    .prepare("UPDATE pending_consents SET approval_review_json = ? WHERE device_code = ?")
    .run(JSON.stringify({ version: "reference.batch-approval-review.v1" }), deviceCode);
  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
      }),
    /malformed|review/i
  );
  assert.equal(await countRows("grant_packages"), 0);
  assert.equal(await countRows("grants"), 0);
  assert.equal(await countRows("tokens"), 0);
});

test("review materializes exact omitted instance IDs and binds them at approval", async () => {
  await setup();
  const deviceCode = await stage({ name: "top_artists", view: "basic" });
  const review = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
  const artifact = getDb()
    .prepare("SELECT approval_review_json FROM pending_consents WHERE device_code = ?")
    .get<{ approval_review_json: string }>(deviceCode);
  assert.ok(artifact?.approval_review_json);
  assert.match(artifact.approval_review_json, new RegExp(INSTANCE_ID));

  createSqliteConnectorInstanceStore().updateStatus(INSTANCE_ID, {
    revokedAt: new Date().toISOString(),
    status: "revoked",
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
      }),
    /stale|eligible|review/i
  );
});

test("transaction-time instance revocation after review rejects without partial batch rows", async () => {
  await setup();
  const deviceCode = await stageBatch();
  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [0, 1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  createSqliteConnectorInstanceStore().updateStatus(INSTANCE_ID, {
    revokedAt: new Date().toISOString(),
    status: "revoked",
    updatedAt: new Date().toISOString(),
  });
  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
        approvedSourceIndexes: [0, 1],
      }),
    /no longer eligible|review/i
  );
  assert.deepEqual(await pendingStatus(deviceCode), { review: review?.reviewRevision ?? null, status: "pending" });
  assert.equal(await countRows("grant_packages"), 0);
  assert.equal(await countRows("grants"), 0);
  assert.equal(await countRows("tokens"), 0);
  assert.equal(await countRows("grant_package_members"), 0);
  assert.equal(await countRows("spine_events"), 2, "request.submitted plus typed rejection event remain");
});

test("transaction-time parent package revoke rejects incremental package without partial rows", async () => {
  await setup();
  const rootDeviceCode = await stageBatch();
  const rootReview = await getPendingConsent(rootDeviceCode, {
    approvedSourceIndexes: [0, 1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  const root = await approveGrant(rootDeviceCode, "owner_local", {
    approval_review_revision: rootReview?.reviewRevision,
    approvedSourceIndexes: [0, 1],
  });
  const rootPackageId = root.grant.package_id as string;

  const initiated = await initiateGrant(
    {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: SOURCE_ID, kind: "connector" },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
      parent_package_id: rootPackageId,
    },
    { nativeManifest: nativeManifest() }
  );
  const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
  assert.ok(deviceCode);
  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [0],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  getDb()
    .prepare("UPDATE grant_packages SET status = 'revoked', revoked_at = ? WHERE package_id = ?")
    .run(new Date().toISOString(), rootPackageId);
  const packageCountBefore = await countRows("grant_packages");
  const grantCountBefore = await countRows("grants");
  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
        approvedSourceIndexes: [0],
      }),
    /parent_package_id .*inactive|no longer eligible|review/i
  );
  assert.deepEqual(await pendingStatus(deviceCode), { review: review?.reviewRevision ?? null, status: "pending" });
  assert.equal(await countRows("grant_packages"), packageCountBefore);
  assert.equal(await countRows("grants"), grantCountBefore);
});

test("SQLite injected package trigger failure rolls back approval transaction", async () => {
  await setup();
  const deviceCode = await stageBatch();
  const review = await getPendingConsent(deviceCode, {
    approvedSourceIndexes: [0, 1],
    finalizeReview: true,
    subjectId: "owner_local",
  });
  getDb().exec(`
    CREATE TRIGGER approval_review_fault_after_package
    AFTER INSERT ON grant_packages
    BEGIN
      SELECT RAISE(ABORT, 'injected package fault');
    END;
  `);
  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
        approvedSourceIndexes: [0, 1],
      }),
    /injected package fault/
  );
  assert.deepEqual(await pendingStatus(deviceCode), { review: review?.reviewRevision ?? null, status: "pending" });
  assert.equal(await countRows("grant_packages"), 0);
  assert.equal(await countRows("grants"), 0);
  assert.equal(await countRows("tokens"), 0);
  assert.equal(await countRows("grant_package_members"), 0);
  assert.equal(await countRows("spine_events"), 1);
});

test("HTTP batch final review resumes the exact result without duplicate issuance", async () => {
  const manifest = loadSpotifyManifest();
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServerHandle;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const register = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(register.status, 201, await register.text());
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        client_name: "Approval Review Fixture",
        registration_mode: "pre_registered_public",
      },
    ]);
    const connectorId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: INSTANCE_ID,
      createdAt: new Date().toISOString(),
      displayName: "Approval review Spotify",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: INSTANCE_ID },
      sourceBindingKey: INSTANCE_ID,
      sourceKind: "account",
      status: "active",
      updatedAt: new Date().toISOString(),
    });

    await registerConnector({ ...manifest, source_declaration: nativeManifest().source_declaration });
    const requestUri = await stageHttpBatch(asUrl, SOURCE_ID);
    const deviceCode = parsePendingConsentRequestUri(requestUri);
    assert.ok(deviceCode);
    const approvalsResponse = await fetch(`${asUrl}/_ref/approvals`);
    const approvalsResponseText = await approvalsResponse.text();
    assert.equal(approvalsResponse.status, 200, approvalsResponseText);
    const approvals = JSON.parse(approvalsResponseText) as {
      data?: Array<{ approval_id?: string; batch?: boolean; kind?: string; request_uri?: unknown }>;
    };
    const approval = approvals.data?.find((entry) => entry.kind === "consent" && entry.batch === true);
    assert.ok(approval?.approval_id, "batch must expose an opaque approval_id for hosted review");
    assert.equal(approval?.request_uri, null, "queue projection must keep request_uri scrubbed");
    const hostedByApprovalId = await fetch(
      `${asUrl}/consent?approval_id=${encodeURIComponent(approval?.approval_id ?? "")}`
    );
    const hostedByApprovalIdHtml = await hostedByApprovalId.text();
    assert.equal(hostedByApprovalId.status, 200, hostedByApprovalIdHtml);
    assert.match(hostedByApprovalIdHtml, /Confirm each source/);
    assert.ok(
      !hostedByApprovalId.url.includes(deviceCode),
      "hosted approval-id link must not put the device-code-equivalent request URI in the browser URL"
    );
    const initial = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
    assert.equal(initial.status, 200);
    const initialHtml = await initial.text();
    assert.doesNotMatch(initialHtml, /name="approval_review_revision"/);

    const firstJsonReview = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ approved_source_indexes: [1], request_uri: requestUri, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const firstJsonReviewText = await firstJsonReview.text();
    assert.equal(firstJsonReview.status, 200, firstJsonReviewText);
    const firstJsonReviewBody = JSON.parse(firstJsonReviewText) as {
      approval_review?: { approved_source_indexes?: number[]; sources?: Array<{ resolved_streams?: unknown[] }> };
      approval_review_revision?: string;
    };
    assert.deepEqual(firstJsonReviewBody.approval_review?.approved_source_indexes, [1]);
    assert.ok(firstJsonReviewBody.approval_review?.sources?.[0]?.resolved_streams);
    assert.equal(await countRows("grant_packages"), 0, "first JSON review POST must not issue");

    const finalReview = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ approved_source_indexes: [1], request_uri: requestUri, subject_id: "owner_local" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    const finalReviewHtml = await finalReview.text();
    assert.equal(finalReview.status, 200, finalReviewHtml);
    const reviewRevision = extractReviewRevision(finalReviewHtml);
    assert.equal(firstJsonReviewBody.approval_review_revision, reviewRevision);
    assert.match(finalReviewHtml, /name="confirm_reviewed_decision"/);
    assert.doesNotMatch(finalReviewHtml, /name="approved_source_indexes"/);
    assert.doesNotMatch(finalReviewHtml, /name="confirm_approve_all"/);
    assert.doesNotMatch(finalReviewHtml, /name="narrow_streams_/);
    assert.equal(await countRows("grant_packages"), 0, "final-review POST must not issue");

    const resumedReview = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
    const resumedReviewHtml = await resumedReview.text();
    assert.equal(resumedReview.status, 200, resumedReviewHtml);
    assert.match(resumedReviewHtml, /name="approval_review_revision"/);
    assert.match(resumedReviewHtml, /name="confirm_reviewed_decision"/);
    assert.doesNotMatch(resumedReviewHtml, /name="approved_source_indexes"/);
    assert.doesNotMatch(resumedReviewHtml, /Confirm each source/);
    assert.doesNotMatch(resumedReviewHtml, /aria-label="Source 1"/);
    assert.match(resumedReviewHtml, /aria-label="Reviewed source 2"/);

    const jsonReview = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ approved_source_indexes: [1], request_uri: requestUri, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const jsonReviewText = await jsonReview.text();
    assert.equal(jsonReview.status, 200, jsonReviewText);
    const jsonReviewBody = JSON.parse(jsonReviewText) as {
      approval_review?: { approved_source_indexes?: number[]; sources?: Array<{ resolved_streams?: unknown[] }> };
      approval_review_revision?: string;
    };
    assert.deepEqual(jsonReviewBody.approval_review?.approved_source_indexes, [1]);
    assert.ok(jsonReviewBody.approval_review?.sources?.[0]?.resolved_streams);
    assert.equal(jsonReviewBody.approval_review_revision, reviewRevision);

    const badNarrowing = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        approved_source_indexes: [1],
        request_uri: requestUri,
        source_narrowing: { nope: { streams: ["top_artists"] } },
        subject_id: "owner_local",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(badNarrowing.status, 400, await badNarrowing.text());

    const nonCanonicalNarrowingKey = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({
        approved_source_indexes: [1],
        request_uri: requestUri,
        source_narrowing: { "01": { streams: ["top_artists"] } },
        subject_id: "owner_local",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(nonCanonicalNarrowingKey.status, 400, await nonCanonicalNarrowingKey.text());

    const forged = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: reviewRevision,
        approved_source_indexes: [0, 1],
        confirm_reviewed_decision: "1",
        request_uri: requestUri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(forged.status, 400, await forged.text());
    assert.equal(await countRows("grant_packages"), 0, "forged second-step choices must not issue");

    const subjectReplay = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: reviewRevision,
        confirm_reviewed_decision: "1",
        request_uri: requestUri,
        subject_id: "owner_local",
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(subjectReplay.status, 400, await subjectReplay.text());
    assert.equal(await countRows("grant_packages"), 0, "final subject replay must not issue");

    const approveBody = JSON.stringify({
      approval_review_revision: reviewRevision,
      confirm_reviewed_decision: "1",
      request_uri: requestUri,
    });
    const countsBeforeApproval = {
      events: await countRows("spine_events"),
      grants: await countRows("grants"),
      members: await countRows("grant_package_members"),
      packages: await countRows("grant_packages"),
      tokens: await countRows("tokens"),
    };
    const [first, second] = await Promise.all([
      fetch(`${asUrl}/consent/approve`, {
        body: approveBody,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      }),
      fetch(`${asUrl}/consent/approve`, {
        body: approveBody,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        method: "POST",
      }),
    ]);
    assert.deepEqual([first.status, second.status], [200, 200]);
    const firstBody = (await first.json()) as {
      grant?: { grant_id?: unknown };
      package_id?: unknown;
      token?: unknown;
    };
    const secondBody = (await second.json()) as typeof firstBody;
    for (const body of [firstBody, secondBody]) {
      const validation = validateResponse("approveConsent", { body, status: 200 });
      assert.equal(validation.ok, true, JSON.stringify(validation));
    }
    assert.deepEqual(secondBody, firstBody, "approval retry must return the persisted package and token result");
    assert.equal(firstBody.grant?.grant_id, firstBody.package_id);
    assert.equal(typeof firstBody.package_id, "string");
    assert.equal(typeof firstBody.token, "string");
    assert.equal(await countRows("grant_packages"), countsBeforeApproval.packages + 1);
    assert.equal(await countRows("grants"), countsBeforeApproval.grants + 1);
    assert.equal(await countRows("grant_package_members"), countsBeforeApproval.members + 1);
    assert.equal(await countRows("tokens"), countsBeforeApproval.tokens + 2);
    assert.equal(await countRows("spine_events"), countsBeforeApproval.events + 4);
  } finally {
    await closeServer(server);
  }
});

test("HTTP single consent must be reviewed before approve", async () => {
  const manifest = loadSpotifyManifest();
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServerHandle;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const register = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(register.status, 201, await register.text());
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        metadata: {
          client_uri: "https://clients.example.test/approval-review",
          logo_uri: "https://clients.example.test/approval-review/logo.svg",
          token_endpoint_auth_method: "none",
        },
        registration_mode: "pre_registered_public",
      },
    ]);
    const connectorId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: INSTANCE_ID,
      createdAt: new Date().toISOString(),
      displayName: "Approval review Spotify",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: INSTANCE_ID },
      sourceBindingKey: INSTANCE_ID,
      sourceKind: "account",
      status: "active",
      updatedAt: new Date().toISOString(),
    });

    await registerConnector({ ...manifest, source_declaration: nativeManifest().source_declaration });
    const requestUri = await stageHttpSingle(asUrl, SOURCE_ID);
    const oneStep = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({ request_uri: requestUri, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(oneStep.status, 400, await oneStep.text());
    assert.equal(await countRows("grants"), 0);

    const jsonReview = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: requestUri, subject_id: "owner_local" }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const jsonReviewText = await jsonReview.text();
    assert.equal(jsonReview.status, 200, jsonReviewText);
    const jsonReviewBody = JSON.parse(jsonReviewText) as {
      approval_review?: {
        client?: { client_display?: { logo_uri?: string | null; name?: string | null; uri?: string | null } };
        resolved_streams?: unknown[];
        version?: string;
      };
      approval_review_revision?: string;
      batch?: boolean;
    };
    assert.equal(jsonReviewBody.batch, false);
    assert.equal(jsonReviewBody.approval_review?.version, "reference.approval-review.v1");
    assert.ok(jsonReviewBody.approval_review?.resolved_streams);
    assert.deepEqual(jsonReviewBody.approval_review?.client?.client_display, {
      logo_uri: "https://clients.example.test/approval-review/logo.svg",
      name: null,
      policy_uri: null,
      tos_uri: null,
      uri: "https://clients.example.test/approval-review",
    });

    const review = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
    const reviewHtml = await review.text();
    assert.equal(review.status, 200, reviewHtml);
    const reviewRevision = extractReviewRevision(reviewHtml);
    assert.equal(jsonReviewBody.approval_review_revision, reviewRevision);
    const approved = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: reviewRevision,
        request_uri: requestUri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const approvedText = await approved.text();
    assert.equal(approved.status, 200, approvedText);
    const approvedBody = JSON.parse(approvedText) as { grant?: { subject?: { id?: string } } };
    assert.equal(approvedBody.grant?.subject?.id, "owner_local");
    assert.equal(await countRows("grants"), 1);
  } finally {
    await closeServer(server);
  }
});

test("HTTP single final approval derives custom subject from persisted review", async () => {
  const manifest = loadSpotifyManifest();
  const customSubjectId = "owner_custom_review_subject";
  const server = (await startServer({ asPort: 0, dbPath: ":memory:", quiet: true, rsPort: 0 })) as TestServerHandle;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    const register = await fetch(`${asUrl}/connectors`, {
      body: JSON.stringify(manifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    assert.equal(register.status, 201, await register.text());
    await seedPreRegisteredClients([
      {
        client_id: CLIENT_ID,
        client_name: "Approval Review Fixture",
        registration_mode: "pre_registered_public",
      },
    ]);
    const connectorId = canonicalConnectorKey(manifest.connector_id) ?? manifest.connector_id;
    await createSqliteConnectorInstanceStore().upsert({
      connectorId,
      connectorInstanceId: INSTANCE_ID,
      createdAt: new Date().toISOString(),
      displayName: "Approval review Spotify",
      ownerSubjectId: customSubjectId,
      sourceBinding: { fixture: INSTANCE_ID },
      sourceBindingKey: INSTANCE_ID,
      sourceKind: "account",
      status: "active",
      updatedAt: new Date().toISOString(),
    });

    await registerConnector({ ...manifest, source_declaration: nativeManifest().source_declaration });
    const requestUri = await stageHttpSingle(asUrl, SOURCE_ID);
    const jsonReview = await fetch(`${asUrl}/consent/review`, {
      body: JSON.stringify({ request_uri: requestUri, subject_id: customSubjectId }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const jsonReviewText = await jsonReview.text();
    assert.equal(jsonReview.status, 200, jsonReviewText);
    const jsonReviewBody = JSON.parse(jsonReviewText) as {
      approval_review?: { subject?: { id?: string } };
      approval_review_revision?: string;
    };
    assert.equal(jsonReviewBody.approval_review?.subject?.id, customSubjectId);
    assert.equal(typeof jsonReviewBody.approval_review_revision, "string");

    const approved = await fetch(`${asUrl}/consent/approve`, {
      body: JSON.stringify({
        approval_review_revision: jsonReviewBody.approval_review_revision,
        request_uri: requestUri,
      }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
    });
    const approvedText = await approved.text();
    assert.equal(approved.status, 200, approvedText);
    const approvedBody = JSON.parse(approvedText) as { grant?: { subject?: { id?: string } } };
    assert.equal(approvedBody.grant?.subject?.id, customSubjectId);
  } finally {
    await closeServer(server);
  }
});

test("PostgreSQL batch review/approval and transaction-time instance stale rejection", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: "pdpp_test_pr114_batch_approval",
    },
    async (databaseUrl) => {
      await setup("postgres", databaseUrl);
      const deviceCode = await stageBatch();
      const review = await getPendingConsent(deviceCode, {
        approvedSourceIndexes: [0, 1],
        finalizeReview: true,
        subjectId: "owner_local",
      });
      const approved = await approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
        approvedSourceIndexes: [0, 1],
      });
      assert.equal(approved.grant.package, true);
      assert.equal(await countRows("grant_packages"), 1);
      assert.equal(await countRows("grant_package_members"), 2);

      const staleDeviceCode = await stageBatch();
      const staleReview = await getPendingConsent(staleDeviceCode, {
        approvedSourceIndexes: [0, 1],
        finalizeReview: true,
        subjectId: "owner_local",
      });
      await createRequestConnectorInstanceStore().updateStatus(INSTANCE_ID, {
        revokedAt: new Date().toISOString(),
        status: "revoked",
        updatedAt: new Date().toISOString(),
      });
      const packageCountBefore = await countRows("grant_packages");
      await assert.rejects(
        () =>
          approveGrant(staleDeviceCode, "owner_local", {
            approval_review_revision: staleReview?.reviewRevision,
            approvedSourceIndexes: [0, 1],
          }),
        /no longer eligible|review/i
      );
      assert.deepEqual(await pendingStatus(staleDeviceCode), {
        review: staleReview?.reviewRevision ?? null,
        status: "pending",
      });
      assert.equal(await countRows("grant_packages"), packageCountBefore);
    }
  );
});

test("PostgreSQL injected package trigger failure rolls back approval transaction", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: "pdpp_test_pr114_batch_rollback",
    },
    async (databaseUrl) => {
      await setup("postgres", databaseUrl);
      const deviceCode = await stageBatch();
      const review = await getPendingConsent(deviceCode, {
        approvedSourceIndexes: [0, 1],
        finalizeReview: true,
        subjectId: "owner_local",
      });
      await postgresQuery(`
          CREATE OR REPLACE FUNCTION approval_review_fault_after_package()
          RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'injected package fault';
          END;
          $$ LANGUAGE plpgsql;
        `);
      await postgresQuery(`
          CREATE TRIGGER approval_review_fault_after_package
          AFTER INSERT ON grant_packages
          FOR EACH ROW EXECUTE FUNCTION approval_review_fault_after_package();
        `);
      await assert.rejects(
        () =>
          approveGrant(deviceCode, "owner_local", {
            approval_review_revision: review?.reviewRevision,
            approvedSourceIndexes: [0, 1],
          }),
        /injected package fault/
      );
      assert.deepEqual(await pendingStatus(deviceCode), {
        review: review?.reviewRevision ?? null,
        status: "pending",
      });
      assert.equal(await countRows("grant_packages"), 0);
      assert.equal(await countRows("grants"), 0);
      assert.equal(await countRows("tokens"), 0);
      assert.equal(await countRows("grant_package_members"), 0);
      assert.equal(await countRows("spine_events"), 1);
    }
  );
});

test("PostgreSQL single-use batch approval preserves reviewed expiry and consumes child grants", {
  skip: POSTGRES_URL ? false : "PDPP_TEST_POSTGRES_URL unset",
}, async () => {
  assert.ok(POSTGRES_URL);
  await withTemporaryPostgresDatabase(
    {
      closeConnections: closePostgresStorage,
      connectionString: POSTGRES_URL,
      databaseName: "pdpp_test_pr114_batch_single_use",
    },
    async (databaseUrl) => {
      await setup("postgres", databaseUrl);
      const deviceCode = await stageBatch("single_use");
      const review = await getPendingConsent(deviceCode, {
        approvedSourceIndexes: [0, 1],
        finalizeReview: true,
        subjectId: "owner_local",
      });
      const artifact = await postgresQuery<{ approval_review_json: string }>(
        "SELECT approval_review_json::text AS approval_review_json FROM pending_consents WHERE device_code = $1",
        [deviceCode]
      );
      const reviewed = JSON.parse(String(artifact.rows[0]?.approval_review_json)) as { expires_at: string };
      await approveGrant(deviceCode, "owner_local", {
        approval_review_revision: review?.reviewRevision,
      });
      const grants = await issuedGrantRows();
      assert.equal(grants.length, 2);
      assert.deepEqual(
        grants.map((row) => row.expires_at),
        [reviewed.expires_at, reviewed.expires_at]
      );
      assert.deepEqual(
        grants.map((row) => row.consumed),
        [1, 1]
      );
    }
  );
});

test("same pending row concurrent re-review invalidates the first revision", async () => {
  await setup();
  const deviceCode = await stage({ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" });
  const firstReview = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
  getDb()
    .prepare(
      "UPDATE pending_consents SET approval_review_revision = ?, approval_review_digest = ? WHERE device_code = ?"
    )
    .run("reference.approval-review.v1:sha256:changed", "sha256:changed", deviceCode);

  await assert.rejects(
    () =>
      approveGrant(deviceCode, "owner_local", {
        approval_review_revision: firstReview?.reviewRevision,
      }),
    /stale|subject changed|review/i
  );
});

test("request-time connector source ID must have explicit fulfillment", async () => {
  await setup();
  await assert.rejects(
    () =>
      initiateGrant({
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/personalization",
            source: { id: "https://registry.pdpp.dev/connectors/unregistered-source", kind: "connector" },
            streams: [{ name: "top_artists", view: "basic" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: CLIENT_ID,
      }),
    /Unknown source/
  );
});

test("request source kind may be omitted and is derived from retained declaration", async () => {
  await setup();
  const initiated = await initiateGrant(
    {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: SOURCE_ID },
          streams: [{ instance_ids: [INSTANCE_ID], name: "top_artists", view: "basic" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    },
    { nativeManifest: nativeManifest() }
  );
  const deviceCode = parsePendingConsentRequestUri(initiated.request_uri);
  assert.ok(deviceCode);
  const pending = await getPendingConsent(deviceCode, { subjectId: "owner_local" });
  assert.deepEqual((pending as PendingReviewView | null)?.request?.source_binding, {
    id: SOURCE_ID,
    kind: "connector",
  });
});
