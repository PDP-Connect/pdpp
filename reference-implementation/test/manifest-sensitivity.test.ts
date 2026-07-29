// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation + resolution coverage for connector manifest `sensitivity`.
 *
 * `sensitivity: "standard" | "sensitive"` is the manifest-declared,
 * owner-facing source classification the batch consent ceremony reads for its
 * cumulative-risk header and approve-all suppression conditions (O5 owner
 * default in `implement-batch-consent-ceremony`). The registry accepts the
 * field, rejects malformed values, defaults absence to `standard`, and consults
 * no hardcoded source list.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveManifestSensitivity } from "../server/connector-manifest-validation.ts";
import { startServer } from "../server/index.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn: (harness: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface RegisterResult {
  body: ErrorBody | string | null;
  status: number;
}

function hasErrorBody(body: RegisterResult["body"]): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

async function registerConnectorManifest(asUrl: string, manifest: unknown): Promise<RegisterResult> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  let body: RegisterResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

function makeManifest(extra: Record<string, unknown> = {}) {
  return {
    connector_id: "https://registry.pdpp.test/connectors/sensitivity-fixture",
    display_name: "Sensitivity fixture",
    protocol_version: "0.1.0",
    streams: [
      {
        cursor_field: "received_at",
        name: "notes",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            received_at: { format: "date-time", type: "string" },
          },
          required: ["id", "received_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
    ...extra,
  };
}

test('manifest declaring sensitivity "sensitive" is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest({ sensitivity: "sensitive" }));
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test('manifest declaring sensitivity "standard" is accepted', async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest({ sensitivity: "standard" }));
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest omitting sensitivity is accepted (resolves to standard default)", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest());
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest with an unsupported sensitivity value is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest({ sensitivity: "top_secret" }));
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /sensitivity must be "standard" or "sensitive"/u);
  });
});

test("resolveManifestSensitivity defaults absence to standard and consults no hardcoded list", () => {
  // Absent → standard.
  assert.equal(resolveManifestSensitivity({}), "standard");
  assert.equal(resolveManifestSensitivity({ sensitivity: undefined }), "standard");
  // A connector whose name resembles a "sensitive" source is still standard
  // unless its manifest declares it — no hardcoded source list.
  assert.equal(resolveManifestSensitivity({ connector_key: "gmail" }), "standard");
  assert.equal(resolveManifestSensitivity({ connector_key: "usaa" }), "standard");
  // Declared sensitive → sensitive.
  assert.equal(resolveManifestSensitivity({ sensitivity: "sensitive" }), "sensitive");
  // Any non-`sensitive` value resolves to the standard default.
  assert.equal(resolveManifestSensitivity({ sensitivity: "standard" }), "standard");
});
