// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { generateDocs } from "../src/docs/generate.ts";
import { listOperations, validateRequest, validateResponse } from "../src/index.ts";
import { generateOpenApi } from "../src/openapi/index.ts";
import {
  BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP,
  BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD,
  publicManifests,
} from "../src/public/index.ts";

const CONSENT_APPROVE_RE = /consent\/approve.*\{ grant_id, token, grant \}/;
const GRANT_REVOKE_RE = /\/grants\/\{grantId\}\/revoke/;
const OAUTH_PAR_RE = /\/oauth\/par/;
const OAUTH_TOKEN_RE = /\/oauth\/token/;
const RECORDS_ROUTE_RE = /\/v1\/streams\/\{stream\}\/records/;
const REF_DATASET_REBUILD_RE = /\/_ref\/dataset\/summary\/rebuild/;
const REF_DATASET_RECONCILE_RE = /\/_ref\/dataset\/summary\/reconcile/;
const REF_SEARCH_RE = /\/_ref\/search/;

test("public manifests cover metadata, auth, grant, and record surfaces", () => {
  const ids = new Set(publicManifests.map((manifest) => manifest.id));

  for (const operationId of [
    "getAuthorizationServerMetadata",
    "getProtectedResourceMetadata",
    "registerDynamicClient",
    "createPushedAuthorizationRequest",
    "approveConsent",
    "startOwnerDeviceAuthorization",
    "exchangeOwnerDeviceToken",
    "introspectToken",
    "revokeGrant",
    "listStreams",
    "getStreamMetadata",
    "listRecords",
    "getRecord",
    "getBlob",
  ]) {
    assert.ok(ids.has(operationId), `expected public manifest ${operationId}`);
  }

  const publicOperations = listOperations().filter((entry) => entry.surface === "public");
  assert.ok(publicOperations.some((entry) => entry.id === "createPushedAuthorizationRequest"));
  assert.ok(publicOperations.some((entry) => entry.id === "revokeGrant"));
});

test("request validators accept the shipped public flow shapes", () => {
  const parRequest = validateRequest("createPushedAuthorizationRequest", {
    body: {
      authorization_details: [
        {
          access_mode: "continuous",
          purpose_code: "https://pdpp.org/purpose/personalization",
          source: { id: "spotify", kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
          type: "https://pdpp.org/data-access",
        },
      ],
      client_id: "longview",
    },
  });
  assert.deepEqual(parRequest, { ok: true });

  const deviceAuthRequest = validateRequest("startOwnerDeviceAuthorization", {
    body: {
      audience: "pdpp",
      client_id: "cli_longview",
    },
  });
  assert.deepEqual(deviceAuthRequest, { ok: true });

  const tokenRequest = validateRequest("exchangeOwnerDeviceToken", {
    body: {
      client_id: "cli_longview",
      device_code: "dc_owner_example",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
  });
  assert.deepEqual(tokenRequest, { ok: true });

  const introspectionRequest = validateRequest("introspectToken", {
    body: {},
  });
  assert.equal(introspectionRequest.ok, false);
  assert.ok(
    !introspectionRequest.ok && introspectionRequest.errors.some((error) => "where" in error && error.where === "body")
  );
});

test("PAR contract advertises batch consent caps as advisory metadata, not hard maxItems", () => {
  assert.equal(BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP, 8);
  assert.equal(BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD, 6);
  assert.ok(BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD < BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP);

  const entries = Array.from({ length: BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP + 1 }, (_, index) => ({
    access_mode: "continuous",
    purpose_code: "https://pdpp.org/purpose/personalization",
    source: { id: `source_${index + 1}`, kind: "connector" },
    streams: [{ name: "items", view: "basic" }],
    type: "https://pdpp.org/data-access",
  }));
  const result = validateRequest("createPushedAuthorizationRequest", {
    body: {
      authorization_details: entries,
      client_id: "longview",
    },
  });
  assert.deepEqual(result, { ok: true });

  const publicDocument = generateOpenApi({ includeReference: false });
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc (noUncheckedIndexedAccess) requires this chain; biome's simpler type model disagrees on the Record<string, OpenApiOperation> index access.
  const parOperation = publicDocument.paths["/oauth/par"]?.post;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: parOperation is possibly undefined per the same index-access disagreement.
  assert.ok(parOperation?.requestBody, "/oauth/par must declare a request body");
  const mediaType = parOperation.requestBody.content["application/json"];
  // biome-ignore lint/suspicious/noUnnecessaryConditions: mediaType is possibly undefined per the same Record index-access disagreement.
  assert.ok(mediaType?.schema?.properties, "/oauth/par requestBody must declare a JSON schema with properties");
  const schema = mediaType.schema.properties.authorization_details;
  assert.ok(schema, "/oauth/par requestBody must declare authorization_details schema");
  assert.equal(schema.maxItems, undefined);
  assert.equal(schema["x-pdpp-soft-cap"], BATCH_CONSENT_STAGED_ENTRY_SOFT_CAP);
  assert.equal(schema["x-pdpp-warning-threshold"], BATCH_CONSENT_STAGED_ENTRY_WARNING_THRESHOLD);
});

test("listRecords response validator accepts runtime warning parameters", () => {
  const result = validateResponse("listRecords", {
    body: {
      data: [],
      has_more: false,
      meta: {
        warnings: [
          {
            code: "deprecated_alias_used",
            message: "connector_instance_id is deprecated; use connection_id",
            param: "connector_instance_id",
          },
        ],
      },
      object: "list",
    },
    status: 200,
  });

  assert.deepEqual(result, { ok: true, skipped: false });
});

test("registerDynamicClient response omits unset optional URI metadata", () => {
  const minimal = validateResponse("registerDynamicClient", {
    body: {
      client_id: "client_test",
      client_id_issued_at: 1_780_963_200,
      client_name: null,
      grant_types: ["authorization_code"],
      redirect_uris: ["http://localhost:1455/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    status: 201,
  });
  assert.deepEqual(minimal, { ok: true, skipped: false });

  const withUri = validateResponse("registerDynamicClient", {
    body: {
      client_id: "client_test",
      client_id_issued_at: 1_780_963_200,
      client_name: "Claude Code",
      client_uri: "https://claude.ai",
      grant_types: ["authorization_code"],
      policy_uri: "https://claude.ai/legal/privacy",
      redirect_uris: ["http://localhost:1455/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    status: 201,
  });
  assert.deepEqual(withUri, { ok: true, skipped: false });

  const withNull = validateResponse("registerDynamicClient", {
    body: {
      client_id: "client_test",
      client_id_issued_at: 1_780_963_200,
      client_name: null,
      client_uri: null,
      grant_types: ["authorization_code"],
      redirect_uris: ["http://localhost:1455/callback"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    status: 201,
  });
  assert.equal(withNull.ok, false);
});

test("OpenAPI and docs generation include the auth/control routes alongside records", () => {
  const publicDocument = generateOpenApi({ includeReference: false });
  const fullDocument = generateOpenApi({ includeReference: true });
  const docs = generateDocs();

  assert.ok(publicDocument.paths["/.well-known/oauth-authorization-server"]);
  assert.ok(publicDocument.paths["/.well-known/oauth-protected-resource"]);
  assert.ok(publicDocument.paths["/oauth/par"]);
  assert.ok(publicDocument.paths["/oauth/token"]);
  assert.ok(publicDocument.paths["/grants/{grantId}/revoke"]);
  assert.equal(publicDocument.paths["/_ref/connectors"], undefined);

  assert.ok(fullDocument.paths["/_ref/connectors"]);
  assert.ok(fullDocument.paths["/_ref/search"]);
  assert.equal(publicDocument.paths["/_ref/dataset/summary/rebuild"], undefined);
  const rebuildOperation = fullDocument.paths["/_ref/dataset/summary/rebuild"];
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc (noUncheckedIndexedAccess) requires this chain; biome's simpler type model disagrees on the Record<string, OpenApiOperation> index access.
  assert.ok(rebuildOperation?.post, "/_ref/dataset/summary/rebuild must declare a post operation");
  assert.equal(rebuildOperation.post.operationId, "refDatasetSummaryRebuild");
  assert.equal(publicDocument.paths["/_ref/dataset/summary/reconcile"], undefined);
  const reconcileOperation = fullDocument.paths["/_ref/dataset/summary/reconcile"];
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc (noUncheckedIndexedAccess) requires this chain; biome's simpler type model disagrees on the Record<string, OpenApiOperation> index access.
  assert.ok(reconcileOperation?.post, "/_ref/dataset/summary/reconcile must declare a post operation");
  assert.equal(reconcileOperation.post.operationId, "refDatasetSummaryReconcile");

  assert.match(docs.routes, OAUTH_PAR_RE);
  assert.match(docs.routes, OAUTH_TOKEN_RE);
  assert.match(docs.routes, GRANT_REVOKE_RE);
  assert.match(docs.routes, RECORDS_ROUTE_RE);
  assert.match(docs.referenceRoutes, REF_SEARCH_RE);
  assert.match(docs.referenceRoutes, REF_DATASET_REBUILD_RE);
  assert.match(docs.referenceRoutes, REF_DATASET_RECONCILE_RE);
  assert.match(docs.cookbook, CONSENT_APPROVE_RE);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc (noUncheckedIndexedAccess) requires this chain; biome's simpler type model disagrees on the Record<string, OpenApiOperation> index access.
  const blobGet = publicDocument.paths["/v1/blobs/{blob_id}"]?.get;
  assert.ok(blobGet, "/v1/blobs/{blob_id} must declare a get operation");
  assert.ok(!blobGet.responses["302"]);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc (noUncheckedIndexedAccess) requires this chain; biome's simpler type model disagrees on the Record<string, OpenApiOperation> index access.
  const timelineGet = fullDocument.paths["/_ref/records/timeline"]?.get;
  assert.ok(timelineGet, "/_ref/records/timeline must declare a get operation");
  assert.deepEqual(timelineGet.parameters.find((parameter) => parameter.name === "timestamp_mode")?.schema?.enum, [
    "native",
    "ingest",
  ]);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: tsc (noUncheckedIndexedAccess) requires this chain; biome's simpler type model disagrees on the Record<string, OpenApiOperation> index access.
  const datasetSummaryGet = fullDocument.paths["/_ref/dataset/summary"]?.get;
  assert.ok(datasetSummaryGet, "/_ref/dataset/summary must declare a get operation");
  assert.ok(!datasetSummaryGet.responses["401"]);
});
