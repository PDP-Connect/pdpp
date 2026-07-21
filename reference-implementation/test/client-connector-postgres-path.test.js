// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Real auth.js Postgres-adapter path proof for the registered-client,
 * CIMD-document, and connector-catalog row operations.
 *
 * The seam-march migration moves these row operations in `server/auth.js`
 * behind small, domain-local stores selected once per op via
 * `isPostgresStorageBackend()`:
 *   - getRegisteredClientStore()  (oauth_clients: upsert, getByClientId,
 *     listByIssuerSubject, countActiveTokensByClientId, deleteByClientId)
 *   - getCimdStore()              (cimd_client_documents: insert, getById,
 *     listAll)
 *   - getConnectorCatalogStore()  (connectors: upsert, listIds,
 *     getManifestById)
 *
 * The existing broad suite `postgres-runtime-storage.test.js` already drives
 * the registered-client and connector-catalog flows in Postgres mode, but the
 * CIMD-document operations (`createCimdDocument` / `getCimdDocument` /
 * `listCimdDocuments`) had ZERO Postgres-path coverage: `cimd.test.js` is
 * SQLite-only. This file closes that gap and additionally pins the
 * connector-manifest read (incl. the canonical-key fallback) and the
 * owner-issued client listing (incl. the per-client active-token count) so
 * every migrated store method executes its Postgres adapter under test.
 *
 * Concrete proof the Postgres adapters run: breaking any migrated Postgres
 * SELECT/INSERT/DELETE in the corresponding store turns the matching test red
 * (negative control). The whole file is gated on `PDPP_TEST_POSTGRES_URL`;
 * when unset it registers a single skipped test so default development and CI
 * do not need Postgres.
 *
 * Run (Compose Postgres proof service):
 *   PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@localhost:55467/pdpp_cli \
 *     node --test --import tsx \
 *     reference-implementation/test/client-connector-postgres-path.test.js
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createCimdDocument,
  deleteCimdDocument,
  deleteRegisteredClient,
  getCimdDocument,
  getConnectorManifest,
  getRegisteredClient,
  listCimdDocuments,
  listOwnerIssuedClients,
  listRegisteredConnectorIds,
  registerConnector,
  registerDynamicClient,
  seedPreRegisteredClients,
} from '../server/auth.js';
import { closeDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');

const SEED_CLIENT_ID = 'pg_path_client_connector_seed';

function loadSpotifyManifest() {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
  );
}

if (!POSTGRES_URL) {
  test(
    'auth.js client/cimd/connector postgres-adapter path (skipped: PDPP_TEST_POSTGRES_URL unset)',
    { skip: true },
    () => {},
  );
} else {
  // ---------------------------------------------------------------------
  // Shared setup. The SQLite handle is opened in-memory only so that auth.js
  // helpers which always touch SQLite (e.g. trace-context plumbing) have a
  // handle; every client / cimd / connector read and write routes to Postgres
  // because the active storage backend is postgres.
  // ---------------------------------------------------------------------
  let setupOk = false;

  test.before(async () => {
    initDb(':memory:');
    await initPostgresStorage({
      backend: 'postgres',
      databaseUrl: POSTGRES_URL,
    });
    setupOk = true;
  });

  test.after(async () => {
    await closePostgresStorage();
    closeDb();
  });

  // ---------------------------------------------------------------------
  // A) Connector catalog: registerConnector (connectors upsert) ->
  //    getConnectorManifest (getManifestById, incl. canonical fallback) ->
  //    listRegisteredConnectorIds (listIds).
  // ---------------------------------------------------------------------
  test('connector catalog: register -> read manifest -> list ids through real auth.js postgres adapters', async () => {
    assert.equal(setupOk, true, 'before() setup must have completed');

    const manifest = loadSpotifyManifest();
    const connectorId = await registerConnector(manifest);
    assert.ok(connectorId, 'registerConnector returns a connector_id (connectors upsert ran)');

    // getManifestById exact lookup via the Postgres `manifest::text` SELECT.
    const persisted = await getConnectorManifest(connectorId);
    assert.ok(persisted, 'getConnectorManifest returns the persisted manifest');
    assert.equal(persisted.connector_id, connectorId, 'persisted manifest connector_id matches');

    // getManifestById canonical fallback (the SECOND postgres SELECT in
    // getConnectorManifestRow): the spotify manifest stores under its canonical
    // key `spotify`, so a query by its registry-URL connector_id misses the
    // exact lookup, canonicalizes to `spotify` (which differs from the URL),
    // and resolves through the canonical-fallback Postgres SELECT.
    const registryUrlId = 'https://registry.pdpp.org/connectors/spotify';
    assert.notEqual(registryUrlId, connectorId, 'registry-URL id differs from the stored canonical id');
    const viaFallback = await getConnectorManifest(registryUrlId);
    assert.ok(viaFallback, 'canonical-key fallback resolves the registry-URL connector id');
    assert.equal(
      viaFallback.connector_id,
      connectorId,
      'fallback returns the canonical manifest (proves the second postgres SELECT ran)',
    );

    const ids = await listRegisteredConnectorIds();
    assert.ok(Array.isArray(ids), 'listRegisteredConnectorIds returns an array');
    assert.ok(ids.includes(connectorId), 'listed connector ids include the registered connector');
  });

  // ---------------------------------------------------------------------
  // B) CIMD document store: createCimdDocument (insert) -> getCimdDocument
  //    (getById) -> listCimdDocuments (listAll) -> deleteCimdDocument.
  //
  // This is the gap closed by this file: cimd.test.js never runs in Postgres
  // mode, so the postgres CIMD adapter had no automated coverage.
  // ---------------------------------------------------------------------
  test('cimd document: create -> read -> list -> delete through real auth.js postgres adapters', async () => {
    assert.equal(setupOk, true, 'before() setup must have completed');

    const redirectUris = ['https://app.example/callback', 'https://app.example/cb2'];
    const documentId = await createCimdDocument({
      clientName: 'PG Path CIMD App',
      redirectUris,
      logoUri: 'https://app.example/logo.png',
    });
    assert.ok(documentId, 'createCimdDocument returns a document_id (cimd insert ran)');

    // getById via the Postgres `redirect_uris::text` SELECT + JSON round-trip.
    const doc = await getCimdDocument(documentId);
    assert.ok(doc, 'getCimdDocument returns the stored document');
    assert.equal(doc.document_id, documentId, 'document_id round-trips');
    assert.equal(doc.client_name, 'PG Path CIMD App', 'client_name round-trips');
    assert.equal(doc.logo_uri, 'https://app.example/logo.png', 'logo_uri round-trips');
    assert.deepEqual(
      doc.redirect_uris,
      redirectUris,
      'redirect_uris round-trips through ::jsonb store + ::text read (proves the postgres CIMD adapter ran)',
    );

    // listAll via the Postgres SELECT ... ORDER BY created_at DESC.
    const listed = await listCimdDocuments();
    assert.ok(Array.isArray(listed), 'listCimdDocuments returns an array');
    const found = listed.find((d) => d.document_id === documentId);
    assert.ok(found, 'listed cimd documents include the created document');
    assert.deepEqual(found.redirect_uris, redirectUris, 'listed document redirect_uris round-trips');

    // deleteCimdDocument (no clientId) deletes via the Postgres DELETE and the
    // subsequent getById returns null.
    await deleteCimdDocument(documentId);
    const afterDelete = await getCimdDocument(documentId);
    assert.equal(afterDelete, null, 'deleted cimd document is no longer readable');
  });

  // ---------------------------------------------------------------------
  // C) Registered client store: registerDynamicClient (oauth_clients upsert)
  //    -> getRegisteredClient (getByClientId) -> listOwnerIssuedClients
  //    (listByIssuerSubject + countActiveTokensByClientId) ->
  //    deleteRegisteredClient (deleteByClientId).
  // ---------------------------------------------------------------------
  test('registered client: register -> read -> owner-list -> delete through real auth.js postgres adapters', async () => {
    assert.equal(setupOk, true, 'before() setup must have completed');

    const ownerSubject = 'owner_pg_path_client';
    const dcr = await registerDynamicClient(
      { client_name: 'PG Path Dynamic Client', redirect_uris: ['https://dyn.example/cb'] },
      { issuer_subject_id: ownerSubject },
    );
    const clientId = dcr.client_id;
    assert.ok(clientId, 'registerDynamicClient returns a client_id (oauth_clients upsert ran)');

    // getByClientId via the Postgres `metadata_json::text` SELECT.
    const fetched = await getRegisteredClient(clientId);
    assert.ok(fetched, 'getRegisteredClient returns the registered client');
    assert.equal(fetched.client_id, clientId, 'client_id round-trips');
    assert.equal(fetched.registration_mode, 'dynamic', 'registration_mode is dynamic');
    assert.equal(
      fetched.metadata.issuer_subject_id,
      ownerSubject,
      'issuer_subject_id stamp round-trips through the metadata_json store + read',
    );

    // listByIssuerSubject + countActiveTokensByClientId via the Postgres
    // SELECT ... WHERE metadata_json->>'issuer_subject_id' = $1 and the
    // per-client COUNT(*) ... WHERE revoked = FALSE.
    const ownerClients = await listOwnerIssuedClients(ownerSubject);
    assert.ok(Array.isArray(ownerClients), 'listOwnerIssuedClients returns an array');
    const ownerEntry = ownerClients.find((c) => c.client_id === clientId);
    assert.ok(ownerEntry, 'owner-issued listing includes the registered dynamic client');
    assert.equal(ownerEntry.client_name, 'PG Path Dynamic Client', 'listed client_name matches');
    assert.equal(
      ownerEntry.active_token_count,
      0,
      'freshly-registered client has zero active tokens (per-client COUNT adapter ran)',
    );

    // A different owner subject must NOT see this client (proves the
    // WHERE metadata_json->>... filter is honored on the Postgres path).
    const otherOwnerClients = await listOwnerIssuedClients('some_other_owner');
    assert.ok(
      !otherOwnerClients.some((c) => c.client_id === clientId),
      'a different owner subject does not see the client',
    );

    // deleteByClientId via the Postgres DELETE; subsequent read returns null.
    await deleteRegisteredClient(clientId, { actingSubjectId: ownerSubject });
    const afterDelete = await getRegisteredClient(clientId);
    assert.equal(afterDelete, null, 'deleted dynamic client is no longer readable');
  });

  // ---------------------------------------------------------------------
  // D) seedPreRegisteredClients upserts a pre-registered client row through
  //    the registered-client store upsert (Postgres ON CONFLICT path), and
  //    getRegisteredClient reads it back.
  // ---------------------------------------------------------------------
  test('seed pre-registered client: upsert -> read through real auth.js postgres adapters', async () => {
    assert.equal(setupOk, true, 'before() setup must have completed');

    await seedPreRegisteredClients([
      {
        client_id: SEED_CLIENT_ID,
        client_name: 'PG Path Seed',
        registration_mode: 'pre_registered_public',
      },
    ]);
    const seeded = await getRegisteredClient(SEED_CLIENT_ID);
    assert.ok(seeded, 'seeded pre-registered client is readable');
    assert.equal(seeded.client_id, SEED_CLIENT_ID, 'seeded client_id matches');
    assert.equal(
      seeded.registration_mode,
      'pre_registered_public',
      'seeded registration_mode matches',
    );
  });
}
