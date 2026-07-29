// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: an over-cap `limit` on the direct-REST search surface SHALL
 * surface a structured `limit_clamped` warning via the canonical
 * `meta.warnings[]` envelope slot on the rs.search.* operations, mirroring the
 * records-list `limit_clamped` semantics. The reduction is no longer silent.
 *
 * Spec: openspec/changes/add-search-limit-clamp-warning/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Search-retrieval limit is clamped to the page maximum")
 *
 * This file covers the host-independent operation behavior (all three search
 * modes, the warning derivation matrix, and hybrid single-warning dedup). The
 * native-shell-to-REST passthrough (proving the warning is not dropped at the
 * host boundary) is covered end-to-end in `lexical-retrieval.test.js`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { executeSearchHybrid, type SearchHybridActor } from "../operations/rs-search-hybrid/index.ts";
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

interface WarningLike {
  code: string;
  detail?: Record<string, unknown>;
  param?: string;
}

interface EnvelopeWithWarnings {
  meta?: { warnings?: WarningLike[] };
}

const lexicalAd = {
  cross_stream: true,
  default_limit: 25,
  max_limit: 100,
  score: { kind: "bm25", order: "lower_is_better", supported: true, value_semantics: "implementation_relative" },
  snippets: true,
  supported: true,
};

const semanticAd = {
  cross_stream: true,
  default_limit: 25,
  max_limit: 100,
  score: { kind: "semantic_distance", order: "lower_is_better", supported: true, value_semantics: "distance" },
  snippets: true,
  supported: true,
};

const BACKEND_ID = "stub-backend-limit-clamp-v1";

// A snapshot of 150 results so an over-cap request can be honestly bounded to
// the 100-hit page maximum and a `has_more` truncation is observable.
function makeLexicalResults(n: number): SearchLexicalSnapshotResult[] {
  return Array.from({ length: n }, (_, i) => ({
    connectorId: "acme_payroll",
    connectorInstanceId: "ci_alpha",
    emittedAt: "2026-04-01T00:00:00Z",
    matchedFields: ["employer"],
    recordKey: `rec_${i}`,
    score: -1.5,
    stream: "pay_statements",
  }));
}

function makeSemanticResults(n: number): SearchSemanticSnapshotResult[] {
  return Array.from({ length: n }, (_, i) => ({
    connectorId: "acme_payroll",
    connectorInstanceId: "ci_alpha",
    distance: 0.05,
    matchedFields: ["employer"],
    recordKey: `rec_${i}`,
    stream: "pay_statements",
  }));
}

function makeLexicalDeps(): SearchLexicalDependencies {
  const stored = new Map();
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }: { manifest: SearchLexicalManifest }) =>
      (manifest.streams || []).map((s) => ({ searchableFields: ["employer"], streamName: s.name })),
    buildSnapshot: ({ q }) => ({ query: q, results: makeLexicalResults(150), snapshot_id: `snap_${q}` }),
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

function makeSemanticDeps(): SearchSemanticDependencies {
  const stored = new Map();
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchSemanticManifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }: { manifest: SearchSemanticManifest }) =>
      (manifest.streams || []).map((s) => ({ searchableFields: ["employer"], streamName: s.name })),
    buildSnapshot: ({ q }) => ({
      backend_hash: BACKEND_ID,
      query: q,
      results: makeSemanticResults(150),
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

function findClamp(envelope: EnvelopeWithWarnings): WarningLike | undefined {
  return (envelope.meta?.warnings || []).find((w) => w.code === "limit_clamped");
}

// ─── rs.search.lexical ──────────────────────────────────────────────────────

test("lexical: limit=500 emits a single limit_clamped warning and bounds the page to 100", async () => {
  const result = await executeSearchLexical(
    { actor: ownerActor, query: { limit: "500", q: "overdraft" } },
    makeLexicalDeps()
  );
  assert.equal(result.envelope.data.length, 100, "over-cap page is bounded to the 100-hit max");
  assert.equal(result.envelope.has_more, true, "has_more honestly reports more hits exist");
  const clamp = findClamp(result.envelope);
  assert.ok(clamp, "expected a limit_clamped warning");
  assert.ok(clamp.detail, "expected clamp warning detail");
  assert.equal(clamp.param, "limit");
  assert.equal(clamp.detail.requested_limit, 500);
  assert.equal(clamp.detail.max_limit, 100);
  const clampCount = (result.envelope.meta?.warnings || []).filter((w) => w.code === "limit_clamped").length;
  assert.equal(clampCount, 1, "exactly one limit_clamped warning");
});

test("lexical: limit at or below the cap, absent, zero, and non-numeric emit no limit_clamped warning", async () => {
  for await (const query of [
    { limit: "100", q: "overdraft" },
    { limit: "50", q: "overdraft" },
    { q: "overdraft" },
    { limit: "0", q: "overdraft" },
    { limit: "banana", q: "overdraft" },
  ]) {
    const result = await executeSearchLexical({ actor: ownerActor, query }, makeLexicalDeps());
    assert.equal(findClamp(result.envelope), undefined, `limit=${query.limit ?? "<absent>"} must not clamp-warn`);
  }
});

// ─── rs.search.semantic ─────────────────────────────────────────────────────

test("semantic: limit=500 emits a single limit_clamped warning and bounds the page to 100", async () => {
  const result = await executeSearchSemantic(
    { actor: ownerActor, query: { limit: "500", q: "overdraft" } },
    makeSemanticDeps()
  );
  assert.equal(result.envelope.data.length, 100);
  const clamp = findClamp(result.envelope);
  assert.ok(clamp, "expected a limit_clamped warning");
  assert.ok(clamp.detail, "expected clamp warning detail");
  assert.equal(clamp.param, "limit");
  assert.equal(clamp.detail.requested_limit, 500);
  assert.equal(clamp.detail.max_limit, 100);
});

test("semantic: in-range / absent limit emits no limit_clamped warning", async () => {
  for await (const query of [{ limit: "100", q: "overdraft" }, { q: "overdraft" }]) {
    const result = await executeSearchSemantic({ actor: ownerActor, query }, makeSemanticDeps());
    assert.equal(findClamp(result.envelope), undefined);
  }
});

// ─── rs.search.hybrid ───────────────────────────────────────────────────────

test("hybrid: limit=500 emits exactly one limit_clamped warning across composed sources", async () => {
  // Hybrid clamps its own limit and forwards the already-clamped value to its
  // sub-runners, so only hybrid's own warning is emitted; even if a sub-runner
  // echoed one, dedup collapses to a single (code, param) row.
  const deps = {
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid({ actor: ownerActor, query: { limit: "500", q: "overdraft" } }, deps);
  const clamps = (result.envelope.meta?.warnings || []).filter((w) => w.code === "limit_clamped");
  assert.equal(clamps.length, 1, "hybrid emits exactly one limit_clamped warning");
  const [clamp] = clamps;
  assert.ok(clamp, "expected a limit_clamped warning entry");
  assert.ok(clamp.detail, "expected clamp warning detail");
  assert.equal(clamp.param, "limit");
  assert.equal(clamp.detail.requested_limit, 500);
  assert.equal(clamp.detail.max_limit, 100);
});

test("hybrid: in-range limit emits no limit_clamped warning", async () => {
  const deps = {
    runLexical: () => ({ envelope: { data: [] } }),
    runSemantic: () => ({ envelope: { data: [] } }),
  };
  const result = await executeSearchHybrid({ actor: ownerActor, query: { limit: "100", q: "overdraft" } }, deps);
  assert.equal(findClamp(result.envelope), undefined);
});
