// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Introspection uses the closed resolved grant as authorization authority.
 * Removing the mutable manifest catalog after issuance must not deactivate or
 * reinterpret a valid grant. SQLite runs everywhere. Postgres runs only when
 * PDPP_TEST_POSTGRES_URL is set.
 */

import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { introspect, registerConnector } from "../server/auth.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;
const CONNECTOR_ID = "introspection_fail_closed";
const DECLARATION_VERSION = "introspection-fail-closed-declaration-v1";
const INSTANCE_ID = "cin_introspection_fail_closed";
const SOURCE_ID = "https://registry.pdpp.dev/connectors/introspection-fail-closed";
const SUBJECT_ID = "introspection_subject";
const CLIENT_ID = "introspection_client";

const MANIFEST = {
  connector_id: CONNECTOR_ID,
  display_name: "Introspection fail closed fixture",
  manifest_uri: "https://implementations.example/connectors/introspection-fail-closed",
  protocol_version: "0.1.0",
  source_declaration: {
    declaration_version: DECLARATION_VERSION,
    display: { name: "Introspection fail closed fixture" },
    protocol_version: "0.1.0",
    publisher: { id: "https://pdpp.dev/reference-implementation/tests" },
    source: { id: SOURCE_ID, kind: "connector" },
    streams: [
      {
        name: "items",
        primary_key: ["id"],
        schema: { properties: { id: { type: "string" } }, type: "object" },
        selection: { fields: true, resources: true },
      },
    ],
  },
  streams: [
    {
      name: "items",
      primary_key: ["id"],
      schema: { properties: { id: { type: "string" } }, type: "object" },
      selection: { fields: true, resources: true },
    },
  ],
  version: "1.0.0",
};

type Backend = "sqlite" | "postgres";

function persistedGrant(grantId: string): string {
  return JSON.stringify({
    access_mode: "continuous",
    client: { client_id: CLIENT_ID },
    grant_id: grantId,
    issued_at: new Date().toISOString(),
    purpose_code: "https://pdpp.dev/purpose/analytics",
    source: { id: SOURCE_ID, kind: "connector" },
    source_declaration: { version: DECLARATION_VERSION },
    streams: [{ fields: ["id"], instance_ids: [INSTANCE_ID], name: "items" }],
    subject: { id: SUBJECT_ID },
    version: "0.1.0",
  });
}

async function seedGrantToken(backend: Backend, grantId: string, tokenId: string): Promise<void> {
  const storageBinding = JSON.stringify({ connector_id: CONNECTOR_ID });
  const grantJson = persistedGrant(grantId);
  const issuedAt = new Date().toISOString();
  if (backend === "postgres") {
    await postgresQuery(
      `INSERT INTO grants(
         grant_id, subject_id, client_id, storage_binding_json, grant_json,
         access_mode, issued_at
       ) VALUES($1, $2, $3, $4::jsonb, $5::jsonb, 'continuous', $6)`,
      [grantId, SUBJECT_ID, CLIENT_ID, storageBinding, grantJson, issuedAt]
    );
    await postgresQuery(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind)
       VALUES($1, $2, $3, $4, 'client')`,
      [tokenId, grantId, SUBJECT_ID, CLIENT_ID]
    );
    return;
  }
  getDb()
    .prepare(`
    INSERT INTO grants(
      grant_id, subject_id, client_id, storage_binding_json, grant_json,
      access_mode, issued_at
    ) VALUES(?, ?, ?, ?, ?, 'continuous', ?)
  `)
    .run(grantId, SUBJECT_ID, CLIENT_ID, storageBinding, grantJson, issuedAt);
  getDb()
    .prepare(`
    INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind)
    VALUES(?, ?, ?, ?, 'client')
  `)
    .run(tokenId, grantId, SUBJECT_ID, CLIENT_ID);
}

async function removeLiveManifestCatalog(backend: Backend): Promise<void> {
  if (backend === "postgres") {
    await postgresQuery("ALTER TABLE connectors RENAME TO connectors_unavailable");
    return;
  }
  getDb().exec("DROP TABLE connectors");
}

async function runSnapshotAuthorityCases(t: TestContext, backend: Backend): Promise<void> {
  initDb(":memory:");
  if (backend === "postgres") {
    assert.ok(POSTGRES_URL, "Postgres URL is configured for the Postgres case");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
  }
  try {
    await registerConnector(MANIFEST);
    const grantId = `grant_introspection_${backend}`;
    const tokenId = `token_introspection_${backend}`;
    await seedGrantToken(backend, grantId, tokenId);

    await t.test("a valid grant introspects active before any fault", async () => {
      const result = await introspect(tokenId);
      assert.equal(result.active, true);
    });

    await t.test("manifest catalog removal does not replace the resolved grant authority", async () => {
      await removeLiveManifestCatalog(backend);
      const result = await introspect(tokenId);
      assert.equal(result.active, true);
      const grant = result.grant as { source_declaration?: { version?: string } } | undefined;
      assert.equal(grant?.source_declaration?.version, DECLARATION_VERSION);
    });
  } finally {
    if (backend === "postgres") {
      await closePostgresStorage();
    }
    closeDb();
  }
}

test("SQLite introspection keeps the issued declaration snapshot authoritative", async (t) => {
  await runSnapshotAuthorityCases(t, "sqlite");
});

test("Postgres introspection keeps the issued declaration snapshot authoritative", {
  skip: !POSTGRES_URL,
}, async (t) => {
  await runSnapshotAuthorityCases(t, "postgres");
});
