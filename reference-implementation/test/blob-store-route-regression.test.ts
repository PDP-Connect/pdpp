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
 * The existing `query-contract.test.ts` covers the success path
 * incidentally; this file focuses on the visibility/404 contract that the
 * extracted `BlobStore` capability must preserve.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { exec, referenceQueries } from "../lib/db.ts";
import { startServer } from "../server/index.ts";
import { MAX_BLOB_RESPONSE_BYTES, mountRsBlobRead } from "../server/routes/rs-read.ts";
import { createBlobStore } from "../server/stores/blob-store.ts";

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

interface BoundaryHarness {
  errors: Array<{ code?: string; message?: string }>;
  invoke: () => Promise<void>;
  loadedRanges: Array<{ end: number; start: number } | null>;
  response: {
    body: unknown;
    headers: Map<string, string>;
    statusCode: number;
  };
}

function makeBoundaryHarness({
  method,
  range,
  size,
}: {
  method: string;
  range?: string;
  size: number;
}): BoundaryHarness {
  const loadedRanges: Array<{ end: number; start: number } | null> = [];
  const errors: Array<{ code?: string; message?: string }> = [];
  const response = {
    body: undefined as unknown,
    headers: new Map<string, string>(),
    statusCode: 200,
  };
  let routeHandler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  const app = {
    get(...args: unknown[]) {
      routeHandler = args.at(-1) as (req: unknown, res: unknown) => Promise<unknown>;
      return app;
    },
  };
  const bytes = Buffer.from("0123456789", "utf8");
  const connectorId = "blob-boundary-connector";
  const record = { data: { blob_ref: { blob_id: "blob_sha256_boundary" } } };
  const blobStore = {
    listBlobBindings: async () => [
      {
        connector_id: connectorId,
        connector_instance_id: "blob-boundary-instance",
        record_key: "attachment-1",
        stream: "attachments",
      },
    ],
    loadContentAddressedBlob: (_blobId: string, selectedRange?: { end: number; start: number }) => {
      loadedRanges.push(selectedRange ?? null);
      const data = selectedRange ? bytes.subarray(selectedRange.start, selectedRange.end + 1) : bytes;
      return {
        blob_id: "blob_sha256_boundary",
        connector_id: connectorId,
        connector_instance_id: "blob-boundary-instance",
        data,
        mime_type: "application/octet-stream",
        record_key: "attachment-1",
        sha256: "sha256-boundary",
        size_bytes: size,
        stream: "attachments",
      };
    },
    loadContentAddressedBlobMetadata: () => ({
      blob_id: "blob_sha256_boundary",
      mime_type: "application/octet-stream",
      sha256: "sha256-boundary",
      size_bytes: size,
    }),
  };
  const context = {
    AmbiguousConnectionError: class extends Error {
      constructor(message: string, _candidates: unknown[]) {
        super(message);
      }
    },
    buildOwnerReadGrant: (stream: string) => ({ streams: [{ name: stream }] }),
    canonicalConnectorKey: (connector: string) => connector,
    createBlobStore: () => blobStore,
    getRecord: async () => record,
    handleError: (_res: unknown, err: unknown) => errors.push(err as { code?: string; message?: string }),
    opts: {},
    ownerSubjectIdForBindings: () => "boundary-owner",
    requireToken: () => undefined,
    resolveOwnerManifestFromScope: async () => ({
      manifest: { streams: [{ name: "attachments" }] },
      storageBinding: { connector_id: connectorId },
    }),
    resolveOwnerReadScope: async () => ({ source: null }),
    resolveReadRequestBindings: async () => ({
      bindings: [{ connectorId, connectorInstanceId: "blob-boundary-instance", displayName: null }],
      requestConnectionId: null,
      warnings: [],
    }),
  };
  mountRsBlobRead(
    app as unknown as Parameters<typeof mountRsBlobRead>[0],
    context as unknown as Parameters<typeof mountRsBlobRead>[1]
  );
  const req = {
    headers: range ? { range } : {},
    method,
    params: { blob_id: "blob_sha256_boundary" },
    path: "/v1/blobs/blob_sha256_boundary",
    query: {},
    tokenInfo: { pdpp_token_kind: "owner" },
  };
  const res = {
    json(body: unknown) {
      response.body = body;
      return response;
    },
    send(body: unknown) {
      response.body = body;
      return response;
    },
    setHeader(name: string, value: string) {
      response.headers.set(name.toLowerCase(), value);
      return response;
    },
    status(code: number) {
      response.statusCode = code;
      return res;
    },
  };
  return {
    errors,
    invoke: async () => {
      assert.ok(routeHandler, "blob route must register a handler");
      await routeHandler(req, res);
    },
    loadedRanges,
    response,
  };
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

test("BlobStore uses metadata-only and backend byte-range reads on SQLite", async () => {
  await withHarness(async () => {
    const blobId = "blob_sha256_store_range_001";
    const bytes = Buffer.from("0123456789", "utf8");
    exec(referenceQueries.blobsInsertBlob, [
      blobId,
      "blob-store-test",
      "blob-store-instance",
      "attachments",
      "range-1",
      "text/plain",
      bytes.length,
      "sha256-test",
      bytes,
    ]);

    const store = createBlobStore();
    const metadata = await store.loadContentAddressedBlobMetadata(blobId);
    assert.ok(metadata, "metadata lookup must find the blob");
    assert.equal(Object.hasOwn(metadata, "data"), false, "metadata lookup must not select blob bytes");

    const ranged = await store.loadContentAddressedBlob(blobId, { end: 5, start: 2 });
    assert.ok(ranged, "range lookup must find the blob");
    assert.deepEqual(Buffer.from(ranged.data ?? []), bytes.subarray(2, 6));
  });
});

test("blob route rejects oversized GET before its byte loader", async () => {
  const harness = makeBoundaryHarness({ method: "GET", size: MAX_BLOB_RESPONSE_BYTES + 1 });
  await harness.invoke();
  assert.deepEqual(harness.loadedRanges, [], "oversized GET must not load the blob row");
  assert.equal(harness.errors[0]?.code, "invalid_request");
});

test("blob route HEAD ignores Range and stays metadata-only", async () => {
  const headSize = MAX_BLOB_RESPONSE_BYTES + 1;
  const harness = makeBoundaryHarness({ method: "HEAD", range: "bytes=1-3", size: headSize });
  await harness.invoke();
  assert.deepEqual(harness.loadedRanges, [], "HEAD must not load the blob row");
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.response.statusCode, 200);
  assert.equal(harness.response.headers.get("content-length"), String(headSize));
  assert.equal(harness.response.headers.has("content-range"), false);
  assert.deepEqual(harness.response.body, Buffer.alloc(0));
});

test("blob route passes a valid GET range to the backend and emits the selected bytes", async () => {
  const harness = makeBoundaryHarness({ method: "GET", range: "bytes=1-3", size: 10 });
  await harness.invoke();
  assert.deepEqual(harness.loadedRanges, [{ end: 3, start: 1 }]);
  assert.equal(harness.errors.length, 0);
  assert.equal(harness.response.statusCode, 206);
  assert.equal(harness.response.headers.get("content-range"), "bytes 1-3/10");
  assert.equal(harness.response.headers.get("content-length"), "3");
  assert.deepEqual(harness.response.body, Buffer.from("123", "utf8"));
});
