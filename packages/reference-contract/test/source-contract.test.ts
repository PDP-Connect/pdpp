// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve pnpm's package directory; Node and tsc resolve it.
import type { Ajv as AjvClass, Plugin, ValidateFunction } from "ajv";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve pnpm's package directory; Node and tsc resolve it.
import type { FormatsPluginOptions } from "ajv-formats";
import type {
  ResolvedGrant,
  SelectionRequest,
  SourceDeclaration,
  SourceDeclarationStream,
} from "../src/public/source.ts";
import {
  ResolvedGrantSchema,
  SelectionRequestSchema,
  SourceDeclarationSchema,
  validateResolvedGrantSemantics,
  validateSelectionRequestSemantics,
  validateSourceDeclarationSemantics,
} from "../src/public/source.ts";

const requireCjs = createRequire(import.meta.url);
const Ajv2020 = requireCjs("ajv/dist/2020.js") as { new (opts?: Record<string, unknown>): AjvClass };
const addFormats = requireCjs("ajv-formats") as Plugin<FormatsPluginOptions>;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function compile(schema: Record<string, unknown>): ValidateFunction {
  return ajv.compile(schema);
}

function assertValid(validator: ValidateFunction, value: unknown): void {
  assert.ok(validator(value), JSON.stringify(validator.errors));
}

function assertInvalid(validator: ValidateFunction, value: unknown): void {
  assert.equal(validator(value), false);
}

const source = { id: "https://registry.pdpp.dev/connectors/github", kind: "connector" } as const;
const issuesStream: SourceDeclarationStream = {
  consent_time_field: "updated_at",
  cursor_field: "updated_at",
  description: "Issues in repositories",
  display: { detail: "Issue titles and update times", label: "Issues" },
  name: "issues",
  primary_key: ["id"],
  query: {
    aggregations: { count: true, group_by_time: ["updated_at"] },
    range_filters: { updated_at: ["gte", "lt"] },
    search: { lexical_fields: ["id"] },
  },
  schema: {
    properties: { id: { type: "string" }, updated_at: { format: "date-time", type: "string" } },
    type: "object",
  },
  selection: { fields: true, resources: true },
  semantics: "mutable_state",
  views: [{ fields: ["id", "updated_at"], id: "basic", label: "Basic" }],
};
const declaration: SourceDeclaration = {
  declaration_version: "release:opaque-v7",
  display: { name: "GitHub" },
  protocol_version: "0.1.0",
  publisher: { id: "https://publishers.example/github" },
  selection_presets: [{ id: "issues-basic", label: "Issues", streams: [{ name: "issues", view: "basic" }] }],
  source,
  streams: [issuesStream],
};

test("SourceDeclaration is a public 2020-12 Core contract for both source kinds", () => {
  assert.equal(SourceDeclarationSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  const validate = compile(SourceDeclarationSchema);
  assertValid(validate, declaration);
  assert.deepEqual(validateSourceDeclarationSemantics(declaration), { ok: true });
  assertValid(validate, { ...declaration, source: { ...source, kind: "provider_native" } });
  assertInvalid(validate, { ...declaration, source: { id: source.id } });
  assertInvalid(validate, { ...declaration, source: { id: "github", kind: "connector" } });
  assertInvalid(validate, { ...declaration, protocol_version: "0.2.0" });
  assertInvalid(validate, { ...declaration, streams: [{ ...issuesStream, name: "*" }] });
  assertInvalid(validate, {
    ...declaration,
    streams: [{ ...issuesStream, schema: { $schema: "http://json-schema.org/draft-07/schema#" } }],
  });
  const { selection: _selection, ...withoutSelection } = issuesStream;
  const { semantics: _semantics, ...withoutSemantics } = issuesStream;
  assertInvalid(validate, { ...declaration, streams: [withoutSelection] });
  assertInvalid(validate, { ...declaration, streams: [withoutSemantics] });
  assertInvalid(validate, {
    ...declaration,
    streams: [{ ...issuesStream, query: { owner_account_id: true } }],
  });
  assertInvalid(validate, {
    ...declaration,
    selection_presets: [
      { id: "owner-bound", label: "Owner bound", streams: [{ instance_ids: ["account-a"], name: "issues" }] },
    ],
  });
  assertInvalid(validate, {
    ...declaration,
    selection_presets: [
      { id: "resource-bound", label: "Resource bound", streams: [{ name: "issues", resources: ["issue-1"] }] },
    ],
  });
});

test("SourceDeclaration semantic validation recursively rejects nonlocal schema references", () => {
  const localReference: SourceDeclaration = {
    ...declaration,
    streams: [
      {
        ...issuesStream,
        schema: {
          $defs: { id: { type: "string" } },
          allOf: [{ $ref: "#/$defs/id" }],
          properties: { id: { type: "string" }, updated_at: { format: "date-time", type: "string" } },
          type: "object",
        },
      },
    ],
  };
  assert.deepEqual(validateSourceDeclarationSemantics(localReference), { ok: true });

  const remoteReference: SourceDeclaration = {
    ...declaration,
    streams: [
      {
        ...issuesStream,
        schema: {
          allOf: [{ $ref: "https://schemas.example/id" }, { $dynamicRef: "other-schema#time" }],
          properties: { id: { type: "string" }, updated_at: { format: "date-time", type: "string" } },
          type: "object",
        },
      },
    ],
  };
  const remoteResult = validateSourceDeclarationSemantics(remoteReference);
  assert.equal(remoteResult.ok, false);
  assert.deepEqual(remoteResult.ok ? [] : remoteResult.failures.map(({ code, path }) => ({ code, path })), [
    {
      code: "source.declaration.nonlocal_schema_reference",
      path: "/streams/0/schema/allOf/0/$ref",
    },
    {
      code: "source.declaration.nonlocal_schema_reference",
      path: "/streams/0/schema/allOf/1/$dynamicRef",
    },
  ]);
});

test("SourceDeclaration semantic validation reports stable uniqueness and reference failures", () => {
  const invalid: SourceDeclaration = {
    ...declaration,
    selection_presets: [
      { id: "duplicate", label: "First", streams: [{ name: "missing" }, { name: "missing" }] },
      { id: "duplicate", label: "Second", streams: [{ name: "issues", view: "missing-view" }] },
    ],
    streams: [
      {
        ...issuesStream,
        cursor_field: "missing_cursor",
        name: "issues",
        query: { ...issuesStream.query, expand: [{ name: "missing-expand" }] },
        relationships: [
          { cardinality: "has_one", foreign_key: "missing_fk", name: "repo", stream: "missing" },
          { cardinality: "has_one", foreign_key: "missing_fk", name: "account", stream: "issues" },
          { cardinality: "has_one", foreign_key: "id", name: "account", stream: "issues" },
        ],
        views: [
          { fields: ["missing_field"], id: "duplicate-view", label: "First" },
          { fields: ["id"], id: "duplicate-view", label: "Second" },
        ],
      },
      { ...issuesStream, name: "issues" },
    ],
  };

  assert.deepEqual(validateSourceDeclarationSemantics(invalid), {
    failures: [
      {
        code: "source.declaration.duplicate_view_id",
        path: "/streams/0/views/1/id",
        reference: "duplicate-view",
      },
      {
        code: "source.declaration.duplicate_relationship_name",
        path: "/streams/0/relationships/2/name",
        reference: "account",
      },
      {
        code: "source.declaration.unknown_schema_field",
        path: "/streams/0/cursor_field",
        reference: "missing_cursor",
      },
      {
        code: "source.declaration.unknown_schema_field",
        path: "/streams/0/views/0/fields",
        reference: "missing_field",
      },
      {
        code: "source.declaration.duplicate_stream_name",
        path: "/streams/1/name",
        reference: "issues",
      },
      {
        code: "source.declaration.unknown_stream",
        path: "/streams/0/relationships/0/stream",
        reference: "missing",
      },
      {
        code: "source.declaration.unknown_schema_field",
        path: "/streams/0/relationships/1/foreign_key",
        reference: "missing_fk",
      },
      {
        code: "source.declaration.unknown_relationship",
        path: "/streams/0/query/expand/0/name",
        reference: "missing-expand",
      },
      {
        code: "source.declaration.unknown_stream",
        path: "/selection_presets/0/streams/0/name",
        reference: "missing",
      },
      {
        code: "source.declaration.duplicate_preset_stream_name",
        path: "/selection_presets/0/streams/1/name",
        reference: "missing",
      },
      {
        code: "source.declaration.unknown_stream",
        path: "/selection_presets/0/streams/1/name",
        reference: "missing",
      },
      {
        code: "source.declaration.duplicate_preset_id",
        path: "/selection_presets/1/id",
        reference: "duplicate",
      },
      {
        code: "source.declaration.unknown_view",
        path: "/selection_presets/1/streams/0/view",
        reference: "missing-view",
      },
    ],
    ok: false,
  });
});

test("SourceDeclaration semantic validation rejects invalid query field types and expand limits", () => {
  const relatedStream: SourceDeclarationStream = {
    ...issuesStream,
    name: "comments",
    primary_key: ["id"],
  };
  const invalid: SourceDeclaration = {
    ...declaration,
    streams: [
      {
        ...issuesStream,
        schema: {
          ...issuesStream.schema,
          properties: {
            ...(issuesStream.schema.properties as Record<string, unknown>),
            score: { type: "number" },
          },
        },
        query: {
          aggregations: {
            count_distinct: ["updated_at"],
            group_by: ["updated_at"],
            group_by_time: ["id"],
            max: ["id"],
            min: ["id"],
            sum: ["id"],
          },
          expand: [
            { default_limit: 10, max_limit: 1, name: "comments" },
            { name: "comments" },
            { default_limit: 1, name: "owner" },
          ],
          range_filters: { id: ["gte"] },
          search: { lexical_fields: ["score"], semantic_fields: ["score"] },
        },
        relationships: [
          { cardinality: "has_many", foreign_key: "id", name: "comments", stream: "comments" },
          { cardinality: "has_one", foreign_key: "id", name: "owner", stream: "issues" },
        ],
      },
      relatedStream,
    ],
  };

  assert.deepEqual(validateSourceDeclarationSemantics(invalid), {
    failures: [
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/search/lexical_fields",
        reference: "score",
      },
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/search/semantic_fields",
        reference: "score",
      },
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/range_filters",
        reference: "id",
      },
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/aggregations/group_by_time",
        reference: "id",
      },
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/aggregations/min",
        reference: "id",
      },
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/aggregations/max",
        reference: "id",
      },
      {
        code: "source.declaration.invalid_query_field_type",
        path: "/streams/0/query/aggregations/sum",
        reference: "id",
      },
      {
        code: "source.declaration.invalid_expand_limits",
        path: "/streams/0/query/expand/0",
        reference: "comments",
      },
      {
        code: "source.declaration.duplicate_expand_name",
        path: "/streams/0/query/expand/1/name",
        reference: "comments",
      },
      {
        code: "source.declaration.invalid_expand_limits",
        path: "/streams/0/query/expand/2",
        reference: "owner",
      },
    ],
    ok: false,
  });
});

test("selection requests keep convenience forms request-only and never imply fan-in", () => {
  const validate = compile(SelectionRequestSchema);
  const base = {
    access_mode: "continuous",
    purpose_code: "https://pdpp.dev/purpose/research",
    source,
    type: "https://pdpp.dev/data-access",
  };
  assertValid(validate, { ...base, streams: [{ name: "*" }] });
  assertValid(validate, { ...base, source: { id: source.id }, streams: [{ name: "*" }] });
  assertInvalid(validate, { ...base, source: { id: source.id, kind: "native" }, streams: [{ name: "*" }] });
  assertValid(validate, { ...base, selection_preset: "issues-basic" });
  assertInvalid(validate, { ...base, selection_preset: "issues-basic", streams: [{ name: "issues" }] });
  assertInvalid(validate, { ...base });
  assertInvalid(validate, { ...base, streams: [{ fields: ["id"], name: "issues", view: "basic" }] });
  assertInvalid(validate, { ...base, streams: [{ instance_ids: ["account-a", "account-a"], name: "issues" }] });
  assertValid(validate, { ...base, streams: [{ instance_ids: ["account-a"], name: "*" }] });
  assertInvalid(validate, { ...base, purpose_code: "research", streams: [{ name: "issues" }] });
  assertInvalid(validate, {
    ...base,
    client_claims: { asserted_by_server: true },
    streams: [{ name: "issues" }],
  });
  assertInvalid(validate, {
    ...base,
    retention: { max_duration: "P30D", on_expiry: "archive" },
    streams: [{ name: "issues" }],
  });

  assert.deepEqual(
    validateSelectionRequestSemantics({
      ...base,
      streams: [{ instance_ids: ["account-a"], name: "*" }],
    } as SelectionRequest),
    { ok: true }
  );
  const mixedWildcard = validateSelectionRequestSemantics({
    ...base,
    streams: [{ name: "*" }, { name: "issues" }],
  } as SelectionRequest);
  assert.equal(mixedWildcard.ok, false);
  assert.ok(
    !mixedWildcard.ok &&
      mixedWildcard.failures.some(({ code }) => code === "source.selection.wildcard_must_be_only_stream")
  );
  const duplicateRequest = validateSelectionRequestSemantics({
    ...base,
    streams: [
      { fields: ["id"], name: "issues" },
      { fields: ["updated_at"], name: "issues" },
    ],
  } as SelectionRequest);
  assert.equal(duplicateRequest.ok, false);
  assert.ok(
    !duplicateRequest.ok &&
      duplicateRequest.failures.some(({ code }) => code === "source.selection.duplicate_stream_name")
  );
  const reversedRequest = validateSelectionRequestSemantics({
    ...base,
    streams: [
      {
        name: "issues",
        time_range: { since: "2026-02-01T00:00:00Z", until: "2026-01-01T00:00:00Z" },
      },
    ],
  } as SelectionRequest);
  assert.equal(reversedRequest.ok, false);
  assert.ok(
    !reversedRequest.ok && reversedRequest.failures.some(({ code }) => code === "source.selection.invalid_time_range")
  );
});

test("resolved grants require explicit frozen stream authorization facts", () => {
  const validate = compile(ResolvedGrantSchema);
  const grant = {
    access_mode: "continuous",
    client: { client_id: "app-1" },
    grant_id: "grant-1",
    issued_at: "2026-08-10T12:00:00Z",
    purpose_code: "https://pdpp.dev/purpose/research",
    source,
    source_declaration: { version: "release:opaque-v7" },
    streams: [
      {
        fields: ["id", "updated_at"],
        instance_ids: ["account-a"],
        name: "issues",
        resources: ["issue-1"],
        time_constraint: { field: "updated_at", since: "2026-01-01T00:00:00Z" },
      },
    ],
    subject: { id: "owner-1" },
    version: "0.1.0",
  };
  assertValid(validate, grant);
  assertValid(validate, { ...grant, client: { client_display: { name: "Research App" }, client_id: "app-1" } });
  assertInvalid(validate, {
    ...grant,
    client: { client_display: { name: "Research App", untrusted_role: "admin" }, client_id: "app-1" },
  });
  assertInvalid(validate, { ...grant, client: { client_id: "app-1", untrusted_role: "admin" } });
  assertInvalid(validate, { ...grant, subject: { email: "owner@example.com", id: "owner-1" } });
  assertInvalid(validate, { ...grant, streams: [{ ...grant.streams[0], instance_ids: [] }] });
  assertInvalid(validate, { ...grant, streams: [{ ...grant.streams[0], name: "*" }] });
  assertInvalid(validate, { ...grant, streams: [{ ...grant.streams[0], time_constraint: { field: "updated_at" } }] });
  assertInvalid(validate, { ...grant, streams: [{ name: "issues" }] });
  assertInvalid(validate, { ...grant, version: "0.2.0" });

  const duplicateGrant = validateResolvedGrantSemantics({
    ...grant,
    streams: [grant.streams[0], { ...grant.streams[0], fields: ["id"] }],
  } as ResolvedGrant);
  assert.equal(duplicateGrant.ok, false);
  assert.ok(
    !duplicateGrant.ok && duplicateGrant.failures.some(({ code }) => code === "source.grant.duplicate_stream_name")
  );
  const reversedGrant = validateResolvedGrantSemantics({
    ...grant,
    streams: [
      {
        ...grant.streams[0],
        time_constraint: {
          field: "updated_at",
          since: "2026-02-01T00:00:00Z",
          until: "2026-01-01T00:00:00Z",
        },
      },
    ],
  } as ResolvedGrant);
  assert.equal(reversedGrant.ok, false);
  assert.ok(
    !reversedGrant.ok && reversedGrant.failures.some(({ code }) => code === "source.grant.invalid_time_constraint")
  );
});
