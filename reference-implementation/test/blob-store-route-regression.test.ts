const TOP_LEVEL_REGEX_1 = /^blob_sha256_/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route-level regression for `GET /v1/blobs/:blob_id` after the
 * `BlobStore` extraction.
 *
 * Pins:
 *   - 200 + correct bytes / Content-Type / Content-Length when the actor's
 *     storage binding holds a record that references the blob.
 *   - 404 + `blob_not_found` envelope when the blob_id does not exist.
 *   - 404 + `blob_not_found` when the blob exists but no visible record under
 *     the actor's storage binding references it.
 *
 * The existing `query-contract.test.js` covers the success path
 * incidentally; this file focuses on the visibility/404 contract that the
 * extracted `BlobStore` capability must preserve.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { startServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
  rsServer: { close: (cb: (err?: Error) => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
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
    body: new URLSearchParams({ subject_id: subjectId, user_code: device.user_code }).toString(),
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

async function withHarness(fn: (urls: { asUrl: string; rsUrl: string }) => Promise<void>) {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
  }
}

interface ConnectorManifest {
  connector_id: string;
  [key: string]: unknown;
}

function loadGmailManifest(): ConnectorManifest {
  const path = join(REFERENCE_IMPL_DIR, "..", "packages", "polyfill-connectors", "manifests", "gmail.json");
  return JSON.parse(readFileSync(path, "utf8")) as ConnectorManifest;
}

async function registerConnector(asUrl: string, manifest: ConnectorManifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  if (!resp.ok) {
    throw new Error(`register connector failed: ${resp.status} ${await resp.text()}`);
  }
}

test("GET /v1/blobs/:blob_id returns 404 blob_not_found for unknown blob_id", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);

    const resp = await fetch(
      `${rsUrl}/v1/blobs/blob_sha256_${"0".repeat(64)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(resp.status, 404);
    const body = (await resp.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "blob_not_found");
  });
});

test("GET /v1/blobs/:blob_id returns 404 when blob exists but no visible record references it", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);

    // Upload a blob without a corresponding record. The blob row + binding
    // exist, but no record references it via blob_ref, so the visibility
    // check must fail.
    const uploadParams = new URLSearchParams({
      connector_id: manifest.connector_id,
      record_key: "orphan_attachment",
      stream: "attachments",
    });
    const upload = await fetch(`${rsUrl}/v1/blobs?${uploadParams.toString()}`, {
      body: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "application/octet-stream",
      },
      method: "POST",
    });
    assert.equal(upload.status, 200, `upload should succeed (got ${upload.status})`);
    const uploadBody = (await upload.json()) as { object: string; blob_id: string };
    assert.equal(uploadBody.object, "blob");
    assert.match(uploadBody.blob_id, TOP_LEVEL_REGEX_1);

    // Read the blob: visibility must fail because no record exposes
    // blob_ref.blob_id pointing at this upload.
    const readResp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadBody.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(readResp.status, 404);
    const readBody = (await readResp.json()) as { error?: { code?: string } };
    assert.equal(readBody.error?.code, "blob_not_found");
  });
});

test("GET /v1/blobs/:blob_id returns 200 with bytes when a visible record references the blob", async () => {
  await withHarness(async ({ asUrl, rsUrl }) => {
    const manifest = loadGmailManifest();
    await registerConnector(asUrl, manifest);
    const ownerToken = await issueOwnerToken(asUrl);

    const bytes = Buffer.from("hello-world", "utf8");
    const uploadParams = new URLSearchParams({
      connector_id: manifest.connector_id,
      record_key: "attach_1",
      stream: "attachments",
    });
    const upload = await fetch(`${rsUrl}/v1/blobs?${uploadParams.toString()}`, {
      body: bytes,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        "Content-Type": "text/plain",
      },
      method: "POST",
    });
    assert.equal(upload.status, 200);
    const uploadBody = (await upload.json()) as { blob_id: string };

    // Ingest a record that references this blob via blob_ref.
    const ndjson = `${JSON.stringify({
      data: {
        blob_ref: { blob_id: uploadBody.blob_id },
        filename: "hello.txt",
        message_id: "msg_1",
        mime_type: "text/plain",
        size_bytes: bytes.byteLength,
      },
      emitted_at: "2026-04-01T00:00:00Z",
      key: "attach_1",
    })}\n`;
    const ingestResp = await fetch(
      `${rsUrl}/v1/ingest/attachments?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      {
        body: ndjson,
        headers: {
          Authorization: `Bearer ${ownerToken}`,
          "Content-Type": "application/x-ndjson",
        },
        method: "POST",
      }
    );
    assert.equal(ingestResp.status, 200);
    const ingestBody = (await ingestResp.json()) as {
      records_accepted: number;
      records_rejected?: number;
      errors?: unknown;
    };
    assert.equal(
      ingestBody.records_accepted,
      1,
      `ingest must accept the record (rejected=${ingestBody.records_rejected}, errors=${JSON.stringify(ingestBody.errors)})`
    );

    // Read the blob: success, with correct headers and bytes.
    const readResp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadBody.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } }
    );
    assert.equal(readResp.status, 200);
    assert.equal(readResp.headers.get("content-type"), "text/plain");
    assert.equal(readResp.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(readResp.headers.get("cache-control"), "private, no-store");
    const buf = Buffer.from(await readResp.arrayBuffer());
    assert.deepEqual(buf, bytes);

    const headResp = await fetch(
      `${rsUrl}/v1/blobs/${encodeURIComponent(uploadBody.blob_id)}?connector_id=${encodeURIComponent(manifest.connector_id)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` }, method: "HEAD" }
    );
    assert.equal(headResp.status, 200);
    assert.equal(headResp.headers.get("content-type"), "text/plain");
    assert.equal(headResp.headers.get("content-length"), String(bytes.byteLength));
    assert.equal(headResp.headers.get("cache-control"), "private, no-store");
    assert.equal(await headResp.text(), "");
  });
});
