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
  assert.ok(introspectionRequest.errors.some((error) => error.where === "body"));
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
  const schema =
    publicDocument.paths["/oauth/par"].post.requestBody.content["application/json"].schema.properties
      .authorization_details;
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
  assert.equal(fullDocument.paths["/_ref/dataset/summary/rebuild"].post.operationId, "refDatasetSummaryRebuild");
  assert.equal(publicDocument.paths["/_ref/dataset/summary/reconcile"], undefined);
  assert.equal(fullDocument.paths["/_ref/dataset/summary/reconcile"].post.operationId, "refDatasetSummaryReconcile");

  assert.match(docs.routes, /\/oauth\/par/);
  assert.match(docs.routes, /\/oauth\/token/);
  assert.match(docs.routes, /\/grants\/\{grantId\}\/revoke/);
  assert.match(docs.routes, /\/v1\/streams\/\{stream\}\/records/);
  assert.match(docs.referenceRoutes, /\/_ref\/search/);
  assert.match(docs.referenceRoutes, /\/_ref\/dataset\/summary\/rebuild/);
  assert.match(docs.referenceRoutes, /\/_ref\/dataset\/summary\/reconcile/);
  assert.match(docs.cookbook, /consent\/approve.*\{ grant_id, token, grant \}/);
  assert.ok(!publicDocument.paths["/v1/blobs/{blob_id}"].get.responses["302"]);
  assert.deepEqual(
    fullDocument.paths["/_ref/records/timeline"].get.parameters.find((parameter) => parameter.name === "timestamp_mode")
      ?.schema?.enum,
    ["native", "ingest"]
  );
  assert.ok(!fullDocument.paths["/_ref/dataset/summary"].get.responses["401"]);
});
