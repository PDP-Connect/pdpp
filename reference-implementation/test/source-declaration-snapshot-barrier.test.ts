// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  approveGrant,
  configureNativeManifest,
  createHostedMcpGrantPackage,
  getGrantPackageAccess,
  getPendingConsent,
  initiateGrant,
  introspect,
  issueToken,
  parsePendingConsentRequestUri,
  registerConnector,
  requireResolvedPersistedGrantState,
} from "../server/auth.ts";
import { getDb } from "../server/db.ts";
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from "../server/stores/connector-instance-store.ts";
import { createSqliteConsentDeviceAuthDriver } from "./helpers/sqlite-consent-device-auth-driver.ts";

interface PendingPayload {
  source_declaration_snapshot: {
    declaration: {
      declaration_version: string;
      extensions?: Record<string, { connector?: { id?: string; version?: string } }>;
      publisher: { id: string };
      source: { id: string; kind: string };
      streams: Record<string, unknown>[];
    };
    accepted_revision_reference?: string;
    declaration_version: string;
    publisher_attribution?: { id: string; status: "unverified" };
    resource_authority?: {
      authority_binding?: string;
      status: "local_operator_provisioned" | "verified";
    };
    snapshot_version: string;
    source: { id: string; kind: string };
  };
}

interface ResolvedStream {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string };
}

const MISSING_SNAPSHOT_RE = /declaration snapshot is missing/;
const INVALID_DECLARATION_RE = /Invalid SourceDeclaration/;
const DECLARATION_METADATA_MISMATCH_RE = /snapshot metadata does not match its bytes/;
const SNAPSHOT_SHAPE_RE = /snapshot shape is unsupported/;
const SNAPSHOT_DERIVATION_RE = /not derivable from the retained declaration/;
const INELIGIBLE_INSTANCE_RE = /does not exist|not found|not active|does not belong/;
const LEGACY_CONNECTION_ID_RE = /additional properties|Unsupported stream selection fields.*connection_id/;
const NO_ACTIVE_INSTANCE_RE = /exactly one eligible instance.*found 0/;
const MULTIPLE_ACTIVE_INSTANCES_RE = /exactly one eligible instance.*found 2/;
const MULTIPLE_LOCAL_BINDINGS_RE = /multiple local fulfillment bindings/;
const PURPOSE_CODE_RE = /purpose_code/;
const INVALID_TIME_RANGE_RE = /source\.selection\.invalid_time_range/;
const COMPOUND_RESOURCE_RE = /compound resource key has the wrong shape/;
const INVALID_NATIVE_INSTANCE_RE = /must equal its configured local instance/;
const GRANT_BINDING_RE = /Grant is malformed|grant/i;
const PROJECTED_DECLARATION_VERSION_RE = /^reference\.legacy-connector-projection\.v1:sha256:[0-9a-f]{64}$/;

function loadNativeManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL("../fixtures/seed-manifests/northstar-hr.json", import.meta.url), "utf8"));
}

async function seedActiveSpotifyInstance(connectorInstanceId: string, account: string): Promise<void> {
  const now = new Date().toISOString();
  await createSqliteConnectorInstanceStore().upsert({
    connectorId: "spotify",
    connectorInstanceId,
    createdAt: now,
    displayName: account,
    ownerSubjectId: "owner_local",
    sourceBinding: { account },
    sourceBindingKey: account,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

function customCoreSourceManifest(connectorKey: string, sourceId: string): Record<string, unknown> {
  const streams = [
    {
      name: "items",
      primary_key: ["id"],
      schema: {
        properties: { id: { type: "string" }, label: { type: "string" } },
        required: ["id"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ];
  return {
    capabilities: { human_interaction: [] },
    connector_id: connectorKey,
    connector_key: connectorKey,
    display_name: "Custom Core source",
    manifest_uri: `https://implementations.example/connectors/${connectorKey}`,
    protocol_version: "0.1.0",
    source_declaration: {
      declaration_version: `${connectorKey}-declaration-v1`,
      display: { name: "Custom Core source" },
      protocol_version: "0.1.0",
      publisher: { id: "https://publishers.example/source-tests" },
      source: { id: sourceId, kind: "connector" },
      streams,
    },
    streams,
    version: "1.0.0",
  };
}

test("source declaration snapshot survives same-version replacement and deletion through issuance and evidence", async () => {
  const driver = createSqliteConsentDeviceAuthDriver();
  await driver.setup();
  try {
    await seedActiveSpotifyInstance("cin_spotify_primary", "primary@example.com");
    const started = await driver.startPendingConsent({
      streams: [
        {
          fields: ["genres"],
          name: "top_artists",
          resources: ["artist-1"],
          time_range: { since: "2026-01-01T00:00:00Z" },
        },
      ],
    });
    const deviceCode = parsePendingConsentRequestUri(started.request_uri);
    assert.ok(deviceCode);

    const pendingRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(deviceCode) as { params_json: string };
    const retained = JSON.parse(pendingRow.params_json) as PendingPayload;
    const registeredManifestRow = getDb()
      .prepare("SELECT manifest FROM connectors WHERE connector_id = ?")
      .get("spotify") as { manifest: string };
    const registeredManifest = JSON.parse(registeredManifestRow.manifest) as Record<string, unknown>;
    const projectedDeclarationVersion = retained.source_declaration_snapshot.declaration_version;
    assert.match(projectedDeclarationVersion, PROJECTED_DECLARATION_VERSION_RE);
    assert.equal(retained.source_declaration_snapshot.snapshot_version, "reference.source-declaration-snapshot.v1");
    assert.equal(retained.source_declaration_snapshot.declaration_version, projectedDeclarationVersion);
    assert.deepEqual(retained.source_declaration_snapshot.source, {
      id: driver.getRegisteredConnectorId(),
      kind: "connector",
    });
    assert.deepEqual(retained.source_declaration_snapshot.declaration.source, {
      id: driver.getRegisteredConnectorId(),
      kind: "connector",
    });
    assert.deepEqual(retained.source_declaration_snapshot.declaration.publisher, {
      id: "https://pdpp.dev/reference-implementation",
    });
    assert.equal(
      retained.source_declaration_snapshot.declaration.declaration_version,
      retained.source_declaration_snapshot.declaration_version
    );
    assert.equal("connector_id" in retained.source_declaration_snapshot.declaration, false);
    assert.equal("version" in retained.source_declaration_snapshot.declaration, false);

    const collectionExtension =
      retained.source_declaration_snapshot.declaration.extensions?.["https://pdpp.dev/profile/collection"];
    assert.ok(collectionExtension);
    assert.deepEqual(collectionExtension.connector, {
      id: registeredManifest.manifest_uri,
      version: registeredManifest.version,
    });

    const replacement = structuredClone(retained.source_declaration_snapshot.declaration) as Record<string, unknown>;
    const replacementStreams = replacement.streams as Record<string, unknown>[];
    replacementStreams[0] = {
      ...replacementStreams[0],
      consent_time_field: "replacement_time",
      schema: {
        properties: { replacement_only: { type: "string" }, replacement_time: { type: "string" } },
        type: "object",
      },
    };
    getDb()
      .prepare("UPDATE connectors SET manifest = ? WHERE connector_id = ?")
      .run(JSON.stringify(replacement), "spotify");

    const displayedAfterReplacement = await getPendingConsent(deviceCode);
    assert.ok(displayedAfterReplacement);
    const displayedStreams = displayedAfterReplacement.resolvedStreams as ResolvedStream[];
    const [displayedStream] = displayedStreams;
    assert.ok(displayedStream);
    assert.ok(displayedStream.fields.includes("id"));
    assert.ok(displayedStream.fields.includes("name"));
    assert.ok(displayedStream.fields.includes("genres"));
    assert.ok(!displayedStream.fields.includes("popularity"));
    assert.ok(!displayedStream.fields.includes("replacement_only"));
    assert.equal(displayedStream.time_constraint?.field, "source_updated_at");

    // The production schema protects active connection rows with a connector
    // FK. Disable it only for this mutation barrier so the test can model an
    // independently lost declaration catalog without deleting eligibility.
    getDb().pragma("foreign_keys = OFF");
    getDb().prepare("DELETE FROM connectors WHERE connector_id = ?").run("spotify");
    getDb().pragma("foreign_keys = ON");
    const displayedAfterDeletion = await getPendingConsent(deviceCode);
    assert.deepEqual(displayedAfterDeletion?.resolvedStreams, displayedAfterReplacement.resolvedStreams);

    const reviewed = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
    assert.ok(typeof reviewed?.reviewRevision === "string");
    const approved = await approveGrant(deviceCode, "owner_local", {
      approval_review_revision: reviewed?.reviewRevision,
    });
    const issuedStreams = approved.grant.streams as unknown as ResolvedStream[];
    const [issuedStream] = issuedStreams;
    assert.ok(issuedStream);
    assert.ok(issuedStream.fields.includes("id"));
    assert.ok(!issuedStream.fields.includes("replacement_only"));
    assert.equal(issuedStream.instance_ids.length, 1);
    assert.notEqual(issuedStream.instance_ids[0], "spotify");
    assert.deepEqual(issuedStream.resources, ["artist-1"]);
    assert.deepEqual(issuedStream.time_constraint, {
      field: "source_updated_at",
      since: "2026-01-01T00:00:00Z",
    });
    assert.deepEqual(approved.grant.source_declaration, {
      version: projectedDeclarationVersion,
    });
    assert.equal((approved.grant.source as { id?: string } | undefined)?.id, driver.getRegisteredConnectorId());
    assert.equal("manifest_version" in approved.grant, false);
    assert.deepEqual(approved.grant.client, { client_id: driver.getRegisteredClientId() });
    assert.equal("connection_id" in issuedStream, false);
    assert.equal("time_range" in issuedStream, false);
    assert.equal("view" in issuedStream, false);

    const tokenState = await introspect(approved.token);
    assert.equal(tokenState.active, true);
    assert.ok(tokenState.grant);
    assert.deepEqual(((tokenState.grant as { streams: ResolvedStream[] }).streams as ResolvedStream[])[0]?.fields, [
      "genres",
      "id",
      "name",
    ]);
    const persistedGrantJson = JSON.stringify(approved.grant);
    const grantMutations = [
      { field: "grant_id", value: "grant_tampered" },
      { field: "subject", value: { id: "owner_tampered" } },
      { field: "client", value: { client_id: "client_tampered" } },
      { field: "access_mode", value: "single_use" },
      { field: "expires_at", value: "2099-01-01T00:00:00.000Z" },
      { field: "version", value: "0.0.9" },
    ];
    for (const mutation of grantMutations) {
      const malformedGrant = structuredClone(approved.grant) as Record<string, unknown>;
      malformedGrant[mutation.field] = mutation.value;
      getDb()
        .prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?")
        .run(JSON.stringify(malformedGrant), approved.grant.grant_id);
      // biome-ignore lint/performance/noAwaitInLoops: each mutation must be restored before the next persisted-row probe.
      assert.equal((await introspect(approved.token)).active, false, `tampered ${mutation.field} must fail closed`);
    }
    getDb()
      .prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?")
      .run(persistedGrantJson, approved.grant.grant_id);

    getDb().prepare("UPDATE tokens SET client_id = ? WHERE token_id = ?").run("client_tampered", approved.token);
    assert.equal(
      (await introspect(approved.token)).active,
      false,
      "token/grant client binding mismatch must fail closed"
    );
    getDb()
      .prepare("UPDATE tokens SET client_id = ? WHERE token_id = ?")
      .run(driver.getRegisteredClientId(), approved.token);

    const tokenCountBefore = (
      getDb().prepare("SELECT COUNT(*) AS count FROM tokens WHERE grant_id = ?").get(approved.grant.grant_id) as {
        count: number;
      }
    ).count;
    await assert.rejects(
      () =>
        issueToken(
          approved.grant.grant_id as string,
          "owner_local",
          "client_tampered",
          approved.grant.expires_at as string | null
        ),
      GRANT_BINDING_RE
    );
    const tokenCountAfter = (
      getDb().prepare("SELECT COUNT(*) AS count FROM tokens WHERE grant_id = ?").get(approved.grant.grant_id) as {
        count: number;
      }
    ).count;
    assert.equal(tokenCountAfter, tokenCountBefore, "binding mismatch must be rejected before token insertion");
    const persistedRow = getDb()
      .prepare(`SELECT grant_id AS persisted_grant_id,
                       subject_id AS grant_subject_id,
                       client_id AS grant_client_id,
                       access_mode AS grant_access_mode,
                       expires_at AS grant_expires_at,
                       grant_json,
                       storage_binding_json
                FROM grants
                WHERE grant_id = ?`)
      .get(approved.grant.grant_id) as { grant_json: string; storage_binding_json: string };
    const consumedState = await requireResolvedPersistedGrantState(persistedRow);
    assert.deepEqual((consumedState.grant.streams as unknown as ResolvedStream[])[0]?.fields, ["genres", "id", "name"]);

    const evidenceRows = getDb()
      .prepare(
        "SELECT event_type, data_json FROM spine_events WHERE grant_id = ? AND event_type IN ('consent.approved', 'grant.issued') ORDER BY event_seq"
      )
      .all(approved.grant.grant_id) as { data_json: string; event_type: string }[];
    assert.deepEqual(
      evidenceRows.map((row) => row.event_type),
      ["consent.approved", "grant.issued"]
    );
    for (const row of evidenceRows) {
      const data = JSON.parse(row.data_json) as {
        resolved_streams: ResolvedStream[];
        source_declaration_snapshot: PendingPayload["source_declaration_snapshot"];
      };
      assert.equal(data.source_declaration_snapshot.snapshot_version, "reference.source-declaration-snapshot.v1");
      assert.deepEqual(data.source_declaration_snapshot.source, {
        id: driver.getRegisteredConnectorId(),
        kind: "connector",
      });
      assert.deepEqual(data.source_declaration_snapshot.declaration, retained.source_declaration_snapshot.declaration);
      assert.deepEqual(data.resolved_streams[0]?.time_constraint, {
        field: "source_updated_at",
        since: "2026-01-01T00:00:00Z",
      });
    }

    const manifestWithPreset = structuredClone(registeredManifest);
    manifestWithPreset.source_declaration = {
      ...retained.source_declaration_snapshot.declaration,
      selection_presets: [
        { id: "artists-basic", label: "Basic artists", streams: [{ name: "top_artists", view: "basic" }] },
      ],
    };
    await registerConnector(manifestWithPreset);
    const presetStarted = await initiateGrant({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          selection_preset: "artists-basic",
          source: { id: driver.getRegisteredConnectorId(), kind: "connector" },
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: driver.getRegisteredClientId(),
    });
    const presetDeviceCode = parsePendingConsentRequestUri(presetStarted.request_uri);
    assert.ok(presetDeviceCode);
    const presetPending = await getPendingConsent(presetDeviceCode);
    assert.ok(presetPending);
    assert.deepEqual((presetPending.resolvedStreams as ResolvedStream[])[0]?.fields, ["id", "name", "genres"]);
    const presetReview = await getPendingConsent(presetDeviceCode, { finalizeReview: true, subjectId: "owner_local" });
    assert.ok(typeof presetReview?.reviewRevision === "string");
    const presetApproved = await approveGrant(presetDeviceCode, "owner_local", {
      approval_review_revision: presetReview?.reviewRevision,
    });
    assert.equal(presetApproved.grant.selection_preset, "artists-basic");
    assert.deepEqual((presetApproved.grant.streams as unknown as ResolvedStream[])[0]?.fields, [
      "id",
      "name",
      "genres",
    ]);

    const forgedInstanceStarted = await initiateGrant({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personalization",
          source: { id: driver.getRegisteredConnectorId(), kind: "connector" },
          streams: [{ instance_ids: ["forged-instance"], name: "top_artists" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: driver.getRegisteredClientId(),
    });
    const forgedInstanceDeviceCode = parsePendingConsentRequestUri(forgedInstanceStarted.request_uri);
    assert.ok(forgedInstanceDeviceCode);
    await assert.rejects(
      () => getPendingConsent(forgedInstanceDeviceCode, { subjectId: "owner_local" }),
      INELIGIBLE_INSTANCE_RE
    );
    await assert.rejects(
      () =>
        initiateGrant({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/personalization",
              source: { id: driver.getRegisteredConnectorId(), kind: "connector" },
              streams: [{ connection_id: "legacy-public-alias", name: "top_artists" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: driver.getRegisteredClientId(),
        }),
      LEGACY_CONNECTION_ID_RE
    );

    const missingSnapshotStarted = await driver.startPendingConsent();
    const missingSnapshotDeviceCode = parsePendingConsentRequestUri(missingSnapshotStarted.request_uri);
    assert.ok(missingSnapshotDeviceCode);
    const missingSnapshotRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(missingSnapshotDeviceCode) as { params_json: string };
    const withoutSnapshot = JSON.parse(missingSnapshotRow.params_json) as Record<string, unknown>;
    Reflect.deleteProperty(withoutSnapshot, "source_declaration_snapshot");
    getDb()
      .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
      .run(JSON.stringify(withoutSnapshot), missingSnapshotDeviceCode);
    await assert.rejects(() => getPendingConsent(missingSnapshotDeviceCode), MISSING_SNAPSHOT_RE);

    const invalidDeclarationStarted = await driver.startPendingConsent();
    const invalidDeclarationDeviceCode = parsePendingConsentRequestUri(invalidDeclarationStarted.request_uri);
    assert.ok(invalidDeclarationDeviceCode);
    const invalidDeclarationRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(invalidDeclarationDeviceCode) as { params_json: string };
    const invalidDeclarationRequest = JSON.parse(invalidDeclarationRow.params_json) as PendingPayload;
    Reflect.deleteProperty(invalidDeclarationRequest.source_declaration_snapshot.declaration, "publisher");
    getDb()
      .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
      .run(JSON.stringify(invalidDeclarationRequest), invalidDeclarationDeviceCode);
    await assert.rejects(() => getPendingConsent(invalidDeclarationDeviceCode), INVALID_DECLARATION_RE);

    const mismatchedVersionStarted = await driver.startPendingConsent();
    const mismatchedVersionDeviceCode = parsePendingConsentRequestUri(mismatchedVersionStarted.request_uri);
    assert.ok(mismatchedVersionDeviceCode);
    const mismatchedVersionRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(mismatchedVersionDeviceCode) as { params_json: string };
    const mismatchedVersionRequest = JSON.parse(mismatchedVersionRow.params_json) as PendingPayload;
    mismatchedVersionRequest.source_declaration_snapshot.declaration_version = "tampered-declaration-revision";
    getDb()
      .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
      .run(JSON.stringify(mismatchedVersionRequest), mismatchedVersionDeviceCode);
    await assert.rejects(() => getPendingConsent(mismatchedVersionDeviceCode), DECLARATION_METADATA_MISMATCH_RE);

    const unknownShapeStarted = await driver.startPendingConsent();
    const unknownShapeDeviceCode = parsePendingConsentRequestUri(unknownShapeStarted.request_uri);
    assert.ok(unknownShapeDeviceCode);
    const unknownShapeRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(unknownShapeDeviceCode) as { params_json: string };
    const unknownShapeRequest = JSON.parse(unknownShapeRow.params_json) as PendingPayload & Record<string, unknown>;
    (unknownShapeRequest.source_declaration_snapshot as unknown as Record<string, unknown>).legacy_manifest = {};
    getDb()
      .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
      .run(JSON.stringify(unknownShapeRequest), unknownShapeDeviceCode);
    await assert.rejects(() => getPendingConsent(unknownShapeDeviceCode), SNAPSHOT_SHAPE_RE);

    const underivedStarted = await driver.startPendingConsent();
    const underivedDeviceCode = parsePendingConsentRequestUri(underivedStarted.request_uri);
    assert.ok(underivedDeviceCode);
    const underivedRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(underivedDeviceCode) as { params_json: string };
    const underivedRequest = JSON.parse(underivedRow.params_json) as PendingPayload;
    const retainedStreams = (
      underivedRequest.source_declaration_snapshot as unknown as { resolved_streams: ResolvedStream[] }
    ).resolved_streams;
    assert.ok(retainedStreams[0]);
    retainedStreams[0].fields = ["id"];
    getDb()
      .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
      .run(JSON.stringify(underivedRequest), underivedDeviceCode);
    await assert.rejects(() => getPendingConsent(underivedDeviceCode), SNAPSHOT_DERIVATION_RE);
  } finally {
    await driver.teardown();
  }
});

test("registered Core source IDs resolve to one exact local connector binding", async () => {
  const driver = createSqliteConsentDeviceAuthDriver();
  await driver.setup();
  try {
    const connectorKey = "custom_core_source_a";
    const connectorInstanceId = "cin_custom_core_source_a";
    const sourceId = "https://sources.example/custom-core-source";
    await registerConnector(customCoreSourceManifest(connectorKey, sourceId));
    const now = new Date().toISOString();
    await createSqliteConnectorInstanceStore().upsert({
      connectorId: connectorKey,
      connectorInstanceId,
      createdAt: now,
      displayName: "Custom Core source account",
      ownerSubjectId: "owner_local",
      sourceBinding: { fixture: "custom-core-source" },
      sourceBindingKey: "custom-core-source",
      sourceKind: "manual",
      status: "active",
      updatedAt: now,
    });

    const started = await initiateGrant({
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/custom_source_test",
          source: { id: sourceId, kind: "connector" },
          streams: [{ name: "items" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      client_id: driver.getRegisteredClientId(),
    });
    const deviceCode = parsePendingConsentRequestUri(started.request_uri);
    assert.ok(deviceCode);
    const pendingRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(deviceCode) as { params_json: string };
    const pending = JSON.parse(pendingRow.params_json) as {
      source_binding: { id: string; kind: string };
      storage_binding: { connector_id: string };
    };
    assert.deepEqual(pending.source_binding, { id: sourceId, kind: "connector" });
    assert.deepEqual(pending.storage_binding, { connector_id: connectorKey });

    const reviewed = await getPendingConsent(deviceCode, { finalizeReview: true, subjectId: "owner_local" });
    assert.ok(typeof reviewed?.reviewRevision === "string");
    const approved = await approveGrant(deviceCode, "owner_local", {
      approval_review_revision: reviewed?.reviewRevision,
    });
    assert.deepEqual((approved.grant.streams as unknown as ResolvedStream[])[0]?.instance_ids, [connectorInstanceId]);

    await registerConnector(customCoreSourceManifest("custom_core_source_b", sourceId));
    await assert.rejects(
      () =>
        initiateGrant({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/custom_source_test",
              source: { id: sourceId, kind: "connector" },
              streams: [{ name: "items" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          client_id: driver.getRegisteredClientId(),
        }),
      MULTIPLE_LOCAL_BINDINGS_RE
    );
  } finally {
    await driver.teardown();
  }
});

test("provider-native grant snapshots its trusted declaration and binds its local instance to the approving subject", async () => {
  const driver = createSqliteConsentDeviceAuthDriver();
  const nativeManifest = loadNativeManifest();
  const sourceId = nativeManifest.provider_id as string;
  await driver.setup();
  configureNativeManifest(nativeManifest);
  try {
    const started = await initiateGrant(
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
        client_id: driver.getRegisteredClientId(),
      },
      { nativeManifest, nativeManifestMode: "local_operator_provisioning" }
    );
    const deviceCode = parsePendingConsentRequestUri(started.request_uri);
    assert.ok(deviceCode);
    const pendingRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(deviceCode) as { params_json: string };
    const pending = JSON.parse(pendingRow.params_json) as PendingPayload;
    assert.equal(pending.source_declaration_snapshot.declaration_version, "reference.native-config.northstar-hr.v1");
    assert.deepEqual(pending.source_declaration_snapshot.declaration.source, {
      id: sourceId,
      kind: "provider_native",
    });
    assert.deepEqual(pending.source_declaration_snapshot.declaration.publisher, {
      id: "https://pdpp.dev/reference-implementation",
    });
    assert.equal(pending.source_declaration_snapshot.accepted_revision_reference, undefined);
    assert.deepEqual(pending.source_declaration_snapshot.resource_authority, {
      status: "local_operator_provisioned",
    });
    assert.deepEqual(pending.source_declaration_snapshot.publisher_attribution, {
      id: "https://pdpp.dev/reference-implementation",
      status: "unverified",
    });

    const nativeOwnerId = "owner_native_alice";
    const reviewed = await getPendingConsent(deviceCode, {
      finalizeReview: true,
      nativeManifest,
      subjectId: nativeOwnerId,
    });
    assert.ok(typeof reviewed?.reviewRevision === "string");
    const reviewedRow = getDb()
      .prepare("SELECT approval_review_json FROM pending_consents WHERE device_code = ?")
      .get(deviceCode) as { approval_review_json: string };
    const reviewedArtifact = JSON.parse(reviewedRow.approval_review_json) as {
      source_declaration: Record<string, unknown>;
    };
    assert.deepEqual(reviewedArtifact.source_declaration.resource_authority, {
      status: "local_operator_provisioned",
    });
    assert.equal(reviewedArtifact.source_declaration.accepted_revision_reference, undefined);
    const approved = await approveGrant(deviceCode, nativeOwnerId, {
      approval_review_revision: reviewed?.reviewRevision,
      nativeManifest,
    });
    assert.deepEqual(approved.grant.source_declaration, { version: "reference.native-config.northstar-hr.v1" });
    const [issuedStream] = approved.grant.streams as unknown as ResolvedStream[];
    assert.ok(issuedStream);
    assert.deepEqual(issuedStream.instance_ids, [
      makeDefaultAccountConnectorInstanceId(
        nativeOwnerId,
        (nativeManifest.storage_binding as { connector_id: string }).connector_id
      ),
    ]);

    const tokenState = await introspect(approved.token);
    assert.equal(tokenState.active, true);
    assert.deepEqual((tokenState.grant as { source?: unknown } | undefined)?.source, {
      id: sourceId,
      kind: "provider_native",
    });
    assert.deepEqual(
      ((tokenState.grant as { streams?: ResolvedStream[] } | undefined)?.streams ?? [])[0]?.instance_ids,
      issuedStream.instance_ids
    );

    const explicitStarted = await initiateGrant(
      {
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            source: { id: sourceId, kind: "provider_native" },
            streams: [{ instance_ids: issuedStream.instance_ids, name: "pay_statements" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: driver.getRegisteredClientId(),
      },
      { nativeManifest, nativeManifestMode: "local_operator_provisioning" }
    );
    assert.ok(parsePendingConsentRequestUri(explicitStarted.request_uri));

    const forgedNativeStarted = await initiateGrant(
      {
        authorization_details: [
          {
            access_mode: "continuous",
            purpose_code: "https://pdpp.dev/purpose/financial_planning",
            source: { id: sourceId, kind: "provider_native" },
            streams: [{ instance_ids: ["forged-native-instance"], name: "pay_statements" }],
            type: "https://pdpp.dev/data-access",
          },
        ],
        client_id: driver.getRegisteredClientId(),
      },
      { nativeManifest, nativeManifestMode: "local_operator_provisioning" }
    );
    const forgedNativeDeviceCode = parsePendingConsentRequestUri(forgedNativeStarted.request_uri);
    assert.ok(forgedNativeDeviceCode);
    await assert.rejects(
      () => getPendingConsent(forgedNativeDeviceCode, { nativeManifest, subjectId: nativeOwnerId }),
      INVALID_NATIVE_INSTANCE_RE
    );
  } finally {
    configureNativeManifest(null);
    await driver.teardown();
  }
});

test("grant approval requires an existing unambiguous instance while staging closes selection values", async () => {
  const driver = createSqliteConsentDeviceAuthDriver();
  await driver.setup();
  try {
    const noInstanceStarted = await driver.startPendingConsent();
    const noInstanceDeviceCode = parsePendingConsentRequestUri(noInstanceStarted.request_uri);
    assert.ok(noInstanceDeviceCode);
    await assert.rejects(
      () => getPendingConsent(noInstanceDeviceCode, { subjectId: "owner_local" }),
      NO_ACTIVE_INSTANCE_RE
    );

    await seedActiveSpotifyInstance("cin_spotify_a", "a@example.com");
    await seedActiveSpotifyInstance("cin_spotify_b", "b@example.com");
    const multipleInstancesStarted = await driver.startPendingConsent();
    const multipleInstancesDeviceCode = parsePendingConsentRequestUri(multipleInstancesStarted.request_uri);
    assert.ok(multipleInstancesDeviceCode);
    await assert.rejects(
      () => getPendingConsent(multipleInstancesDeviceCode, { subjectId: "owner_local" }),
      MULTIPLE_ACTIVE_INSTANCES_RE
    );

    const source = { id: driver.getRegisteredConnectorId(), kind: "connector" };
    const base = {
      access_mode: "continuous",
      purpose_code: "https://pdpp.dev/purpose/personalization",
      source,
      streams: [{ instance_ids: ["cin_spotify_a"], name: "top_artists" }],
      type: "https://pdpp.dev/data-access",
    };
    const explicitlyBound = await initiateGrant({
      authorization_details: [base],
      client_id: driver.getRegisteredClientId(),
    });
    assert.ok(parsePendingConsentRequestUri(explicitlyBound.request_uri));

    const { purpose_code: _purposeCode, ...withoutPurpose } = base;
    await assert.rejects(
      () =>
        initiateGrant({
          authorization_details: [withoutPurpose],
          client_id: driver.getRegisteredClientId(),
        }),
      PURPOSE_CODE_RE
    );
    await assert.rejects(
      () =>
        initiateGrant({
          authorization_details: [
            {
              ...base,
              streams: [
                {
                  instance_ids: ["cin_spotify_a"],
                  name: "top_artists",
                  time_range: { since: "2026-02-01T00:00:00Z", until: "2026-01-01T00:00:00Z" },
                },
              ],
            },
          ],
          client_id: driver.getRegisteredClientId(),
        }),
      INVALID_TIME_RANGE_RE
    );

    const manifestRow = getDb().prepare("SELECT manifest FROM connectors WHERE connector_id = ?").get("spotify") as {
      manifest: string;
    };
    const compoundManifest = JSON.parse(manifestRow.manifest) as Record<string, unknown>;
    const streams = compoundManifest.streams as Record<string, unknown>[];
    const topArtists = streams.find((stream) => stream.name === "top_artists");
    assert.ok(topArtists);
    topArtists.primary_key = ["id", "name"];
    const declarationProbeStarted = await driver.startPendingConsent({
      streams: [{ instance_ids: ["cin_spotify_a"], name: "top_artists" }],
    });
    const declarationProbeDeviceCode = parsePendingConsentRequestUri(declarationProbeStarted.request_uri);
    assert.ok(declarationProbeDeviceCode);
    const declarationProbeRow = getDb()
      .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
      .get(declarationProbeDeviceCode) as { params_json: string };
    const declarationProbe = JSON.parse(declarationProbeRow.params_json) as PendingPayload;
    compoundManifest.source_declaration = {
      ...declarationProbe.source_declaration_snapshot.declaration,
      streams: declarationProbe.source_declaration_snapshot.declaration.streams.map((stream) =>
        stream.name === "top_artists" ? { ...stream, primary_key: ["id", "name"] } : stream
      ),
    };
    await registerConnector(compoundManifest);
    await assert.rejects(
      () =>
        initiateGrant({
          authorization_details: [
            {
              ...base,
              streams: [
                {
                  instance_ids: ["cin_spotify_a"],
                  name: "top_artists",
                  resources: ['["artist-1"]'],
                },
              ],
            },
          ],
          client_id: driver.getRegisteredClientId(),
        }),
      COMPOUND_RESOURCE_RE
    );
  } finally {
    await driver.teardown();
  }
});

test("private hosted wildcard expansion preserves the chosen instance across every stream", async () => {
  const driver = createSqliteConsentDeviceAuthDriver();
  await driver.setup();
  try {
    await seedActiveSpotifyInstance("cin_spotify_work", "work@example.com");
    await seedActiveSpotifyInstance("cin_spotify_personal", "personal@example.com");
    const result = await createHostedMcpGrantPackage({
      authorizationDetails: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
          source: { id: driver.getRegisteredConnectorId(), kind: "connector" },
          streams: [{ instance_ids: ["cin_spotify_work"], name: "*" }],
          type: "https://pdpp.dev/data-access",
        },
      ],
      clientId: driver.getRegisteredClientId(),
      connectionIds: ["cin_spotify_work"],
      storageBindings: [{ connector_id: "spotify" }],
    });
    const childGrants = result.child_grants as Array<{ grant: { streams: ResolvedStream[] } }>;
    assert.equal(childGrants.length, 1);
    const [childGrant] = childGrants;
    assert.ok(childGrant);
    assert.ok(childGrant.grant.streams.length);
    for (const stream of childGrant.grant.streams) {
      assert.deepEqual(stream.instance_ids, ["cin_spotify_work"]);
      assert.equal("connection_id" in stream, false);
    }

    const packageId = result.package_id as string;
    const packageRow = getDb()
      .prepare("SELECT package_json FROM grant_packages WHERE package_id = ?")
      .get(packageId) as { package_json: string };
    assert.equal((await introspect(result.token)).active, true);
    getDb().prepare("UPDATE tokens SET subject_id = ? WHERE token_id = ?").run("owner_tampered", result.token);
    assert.equal((await introspect(result.token)).active, false, "package token binding mismatch must fail closed");
    getDb().prepare("UPDATE tokens SET subject_id = ? WHERE token_id = ?").run("owner_local", result.token);
    const memberRow = getDb()
      .prepare(
        `SELECT gm.grant_id, gm.token_id, g.grant_json
           FROM grant_package_members gm
           JOIN grants g ON g.grant_id = gm.grant_id
          WHERE gm.package_id = ?`
      )
      .get(packageId) as { grant_id: string; grant_json: string; token_id: string };
    const originalChildGrant = JSON.parse(memberRow.grant_json) as Record<string, unknown>;
    const foreignChildGrant = structuredClone(originalChildGrant);
    foreignChildGrant.subject = { id: "owner_foreign" };
    getDb()
      .prepare("UPDATE grants SET subject_id = ?, grant_json = ? WHERE grant_id = ?")
      .run("owner_foreign", JSON.stringify(foreignChildGrant), memberRow.grant_id);
    getDb().prepare("UPDATE tokens SET subject_id = ? WHERE token_id = ?").run("owner_foreign", memberRow.token_id);
    const foreignMemberAccess = (await getGrantPackageAccess(packageId)) as { members?: unknown[] } | null;
    assert.deepEqual(
      foreignMemberAccess?.members,
      [],
      "a valid child bound to another subject cannot be exposed through this package"
    );
    getDb()
      .prepare("UPDATE grants SET subject_id = ?, grant_json = ? WHERE grant_id = ?")
      .run("owner_local", JSON.stringify(originalChildGrant), memberRow.grant_id);
    getDb().prepare("UPDATE tokens SET subject_id = ? WHERE token_id = ?").run("owner_local", memberRow.token_id);
    assert.equal(
      ((await getGrantPackageAccess(packageId)) as { members: unknown[] }).members.length,
      1,
      "restored child identity is active"
    );
    const oldPackage = JSON.parse(packageRow.package_json) as Record<string, unknown>;
    oldPackage.version = "reference.mcp_package.v1";
    getDb()
      .prepare("UPDATE grant_packages SET package_json = ? WHERE package_id = ?")
      .run(JSON.stringify(oldPackage), packageId);
    assert.equal(await getGrantPackageAccess(packageId), null, "old package envelopes require fresh consent");
    const oldPackageToken = await introspect(result.token);
    assert.equal(oldPackageToken.active, false, "old package tokens require fresh consent");
    assert.equal(oldPackageToken.inactive_reason, "package_invalid");

    await assert.rejects(
      () =>
        createHostedMcpGrantPackage({
          authorizationDetails: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.dev/purpose/personal_ai_assistant",
              source: { id: driver.getRegisteredConnectorId(), kind: "connector" },
              streams: [{ connection_id: "cin_spotify_work", name: "*" }],
              type: "https://pdpp.dev/data-access",
            },
          ],
          clientId: driver.getRegisteredClientId(),
          connectionIds: ["cin_spotify_work"],
          storageBindings: [{ connector_id: "spotify" }],
        }),
      LEGACY_CONNECTION_ID_RE
    );
  } finally {
    await driver.teardown();
  }
});
