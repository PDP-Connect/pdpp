// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical public read envelope — cross-operation conformance.
 *
 * Targets tasks 7.1, 7.2, 7.3 of `canonicalize-public-read-contract`:
 *
 *   - 7.1: envelope-shape coverage for already-supported invariants
 *          (`object`, `data`, `has_more`, identity on every hit).
 *   - 7.2: multi-connection fixture exercising lexical/semantic/hybrid so
 *          identity is verified across more than one binding.
 *   - 7.3: regression assertions that strict-validation behavior already
 *          shipped (conflicting alias) is uniform across search ops.
 *
 * Scope discipline: this file only asserts cross-operation behavior already
 * implemented in the runtime. Focused runtime tests cover records-list
 * identity, deprecated-alias warnings, unknown-parameter rejection, and
 * expansion-target rejection. Items still pending in `tasks.md` are kept as
 * `test.todo` here so the broader implementation lane cannot silently drop
 * them.
 *
 * Companion files:
 *   - search-connection-identity.test.js — identity emission per backend
 *   - public-read-connection-alias.test.js — request-side alias validation
 *   - public-read-connection-id-decoration.test.js — records-list/detail
 *     identity, deprecated-alias warnings, and expansion rejection
 *   - record-read-conformance.test.js     — record list/cursor/projection
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSearchHybrid,
  parseSearchHybridParams,
  type SearchHybridActor,
  SearchHybridRequestError,
  type SearchHybridSourceResult,
} from "../operations/rs-search-hybrid/index.ts";
import {
  executeSearchLexical,
  parseSearchLexicalParams,
  type SearchLexicalActor,
  type SearchLexicalDependencies,
  type SearchLexicalManifest,
  SearchLexicalRequestError,
  type SearchLexicalSnapshotResult,
} from "../operations/rs-search-lexical/index.ts";
import {
  executeSearchSemantic,
  parseSearchSemanticParams,
  type SearchSemanticActor,
  type SearchSemanticDependencies,
  type SearchSemanticManifest,
  SearchSemanticRequestError,
  type SearchSemanticSnapshotResult,
} from "../operations/rs-search-semantic/index.ts";

const ownerActor: SearchLexicalActor & SearchSemanticActor & SearchHybridActor = {
  kind: "owner",
  subject_id: "subj_owner",
};

function firstOf<T>(items: readonly T[], label: string): T {
  // biome-ignore lint/style/useDestructuring: localized test assertion preserves its explicit contract.
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

const BACKEND_ID = "stub-canonical-conformance-v1";

function makeLexicalDeps({
  connectorInstanceIds,
  displayNames = {},
}: {
  connectorInstanceIds: string[];
  displayNames?: Record<string, string>;
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
      results: connectorInstanceIds.map((cii, i): SearchLexicalSnapshotResult => {
        const hit: SearchLexicalSnapshotResult = {
          connectorId: "acme_payroll",
          connectorInstanceId: cii,
          emittedAt: "2026-04-01T00:00:00Z",
          matchedFields: ["employer"],
          recordKey: `rec_${i + 1}`,
          score: -1 - i * 0.1,
          stream: "pay_statements",
        };
        if (displayNames[cii]) {
          hit.displayName = displayNames[cii];
        }
        return hit;
      }),
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
  displayNames = {},
}: {
  connectorInstanceIds: string[];
  displayNames?: Record<string, string>;
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
      results: connectorInstanceIds.map((cii, i): SearchSemanticSnapshotResult => {
        const hit: SearchSemanticSnapshotResult = {
          connectorId: "acme_payroll",
          connectorInstanceId: cii,
          distance: 0.05 + i * 0.01,
          matchedFields: ["employer"],
          recordKey: `rec_${i + 1}`,
          stream: "pay_statements",
        };
        if (displayNames[cii]) {
          hit.displayName = displayNames[cii];
        }
        return hit;
      }),
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

// ───────────────────────────────────────────────────────────────────────
// 7.1 — Envelope-shape coverage for already-implemented invariants
// ───────────────────────────────────────────────────────────────────────

test("lexical search envelope carries object=list, data array, and has_more flag", async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: ["ci_acme_alpha"] });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(result.envelope.object, "list");
  assert.ok(Array.isArray(result.envelope.data));
  assert.equal(typeof result.envelope.has_more, "boolean");
});

test("semantic search envelope carries object=list, data array, and has_more flag", async () => {
  const deps = makeSemanticDeps({ connectorInstanceIds: ["ci_acme_alpha"] });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(result.envelope.object, "list");
  assert.ok(Array.isArray(result.envelope.data));
  assert.equal(typeof result.envelope.has_more, "boolean");
});

test("every lexical hit is canonically addressable: connector_id + stream + record_key", async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: ["ci_acme_alpha"] });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.ok(result.envelope.data.length > 0);
  for (const hit of result.envelope.data) {
    assert.equal(hit.object, "search_result");
    assert.equal(typeof hit.connector_id, "string");
    assert.equal(typeof hit.stream, "string");
    assert.equal(typeof hit.record_key, "string");
    assert.ok(hit.connector_id.length > 0);
    assert.ok(hit.stream.length > 0);
    assert.ok(hit.record_key.length > 0);
  }
});

// ───────────────────────────────────────────────────────────────────────
// 7.2 — Multi-connection fixture: identity must distinguish bindings
// ───────────────────────────────────────────────────────────────────────

test("multi-connection lexical fixture: every hit carries its own connection_id (not the same one)", async () => {
  const deps = makeLexicalDeps({
    connectorInstanceIds: ["ci_acme_alpha", "ci_acme_beta", "ci_acme_gamma"],
  });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  const ids = result.envelope.data.map((h) => h.connection_id);
  assert.deepEqual(
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    ids.sort(),
    ["ci_acme_alpha", "ci_acme_beta", "ci_acme_gamma"],
    "lexical search across multiple bindings must preserve per-hit identity"
  );
  // Deprecated alias must mirror exactly during the migration window.
  for (const hit of result.envelope.data) {
    assert.equal(hit.connector_instance_id, hit.connection_id);
  }
});

test("multi-connection semantic fixture: every hit carries its own connection_id", async () => {
  const deps = makeSemanticDeps({
    connectorInstanceIds: ["ci_acme_alpha", "ci_acme_beta"],
  });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  const ids = result.envelope.data.map((h) => h.connection_id);
  // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
  assert.deepEqual(ids.sort(), ["ci_acme_alpha", "ci_acme_beta"]);
});

test("multi-connection hybrid fixture: identity from both sources survives composition", async () => {
  const lexicalHits: SearchHybridSourceResult[] = [
    {
      connection_id: "ci_alpha",
      connector_id: "acme",
      connector_instance_id: "ci_alpha",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["title"],
      object: "search_result",
      record_key: "rec_alpha",
      record_url: "/v1/streams/posts/records/rec_alpha",
      score: { kind: "bm25", order: "lower_is_better", value: -1.5 },
      stream: "posts",
    },
  ];
  const semanticHits: SearchHybridSourceResult[] = [
    {
      connection_id: "ci_beta",
      connector_id: "acme",
      connector_instance_id: "ci_beta",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["selftext"],
      object: "search_result",
      record_key: "rec_beta",
      record_url: "/v1/streams/posts/records/rec_beta",
      retrieval_mode: "semantic",
      score: { kind: "semantic_distance", order: "lower_is_better", value: 0.05 },
      stream: "posts",
    },
  ];
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: "overdraft" } },
    {
      runLexical: () => ({ envelope: { data: lexicalHits } }),
      runSemantic: () => ({ envelope: { data: semanticHits } }),
    }
  );
  const byKey = Object.fromEntries(result.envelope.data.map((h) => [h.record_key, h]));
  const recAlpha = byKey.rec_alpha;
  const recBeta = byKey.rec_beta;
  assert.ok(recAlpha, "rec_alpha result must be present");
  assert.ok(recBeta, "rec_beta result must be present");
  assert.equal(recAlpha.connection_id, "ci_alpha");
  assert.equal(recBeta.connection_id, "ci_beta");
  // Confirm the two identities truly stayed distinct (regression: an early
  // composition pass copied the first hit's identity onto every result).
  assert.notEqual(recAlpha.connection_id, recBeta.connection_id);
});

// ───────────────────────────────────────────────────────────────────────
// 3.1 — Search hits carry display_name when the snapshot pinned a label
// ───────────────────────────────────────────────────────────────────────

test("lexical search emits display_name when the snapshot pinned a non-placeholder label", async () => {
  const deps = makeLexicalDeps({
    connectorInstanceIds: ["ci_acme_alpha", "ci_acme_beta"],
    displayNames: {
      ci_acme_alpha: "Acme Personal",
      ci_acme_beta: "Acme Business",
    },
  });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  const byCii = Object.fromEntries(result.envelope.data.map((h) => [h.connection_id, h]));
  assert.equal(byCii.ci_acme_alpha.display_name, "Acme Personal");
  assert.equal(byCii.ci_acme_beta.display_name, "Acme Business");
});

test("lexical search omits display_name when the snapshot did not pin one (no guessing)", async () => {
  const deps = makeLexicalDeps({ connectorInstanceIds: ["ci_acme_alpha"] });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  for (const hit of result.envelope.data) {
    assert.ok(
      !("display_name" in hit),
      "display_name SHOULD be omitted when the runtime cannot pin a label without guessing"
    );
  }
});

test("semantic search emits display_name when the snapshot pinned a label", async () => {
  const deps = makeSemanticDeps({
    connectorInstanceIds: ["ci_acme_alpha"],
    displayNames: { ci_acme_alpha: "Acme Personal" },
  });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  assert.equal(firstOf(result.envelope.data, "result.envelope.data").display_name, "Acme Personal");
});

test("semantic search omits display_name when the snapshot did not pin one", async () => {
  const deps = makeSemanticDeps({ connectorInstanceIds: ["ci_acme_alpha"] });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "overdraft" } }, deps);
  for (const hit of result.envelope.data) {
    assert.ok(!("display_name" in hit));
  }
});

test("hybrid search forwards display_name from whichever source provided it", async () => {
  const lexicalHits: SearchHybridSourceResult[] = [
    {
      connection_id: "ci_alpha",
      connector_id: "acme",
      connector_instance_id: "ci_alpha",
      display_name: "Acme Personal",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["title"],
      object: "search_result",
      record_key: "rec_alpha",
      record_url: "/v1/streams/posts/records/rec_alpha",
      score: { kind: "bm25", order: "lower_is_better", value: -1.5 },
      stream: "posts",
    },
  ];
  const semanticHits: SearchHybridSourceResult[] = [
    {
      connection_id: "ci_beta",
      connector_id: "acme",
      connector_instance_id: "ci_beta",
      emitted_at: "2026-04-01T00:00:00Z",
      matched_fields: ["selftext"],
      object: "search_result",
      record_key: "rec_beta",
      // No display_name supplied — hybrid must omit on the merged item.
      record_url: "/v1/streams/posts/records/rec_beta",
      retrieval_mode: "semantic",
      score: { kind: "semantic_distance", order: "lower_is_better", value: 0.05 },
      stream: "posts",
    },
  ];
  const result = await executeSearchHybrid(
    { actor: ownerActor, query: { q: "overdraft" } },
    {
      runLexical: () => ({ envelope: { data: lexicalHits } }),
      runSemantic: () => ({ envelope: { data: semanticHits } }),
    }
  );
  const byKey = Object.fromEntries(result.envelope.data.map((h) => [h.record_key, h]));
  const recAlpha = byKey.rec_alpha;
  const recBeta = byKey.rec_beta;
  assert.ok(recAlpha, "rec_alpha result must be present");
  assert.ok(recBeta, "rec_beta result must be present");
  assert.equal(recAlpha.display_name, "Acme Personal");
  assert.ok(!("display_name" in recBeta));
});

// ───────────────────────────────────────────────────────────────────────
// 7.3 — Strict-validation regressions for already-shipped behavior
// ───────────────────────────────────────────────────────────────────────

test("lexical parser does NOT silently no-op on conflicting alias", () => {
  // Regression: prior code accepted both and picked one without warning.
  assert.throws(
    () =>
      parseSearchLexicalParams({
        connection_id: "ci_a",
        connector_instance_id: "ci_b",
        q: "overdraft",
      }),
    (err) =>
      err instanceof SearchLexicalRequestError &&
      err.code === "invalid_argument" &&
      err.param === "connector_instance_id"
  );
});

test("semantic parser does NOT silently no-op on conflicting alias", () => {
  assert.throws(
    () =>
      parseSearchSemanticParams({
        connection_id: "ci_a",
        connector_instance_id: "ci_b",
        q: "overdraft",
      }),
    (err) =>
      err instanceof SearchSemanticRequestError &&
      err.code === "invalid_argument" &&
      err.param === "connector_instance_id"
  );
});

test("hybrid parser does NOT silently no-op on conflicting alias", () => {
  assert.throws(
    () =>
      parseSearchHybridParams({
        connection_id: "ci_a",
        connector_instance_id: "ci_b",
        q: "overdraft",
      }),
    (err) =>
      err instanceof SearchHybridRequestError &&
      err.code === "invalid_argument" &&
      err.param === "connector_instance_id"
  );
});

test("all three search parsers reject the same alias-conflict shape consistently", () => {
  // Cross-op consistency: an MCP / dashboard / CLI client that learns one
  // error contract MUST get the same shape from every search mode. Drift
  // here is the symptom we are guarding against.
  const conflicting = {
    connection_id: "ci_a",
    connector_instance_id: "ci_b",
    q: "overdraft",
  };
  type ConflictErrorClass =
    | typeof SearchLexicalRequestError
    | typeof SearchSemanticRequestError
    | typeof SearchHybridRequestError;
  const parsers: [string, (query: Record<string, unknown>) => unknown, ConflictErrorClass][] = [
    ["lexical", parseSearchLexicalParams, SearchLexicalRequestError],
    ["semantic", parseSearchSemanticParams, SearchSemanticRequestError],
    ["hybrid", parseSearchHybridParams, SearchHybridRequestError],
  ];
  const errors: Array<{ code: string; param: string | undefined }> = [];
  for (const [label, parse, ErrType] of parsers) {
    try {
      parse(conflicting);
      assert.fail(`${label} parser failed to reject conflicting alias`);
    } catch (err) {
      assert.ok(err instanceof ErrType, `${label} threw the wrong error type`);
      errors.push({ code: err.code, param: err.param });
    }
  }
  // Same code/param across the board.
  assert.deepEqual(new Set(errors.map((e) => e.code)), new Set(["invalid_argument"]));
  assert.deepEqual(new Set(errors.map((e) => e.param)), new Set(["connector_instance_id"]));
});
