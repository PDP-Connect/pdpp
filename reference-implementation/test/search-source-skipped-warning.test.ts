// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `source_skipped_not_applicable` warning — task 3.6 of
 * `canonicalize-public-read-contract`.
 *
 * Owner-mode search fans out across every owner-visible connector. Today
 * the runtime silently drops connectors whose manifest cannot be resolved
 * or whose searchable plan is empty (no declared lexical/semantic fields).
 *
 * The canonical envelope requires that these drops surface as structured
 * `source_skipped_not_applicable` warnings on `meta.warnings[]`, so wire
 * consumers (REST, MCP, dashboard, CLI) can detect partial fan-out without
 * relying on free-form prose or connector-side health checks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type {
  SearchLexicalActor,
  SearchLexicalDependencies,
  SearchLexicalManifest,
  SearchLexicalSnapshot,
} from "../operations/rs-search-lexical/index.ts";
import { executeSearchLexical, SEARCH_SOURCE_SKIPPED_WARNING_CODE } from "../operations/rs-search-lexical/index.ts";
import type {
  SearchSemanticDependencies,
  SearchSemanticManifest,
  SearchSemanticSnapshot,
} from "../operations/rs-search-semantic/index.ts";
import {
  executeSearchSemantic,
  SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE,
} from "../operations/rs-search-semantic/index.ts";

const ownerActor: SearchLexicalActor = { kind: "owner", subject_id: "subj_owner" };

/**
 * `SearchSemanticEnvelopeMeta.warnings` is publicly typed without `detail`
 * (`Array<{ code, param?, message? }>`), but the operation's
 * `source_skipped_not_applicable` warnings are always constructed as
 * `SearchSemanticWarning` (which does carry `detail: Record<string, unknown>`)
 * before being placed on `meta.warnings` — see the `skippedWarnings` /
 * `allWarnings` construction in `operations/rs-search-semantic/index.ts`.
 * This is a real mismatch between the internal warning type and the public
 * envelope-meta type; this guard verifies the shape at runtime rather than
 * asserting it away.
 */
function hasSourceDetail(w: unknown): w is { code: string; detail: { source?: unknown } } {
  return (
    typeof w === "object" &&
    w !== null &&
    "detail" in w &&
    typeof (w as { detail?: unknown }).detail === "object" &&
    (w as { detail: unknown }).detail !== null
  );
}

/** Options shared by `makeLexicalDeps` and `makeSemanticDeps`. */
interface MakeDepsOptions {
  brokenManifestConnectors?: string[];
  emptyPlanConnectors?: string[];
  ownerConnectors: string[];
  throwingFilterConnectors?: string[];
}

/** Error shape thrown by `buildSearchPlanForGrant` to simulate a per-stream schema miss. */
interface FilterFieldNotInSchemaError extends Error {
  code: string;
}

function makeFilterFieldNotInSchemaError(): FilterFieldNotInSchemaError {
  const err = new Error("Unknown field: received_at") as FilterFieldNotInSchemaError;
  err.code = "filter_field_not_in_schema";
  return err;
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

const SEMANTIC_BACKEND_ID = "stub-source-skipped-v1";

function makeLexicalDeps({
  ownerConnectors,
  brokenManifestConnectors = [],
  emptyPlanConnectors = [],
  throwingFilterConnectors = [],
}: MakeDepsOptions): SearchLexicalDependencies {
  const stored = new Map<string, SearchLexicalSnapshot>();
  const broken = new Set(brokenManifestConnectors);
  const empty = new Set(emptyPlanConnectors);
  const throwing = new Set(throwingFilterConnectors);
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({
      manifest,
      connectorId,
    }: {
      manifest: SearchLexicalManifest;
      connectorId: string | null;
    }) => {
      if (connectorId !== null && empty.has(connectorId)) {
        return [];
      }
      if (connectorId !== null && throwing.has(connectorId)) {
        // Simulates compileRequestFilters throwing "Unknown field" when the
        // stream's schema lacks the filtered field.
        throw makeFilterFieldNotInSchemaError();
      }
      return (manifest.streams || []).map((s) => ({
        searchableFields: ["subject"],
        streamName: s.name,
      }));
    },
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      query: q,
      results: perConnectorPlans.flatMap(({ connectorId }) => [
        {
          connectorId: connectorId ?? "",
          connectorInstanceId: `ci_${connectorId}`,
          emittedAt: "2026-04-01T00:00:00Z",
          matchedFields: ["subject"],
          recordKey: `rec_${connectorId}`,
          score: -1,
          stream: "messages",
        },
      ]),
      snapshot_id: `snap_${q}`,
    }),
    formatRecordUrl: ({ stream, recordKey }: { stream: string; recordKey: string }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ownerConnectors,
    loadSnapshot: (id: string) => stored.get(id) ?? null,
    persistSnapshot: (snap: SearchLexicalSnapshot) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "messages" }] }),
    resolveOwnerManifestForConnector: (connectorId: string) => {
      if (broken.has(connectorId)) {
        return null;
      }
      return { connector_id: connectorId, streams: [{ name: "messages" }] };
    },
  };
}

function makeSemanticDeps({
  ownerConnectors,
  brokenManifestConnectors = [],
  emptyPlanConnectors = [],
  throwingFilterConnectors = [],
}: MakeDepsOptions): SearchSemanticDependencies {
  const stored = new Map<string, SearchSemanticSnapshot>();
  const broken = new Set(brokenManifestConnectors);
  const empty = new Set(emptyPlanConnectors);
  const throwing = new Set(throwingFilterConnectors);
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchSemanticManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({
      manifest,
      connectorId,
    }: {
      manifest: SearchSemanticManifest;
      connectorId: string | null;
    }) => {
      if (connectorId !== null && empty.has(connectorId)) {
        return [];
      }
      if (connectorId !== null && throwing.has(connectorId)) {
        throw makeFilterFieldNotInSchemaError();
      }
      return (manifest.streams || []).map((s) => ({
        searchableFields: ["subject"],
        streamName: s.name,
      }));
    },
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      backend_hash: SEMANTIC_BACKEND_ID,
      query: q,
      results: perConnectorPlans.flatMap(({ connectorId }) => [
        {
          connectorId: connectorId ?? "",
          connectorInstanceId: `ci_${connectorId}`,
          distance: 0.1,
          matchedFields: ["subject"],
          recordKey: `rec_${connectorId}`,
          stream: "messages",
        },
      ]),
      snapshot_id: `snap_${q}`,
    }),
    formatRecordUrl: ({ stream, recordKey }: { stream: string; recordKey: string }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => semanticAd,
    getCurrentBackendIdentity: () => SEMANTIC_BACKEND_ID,
    hydrateResult: ({ hit }: { hit: { recordKey: string } }) => ({
      emittedAt: "2026-04-01T00:00:00Z",
      snippet: { field: "subject", text: `…${hit.recordKey}…` },
    }),
    listOwnerVisibleConnectorIds: () => ownerConnectors,
    loadSnapshot: (id: string) => stored.get(id) ?? null,
    persistSnapshot: (snap: SearchSemanticSnapshot) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "messages" }] }),
    resolveOwnerManifestForConnector: (connectorId: string) => {
      if (broken.has(connectorId)) {
        return null;
      }
      return { connector_id: connectorId, streams: [{ name: "messages" }] };
    },
  };
}

// ───────────────────────────────────────────────────────────────────────
// Lexical
// ───────────────────────────────────────────────────────────────────────

test("lexical search emits source_skipped_not_applicable for broken-manifest connector", async () => {
  const deps = makeLexicalDeps({
    brokenManifestConnectors: ["broken_one"],
    ownerConnectors: ["acme", "broken_one"],
  });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "hello" } }, deps);
  const warnings = result.envelope.meta?.warnings ?? [];
  const skipped = warnings.filter((w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0]);
  assert.equal(skipped[0].detail?.source, "broken_one");
});

test("lexical search emits source_skipped_not_applicable when the searchable plan is empty", async () => {
  const deps = makeLexicalDeps({
    emptyPlanConnectors: ["no_fields"],
    ownerConnectors: ["acme", "no_fields"],
  });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "hello" } }, deps);
  const skipped = (result.envelope.meta?.warnings ?? []).filter((w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0]);
  assert.equal(skipped[0].detail?.source, "no_fields");
});

test("lexical search omits source_skipped_not_applicable when every connector contributes", async () => {
  const deps = makeLexicalDeps({ ownerConnectors: ["acme"] });
  const result = await executeSearchLexical({ actor: ownerActor, query: { q: "hello" } }, deps);
  const warnings = result.envelope.meta?.warnings ?? [];
  for (const w of warnings) {
    assert.notEqual(w.code, SEARCH_SOURCE_SKIPPED_WARNING_CODE);
  }
});

// ───────────────────────────────────────────────────────────────────────
// Semantic
// ───────────────────────────────────────────────────────────────────────

test("semantic search emits source_skipped_not_applicable for broken-manifest connector", async () => {
  const deps = makeSemanticDeps({
    brokenManifestConnectors: ["broken_one"],
    ownerConnectors: ["acme", "broken_one"],
  });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "hello" } }, deps);
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE
  );
  assert.equal(skipped.length, 1);
  assert.ok(hasSourceDetail(skipped[0]));
  assert.equal(skipped[0].detail.source, "broken_one");
});

test("semantic search emits source_skipped_not_applicable when the searchable plan is empty", async () => {
  const deps = makeSemanticDeps({
    emptyPlanConnectors: ["no_fields"],
    ownerConnectors: ["acme", "no_fields"],
  });
  const result = await executeSearchSemantic({ actor: ownerActor, query: { q: "hello" } }, deps);
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE
  );
  assert.equal(skipped.length, 1);
  assert.ok(hasSourceDetail(skipped[0]));
  assert.equal(skipped[0].detail.source, "no_fields");
});

// ───────────────────────────────────────────────────────────────────────
// B4: Unknown-field filter → skip, not ok:false
//
// When an owner fan-out query filters on a field that exists in some streams
// but not others, the per-source filter compilation throws an
// `invalidQueryError`-shaped error. The operation must convert it to a
// `source_skipped_not_applicable` warning rather than propagating it as a
// whole-request failure.
// ───────────────────────────────────────────────────────────────────────

test("lexical: multi-source query — unknown-field filter skips that source, others succeed", async () => {
  // "acme" has the filtered field; "legacy" lacks it (throws invalidQueryError).
  const deps = makeLexicalDeps({
    ownerConnectors: ["acme", "legacy"],
    throwingFilterConnectors: ["legacy"],
  });
  const result = await executeSearchLexical(
    {
      actor: ownerActor,
      query: { filter: { received_at: { gte: "2026-01-01" } }, q: "hello", "streams[]": "messages" },
    },
    deps
  );
  // The skip warning is present for the throwing source.
  const skipped = (result.envelope.meta?.warnings ?? []).filter((w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE);
  assert.equal(skipped.length, 1, "exactly one source skipped");
  assert.ok(skipped[0]);
  assert.equal(skipped[0].detail?.source, "legacy");
  // The non-throwing source contributed a result.
  assert.equal(
    result.envelope.data.some((d) => d.connector_id === "acme"),
    true,
    "acme result present"
  );
});

test("lexical: single-source unknown-field filter propagates as error (no silent widening)", async () => {
  // Single source with a throwing filter — the error should propagate, not be swallowed.
  // In client mode (single manifest path), the caller controls the filter and
  // must get an error back so they can fix the request.
  const stored = new Map<string, SearchLexicalSnapshot>();
  const deps: SearchLexicalDependencies = {
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: () => {
      throw makeFilterFieldNotInSchemaError();
    },
    buildSnapshot: ({ q }: { q: string }) => ({ query: q, results: [], snapshot_id: `snap_${q}` }),
    formatRecordUrl: ({ stream, recordKey }: { stream: string; recordKey: string }) =>
      `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => lexicalAd,
    listOwnerVisibleConnectorIds: () => ["acme"],
    loadSnapshot: (id: string) => stored.get(id) ?? null,
    persistSnapshot: (snap: SearchLexicalSnapshot) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "messages" }] }),
    resolveOwnerManifestForConnector: () => ({ streams: [{ name: "messages" }] }),
  };
  // Owner fan-out with single connector: should emit skip warning, not throw.
  const result = await executeSearchLexical(
    {
      actor: ownerActor,
      query: { filter: { received_at: { gte: "2026-01-01" } }, q: "hello", "streams[]": "messages" },
    },
    deps
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter((w) => w.code === SEARCH_SOURCE_SKIPPED_WARNING_CODE);
  assert.equal(skipped.length, 1, "single-connector unknown-field emits skip warning");
  assert.equal(result.envelope.data.length, 0, "no results from skipped connector");
});

test("semantic: multi-source query — unknown-field filter skips that source, others succeed", async () => {
  const deps = makeSemanticDeps({
    ownerConnectors: ["acme", "legacy"],
    throwingFilterConnectors: ["legacy"],
  });
  const result = await executeSearchSemantic(
    {
      actor: ownerActor,
      query: { filter: { received_at: { gte: "2026-01-01" } }, q: "hello", "streams[]": "messages" },
    },
    deps
  );
  const skipped = (result.envelope.meta?.warnings ?? []).filter(
    (w) => w.code === SEARCH_SEMANTIC_SOURCE_SKIPPED_WARNING_CODE
  );
  assert.equal(skipped.length, 1, "exactly one source skipped");
  assert.ok(hasSourceDetail(skipped[0]));
  assert.equal(skipped[0].detail.source, "legacy");
  assert.equal(
    result.envelope.data.some((d) => d.connector_id === "acme"),
    true,
    "acme result present"
  );
});
