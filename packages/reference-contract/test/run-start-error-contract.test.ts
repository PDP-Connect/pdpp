// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { RouteManifest } from "../src/common/index.ts";
import { generateOpenApi } from "../src/openapi/index.ts";
import { publicManifests } from "../src/public/index.ts";
import { referenceManifests } from "../src/reference/index.ts";
import { validateResponse } from "../src/validate.ts";

const RUN_START_OPERATION_IDS = [
  "refRunConnector",
  "refRunConnection",
  "ownerRunConnector",
  "ownerRunConnection",
] as const;

const RUN_START_OPERATION_ID_SET = new Set<string>(RUN_START_OPERATION_IDS);
const OAUTH_CONSENT_INTERACTION_PATH_RE = /\/(?:oauth|consent)\b|\/interaction\b/;
const PUBLIC_ROUTES = publicManifests as readonly RouteManifest[];
const REFERENCE_ROUTES = referenceManifests as readonly RouteManifest[];

function errorProperties(manifest: RouteManifest, status: number) {
  const response = manifest.responses?.[String(status)];
  assert.ok(response?.schema, `${manifest.id} must declare a ${status} schema`);
  const error = response.schema.properties?.error;
  assert.ok(error?.properties, `${manifest.id} ${status} must declare an error object schema`);
  return error.properties;
}

function openApiErrorProperties(document: ReturnType<typeof generateOpenApi>, operationId: string, status: number) {
  const operation = Object.values(document.paths)
    .flatMap((pathItem) => Object.values(pathItem))
    .find((candidate) => candidate.operationId === operationId);
  assert.ok(operation, `OpenAPI must include ${operationId}`);
  const response = operation.responses[String(status)];
  assert.ok(response, `${operationId} must declare a ${status} response`);
  const error = response.content?.["application/json"]?.schema?.properties?.error;
  assert.ok(error?.properties, `${operationId} ${status} must declare an error object schema`);
  return error.properties;
}

function openApiRunIdResponseIds(document: ReturnType<typeof generateOpenApi>) {
  const ids: string[] = [];
  for (const pathItem of Object.values(document.paths)) {
    for (const operation of Object.values(pathItem)) {
      for (const [status, response] of Object.entries(operation.responses)) {
        const runId = response.content?.["application/json"]?.schema?.properties?.error?.properties?.run_id;
        if (runId) {
          ids.push(`${operation.operationId}:${status}`);
        }
      }
    }
  }
  return ids.sort((left, right) => left.localeCompare(right));
}

function assertNoRunIdInErrorSchemas(entries: Iterable<RouteManifest>, label: string) {
  for (const manifest of entries) {
    for (const [status, response] of Object.entries(manifest.responses ?? {})) {
      const error = response.schema?.properties?.error;
      if (!error || typeof error !== "object" || !("properties" in error)) {
        continue;
      }
      const { properties } = error as { properties?: Record<string, unknown> };
      assert.equal(properties?.run_id, undefined, `${label}: ${manifest.id} ${status} must not expose run_id`);
    }
  }
}

test("only the four run-start 409 errors expose optional safe run_id", () => {
  for (const operationId of RUN_START_OPERATION_IDS) {
    const manifest = REFERENCE_ROUTES.find((candidate) => candidate.id === operationId);
    assert.ok(manifest, `missing run-start manifest ${operationId}`);

    assert.deepEqual(errorProperties(manifest, 409).run_id, { type: "string" });
    assert.equal(manifest.responses?.["409"]?.schema?.properties?.error?.required?.includes("run_id"), false);
    assert.equal(errorProperties(manifest, 400).run_id, undefined);
    assert.equal(errorProperties(manifest, 404).run_id, undefined);

    const withoutRunId = {
      error: {
        code: "run_already_active",
        message: "a run is already active",
        request_id: "req_run_start",
        type: "conflict_error",
      },
    };
    assert.deepEqual(validateResponse(operationId, { body: withoutRunId, status: 409 }), {
      ok: true,
      skipped: false,
    });
    assert.deepEqual(
      validateResponse(operationId, {
        body: { error: { ...withoutRunId.error, run_id: "run_active_123" } },
        status: 409,
      }),
      { ok: true, skipped: false }
    );
    assert.equal(
      validateResponse(operationId, {
        body: { error: { ...withoutRunId.error, run_id: 123 } },
        status: 409,
      }).ok,
      false,
      `${operationId} 409 must reject non-string run_id`
    );
    for (const status of [400, 404]) {
      assert.equal(
        validateResponse(operationId, {
          body: { error: { ...withoutRunId.error, run_id: "run_should_not_be_here" } },
          status,
        }).ok,
        false,
        `${operationId} ${status} must reject run_id`
      );
    }
  }
});

test("generated OpenAPI keeps run_id on only those four 409 responses", () => {
  const publicDocument = generateOpenApi({ includeReference: false });
  const fullDocument = generateOpenApi({ includeReference: true });

  for (const operationId of RUN_START_OPERATION_IDS) {
    assert.deepEqual(openApiErrorProperties(fullDocument, operationId, 409).run_id, { type: "string" });
    assert.equal(openApiErrorProperties(fullDocument, operationId, 400).run_id, undefined);
    assert.equal(openApiErrorProperties(fullDocument, operationId, 404).run_id, undefined);
  }

  assert.deepEqual(openApiRunIdResponseIds(publicDocument), [], "public generated schemas must not expose run_id");
  assert.deepEqual(
    openApiRunIdResponseIds(fullDocument),
    RUN_START_OPERATION_IDS.map((operationId) => `${operationId}:409`).sort((left, right) => left.localeCompare(right)),
    "only the four run-start 409 schemas may expose run_id"
  );

  assertNoRunIdInErrorSchemas(PUBLIC_ROUTES, "public schemas");
  assertNoRunIdInErrorSchemas(
    REFERENCE_ROUTES.filter((manifest) => !RUN_START_OPERATION_ID_SET.has(manifest.id)),
    "unrelated reference schemas"
  );

  const oauthConsentAndInteractions = [...PUBLIC_ROUTES, ...REFERENCE_ROUTES].filter((manifest) =>
    OAUTH_CONSENT_INTERACTION_PATH_RE.test(manifest.path)
  );
  assert.ok(oauthConsentAndInteractions.length > 0, "OAuth/consent and interaction routes must be covered");
  assertNoRunIdInErrorSchemas(oauthConsentAndInteractions, "OAuth/consent/interaction schemas");
});
