// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * B4 conformance — blob_ref / fetch_url replayable runbook proof.
 *
 * Verifies that the documented contract in:
 *   docs/operator/blob-fetch-runbook.md
 *
 * matches the actual behaviour of GET /v1/blobs/:blob_id.
 *
 * Tests mirror the runbook steps:
 *   1. Upload a blob (POST /v1/blobs)
 *   2. Seed the record that references it via blob_ref
 *   3. Issue a grant that includes the blob_ref field
 *   4. Query records → fetch_url is decorated on blob_ref
 *   5. GET /v1/blobs/:blob_id → documented headers + raw bytes
 *   6. Grant enforcement: blob_not_found when token cannot see the record
 *
 * Gate: all tests green; documented shapes match actual responses.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const POLYFILL_MANIFESTS_DIR = join(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");

// ─── helpers ────────────────────────────────────────────────────────────────

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.abortStartupBackfill("test shutdown");
  server.schedulerManager?.stop();
  server.stopBrowserSurfaceLeaseSweep();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
    server.startupBackfillDone,
    server.startupSummaryEvidenceSweepDone,
    server.stopClientEventDeliveryWorker(),
  ]);
}

async function fetchJson<T = unknown>(url: string, opts: RequestInit = {}): Promise<{ status: number; body: T }> {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body: body as T, status: resp.status };
}

interface DeviceAuthorization {
  device_code: string;
  user_code: string;
}

interface TokenResponse {
  access_token: string;
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: device } = await fetchJson<DeviceAuthorization>(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  const { body: tokenBody } = await fetchJson<TokenResponse>(`${asUrl}/oauth/token`, {
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

interface UploadBlobParams {
  connector_id: string;
  record_key: string;
  stream: string;
}

interface UploadedBlob {
  blob_id: string;
  mime_type: string;
  sha256: string;
  size_bytes: number;
}

/**
 * Upload a blob via POST /v1/blobs.
 * Returns the parsed JSON response: { blob_id, mime_type, size_bytes, sha256 }.
 */
async function uploadBlob(
  rsUrl: string,
  ownerToken: string,
  params: UploadBlobParams,
  bytes: Buffer,
  contentType: string
): Promise<UploadedBlob> {
  const query = new URLSearchParams({
    connector_id: params.connector_id,
    record_key: params.record_key,
    stream: params.stream,
  });
  const { status, body } = await fetchJson<UploadedBlob>(`${rsUrl}/v1/blobs?${query.toString()}`, {
    body: bytes,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      "Content-Type": contentType,
    },
    method: "POST",
  });
  assert.equal(status, 200, `upload blob ok: ${JSON.stringify(body)}`);
  return body;
}

interface SeedRecord {
  emitted_at?: string;
  id: string;
  [key: string]: unknown;
}

/**
 * Seed records into a stream via NDJSON ingest.
 */
async function seedStream(
  rsUrl: string,
  ownerToken: string,
  connectorId: string,
  stream: string,
  records: SeedRecord[]
) {
  const ndjson = records
    .map((r) =>
      JSON.stringify({
        data: r,
        emitted_at: r.emitted_at || "2026-01-01T00:00:00Z",
        key: r.id,
      })
    )
    .join("\n");
  const resp = await fetch(
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}?connector_id=${encodeURIComponent(connectorId)}`,
    {
      body: ndjson,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/x-ndjson",
      },
      method: "POST",
    }
  );
  assert.equal(resp.status, 200, `seed ${stream} ok`);
}

interface ClientGrantParams {
  access_mode: string;
  client_id: string;
  connector_id: string;
  purpose_code: string;
  purpose_description: string;
  streams: { name: string; fields: string[] }[];
}

interface ApprovedGrant {
  grant: { grant_id: string; access_mode: string; expires_at?: string };
  token: string;
}

/**
 * Issue a grant-scoped client token via PAR + consent/approve.
 */
async function issueClientGrant(asUrl: string, subjectId: string, params: ClientGrantParams): Promise<ApprovedGrant> {
  const { body: par } = await fetchJson<{ request_uri: string }>(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          source: { id: params.connector_id, kind: "connector" },
          streams: params.streams,
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const { body: approved } = await fetchJson<ApprovedGrant>(`${asUrl}/consent/approve`, {
    body: JSON.stringify({
      request_uri: par.request_uri,
      subject_id: subjectId,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return approved;
}

interface ConnectorManifest {
  connector_id: string;
  [key: string]: unknown;
}

interface RecordEnvelope {
  data: { blob_ref?: { fetch_url?: string; blob_id?: string }; [key: string]: unknown };
  id: string;
}

interface RecordsListBody {
  data: RecordEnvelope[];
}

function readGmailManifest(): ConnectorManifest {
  return JSON.parse(readFileSync(join(POLYFILL_MANIFESTS_DIR, "gmail.json"), "utf8")) as ConnectorManifest;
}

async function withGmailHarness(fn: (ctx: { asUrl: string; rsUrl: string; connectorId: string }) => Promise<void>) {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  const manifest = readGmailManifest();
  const regResp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  assert.equal(regResp.status, 201, "register gmail connector");

  try {
    await fn({ asUrl, connectorId: manifest.connector_id, rsUrl });
  } finally {
    await closeServer(server);
  }
}

// ─── B4.1 — full blob lifecycle: upload → record → grant → fetch ─────────────

test("blob lifecycle: upload → seed record → grant with blob_ref → fetch bytes (B4)", async () => {
  await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b4_lifecycle_owner");
    const bytes = Buffer.from("attachment content: invoice data for B4 test");
    const sha256Expected = createHash("sha256").update(bytes).digest("hex");

    // Step 1 — upload blob
    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "msg-b4:2", stream: "attachments" },
      bytes,
      "application/pdf"
    );

    assert.ok(blob.blob_id.startsWith("blob_sha256_"), "blob_id has expected prefix");
    assert.equal(blob.mime_type, "application/pdf", "mime_type echoed back");
    assert.equal(blob.size_bytes, bytes.length, "size_bytes echoed back");
    assert.ok(blob.sha256, "sha256 present");

    // Step 2 — seed parent message + attachment record with blob_ref
    await seedStream(rsUrl, ownerToken, connectorId, "messages", [
      {
        bcc: [],
        cc: [],
        has_attachments: true,
        id: "msg-b4",
        is_answered: false,
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        labels: [],
        received_at: "2026-01-10T12:00:00Z",
        references: [],
        reply_to: [],
        snippet: "Invoice attached.",
        subject: "B4 invoice",
        thread_id: "thread-b4",
        to: [],
      },
    ]);

    await seedStream(rsUrl, ownerToken, connectorId, "attachments", [
      {
        blob_ref: {
          blob_id: blob.blob_id,
          mime_type: blob.mime_type,
          sha256: blob.sha256,
          size_bytes: blob.size_bytes,
        },
        content_id: null,
        content_sha256: blob.sha256,
        content_type: "application/pdf",
        encoding: "base64",
        filename: "invoice.pdf",
        hydration_error: null,
        hydration_status: "hydrated",
        id: "msg-b4:2",
        is_inline: false,
        message_id: "msg-b4",
        message_received_at: "2026-01-10T12:00:00Z",
        part_index: "2",
        size_bytes: blob.size_bytes,
      },
    ]);

    // Step 3 — issue client grant that includes blob_ref field
    const approved = await issueClientGrant(asUrl, "b4_lifecycle_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_export",
      purpose_description: "Export Gmail attachment for B4 blob test.",
      streams: [
        {
          fields: ["id", "thread_id", "subject", "received_at", "has_attachments"],
          name: "messages",
        },
        {
          fields: ["id", "message_id", "filename", "content_type", "size_bytes", "blob_ref"],
          name: "attachments",
        },
      ],
    });

    // Step 4 — query attachments, assert fetch_url is decorated on blob_ref
    const { status: recStatus, body: recBody } = await fetchJson<RecordsListBody>(
      `${rsUrl}/v1/streams/attachments/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );
    assert.equal(recStatus, 200, "records query ok");
    const attachment = recBody.data.find((r) => r.id === "msg-b4:2");
    assert.ok(attachment, "attachment record found");
    assert.ok(attachment.data.blob_ref, "blob_ref present on record");
    assert.equal(
      attachment.data.blob_ref.fetch_url,
      `/v1/blobs/${blob.blob_id}`,
      "fetch_url matches /v1/blobs/:blob_id shape"
    );

    // Step 5 — fetch blob bytes via fetch_url using the same client token
    const fetchUrl = `${rsUrl}${attachment.data.blob_ref.fetch_url}`;
    const blobResp = await fetch(fetchUrl, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(blobResp.status, 200, "blob fetch returns 200");

    // Documented response headers
    assert.equal(
      blobResp.headers.get("Content-Type"),
      "application/pdf",
      "Content-Type = mime_type stored at upload time"
    );
    assert.equal(
      blobResp.headers.get("Cache-Control"),
      "private, no-store",
      "Cache-Control: private, no-store (always)"
    );
    assert.equal(blobResp.headers.get("Content-Length"), String(bytes.length), "Content-Length = exact size_bytes");

    // Byte integrity
    const fetched = Buffer.from(await blobResp.arrayBuffer());
    assert.deepEqual(fetched, bytes, "fetched bytes are byte-identical to uploaded bytes");
    const sha256Actual = createHash("sha256").update(fetched).digest("hex");
    assert.equal(sha256Actual, sha256Expected, "sha256 of fetched bytes matches upload");
  });
});

// ─── B4.2 — grant enforcement: blob_not_found without matching grant ─────────

test("blob grant enforcement: blob_not_found when token lacks visibility to the record (B4)", async () => {
  await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b4_enforce_owner");
    const bytes = Buffer.from("secret content: must not be accessible without grant");

    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "msg-enforce:2", stream: "attachments" },
      bytes,
      "application/octet-stream"
    );

    await seedStream(rsUrl, ownerToken, connectorId, "messages", [
      {
        bcc: [],
        cc: [],
        has_attachments: true,
        id: "msg-enforce",
        is_answered: false,
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        labels: [],
        received_at: "2026-01-11T12:00:00Z",
        references: [],
        reply_to: [],
        snippet: "",
        subject: "Enforcement test",
        thread_id: "thread-enforce",
        to: [],
      },
    ]);

    await seedStream(rsUrl, ownerToken, connectorId, "attachments", [
      {
        blob_ref: {
          blob_id: blob.blob_id,
          mime_type: blob.mime_type,
          sha256: blob.sha256,
          size_bytes: blob.size_bytes,
        },
        content_id: null,
        content_sha256: blob.sha256,
        content_type: "application/octet-stream",
        encoding: "base64",
        filename: "secret.bin",
        hydration_error: null,
        hydration_status: "hydrated",
        id: "msg-enforce:2",
        is_inline: false,
        message_id: "msg-enforce",
        message_received_at: "2026-01-11T12:00:00Z",
        part_index: "2",
        size_bytes: blob.size_bytes,
      },
    ]);

    // Issue a grant that does NOT include blob_ref in the attachments field projection
    const noBlob = await issueClientGrant(asUrl, "b4_enforce_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_summarize",
      purpose_description: "B4 enforcement: no blob_ref in projection.",
      streams: [
        {
          fields: ["id", "subject", "received_at"],
          name: "messages",
        },
        {
          // blob_ref deliberately omitted from fields
          fields: ["id", "message_id", "filename", "content_type"],
          name: "attachments",
        },
      ],
    });

    // Attempt to fetch the blob with the grant that cannot see it
    const enforceResp = await fetch(`${rsUrl}/v1/blobs/${encodeURIComponent(blob.blob_id)}`, {
      headers: { Authorization: `Bearer ${noBlob.token}` },
    });

    assert.equal(enforceResp.status, 404, "blob fetch returns 404 when grant does not expose blob_ref");

    const enforceBody = (await enforceResp.json()) as { error?: { code?: string } };
    assert.equal(
      enforceBody.error?.code,
      "blob_not_found",
      "error code is blob_not_found (caller learns nothing about which connector owns the blob)"
    );
  });
});

// ─── B4.3 — fetch_url shape: relative path prepend RS base URL ───────────────

test("fetch_url is relative /v1/blobs/:blob_id — must prepend RS base URL (B4)", async () => {
  await withGmailHarness(async ({ asUrl, rsUrl, connectorId }) => {
    const ownerToken = await issueOwnerToken(asUrl, "b4_fetchurl_owner");
    const bytes = Buffer.from("shape test bytes");

    const blob = await uploadBlob(
      rsUrl,
      ownerToken,
      { connector_id: connectorId, record_key: "msg-shape:3", stream: "attachments" },
      bytes,
      "image/png"
    );

    await seedStream(rsUrl, ownerToken, connectorId, "messages", [
      {
        bcc: [],
        cc: [],
        has_attachments: true,
        id: "msg-shape",
        is_answered: false,
        is_draft: false,
        is_flagged: false,
        is_seen: true,
        labels: [],
        received_at: "2026-01-12T12:00:00Z",
        references: [],
        reply_to: [],
        snippet: "",
        subject: "Shape test",
        thread_id: "thread-shape",
        to: [],
      },
    ]);

    await seedStream(rsUrl, ownerToken, connectorId, "attachments", [
      {
        blob_ref: {
          blob_id: blob.blob_id,
          mime_type: "image/png",
          sha256: blob.sha256,
          size_bytes: blob.size_bytes,
        },
        content_id: null,
        content_sha256: blob.sha256,
        content_type: "image/png",
        encoding: "base64",
        filename: "logo.png",
        hydration_error: null,
        hydration_status: "hydrated",
        id: "msg-shape:3",
        is_inline: true,
        message_id: "msg-shape",
        message_received_at: "2026-01-12T12:00:00Z",
        part_index: "3",
        size_bytes: blob.size_bytes,
      },
    ]);

    const approved = await issueClientGrant(asUrl, "b4_fetchurl_owner", {
      access_mode: "continuous",
      client_id: "longview",
      connector_id: connectorId,
      purpose_code: "https://pdpp.dev/purpose/assist_export",
      purpose_description: "B4 fetch_url shape test.",
      streams: [
        { fields: ["id", "subject"], name: "messages" },
        { fields: ["id", "filename", "blob_ref"], name: "attachments" },
      ],
    });

    const { body: recBody } = await fetchJson<RecordsListBody>(
      `${rsUrl}/v1/streams/attachments/records?connector_id=${encodeURIComponent(connectorId)}`,
      { headers: { Authorization: `Bearer ${approved.token}` } }
    );

    const rec = recBody.data.find((r) => r.id === "msg-shape:3");
    assert.ok(rec, "record found");

    const fetchUrl = rec.data.blob_ref?.fetch_url;
    assert.ok(fetchUrl, "fetch_url is present");

    // Documented shape: relative path, starts with /v1/blobs/
    assert.ok(fetchUrl.startsWith("/v1/blobs/"), `fetch_url must start with /v1/blobs/, got: ${fetchUrl}`);
    assert.ok(!fetchUrl.startsWith("http"), "fetch_url is relative (no scheme)");

    // Content-Type must reflect mime_type at upload time (image/png)
    const blobResp = await fetch(`${rsUrl}${fetchUrl}`, {
      headers: { Authorization: `Bearer ${approved.token}` },
    });
    assert.equal(blobResp.status, 200);
    assert.equal(blobResp.headers.get("Content-Type"), "image/png", "Content-Type = image/png");
    assert.equal(blobResp.headers.get("Cache-Control"), "private, no-store");
  });
});
