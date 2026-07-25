// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import type { RouteManifest } from "../src/common/index.ts";
import { publicManifests as publicManifestsRaw } from "../src/public/index.ts";

// The public module is still JS; its array structurally matches
// RouteManifest[] and Node type-stripping loads it as an untyped binding.
// Cast once at import, same pattern as src/validate.ts.
const publicManifests = publicManifestsRaw as readonly RouteManifest[];

const FIELD_CAPABILITIES_OR_FILTER_RE = /field_capabilities|filter/i;
const FIELD_CAPABILITIES_RE = /field_capabilities/;
const HYBRID_PAGINATION_RE = /hybrid_pagination_supported/;
const LEXICAL_FALLBACK_RE = /lexical|\/v1\/search\b/;
const STREAM_PARAMETER_RE = /stream=<name>/;
const V1_SCHEMA_RE = /\/v1\/schema/;
const VIEW_COMPACT_RE = /view=compact/;

function findOperation(operationId: string): RouteManifest {
  const operation = publicManifests.find((manifest) => manifest.id === operationId);
  assert.ok(operation, `expected public manifest ${operationId}`);
  return operation;
}

function requireSummary(operation: RouteManifest): string {
  assert.ok(operation.summary, `${operation.id} must declare a summary`);
  return operation.summary;
}

test("listStreams summary directs LLMs to /v1/schema for field capabilities", () => {
  const operation = findOperation("listStreams");
  const summary = requireSummary(operation);
  assert.match(summary, V1_SCHEMA_RE, "listStreams.summary must reference /v1/schema");
  assert.match(
    summary,
    FIELD_CAPABILITIES_OR_FILTER_RE,
    "listStreams.summary must explain why /v1/schema matters (filter / field_capabilities)"
  );
});

test("getStreamMetadata summary directs LLMs to /v1/schema for field capabilities", () => {
  const operation = findOperation("getStreamMetadata");
  const summary = requireSummary(operation);
  assert.match(summary, V1_SCHEMA_RE, "getStreamMetadata.summary must reference /v1/schema");
  assert.match(
    summary,
    FIELD_CAPABILITIES_OR_FILTER_RE,
    "getStreamMetadata.summary must explain why /v1/schema matters"
  );
});

test("getSchema advertises compact token-efficient discovery controls", () => {
  const operation = findOperation("getSchema");
  const summary = requireSummary(operation);
  assert.match(summary, VIEW_COMPACT_RE, "getSchema.summary must tell agents about compact schema discovery");
  assert.match(summary, STREAM_PARAMETER_RE, "getSchema.summary must tell agents about stream-scoped schema discovery");
  assert.ok(operation.request?.query?.properties?.view, "getSchema query must declare view");
  assert.ok(operation.request?.query?.properties?.stream, "getSchema query must declare stream");
});

test("searchRecordsHybrid summary references hybrid_pagination_supported and lexical fallback", () => {
  const operation = findOperation("searchRecordsHybrid");
  const summary = requireSummary(operation);
  assert.match(
    summary,
    HYBRID_PAGINATION_RE,
    "searchRecordsHybrid.summary must name the hybrid_pagination_supported discovery hint"
  );
  assert.match(
    summary,
    LEXICAL_FALLBACK_RE,
    "searchRecordsHybrid.summary must recommend the lexical fallback for cursor pagination"
  );
});

test("ListRecordsQuerySchema.filter description references field_capabilities and /v1/schema", () => {
  const listRecords = findOperation("listRecords");
  const filterSchema = listRecords.request?.query?.properties?.filter;
  assert.ok(filterSchema, "listRecords query must declare a filter property");
  const { description } = filterSchema;
  assert.equal(typeof description, "string");
  assert.match(description ?? "", FIELD_CAPABILITIES_RE, "filter.description must name field_capabilities");
  assert.match(description ?? "", V1_SCHEMA_RE, "filter.description must reference /v1/schema");
});
