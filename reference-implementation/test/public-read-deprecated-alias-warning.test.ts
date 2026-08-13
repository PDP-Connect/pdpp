// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: deprecated `connector_instance_id` alias usage SHALL surface
 * a structured `deprecated_alias_used` warning via the canonical
 * `meta.warnings[]` envelope slot on rs.search.* operations and via the
 * shared `resolveRequestConnectionId` helper used by records/aggregate.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Public read warnings SHALL be structured")
 *
 * Tasks 3.6 + 3.5 of `canonicalize-public-read-contract` — strict alias
 * conflict rejection is already covered by `public-read-connection-alias.test.js`.
 * This file covers the *warning* surface, not the conflict surface.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSearchHybrid,
  type SearchHybridDependencies,
  type SearchHybridSourceOutput,
} from "../operations/rs-search-hybrid/index.ts";
import { executeSearchLexical, type SearchLexicalDependencies } from "../operations/rs-search-lexical/index.ts";
import { executeSearchSemantic, type SearchSemanticDependencies } from "../operations/rs-search-semantic/index.ts";
import {
  CONNECTION_ALIAS_DEPRECATED_WARNING_CODE,
  projectStorageDisplayName,
  resolveRequestConnectionId,
} from "../server/connection-id-request.ts";

const ownerActor = { kind: "owner", subject_id: "subj_owner" } as const;

const lexicalAd = {
  cross_stream: true,
  default_limit: 25,
  max_limit: 100,
  score: {
    kind: "bm25",
    order: "lower_is_better",
    supported: true,
    value_semantics: "implementation_relative",
  },
  snippets: true,
  supported: true,
};

const semanticAd = {
  cross_stream: true,
  default_limit: 25,
  max_limit: 100,
  score: {
    kind: "semantic_distance",
    order: "lower_is_better",
    supported: true,
    value_semantics: "distance",
  },
  snippets: true,
  supported: true,
};

const BACKEND_ID = "stub-backend-warning-v1";

function makeLexicalDeps(): SearchLexicalDependencies {
  const stored = new Map();
  return {
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }) =>
      (manifest.streams || []).map((s) => ({
        searchableFields: ["employer"],
        streamName: s.name,
      })),
    buildSnapshot: ({ q }) => ({
      query: q,
      results: [
        {
          connectorId: "acme_payroll",
          connectorInstanceId: "ci_alpha",
          emittedAt: "2026-04-01T00:00:00Z",
          matchedFields: ["employer"],
          recordKey: "rec_1",
          score: -1.5,
          stream: "pay_statements",
        },
      ],
      snapshot_id: `snap_${q}`,
    }),
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ["acme_payroll"],
    loadSnapshot: (id) => stored.get(id) ?? null,
    persistSnapshot: (snap) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "pay_statements" }] }),
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: "pay_statements" }],
    }),
  };
}

function makeSemanticDeps(): SearchSemanticDependencies {
  const stored = new Map();
  return {
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }) =>
      (manifest.streams || []).map((s) => ({
        searchableFields: ["employer"],
        streamName: s.name,
      })),
    buildSnapshot: ({ q }) => ({
      backend_hash: BACKEND_ID,
      query: q,
      results: [
        {
          connectorId: "acme_payroll",
          connectorInstanceId: "ci_alpha",
          distance: 0.05,
          matchedFields: ["employer"],
          recordKey: "rec_1",
          stream: "pay_statements",
        },
      ],
      snapshot_id: `snap_${q}`,
    }),
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => semanticAd,
    getCurrentBackendIdentity: () => BACKEND_ID,
    hydrateResult: ({ hit }) => ({
      emittedAt: "2026-04-01T00:00:00Z",
      snippet: { field: "employer", text: `…${hit.recordKey}…` },
    }),
    listOwnerVisibleConnectorIds: () => ["acme_payroll"],
    loadSnapshot: (id) => stored.get(id) ?? null,
    persistSnapshot: (snap) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "pay_statements" }] }),
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: "pay_statements" }],
    }),
  };
}

// ─── connection-id-request: helper-level coverage ───────────────────────────

test("resolveRequestConnectionId emits no warnings for canonical-only request", () => {
  const { connectionId, warnings } = resolveRequestConnectionId({ connection_id: "cin_abc" });
  assert.equal(connectionId, "cin_abc");
  assert.deepEqual(warnings, []);
});

test("resolveRequestConnectionId emits deprecated_alias_used when only deprecated alias is sent", () => {
  const { connectionId, warnings } = resolveRequestConnectionId({
    connector_instance_id: "cin_abc",
  });
  assert.equal(connectionId, "cin_abc");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.code, CONNECTION_ALIAS_DEPRECATED_WARNING_CODE);
  assert.equal(warnings[0]?.param, "connector_instance_id");
});

test("resolveRequestConnectionId emits deprecated_alias_used when both fields match", () => {
  const { connectionId, warnings } = resolveRequestConnectionId({
    connection_id: "cin_abc",
    connector_instance_id: "cin_abc",
  });
  assert.equal(connectionId, "cin_abc");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.code, CONNECTION_ALIAS_DEPRECATED_WARNING_CODE);
});

test("resolveRequestConnectionId returns null connectionId and no warnings when neither is sent", () => {
  const { connectionId, warnings } = resolveRequestConnectionId({});
  assert.equal(connectionId, null);
  assert.deepEqual(warnings, []);
});

test("resolveRequestConnectionId still rejects conflicting values via the shared validator", () => {
  assert.throws(
    () =>
      resolveRequestConnectionId({
        connection_id: "cin_abc",
        connector_instance_id: "cin_xyz",
      }),
    (err: unknown) => {
      const error = err as Error & { code?: string; param?: string };
      return error.code === "invalid_argument" && error.param === "connector_instance_id";
    }
  );
});

test("resolveRequestConnectionId treats empty alias as absent (no warning, no value)", () => {
  const { connectionId, warnings } = resolveRequestConnectionId({
    connector_instance_id: "",
  });
  assert.equal(connectionId, null);
  assert.deepEqual(warnings, []);
});

test("projectStorageDisplayName treats registry URL connector labels as fallback placeholders", () => {
  assert.equal(
    projectStorageDisplayName("https://registry.pdpp.dev/connectors/amazon", {
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon_personal",
    }),
    null
  );
});

test("projectStorageDisplayName treats legacy alias labels as fallback placeholders", () => {
  assert.equal(
    projectStorageDisplayName("claude_code", {
      connectorId: "claude-code",
      connectorInstanceId: "cin_claude_code",
    }),
    null
  );
});

// ─── rs.search.lexical: envelope-level coverage ─────────────────────────────

test("lexical search omits meta.warnings when only canonical connection_id is sent", async () => {
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { connection_id: "ci_alpha", q: "overdraft" } },
    makeLexicalDeps()
  );
  // `meta` is always present now (it carries recall disclosure per
  // openspec/changes/disclose-lexical-recall-windows); the contract this test
  // pins is that NO `warnings[]` are emitted for a clean canonical request.
  assert.equal(result.envelope.meta?.warnings, undefined);
});

test("lexical search emits meta.warnings deprecated_alias_used when only the deprecated alias is sent", async () => {
  const result = await executeSearchLexical(
    {
      actor: ownerActor,
      query: { connector_instance_id: "ci_alpha", q: "overdraft" },
    },
    makeLexicalDeps()
  );
  assert.ok(result.envelope.meta, "expected envelope.meta to be present");
  assert.equal(result.envelope.meta?.warnings?.length, 1);
  assert.equal(result.envelope.meta?.warnings?.[0]?.code, "deprecated_alias_used");
  assert.equal(result.envelope.meta?.warnings?.[0]?.param, "connector_instance_id");
});

test("lexical search emits meta.warnings when both fields are sent with matching values", async () => {
  const result = await executeSearchLexical(
    {
      actor: ownerActor,
      query: {
        connection_id: "ci_alpha",
        connector_instance_id: "ci_alpha",
        q: "overdraft",
      },
    },
    makeLexicalDeps()
  );
  assert.ok(result.envelope.meta);
  assert.equal(result.envelope.meta?.warnings?.[0]?.code, "deprecated_alias_used");
});

// ─── rs.search.semantic: envelope-level coverage ────────────────────────────

test("semantic search emits meta.warnings deprecated_alias_used when only the deprecated alias is sent", async () => {
  const result = await executeSearchSemantic(
    {
      actor: ownerActor,
      query: { connector_instance_id: "ci_alpha", q: "overdraft" },
    },
    makeSemanticDeps()
  );
  assert.ok(result.envelope.meta);
  assert.equal(result.envelope.meta?.warnings?.[0]?.code, "deprecated_alias_used");
});

test("semantic search omits meta.warnings when no alias is sent", async () => {
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { connection_id: "ci_alpha", q: "overdraft" } },
    makeSemanticDeps()
  );
  assert.equal(result.envelope.meta, undefined);
});

// ─── rs.search.hybrid: envelope-level coverage ──────────────────────────────

test("hybrid search emits a single deduplicated deprecated_alias_used warning across sources", async () => {
  // Sources legitimately emit the same warning because the caller's query
  // contains the alias. Hybrid MUST deduplicate so callers see one row per
  // unique (code, param) pair instead of N copies.
  const lexicalEnv: SearchHybridSourceOutput["envelope"] = {
    data: [
      {
        connection_id: "ci_alpha",
        connector_id: "acme",
        connector_instance_id: "ci_alpha",
        emitted_at: "2026-04-01T00:00:00Z",
        matched_fields: ["title"],
        object: "search_result",
        record_key: "rec_1",
        record_url: "/v1/streams/posts/records/rec_1",
        stream: "posts",
      },
    ],
    meta: {
      warnings: [
        {
          code: "deprecated_alias_used",
          message: "`connector_instance_id` is deprecated; send `connection_id` instead.",
          param: "connector_instance_id",
        },
      ],
    },
  };
  const semanticEnv: SearchHybridSourceOutput["envelope"] = {
    data: [],
    meta: {
      warnings: [
        {
          code: "deprecated_alias_used",
          message: "`connector_instance_id` is deprecated; send `connection_id` instead.",
          param: "connector_instance_id",
        },
      ],
    },
  };
  const deps: SearchHybridDependencies = {
    runLexical: () => ({ envelope: lexicalEnv }),
    runSemantic: () => ({ envelope: semanticEnv }),
  };
  const result = await executeSearchHybrid(
    {
      actor: ownerActor,
      query: { connector_instance_id: "ci_alpha", q: "overdraft" },
    },
    deps
  );
  assert.ok(result.envelope.meta);
  assert.equal(
    result.envelope.meta?.warnings?.length,
    1,
    "hybrid MUST deduplicate identical warnings from its own request and from sub-envelopes"
  );
  assert.equal(result.envelope.meta?.warnings?.[0]?.code, "deprecated_alias_used");
});

test("hybrid search omits meta.warnings entirely when neither hybrid nor any source carries warnings", async () => {
  const deps: SearchHybridDependencies = {
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(result.envelope.meta, undefined);
});
