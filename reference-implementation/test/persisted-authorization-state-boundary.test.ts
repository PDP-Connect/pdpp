// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { requirePersistedGrantState } from "../server/auth.ts";
import { closeDb, getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { introspectionHeaders } from "./helpers/introspection.ts";
import { TEST_RS_INTROSPECTION_CREDENTIALS } from "./helpers/introspection-test-credentials.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const V01_LEGACY_BYTES = readFileSync(join(TEST_DIR, "seam-spike/fixtures/pr89/legacy-grant-v01.bytes"), "utf8").trim();

type TestServer = Awaited<ReturnType<typeof startServer>> & {
  asServer: { close: (callback: () => void) => void; closeAllConnections: () => void };
  rsServer: { close: (callback: () => void) => void; closeAllConnections: () => void };
};

async function closeServer(server: TestServer): Promise<void> {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise<void>((resolve) => server.asServer.close(resolve)),
    new Promise<void>((resolve) => server.rsServer.close(resolve)),
  ]);
  closeDb();
}

function errorCode(body: unknown): string | undefined {
  if (!(body && typeof body === "object" && "error" in body)) {
    return;
  }
  const { error } = body as { error?: unknown };
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code?: string }).code;
  }
  return typeof error === "string" ? error : undefined;
}

test("pre-contract persisted bytes are rejected by the current grant reader", () => {
  assert.throws(
    () => requirePersistedGrantState({ grant_json: V01_LEGACY_BYTES, storage_binding_json: null }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "authorization_state.unsupported_legacy_shape");
      return true;
    }
  );
});

test("legacy persisted grant state fails before the SQLite RS route", async () => {
  const server = (await startServer({
    asPort: 0,
    dbPath: ":memory:",
    introspectionCallerCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    quiet: true,
    rsIntrospectionCredentials: TEST_RS_INTROSPECTION_CREDENTIALS,
    rsPort: 0,
  })) as TestServer;
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const token = "tok_legacy_authorization_state";
  const db = getDb();
  db.prepare(
    `INSERT INTO grants(
       grant_id, subject_id, client_id, storage_binding_json, grant_json,
       access_mode, status, consumed, issued_at
     ) VALUES (?, ?, ?, NULL, ?, 'continuous', 'active', FALSE, ?)`
  ).run("grt_legacy", "owner_local", "legacy_client", V01_LEGACY_BYTES, "2026-08-11T12:00:00Z");
  db.prepare(
    `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at, revoked)
     VALUES (?, ?, ?, ?, 'client', NULL, FALSE)`
  ).run(token, "grt_legacy", "owner_local", "legacy_client");

  try {
    const introspection = await fetch(`${asUrl}/introspect`, {
      body: new URLSearchParams({ token }).toString(),
      headers: introspectionHeaders("application/x-www-form-urlencoded"),
      method: "POST",
    });
    assert.equal(introspection.status, 200);
    const introspectionBody = (await introspection.json()) as Record<string, unknown>;
    assert.equal(introspectionBody.active, false);
    assert.equal(introspectionBody.aud, rsUrl);
    assert.equal(introspectionBody.client_id, "legacy_client");
    assert.equal(introspectionBody.grant_id, "grt_legacy");
    assert.equal(introspectionBody.inactive_reason, "authorization_state.unsupported_legacy_shape");
    assert.equal(introspectionBody.subject_id, "owner_local");
    assert.equal(new URL(String(introspectionBody.iss)).port, String(server.asPort));

    const route = await fetch(`${rsUrl}/v1/schema`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(route.status, 401);
    assert.equal(errorCode(await route.json()), "authorization_state.unsupported_legacy_shape");
  } finally {
    await closeServer(server);
  }
});
