// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateResponse } from "@pdpp/reference-contract";
// biome-ignore lint/correctness/noUnresolvedImports: Node and TypeScript resolve this declared runtime dependency.
import Database from "better-sqlite3";

import {
  initiateGrant,
  parsePendingConsentRequestUri,
  registerConnector,
  seedPreRegisteredClients,
} from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { closePostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { createSqliteAcceptedSourceDeclarationRevisionStore } from "../server/source-declaration-trust/revision-store.ts";
import { retrieveAndAcceptProviderNativeDeclaration } from "../server/source-declaration-trust/service.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { withTemporaryPostgresDatabase } from "./helpers/postgres-temp-database.ts";

const CLIENT_ID = "accepted_revision_consent_client";
const POINTER = "https://declarations.example.test/northstar/current.json";
const AUTHORITY = "metadata:https://northstar.example/pdpp";
const NOT_FOUND_RE = /not found/;
const PUBLISHER_ATTRIBUTION_RE = /Publisher attribution/;
const RESOURCE_AUTHORITY_RE = /Resource authority/;
const UNVERIFIED_RE = /unverified/;

interface TestServerHandle {
  asPort: number;
  asServer: { close: (callback: () => void) => void; closeAllConnections?: () => void };
  rsServer: { close: (callback: () => void) => void; closeAllConnections?: () => void };
}

interface ValidatedTestDeclaration extends Record<string, unknown> {
  declaration_version: string;
  source: { id: string; kind: string };
}

function streamBody(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

async function closeServer(server: TestServerHandle): Promise<void> {
  server.asServer.closeAllConnections?.();
  server.rsServer.closeAllConnections?.();
  const close = (value: TestServerHandle["asServer"]) => new Promise<void>((resolve) => value.close(resolve));
  await Promise.allSettled([close(server.asServer), close(server.rsServer)]);
}

async function jsonPost(url: string, body: unknown): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    method: "POST",
  });
  return { body: (await response.json()) as Record<string, unknown>, status: response.status };
}

test("HTTP consent consumes one accepted provider-native revision without discovery refetch", async () => {
  const revisionDatabase = new Database(":memory:");
  const revisionStore = createSqliteAcceptedSourceDeclarationRevisionStore(revisionDatabase);
  const nativeManifest = JSON.parse(
    readFileSync(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  const declarationA = structuredClone(nativeManifest.source_declaration) as ValidatedTestDeclaration;
  declarationA.declaration_version = "accepted:northstar:a";
  const declarationB = structuredClone(declarationA);
  declarationB.declaration_version = "accepted:northstar:b";
  declarationB.display = { name: "Northstar HR revision B" };
  const sourceId = (declarationA.source as Record<string, unknown>).id as string;
  let liveDeclaration = declarationA;
  let retrievalOnline = true;
  const retrievalDependencies = {
    fetch: () => {
      if (!retrievalOnline) {
        throw new Error("discovery is offline");
      }
      return Promise.resolve({ body: streamBody(JSON.stringify(liveDeclaration)), status: 200 });
    },
    resolveDns: () => Promise.resolve(["203.0.113.4"]),
    revisionStore,
    validateAddress: () => Promise.resolve(true),
    validateDeclaration: (value: unknown) => ({ declaration: value as typeof declarationA, ok: true as const }),
  };
  const acceptedA = await retrieveAndAcceptProviderNativeDeclaration(
    { acceptedPointer: POINTER, authorityBinding: AUTHORITY, expectedSourceId: sourceId },
    retrievalDependencies,
    { maxAddresses: 4, maxBytes: 65_536, maxRedirects: 1, timeoutMs: 1000 }
  );
  assert.equal(acceptedA.ok, true);
  if (!acceptedA.ok) {
    assert.fail("revision A was not accepted");
  }

  const fulfillmentManifest = { ...nativeManifest, source_declaration: declarationB };
  const server = (await startServer({
    acceptedProviderNativeRevision: {
      acceptedRevisionReference: acceptedA.acceptedRevisionReference,
      revisionStore,
      sourceId,
    },
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest: fulfillmentManifest,
    quiet: true,
    rsPort: 0,
  })) as TestServerHandle;
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await seedPreRegisteredClients([
      { client_id: CLIENT_ID, client_name: "Accepted revision consent", registration_mode: "pre_registered_public" },
    ]);
    const par = await jsonPost(`${asUrl}/oauth/par`, {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          source: { id: sourceId, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    });
    assert.equal(par.status, 201, JSON.stringify(par.body));
    assert.equal(typeof par.body.request_uri, "string");

    liveDeclaration = declarationB;
    const acceptedB = await retrieveAndAcceptProviderNativeDeclaration(
      { acceptedPointer: POINTER, authorityBinding: AUTHORITY, expectedSourceId: sourceId },
      retrievalDependencies,
      { maxAddresses: 4, maxBytes: 65_536, maxRedirects: 1, timeoutMs: 1000 }
    );
    assert.equal(acceptedB.ok, true);
    retrievalOnline = false;

    const review = await jsonPost(`${asUrl}/consent/review`, {
      request_uri: par.body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(review.status, 200, JSON.stringify(review.body));
    const artifact = review.body.approval_review as Record<string, unknown>;
    const declarationEvidence = artifact.source_declaration as Record<string, unknown>;
    assert.equal(declarationEvidence.version, "accepted:northstar:a");
    assert.equal(declarationEvidence.accepted_revision_reference, acceptedA.acceptedRevisionReference);
    assert.deepEqual(declarationEvidence.resource_authority, { authority_binding: AUTHORITY, status: "verified" });
    assert.deepEqual(declarationEvidence.publisher_attribution, {
      id: (declarationA.publisher as Record<string, unknown>).id,
      status: "unverified",
    });
    for (const malformed of [
      { ...declarationEvidence, accepted_revision_reference: undefined },
      {
        ...declarationEvidence,
        resource_authority: { status: "local_operator_provisioned" },
      },
    ]) {
      const malformedArtifact = { ...artifact, source_declaration: malformed };
      const validation = validateResponse("reviewConsent", {
        body: { ...review.body, approval_review: malformedArtifact },
        status: 200,
      });
      assert.equal(validation.ok, false, "partial or mixed provider-native evidence must fail the public contract");
    }
    const resumed = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(String(par.body.request_uri))}`);
    const resumedHtml = await resumed.text();
    assert.equal(resumed.status, 200, resumedHtml);
    assert.match(resumedHtml, RESOURCE_AUTHORITY_RE);
    assert.match(resumedHtml, new RegExp(`Verified \\(${AUTHORITY.replaceAll(".", "\\.")}\\)`));
    assert.match(resumedHtml, PUBLISHER_ATTRIBUTION_RE);
    assert.match(resumedHtml, UNVERIFIED_RE);
    assert.match(resumedHtml, new RegExp(acceptedA.acceptedRevisionReference.replaceAll(".", "\\.")));

    const approved = await jsonPost(`${asUrl}/consent/approve`, {
      approval_review_revision: review.body.approval_review_revision,
      request_uri: par.body.request_uri,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const grant = approved.body.grant as Record<string, unknown>;
    assert.deepEqual(grant.source_declaration, { version: "accepted:northstar:a" });
    assert.equal(JSON.stringify(grant).includes("accepted_revision_reference"), false);

    const grantId = grant.grant_id as string;
    const events = getDb()
      .prepare(
        "SELECT data_json FROM spine_events WHERE grant_id = ? AND event_type IN ('consent.approved', 'grant.issued')"
      )
      .all(grantId) as Array<{ data_json: string }>;
    assert.equal(events.length, 2);
    for (const event of events) {
      const evidence = (JSON.parse(event.data_json).source_declaration_snapshot ?? {}) as Record<string, unknown>;
      assert.equal(evidence.declaration_version, "accepted:northstar:a");
      assert.equal(evidence.accepted_revision_reference, acceptedA.acceptedRevisionReference);
      assert.deepEqual(evidence.resource_authority, { authority_binding: AUTHORITY, status: "verified" });
    }

    const spotify = JSON.parse(readFileSync(new URL("../fixtures/seed-manifests/spotify.json", import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
    await registerConnector(spotify);
    const unrelated = await jsonPost(`${asUrl}/oauth/par`, {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: "https://registry.pdpp.dev/connectors/spotify", kind: "connector" },
          streams: [{ name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    });
    assert.equal(unrelated.status, 201, JSON.stringify(unrelated.body));

    const tampered = await jsonPost(`${asUrl}/oauth/par`, {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/financial_planning",
          source: { id: sourceId, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: CLIENT_ID,
    });
    assert.equal(tampered.status, 201, JSON.stringify(tampered.body));
    const deviceCode = parsePendingConsentRequestUri(tampered.body.request_uri);
    assert.ok(deviceCode);
    const row = getDb().prepare("SELECT params_json FROM pending_consents WHERE device_code = ?").get(deviceCode) as {
      params_json: string;
    };
    const params = JSON.parse(row.params_json) as Record<string, unknown>;
    const snapshot = params.source_declaration_snapshot as Record<string, unknown>;
    snapshot.accepted_revision_reference = `${acceptedA.acceptedRevisionReference}:tampered`;
    getDb()
      .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
      .run(JSON.stringify(params), deviceCode);
    const rejectedReview = await jsonPost(`${asUrl}/consent/review`, {
      request_uri: tampered.body.request_uri,
      subject_id: "owner_local",
    });
    assert.equal(rejectedReview.status, 400);
    assert.equal((rejectedReview.body.error as Record<string, unknown>).code, "invalid_request");

    await assert.rejects(
      initiateGrant(
        {
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/financial_planning",
              source: { id: sourceId, kind: "provider_native" },
              streams: [{ name: "pay_statements" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: CLIENT_ID,
        },
        {
          acceptedRevisionReference: "urn:pdpp:accepted-source-declaration:missing",
          acceptedRevisionStore: revisionStore,
          nativeManifest: fulfillmentManifest,
          nativeManifestMode: "fulfillment_only",
        }
      ),
      NOT_FOUND_RE
    );
  } finally {
    await closeServer(server);
    revisionDatabase.close();
  }
});

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

if (POSTGRES_URL) {
  test("PostgreSQL HTTP consent persists accepted revision review and audit evidence", async () => {
    await withTemporaryPostgresDatabase(
      {
        closeConnections: closePostgresStorage,
        connectionString: POSTGRES_URL,
        databaseName: `pdpp_test_accepted_bridge_${process.pid.toString(16).padStart(8, "0").slice(-8)}_1`,
      },
      async (databaseUrl) => {
        const revisionDatabase = new Database(":memory:");
        const revisionStore = createSqliteAcceptedSourceDeclarationRevisionStore(revisionDatabase);
        const nativeManifest = JSON.parse(
          readFileSync(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url), "utf8")
        ) as Record<string, unknown>;
        const declaration = structuredClone(nativeManifest.source_declaration) as ValidatedTestDeclaration;
        declaration.declaration_version = "accepted:northstar:postgres";
        const sourceId = (declaration.source as Record<string, unknown>).id as string;
        const accepted = await retrieveAndAcceptProviderNativeDeclaration(
          { acceptedPointer: POINTER, authorityBinding: AUTHORITY, expectedSourceId: sourceId },
          {
            fetch: () => Promise.resolve({ body: streamBody(JSON.stringify(declaration)), status: 200 }),
            resolveDns: () => Promise.resolve(["203.0.113.4"]),
            revisionStore,
            validateAddress: () => Promise.resolve(true),
            validateDeclaration: (value: unknown) => ({ declaration: value as typeof declaration, ok: true as const }),
          },
          { maxAddresses: 4, maxBytes: 65_536, maxRedirects: 1, timeoutMs: 1000 }
        );
        assert.equal(accepted.ok, true);
        if (!accepted.ok) {
          assert.fail("PostgreSQL fixture revision was not accepted");
        }
        let server: TestServerHandle | null = null;
        try {
          server = (await startServer({
            acceptedProviderNativeRevision: {
              acceptedRevisionReference: accepted.acceptedRevisionReference,
              revisionStore,
              sourceId,
            },
            asPort: 0,
            databaseUrl,
            dbPath: ":memory:",
            nativeManifest: { ...nativeManifest, source_declaration: declaration },
            quiet: true,
            rsPort: 0,
            startClientEventDeliveryWorker: false,
            storageBackend: "postgres",
          })) as TestServerHandle;
          await seedPreRegisteredClients([
            {
              client_id: CLIENT_ID,
              client_name: "Accepted revision consent",
              registration_mode: "pre_registered_public",
            },
          ]);
          const asUrl = `http://localhost:${server.asPort}`;
          const par = await jsonPost(`${asUrl}/oauth/par`, {
            authorization_details: [
              {
                access_mode: "continuous",
                purpose_code: "https://pdpp.dev/purpose/financial_planning",
                source: { id: sourceId, kind: "provider_native" },
                streams: [{ name: "pay_statements" }],
                type: "https://pdpp.dev/data-access",
              },
            ],
            client_id: CLIENT_ID,
          });
          assert.equal(par.status, 201, JSON.stringify(par.body));
          const review = await jsonPost(`${asUrl}/consent/review`, {
            request_uri: par.body.request_uri,
            subject_id: "owner_local",
          });
          if (review.status !== 200) {
            const pending = await postgresQuery<{ params_json: Record<string, unknown> }>(
              "SELECT params_json FROM pending_consents ORDER BY created_at DESC LIMIT 1"
            );
            assert.equal(review.status, 200, JSON.stringify({ error: review.body, pending: pending.rows[0] }));
          }
          const sourceDeclaration = (review.body.approval_review as Record<string, unknown>)
            .source_declaration as Record<string, unknown>;
          assert.equal(sourceDeclaration.accepted_revision_reference, accepted.acceptedRevisionReference);
          const approved = await jsonPost(`${asUrl}/consent/approve`, {
            approval_review_revision: review.body.approval_review_revision,
            request_uri: par.body.request_uri,
          });
          assert.equal(approved.status, 200, JSON.stringify(approved.body));
          const grant = approved.body.grant as Record<string, unknown>;
          const events = await postgresQuery<{ data_json: Record<string, unknown> }>(
            "SELECT data_json FROM spine_events WHERE grant_id = $1 AND event_type IN ('consent.approved', 'grant.issued')",
            [grant.grant_id]
          );
          assert.equal(events.rows.length, 2);
          for (const event of events.rows) {
            const evidence = event.data_json.source_declaration_snapshot as Record<string, unknown>;
            assert.equal(evidence.accepted_revision_reference, accepted.acceptedRevisionReference);
            assert.equal(evidence.declaration_version, "accepted:northstar:postgres");
          }
        } finally {
          if (server) {
            await closeServer(server);
          }
          await closePostgresStorage();
          revisionDatabase.close();
        }
      }
    );
  });
}
