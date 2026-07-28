// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.search.semantic`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that the host-independent slice of behavior moved into the operation is
 * preserved:
 *   - the result envelope flows from the dependency's snapshot;
 *   - the score-advertisement gate controls whether `score` is emitted
 *     (kind: "semantic_distance", lower-is-better);
 *   - the cross-stream advertisement gate requires `streams[]` when
 *     `cross_stream: false`;
 *   - the v1 query-param allowlist rejects unknown params and missing `q`;
 *   - the explicit forbidden-parameter list (`vector`, `embedding`,
 *     `model`, `connector_id`, `order`, etc.) returns `invalid_request`
 *     with the rejected `param`;
 *   - `filter[...]` requires exactly one `streams[]` value;
 *   - client-mode `streams[] ⊆ grant.streams` is enforced
 *     (`grant_stream_not_allowed`);
 *   - owner-mode `streams[]` is a soft filter (no error on unknown stream);
 *   - cursor encode/decode round-trips through `loadSnapshot` and the
 *     operation paginates via `next_cursor`;
 *   - produced cursors carry the literal `sem1.` prefix;
 *   - malformed cursors (no prefix and bad body) raise `invalid_cursor`;
 *   - expired/unknown snapshot ids raise `invalid_cursor`;
 *   - backend-identity divergence on cursor load raises `invalid_cursor`
 *     (the previous "cursor predates a backend identity change" rejection);
 *   - every emitted hit carries `retrieval_mode: "semantic"`;
 *   - the operation produces the `disclosure.served`-shaped data block with
 *     `query_shape: "search_semantic"`;
 *   - `formatRecordUrl` and `hydrateResult` are invoked for every emitted
 *     hit.
 *
 * Host-mounted parity is covered by `semantic-retrieval.test.js` (native).
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSearchSemanticCursor,
  executeSearchSemantic,
  parseSearchSemanticParams,
  type SearchSemanticActor,
  type SearchSemanticDependencies,
  SearchSemanticRequestError,
  type SearchSemanticSnapshot,
  type SearchSemanticSnapshotResult,
} from "../operations/rs-search-semantic/index.ts";
import { buildSemanticSearchPlanForGrant } from "../server/search-semantic.ts";

const ownerActor: SearchSemanticActor = { kind: "owner", subject_id: "subj_owner" };
const clientGrant = {
  source: { id: "acme_payroll", kind: "connector" },
  streams: [{ name: "pay_statements" }, { name: "time_entries" }],
};
const clientActor: SearchSemanticActor = {
  client_id: "client_x",
  grant: clientGrant,
  grant_id: "grant_y",
  kind: "client",
  subject_id: "subj_client",
};

const defaultAdvertisement = {
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

const STUB_BACKEND_IDENTITY = "stub-backend-identity-v1";

function makeHit(overrides: Partial<SearchSemanticSnapshotResult> = {}): SearchSemanticSnapshotResult {
  return {
    connectorId: "acme_payroll",
    distance: 0.05,
    matchedFields: ["employer"],
    recordKey: "rec_1",
    stream: "pay_statements",
    topField: "employer",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SearchSemanticDependencies> = {}): SearchSemanticDependencies & {
  _formatCalls: { isOwner: boolean; recordKey: string; stream: string }[];
  _hydrateCalls: { hit: SearchSemanticSnapshotResult; isOwner: boolean }[];
  _stored: Map<string, SearchSemanticSnapshot>;
} {
  const stored = new Map<string, SearchSemanticSnapshot>();
  const hydrateCalls: { hit: SearchSemanticSnapshotResult; isOwner: boolean }[] = [];
  const formatCalls: { isOwner: boolean; recordKey: string; stream: string }[] = [];
  const base: SearchSemanticDependencies = {
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest, streamsFilter }) =>
      (manifest.streams || [])
        .filter((s) => !streamsFilter || streamsFilter.includes(s.name))
        .map((s) => ({ searchableFields: ["employer"], streamName: s.name })),
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      backend_hash: STUB_BACKEND_IDENTITY,
      query: q,
      // Empty plans ⇒ empty results, mirroring native behavior so owner-mode
      // soft-filter semantics are exercised honestly.
      results:
        perConnectorPlans.length === 0
          ? []
          : [makeHit({ distance: 0.05, recordKey: "rec_1" }), makeHit({ distance: 0.2, recordKey: "rec_2" })],
      snapshot_id: `snap_${q.replace(/[^a-z0-9]/gi, "_")}`,
    }),
    formatRecordUrl: ({ stream, recordKey, isOwner }) => {
      const args = { isOwner, recordKey, stream };
      formatCalls.push(args);
      return isOwner
        ? `/v1/streams/${stream}/records/${recordKey}?owner=1`
        : `/v1/streams/${stream}/records/${recordKey}`;
    },
    getAdvertisement: () => defaultAdvertisement,
    getCurrentBackendIdentity: () => STUB_BACKEND_IDENTITY,
    hydrateResult: ({ hit, isOwner }) => {
      hydrateCalls.push({ hit, isOwner });
      const topField = typeof hit.topField === "string" ? hit.topField : undefined;
      return {
        emittedAt: "2026-04-01T00:00:00Z",
        snippet: { field: topField || hit.matchedFields[0] || "", text: "…snippet…" },
      };
    },
    listOwnerVisibleConnectorIds: () => ["acme_payroll", "sherwood_finance"],
    loadSnapshot: (snapshotId) => stored.get(snapshotId) ?? null,
    persistSnapshot: (snapshot) => {
      stored.set(snapshot.snapshot_id, snapshot);
    },
    resolveClientManifest: () => ({
      streams: [{ name: "pay_statements" }, { name: "time_entries" }],
    }),
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: "pay_statements" }],
    }),
  };
  return {
    ...base,
    ...overrides,
    _formatCalls: formatCalls,
    _hydrateCalls: hydrateCalls,
    _stored: stored,
  };
}

// ─── Allowlist + required q + filter coupling + forbidden list ─────────────

test("parseSearchSemanticParams rejects unsupported query parameters", () => {
  assert.throws(
    () => parseSearchSemanticParams({ q: "foo", unknown_param: "x" }),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "unknown_param");
      return true;
    }
  );
});

test("parseSearchSemanticParams rejects every explicit forbidden parameter with param set", () => {
  // Mirrors the FORBIDDEN_PARAMS list in the operation. Each rejection must
  // carry `param: <key>` so the host-level error envelope can identify the
  // rejected parameter.
  const forbidden = [
    "vector",
    "embedding",
    "embed",
    "model",
    "model_id",
    "model_family",
    "rank",
    "boost",
    "weights",
    "blend",
    "connector_id",
    "fields",
    "expand",
    "expand[]",
    "expand_limit",
    "expand_limit[]",
    "order",
    "sort",
    "mode",
  ];
  for (const key of forbidden) {
    assert.throws(
      () => parseSearchSemanticParams({ q: "foo", [key]: "whatever" }),
      (err) => {
        assert.ok(err instanceof SearchSemanticRequestError, `${key} should throw a typed error`);
        assert.equal(err.code, "invalid_request", `${key} code`);
        assert.equal(err.param, key, `${key} param`);
        return true;
      }
    );
  }
});

test("parseSearchSemanticParams requires q", () => {
  assert.throws(
    () => parseSearchSemanticParams({}),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "q");
      return true;
    }
  );
});

test("parseSearchSemanticParams clamps and defaults limit", () => {
  assert.equal(parseSearchSemanticParams({ q: "foo" }).limit, 25);
  assert.equal(parseSearchSemanticParams({ limit: "500", q: "foo" }).limit, 100);
  assert.equal(parseSearchSemanticParams({ limit: "0", q: "foo" }).limit, 25);
  assert.equal(parseSearchSemanticParams({ limit: "7", q: "foo" }).limit, 7);
});

test("parseSearchSemanticParams normalizes streams (string and array)", () => {
  const a = parseSearchSemanticParams({ q: "foo", streams: "posts" });
  assert.deepEqual(a.streams, ["posts"]);
  const b = parseSearchSemanticParams({ q: "foo", streams: ["posts", "comments"] });
  assert.deepEqual(b.streams, ["posts", "comments"]);
  const c = parseSearchSemanticParams({ q: "foo", "streams[]": "posts" });
  assert.deepEqual(c.streams, ["posts"]);
});

test("parseSearchSemanticParams requires filter[...] to bind to exactly one streams[]", () => {
  assert.throws(
    () => parseSearchSemanticParams({ filter: { x: 1 }, q: "foo" }),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "streams");
      return true;
    }
  );
  const ok = parseSearchSemanticParams({ filter: { x: 1 }, q: "foo", streams: "posts" });
  assert.equal(ok.filteredStream, "posts");
});

// ─── Cross-stream advertisement gate ────────────────────────────────────

test("cross_stream:false advertisement requires streams[] in the request", async () => {
  const deps = makeDeps({
    getAdvertisement: () => ({ ...defaultAdvertisement, cross_stream: false }),
  });
  await assert.rejects(
    () => executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "streams");
      return true;
    }
  );
});

// ─── Client-mode grant enforcement ──────────────────────────────────────

test("client-mode rejects streams[] not in grant", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => executeSearchSemantic({ actor: clientActor, query: { q: "foo", streams: "comments" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "grant_stream_not_allowed");
      return true;
    }
  );
});

test("client-mode allows streams[] in grant", async () => {
  const deps = makeDeps();
  const out = await executeSearchSemantic({ actor: clientActor, query: { q: "foo", streams: "pay_statements" } }, deps);
  assert.equal(out.envelope.object, "list");
  assert.equal(out.disclosureData.mode, "client");
});

// ─── Owner-mode soft streams[] filter ──────────────────────────────────

test("owner-mode treats unknown streams[] as a soft filter (no error)", async () => {
  const deps = makeDeps();
  const out = await executeSearchSemantic(
    { actor: ownerActor, query: { q: "foo", streams: "totally_unknown_stream" } },
    deps
  );
  assert.equal(out.envelope.object, "list");
  assert.equal(out.envelope.has_more, false);
  assert.equal(out.envelope.data.length, 0);
});

// ─── Score-advertisement gate ───────────────────────────────────────────

test("score is emitted only when advertisement is semantic_distance lower_is_better", async () => {
  const depsWithScore = makeDeps();
  const out1 = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, depsWithScore);
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const item1 = out1.envelope.data[0];
  assert.ok(item1, "expected the first result item");
  assert.ok(item1.score, "score should be emitted when advertised");
  assert.equal(item1.score.kind, "semantic_distance");
  assert.equal(item1.score.order, "lower_is_better");

  const depsNoScore = makeDeps({
    getAdvertisement: () => ({
      ...defaultAdvertisement,
      score: { ...defaultAdvertisement.score, supported: false },
    }),
  });
  const out2 = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, depsNoScore);
  for (const hit of out2.envelope.data) {
    assert.equal("score" in hit, false, "score must be omitted when not advertised");
  }
});

test("per-hit score object carries exactly kind/value/order — no capability-level metadata leaks onto individual hits", async () => {
  // Per-hit score on /v1/search/semantic results emits exactly
  // { kind, value, order }. Capability-level fields such as `value_semantics`,
  // `comparable_with`, `model`, `dimensions`, `distance_metric`, `profile_id`,
  // `dtype`, and `backend_identity` are advertised once at
  // `capabilities.semantic_retrieval.score` and MUST NOT be repeated on
  // individual hits. Even when the advertisement carries those fields, the
  // operation must not propagate them onto the per-hit score object.
  const richAdvertisement = {
    ...defaultAdvertisement,
    score: {
      ...defaultAdvertisement.score,
      comparable_with: {
        backend_identity: "profile=stub;model=pdpp-reference-stub-embed-v0;dimensions=64;metric=cosine",
        dimensions: 64,
        distance_metric: "cosine",
        dtype: "fp32",
        model: "pdpp-reference-stub-embed-v0",
        profile_id: "stub",
      },
      value_semantics: "distance",
    },
  };
  const deps = makeDeps({ getAdvertisement: () => richAdvertisement });
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.ok(out.envelope.data.length > 0, "precondition: snapshot returned hits");
  const forbiddenScoreFields = [
    "value_semantics",
    "comparable_with",
    "model",
    "dimensions",
    "distance_metric",
    "profile_id",
    "dtype",
    "backend_identity",
    "supported",
    "snippets",
    "cross_stream",
    "default_limit",
    "max_limit",
  ];
  for (const hit of out.envelope.data) {
    assert.ok(hit.score, "precondition: score advertised, score should be emitted");
    assert.deepEqual(
      Object.keys(hit.score).sort(),
      ["kind", "order", "value"],
      "per-hit score MUST carry exactly kind/value/order"
    );
    assert.equal(hit.score.kind, "semantic_distance");
    assert.equal(hit.score.order, "lower_is_better");
    assert.equal(typeof hit.score.value, "number");
    for (const forbidden of forbiddenScoreFields) {
      assert.equal(
        forbidden in hit.score,
        false,
        `per-hit score MUST NOT include capability-level field "${forbidden}"`
      );
    }
  }
});

// ─── retrieval_mode is unconditionally "semantic" ──────────────────────

test('every emitted hit carries retrieval_mode:"semantic"', async () => {
  const deps = makeDeps();
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.ok(out.envelope.data.length > 0, "precondition: snapshot returned hits");
  for (const hit of out.envelope.data) {
    assert.equal(hit.retrieval_mode, "semantic", 'v1: every hit emits retrieval_mode:"semantic"');
  }
});

// ─── formatRecordUrl + hydrateResult are called for every hit ──────────

test("formatRecordUrl decorates every emitted result with isOwner=true for owner actor", async () => {
  const deps = makeDeps();
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.equal(deps._formatCalls.length, out.envelope.data.length);
  for (const call of deps._formatCalls) {
    assert.equal(call.isOwner, true);
  }
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const item = out.envelope.data[0];
  assert.ok(item, "expected the first result item");
  // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
  assert.match(item.record_url, /\?owner=1$/);
});

test("hydrateResult is invoked for every emitted hit and its result populates emitted_at + snippet", async () => {
  const deps = makeDeps();
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.equal(deps._hydrateCalls.length, out.envelope.data.length);
  for (const hit of out.envelope.data) {
    assert.equal(hit.emitted_at, "2026-04-01T00:00:00Z");
    assert.ok(hit.snippet, "snippet should appear when hydrate returns one");
    assert.equal(typeof hit.snippet.field, "string");
    assert.equal(typeof hit.snippet.text, "string");
  }
});

test("hydrateResult authoredAt is emitted as authored_at", async () => {
  const deps = makeDeps({
    hydrateResult: ({ hit }) => {
      const topField = typeof hit.topField === "string" ? hit.topField : undefined;
      return {
        authoredAt: "2026-04-08T16:57:06.018Z",
        emittedAt: "2026-04-01T00:00:00Z",
        snippet: { field: topField || hit.matchedFields[0] || "", text: "…snippet…" },
      };
    },
  });
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const item = out.envelope.data[0];
  assert.ok(item, "expected the first result item");
  assert.equal(item.authored_at, "2026-04-08T16:57:06.018Z");
});

test("hydrateResult returning null/undefined snippet causes the field to be omitted", async () => {
  const deps = makeDeps({
    hydrateResult: () => ({ emittedAt: null, snippet: null }),
  });
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  for (const hit of out.envelope.data) {
    assert.equal("snippet" in hit, false, "snippet must be omitted when hydrate returns none");
    assert.equal(hit.emitted_at, null);
  }
});

// ─── Cursor round-trip + sem1. prefix + backend-identity stale check ───

test("cursor round-trip slices the snapshot and produces sem1.-prefixed cursors", async () => {
  const deps = makeDeps();
  const page1 = await executeSearchSemantic({ actor: ownerActor, query: { limit: "1", q: "foo" } }, deps);
  assert.equal(page1.envelope.data.length, 1);
  assert.equal(page1.envelope.has_more, true);
  assert.equal(typeof page1.envelope.next_cursor, "string");
  const cursor = page1.envelope.next_cursor;
  assert.ok(cursor, "expected a next_cursor");
  assert.ok(cursor.startsWith("sem1."), "semantic cursors MUST carry the literal sem1. prefix");

  const page2 = await executeSearchSemantic({ actor: ownerActor, query: { cursor, limit: "1", q: "foo" } }, deps);
  assert.equal(page2.envelope.data.length, 1);
  assert.equal(page2.envelope.has_more, false);
  assert.equal("next_cursor" in page2.envelope, false);
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const item1 = page1.envelope.data[0];
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const item2 = page2.envelope.data[0];
  assert.ok(item1, "expected page1's result item");
  assert.ok(item2, "expected page2's result item");
  assert.notEqual(item2.record_key, item1.record_key);
});

test("cursor without sem1. prefix raises invalid_cursor", async () => {
  const deps = makeDeps();
  // A base64url-encoded JSON cursor *without* the sem1. prefix — i.e. the
  // shape produced by the lexical operation. Must not be honored.
  const lexicalLikeCursor = Buffer.from(JSON.stringify({ off: 1, snap: "snap_foo" }), "utf8").toString("base64url");
  await assert.rejects(
    () => executeSearchSemantic({ actor: ownerActor, query: { cursor: lexicalLikeCursor, q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_cursor");
      return true;
    }
  );
});

test("malformed sem1. cursor raises invalid_cursor", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => executeSearchSemantic({ actor: ownerActor, query: { cursor: "sem1.not-base64-json", q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_cursor");
      return true;
    }
  );
});

test("expired/unknown snapshot id raises invalid_cursor", async () => {
  const deps = makeDeps();
  const cursor = encodeSearchSemanticCursor({ off: 0, snap: "snap_does_not_exist" });
  await assert.rejects(
    () => executeSearchSemantic({ actor: ownerActor, query: { cursor, q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_cursor");
      return true;
    }
  );
});

test("snapshot whose backend_hash differs from current backend identity raises invalid_cursor", async () => {
  // Build a snapshot under one backend identity, then ask the operation to
  // load it under a different backend identity. The operation MUST raise
  // invalid_cursor — this is the "cursor predates a backend identity
  // change" rejection that prevents recomputing under a different model.
  let currentIdentity = STUB_BACKEND_IDENTITY;
  const deps = makeDeps({
    getCurrentBackendIdentity: () => currentIdentity,
  });
  // First request builds and persists the snapshot under STUB_BACKEND_IDENTITY.
  const page1 = await executeSearchSemantic({ actor: ownerActor, query: { limit: "1", q: "foo" } }, deps);
  assert.equal(page1.envelope.has_more, true);
  // Backend identity rotates — e.g. operator changes the embedding model.
  currentIdentity = "rotated-backend-identity-v2";
  await assert.rejects(
    () =>
      executeSearchSemantic(
        { actor: ownerActor, query: { cursor: page1.envelope.next_cursor, limit: "1", q: "foo" } },
        deps
      ),
    (err) => {
      assert.ok(err instanceof SearchSemanticRequestError);
      assert.equal(err.code, "invalid_cursor");
      return true;
    }
  );
});

// ─── Disclosure data block ─────────────────────────────────────────────

test("disclosure data block carries query_shape:search_semantic plus record_count, has_more, mode, connector_count", async () => {
  const deps = makeDeps();
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.deepEqual(out.disclosureData, {
    connector_count: 2,
    has_more: false,
    mode: "owner",
    query_shape: "search_semantic",
    record_count: 2,
  });
});

test("a stale grant for a dormant stream rejects before semantic storage/index dependencies", async () => {
  const deps = makeDeps({
    buildSearchPlanForGrant: buildSemanticSearchPlanForGrant as SearchSemanticDependencies["buildSearchPlanForGrant"],
    buildSnapshot: () => assert.fail("dormant stream must not reach semantic storage/index snapshot"),
    persistSnapshot: () => assert.fail("dormant stream must not persist a snapshot"),
    resolveClientManifest: () => ({ streams: [{ name: "pay_statements" }] }),
  });
  await assert.rejects(
    () => executeSearchSemantic({ actor: clientActor, query: { q: "old", streams: "time_entries" } }, deps),
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "stream_not_declared"
  );
});
