// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: search hits across lexical / semantic / hybrid all carry
 * `connection_id` and the deprecated `connector_instance_id` alias on the
 * emitted `search_result` items when the underlying snapshot supplied the
 * identifier.
 *
 * Scope:
 *   - Lexical and semantic snapshots already track `connectorInstanceId`
 *     per hit. The operation MUST forward it onto the public result item.
 *   - Hybrid composes the two source envelopes and MUST preserve the
 *     identity fields that the sources emitted.
 *   - When the snapshot omits the identifier (defensive: pre-identity
 *     snapshots or partial fixtures), the operation MUST omit the field
 *     rather than emit an empty string.
 *
 * Companion to `public-read-connection-alias.test.js`, which covers the
 * alias-conflict validation on the request side. This file covers the
 * response side.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSearchHybrid,
  type SearchHybridActor,
  type SearchHybridSourceResult,
} from "../operations/rs-search-hybrid/index.ts";
import {
  executeSearchLexical,
  type SearchLexicalActor,
  type SearchLexicalDependencies,
  type SearchLexicalManifest,
  type SearchLexicalSnapshotResult,
} from "../operations/rs-search-lexical/index.ts";
import {
  executeSearchSemantic,
  type SearchSemanticActor,
  type SearchSemanticDependencies,
  type SearchSemanticManifest,
  type SearchSemanticSnapshotResult,
} from "../operations/rs-search-semantic/index.ts";

const ownerActor: SearchLexicalActor & SearchSemanticActor & SearchHybridActor = {
  kind: "owner",
  subject_id: "subj_owner",
};

function firstOf<T>(items: readonly T[], label: string): T {
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const first = items[0];
  assert.ok(first, `${label}: expected at least one item`);
  return first;
}

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

const BACKEND_ID = "stub-backend-identity-v1";

function makeLexicalDeps({
  connectorInstanceIds,
}: {
  connectorInstanceIds: Array<string | null>;
}): SearchLexicalDependencies {
  const stored = new Map();
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }: { manifest: SearchLexicalManifest }) =>
      (manifest.streams || []).map((s) => ({
        searchableFields: ["employer"],
        streamName: s.name,
      })),
    buildSnapshot: ({ q }) => ({
      query: q,
      results: connectorInstanceIds.map(
        (cii, i): SearchLexicalSnapshotResult => ({
          connectorId: "acme_payroll",
          connectorInstanceId: cii,
          emittedAt: "2026-04-01T00:00:00Z",
          matchedFields: ["employer"],
          recordKey: `rec_${i + 1}`,
          score: -1 - i * 0.1,
          stream: "pay_statements",
        })
      ),
      snapshot_id: `snap_${q}`,
    }),
    formatRecordUrl: ({ stream, recordKey }: { stream: string; recordKey: string }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ["acme_payroll"],
    loadSnapshot: (id: string) => stored.get(id) ?? null,
    persistSnapshot: (snap: { snapshot_id: string }) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "pay_statements" }] }),
    resolveOwnerManifestForConnector: (connectorId: string) => ({
      connector_id: connectorId,
      streams: [{ name: "pay_statements" }],
    }),
  };
}

function makeSemanticDeps({
  connectorInstanceIds,
}: {
  connectorInstanceIds: Array<string | null>;
}): SearchSemanticDependencies {
  const stored = new Map();
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchSemanticManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }: { manifest: SearchSemanticManifest }) =>
      (manifest.streams || []).map((s) => ({
        searchableFields: ["employer"],
        streamName: s.name,
      })),
    buildSnapshot: ({ q }) => ({
      backend_hash: BACKEND_ID,
      query: q,
      results: connectorInstanceIds.map(
        (cii, i): SearchSemanticSnapshotResult => ({
          connectorId: "acme_payroll",
          connectorInstanceId: cii,
          distance: 0.05 + i * 0.01,
          matchedFields: ["employer"],
          recordKey: `rec_${i + 1}`,
          stream: "pay_statements",
        })
      ),
      snapshot_id: `snap_${q}`,
    }),
    formatRecordUrl: ({ stream, recordKey }: { stream: string; recordKey: string }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => semanticAd,
    getCurrentBackendIdentity: () => BACKEND_ID,
    hydrateResult: ({ hit }: { hit: { recordKey: string } }) => ({
      emittedAt: "2026-04-01T00:00:00Z",
      snippet: { field: "employer", text: `…${hit.recordKey}…` },
    }),
    listOwnerVisibleConnectorIds: () => ["acme_payroll"],
    loadSnapshot: (id: string) => stored.get(id) ?? null,
    persistSnapshot: (snap: { snapshot_id: string }) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "pay_statements" }] }),
    resolveOwnerManifestForConnector: (connectorId: string) => ({
      connector_id: connectorId,
      streams: [{ name: "pay_statements" }],
    }),
  };
}

test("lexical search emits connection_id and connector_instance_id on every hit", async () => {
  const deps = makeLexicalDeps({
    connectorInstanceIds: ["ci_acme_alpha", "ci_acme_beta"],
  });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(result.envelope.data.length, 2);
  for (const hit of result.envelope.data) {
    assert.equal(hit.connector_id, "acme_payroll");
    assert.ok(hit.connection_id && typeof hit.connection_id === "string", "lexical hit must carry connection_id");
    assert.equal(
      hit.connector_instance_id,
      hit.connection_id,
      "connector_instance_id MUST mirror connection_id during deprecation"
    );
  }
  // Confirm both bindings round-trip distinctly so the value really came
  // from the snapshot, not a hard-coded string.
  // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
  assert.deepEqual(result.envelope.data.map((h) => h.connection_id).sort(), ["ci_acme_alpha", "ci_acme_beta"]);
});

test("lexical search omits connection_id when the snapshot did not capture one", async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: [null] });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(result.envelope.data.length, 1);
  const hit = firstOf(result.envelope.data, "result.envelope.data");
  assert.equal(hit.connection_id, undefined);
  assert.equal(hit.connector_instance_id, undefined);
});

test("semantic search emits connection_id and connector_instance_id on every hit", async () => {
  const deps = makeSemanticDeps({
    connectorInstanceIds: ["ci_acme_alpha", "ci_acme_beta"],
  });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(result.envelope.data.length, 2);
  for (const hit of result.envelope.data) {
    assert.equal(hit.retrieval_mode, "semantic");
    assert.ok(hit.connection_id && typeof hit.connection_id === "string", "semantic hit must carry connection_id");
    assert.equal(hit.connector_instance_id, hit.connection_id);
  }
  // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
  assert.deepEqual(result.envelope.data.map((h) => h.connection_id).sort(), ["ci_acme_alpha", "ci_acme_beta"]);
});

test("semantic search omits connection_id when the snapshot did not capture one", async () => {
  const deps = makeSemanticDeps({ connectorInstanceIds: [null] });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  const hit = firstOf(result.envelope.data, "result.envelope.data");
  assert.equal(hit.connection_id, undefined);
  assert.equal(hit.connector_instance_id, undefined);
});

test("hybrid search forwards connection_id from both sources and reconciles overlap", async () => {
  // rec_1 is found by both sources with matching connection_id ⇒ identity
  // pinned on first source-write wins, but values agree.
  // rec_2 only from semantic, rec_3 only from lexical — each preserves its
  // own connection_id distinctly.
  const lexicalHits: SearchHybridSourceResult[] = [
    {
      connection_id: "ci_acme_alpha",
      connector_id: "acme",
      connector_instance_id: "ci_acme_alpha",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["title"],
      object: "search_result",
      record_key: "rec_1",
      record_url: "/v1/streams/posts/records/rec_1",
      score: { kind: "bm25", order: "lower_is_better", value: -1.5 },
      snippet: { field: "title", text: "lex-snippet" },
      stream: "posts",
    },
    {
      connection_id: "ci_acme_gamma",
      connector_id: "acme",
      connector_instance_id: "ci_acme_gamma",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["title"],
      object: "search_result",
      record_key: "rec_3",
      record_url: "/v1/streams/posts/records/rec_3",
      score: { kind: "bm25", order: "lower_is_better", value: -1.2 },
      stream: "posts",
    },
  ];
  const semanticHits: SearchHybridSourceResult[] = [
    {
      connection_id: "ci_acme_alpha",
      connector_id: "acme",
      connector_instance_id: "ci_acme_alpha",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["selftext"],
      object: "search_result",
      record_key: "rec_1",
      record_url: "/v1/streams/posts/records/rec_1",
      retrieval_mode: "semantic",
      score: { kind: "semantic_distance", order: "lower_is_better", value: 0.05 },
      snippet: { field: "selftext", text: "sem-snippet" },
      stream: "posts",
    },
    {
      connection_id: "ci_acme_beta",
      connector_id: "acme",
      connector_instance_id: "ci_acme_beta",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["selftext"],
      object: "search_result",
      record_key: "rec_2",
      record_url: "/v1/streams/posts/records/rec_2",
      retrieval_mode: "semantic",
      score: { kind: "semantic_distance", order: "lower_is_better", value: 0.08 },
      stream: "posts",
    },
  ];
  const deps = {
    runLexical: () => ({ envelope: { data: lexicalHits } }),
    runSemantic: () => ({ envelope: { data: semanticHits } }),
  };
  const result = await executeSearchHybrid({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  // Index hits by record_key for clarity.
  const byKey = Object.fromEntries(result.envelope.data.map((h) => [h.record_key, h]));
  const rec1 = byKey.rec_1;
  const rec2 = byKey.rec_2;
  const rec3 = byKey.rec_3;
  assert.ok(rec1, "rec_1 result must be present");
  assert.ok(rec2, "rec_2 result must be present");
  assert.ok(rec3, "rec_3 result must be present");
  assert.equal(rec1.connection_id, "ci_acme_alpha");
  assert.equal(rec1.connector_instance_id, "ci_acme_alpha");
  assert.equal(rec2.connection_id, "ci_acme_beta");
  assert.equal(rec2.connector_instance_id, "ci_acme_beta");
  assert.equal(rec3.connection_id, "ci_acme_gamma");
  assert.equal(rec3.connector_instance_id, "ci_acme_gamma");
  // Hybrid mode is preserved on every hit.
  for (const hit of result.envelope.data) {
    assert.equal(hit.retrieval_mode, "hybrid");
  }
});

test("hybrid search omits connection_id when neither source supplied one", async () => {
  const lexicalHit: SearchHybridSourceResult = {
    connector_id: "acme",
    emitted_at: "2026-04-01T00:00:00Z",
    matched_fields: ["title"],
    object: "search_result",
    record_key: "rec_1",
    record_url: "/v1/streams/posts/records/rec_1",
    score: { kind: "bm25", order: "lower_is_better", value: -1.5 },
    stream: "posts",
  };
  const deps = {
    runLexical: () => ({ envelope: { data: [lexicalHit] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  const hit = firstOf(result.envelope.data, "result.envelope.data");
  assert.equal(hit.connection_id, undefined);
  assert.equal(hit.connector_instance_id, undefined);
});

test("hybrid search falls back to connector_instance_id when source emits only the alias", async () => {
  // Defensive: a source that ships only the deprecated alias still seeds
  // the canonical `connection_id` on the merged hybrid hit.
  const lexicalHit: SearchHybridSourceResult = {
    connector_id: "acme",
    connector_instance_id: "ci_legacy_only",
    emitted_at: "2026-04-01T00:00:00Z",
    matched_fields: ["title"],
    object: "search_result",
    record_key: "rec_1",
    record_url: "/v1/streams/posts/records/rec_1",
    score: { kind: "bm25", order: "lower_is_better", value: -1.5 },
    stream: "posts",
  };
  const deps = {
    runLexical: () => ({ envelope: { data: [lexicalHit] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  const hit = firstOf(result.envelope.data, "result.envelope.data");
  assert.equal(hit.connection_id, "ci_legacy_only");
  assert.equal(hit.connector_instance_id, "ci_legacy_only");
});
