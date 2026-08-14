// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Operation-level tests for `rs.search.lexical`.
 *
 * Exercises the operation in isolation with stub dependencies, asserting
 * that the host-independent slice of behavior moved into the operation is
 * preserved:
 *   - the result envelope flows from the dependency's snapshot;
 *   - the score-advertisement gate controls whether `score` is emitted;
 *   - the cross-stream advertisement gate requires `streams[]` when
 *     `cross_stream: false`;
 *   - the v1 query-param allowlist rejects unknown params and missing `q`;
 *   - `filter[...]` requires exactly one `streams[]` value;
 *   - client-mode `streams[] ⊆ grant.streams` is enforced
 *     (`grant_stream_not_allowed`);
 *   - owner-mode `streams[]` is a soft filter (no error on unknown stream);
 *   - cursor encode/decode round-trips through `loadSnapshot` and the
 *     operation paginates via `next_cursor`;
 *   - malformed and expired cursors raise `invalid_cursor`;
 *   - the operation produces the `disclosure.served`-shaped data block;
 *   - `formatRecordUrl` is invoked for every emitted hit.
 *
 * Host-mounted parity is covered by `lexical-retrieval.test.js` (native)
 * and the sandbox `_demo/routes.test.ts` suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeSearchLexicalCursor,
  executeSearchLexical,
  parseSearchLexicalParams,
  type SearchLexicalActor,
  type SearchLexicalDependencies,
  SearchLexicalRequestError,
  type SearchLexicalSnapshot,
  type SearchLexicalSnapshotRecall,
  type SearchLexicalSnapshotResult,
} from "../operations/rs-search-lexical/index.ts";
import { buildSearchPlanForGrant } from "../server/search.ts";

const FIELD_WINDOW_ROUTE_PATTERN = /^\/v1\/streams\/[^/]+\/records\/[^/]+\/field-window$/;
const OWNER_RECORD_URL_PATTERN = /\/owner$/;

const ownerActor: SearchLexicalActor = { kind: "owner", subject_id: "subj_owner" };
const clientGrant = {
  source: { id: "acme_payroll", kind: "connector" },
  streams: [{ name: "pay_statements" }, { name: "time_entries" }],
};
const clientActor: SearchLexicalActor = {
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
    kind: "bm25",
    order: "lower_is_better",
    supported: true,
    value_semantics: "implementation_relative",
  },
  snippets: true,
  supported: true,
};

function makeHit(overrides: Partial<SearchLexicalSnapshotResult> = {}): SearchLexicalSnapshotResult {
  return {
    connectorId: "acme_payroll",
    emittedAt: "2026-04-01T00:00:00Z",
    matchedFields: ["employer"],
    recordKey: "rec_1",
    score: -1.5,
    snippet: { field: "employer", text: "…snippet…" },
    stream: "pay_statements",
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<SearchLexicalDependencies> = {}
): SearchLexicalDependencies & { _stored: Map<string, SearchLexicalSnapshot> } {
  const stored = new Map<string, SearchLexicalSnapshot>();
  const base: SearchLexicalDependencies = {
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest, streamsFilter }) =>
      (manifest.streams || [])
        .filter((s) => !streamsFilter || streamsFilter.includes(s.name))
        .map((s) => ({ searchableFields: ["employer"], streamName: s.name })),
    buildSnapshot: ({ q, perConnectorPlans }) => ({
      query: q,
      // Empty plans ⇒ empty results, mirroring the native FTS behavior so
      // owner-mode soft-filter semantics are exercised honestly.
      results:
        perConnectorPlans.length === 0
          ? []
          : [makeHit({ recordKey: "rec_1" }), makeHit({ recordKey: "rec_2", score: -1.0 })],
      snapshot_id: `snap_${q.replace(/[^a-z0-9]/gi, "_")}`,
    }),
    formatRecordUrl: ({ stream, recordKey, isOwner }) =>
      isOwner ? `/v1/streams/${stream}/records/${recordKey}?owner=1` : `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => defaultAdvertisement,
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
  return { ...base, ...overrides, _stored: stored };
}

// ─── Allowlist + required q + filter coupling ───────────────────────────

test("parseSearchLexicalParams rejects unsupported query parameters", () => {
  assert.throws(
    () => parseSearchLexicalParams({ connector_id: "x", q: "foo" }),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "connector_id");
      return true;
    }
  );
});

test("parseSearchLexicalParams requires q", () => {
  assert.throws(
    () => parseSearchLexicalParams({}),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "q");
      return true;
    }
  );
});

test("parseSearchLexicalParams clamps and defaults limit", () => {
  assert.equal(parseSearchLexicalParams({ q: "foo" }).limit, 25);
  assert.equal(parseSearchLexicalParams({ limit: "500", q: "foo" }).limit, 100);
  assert.equal(parseSearchLexicalParams({ limit: "0", q: "foo" }).limit, 25);
  assert.equal(parseSearchLexicalParams({ limit: "7", q: "foo" }).limit, 7);
});

test("parseSearchLexicalParams normalizes streams (string and array)", () => {
  const a = parseSearchLexicalParams({ q: "foo", streams: "posts" });
  assert.deepEqual(a.streams, ["posts"]);
  const b = parseSearchLexicalParams({ q: "foo", streams: ["posts", "comments"] });
  assert.deepEqual(b.streams, ["posts", "comments"]);
  // streams[] alias
  const c = parseSearchLexicalParams({ q: "foo", "streams[]": "posts" });
  assert.deepEqual(c.streams, ["posts"]);
});

test("parseSearchLexicalParams requires filter[...] to bind to exactly one streams[]", () => {
  assert.throws(
    () => parseSearchLexicalParams({ filter: { x: 1 }, q: "foo" }),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, "invalid_request");
      assert.equal(err.param, "streams");
      return true;
    }
  );
  // OK: filter + exactly one stream
  const ok = parseSearchLexicalParams({ filter: { x: 1 }, q: "foo", streams: "posts" });
  assert.equal(ok.filteredStream, "posts");
});

// ─── Cross-stream advertisement gate ────────────────────────────────────

test("cross_stream:false advertisement requires streams[] in the request", async () => {
  const deps = makeDeps({
    getAdvertisement: () => ({ ...defaultAdvertisement, cross_stream: false }),
  });
  await assert.rejects(
    () => executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
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
    () => executeSearchLexical({ actor: clientActor, query: { q: "foo", streams: "comments" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, "grant_stream_not_allowed");
      return true;
    }
  );
});

test("client-mode allows streams[] in grant", async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical({ actor: clientActor, query: { q: "foo", streams: "pay_statements" } }, deps);
  assert.equal(out.envelope.object, "list");
  assert.equal(out.disclosureData.mode, "client");
});

// ─── Owner-mode soft streams[] filter ──────────────────────────────────

test("lexical search emits first-class bounded evidence excerpts", async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical({ actor: clientActor, query: { q: "foo" } }, deps);
  const [first] = out.envelope.data;
  assert.ok(first, "expected the first result item");

  assert.equal(first.evidence_excerpts?.[0]?.object, "evidence_excerpt");
  assert.equal(first.evidence_excerpts?.[0]?.field_path, "employer");
  assert.equal(first.evidence_excerpts?.[0]?.preview_text, "…snippet…");
  assert.equal(first.evidence_excerpts?.[0]?.truncated, true);
  assert.equal(first.evidence_excerpts?.[0]?.provenance, "lexical_match");
});

test("REST search evidence excerpt carries a bounded field-window read continuation", async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical({ actor: clientActor, query: { q: "foo" } }, deps);
  const [firstResult] = out.envelope.data;
  const [excerpt] = firstResult?.evidence_excerpts ?? [];

  // SLVP parity: a REST/CLI client must be able to follow a search excerpt to
  // the full bounded field window without exporting the record — the descriptor
  // is not a dead end. This mirrors the MCP read_record_field continuation.
  const read = excerpt?.read;
  assert.ok(read, "evidence excerpt must include a read continuation");
  assert.equal(read.object, "field_window_read");
  assert.equal(read.method, "GET");
  assert.equal(read.field, excerpt.field_path);
  assert.match(read.route, FIELD_WINDOW_ROUTE_PATTERN);
  assert.equal(typeof read.stream, "string");
  assert.equal(typeof read.record_id, "string");
  // The route is self-consistent with the structured stream/record_id.
  assert.equal(
    read.route,
    `/v1/streams/${encodeURIComponent(read.stream)}/records/${encodeURIComponent(read.record_id)}/field-window`
  );
});

test("owner-mode treats unknown streams[] as a soft filter (no error)", async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { q: "foo", streams: "totally_unknown_stream" } },
    deps
  );
  // Plan compilation drops streams not present in the manifest, so the
  // resulting plan list is empty and the operation produces zero hits
  // without raising.
  assert.equal(out.envelope.object, "list");
  assert.equal(out.envelope.has_more, false);
  assert.equal(out.envelope.data.length, 0);
});

// ─── Score-advertisement gate ───────────────────────────────────────────

test("score is emitted only when capability advertises bm25 lower_is_better", async () => {
  const depsWithScore = makeDeps();
  const out1 = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, depsWithScore);
  const [item1] = out1.envelope.data;
  assert.ok(item1, "expected the first result item");
  assert.ok(item1.score, "score should be emitted when advertised");
  assert.equal(item1.score.kind, "bm25");
  assert.equal(item1.score.order, "lower_is_better");

  const depsNoScore = makeDeps({
    getAdvertisement: () => ({
      ...defaultAdvertisement,
      score: { ...defaultAdvertisement.score, supported: false },
    }),
  });
  const out2 = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, depsNoScore);
  for (const hit of out2.envelope.data) {
    assert.equal("score" in hit, false, "score must be omitted when not advertised");
  }
});

test("authoredAt snapshot value is emitted as authored_at", async () => {
  const deps = makeDeps({
    buildSnapshot: () => ({
      query: "foo",
      results: [makeHit({ authoredAt: "2026-04-08T16:57:06.018Z" })],
      snapshot_id: "snap_authored",
    }),
  });
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  const [item] = out.envelope.data;
  assert.ok(item, "expected the first result item");
  assert.equal(item.authored_at, "2026-04-08T16:57:06.018Z");
});

// ─── formatRecordUrl is called for every hit ───────────────────────────

test("formatRecordUrl decorates every emitted result with isOwner=true for owner actor", async () => {
  const calls: { isOwner: boolean; recordKey: string; stream: string }[] = [];
  const deps = makeDeps({
    formatRecordUrl: (args) => {
      calls.push(args);
      return `/test/${args.stream}/${args.recordKey}/${args.isOwner ? "owner" : "client"}`;
    },
  });
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.equal(calls.length, out.envelope.data.length);
  for (const call of calls) {
    assert.equal(call.isOwner, true);
  }
  const [item] = out.envelope.data;
  assert.ok(item, "expected the first result item");
  assert.match(item.record_url, OWNER_RECORD_URL_PATTERN);
});

// ─── Cursor round-trip ─────────────────────────────────────────────────

test("cursor round-trip slices the snapshot and rejects malformed/expired cursors", async () => {
  const deps = makeDeps();
  // limit=1 forces pagination across the 2-result snapshot.
  const page1 = await executeSearchLexical({ actor: ownerActor, query: { limit: "1", q: "foo" } }, deps);
  assert.equal(page1.envelope.data.length, 1);
  assert.equal(page1.envelope.has_more, true);
  assert.equal(typeof page1.envelope.next_cursor, "string");

  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { cursor: page1.envelope.next_cursor, limit: "1", q: "foo" } },
    deps
  );
  assert.equal(page2.envelope.data.length, 1);
  assert.equal(page2.envelope.has_more, false);
  assert.equal("next_cursor" in page2.envelope, false);
  // Different record on page 2 than page 1.
  const [item1] = page1.envelope.data;
  const [item2] = page2.envelope.data;
  assert.ok(item1, "expected page1's result item");
  assert.ok(item2, "expected page2's result item");
  assert.notEqual(item2.record_key, item1.record_key);
});

test("cursor replay rejects a changed query or narrowed grant authority", async () => {
  const deps = makeDeps();
  const page1 = await executeSearchLexical({ actor: clientActor, query: { limit: "1", q: "foo" } }, deps);
  const cursor = page1.envelope.next_cursor;
  assert.ok(cursor);
  await assert.rejects(
    () => executeSearchLexical({ actor: clientActor, query: { cursor, q: "bar" } }, deps),
    (err) => err instanceof SearchLexicalRequestError && err.code === "invalid_cursor"
  );
  const narrowedActor: SearchLexicalActor = {
    ...clientActor,
    grant: {
      ...clientGrant,
      streams: [
        { instance_ids: ["cin_acme"], name: "pay_statements", resources: ["rec_2"] },
        { instance_ids: ["cin_acme"], name: "time_entries" },
      ],
    },
  };
  await assert.rejects(
    () => executeSearchLexical({ actor: narrowedActor, query: { cursor, q: "foo" } }, deps),
    (err) => err instanceof SearchLexicalRequestError && err.code === "invalid_cursor"
  );
});

test("malformed cursor raises invalid_cursor", async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => executeSearchLexical({ actor: ownerActor, query: { cursor: "not-base64-json", q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, "invalid_cursor");
      return true;
    }
  );
});

test("expired/unknown snapshot id raises invalid_cursor", async () => {
  const deps = makeDeps();
  // Build a syntactically-valid cursor that points at a snapshot id the
  // store has never seen.
  const cursor = encodeSearchLexicalCursor({ off: 0, snap: "snap_does_not_exist" });
  await assert.rejects(
    () => executeSearchLexical({ actor: ownerActor, query: { cursor, q: "foo" } }, deps),
    (err) => {
      assert.ok(err instanceof SearchLexicalRequestError);
      assert.equal(err.code, "invalid_cursor");
      return true;
    }
  );
});

// ─── Disclosure data block ─────────────────────────────────────────────

test("disclosure data block carries query_shape, record_count, has_more, mode, connector_count", async () => {
  const deps = makeDeps();
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.deepEqual(out.disclosureData, {
    connector_count: 2,
    has_more: false,
    mode: "owner",
    query_shape: "search",
    record_count: 2,
  });
});

// ─── Recall / count disclosure (disclose-lexical-recall-windows) ─────────

// Build deps whose snapshot carries an explicit `recall_meta`, mirroring the
// adapter seam where the FTS builder folds per-source truncation facts into
// the snapshot so cursor pages reuse them verbatim.
function makeRecallDeps(
  recallMeta: SearchLexicalSnapshotRecall | undefined,
  { hits }: { hits?: SearchLexicalSnapshotResult[] } = {}
): SearchLexicalDependencies & { _stored: Map<string, SearchLexicalSnapshot> } {
  const stored = new Map<string, SearchLexicalSnapshot>();
  return makeDeps({
    buildSnapshot: ({ q, perConnectorPlans }) => {
      const results =
        perConnectorPlans.length === 0
          ? []
          : (hits ?? [makeHit({ recordKey: "rec_1" }), makeHit({ recordKey: "rec_2", score: -1.0 })]);
      return {
        query: q,
        results,
        snapshot_id: `snap_${q.replace(/[^a-z0-9]/gi, "_")}`,
        ...(recallMeta ? { recall_meta: recallMeta } : {}),
      };
    },
    loadSnapshot: (snapshotId) => stored.get(snapshotId) ?? null,
    persistSnapshot: (snapshot) => {
      stored.set(snapshot.snapshot_id, snapshot);
    },
  });
}

test("exact complete search emits meta.count exact + recall all_matches", async () => {
  const deps = makeRecallDeps({
    count: 2,
    count_accuracy: "exact",
    recall: {
      complete: true,
      ranked_candidate_count: 2,
      ranking_scope: "all_matches",
      sources_searched_count: 2,
      truncated: false,
    },
  });
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.ok(out.envelope.meta, "expected envelope meta");
  assert.equal(out.envelope.meta.count, 2);
  assert.equal(out.envelope.meta.count_accuracy, "exact");
  assert.ok(out.envelope.meta.recall, "expected recall meta");
  assert.equal(out.envelope.meta.recall.complete, true);
  assert.equal(out.envelope.meta.recall.ranking_scope, "all_matches");
  assert.equal(out.envelope.meta.recall.truncated, false);
});

test("bounded-window search emits lower_bound count + candidate_window recall with compact facts", async () => {
  const deps = makeRecallDeps({
    count: 200,
    count_accuracy: "lower_bound",
    recall: {
      candidate_window_limit: 200,
      complete: false,
      ranked_candidate_count: 200,
      ranking_scope: "candidate_window",
      sources_searched_count: 2,
      truncated: true,
      truncated_source_count: 1,
    },
  });
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.ok(out.envelope.meta, "expected envelope meta");
  assert.equal(out.envelope.meta.count, 200);
  assert.equal(out.envelope.meta.count_accuracy, "lower_bound");
  assert.notEqual(out.envelope.meta.count_accuracy, "exact");
  const { recall } = out.envelope.meta;
  assert.ok(recall, "expected recall meta");
  assert.equal(recall.complete, false);
  assert.equal(recall.ranking_scope, "candidate_window");
  assert.equal(recall.truncated, true);
  assert.equal(recall.ranked_candidate_count, 200);
  assert.equal(recall.candidate_window_limit, 200);
  assert.ok(recall.truncated_source_count && recall.truncated_source_count > 0);
});

test("snapshot without recall_meta yields honest not_counted / unknown (no has_more inference)", async () => {
  // A snapshot that omits recall_meta (legacy adapter / pre-upgrade cursor)
  // must NOT be reported as complete just because it fit one page.
  const deps = makeRecallDeps(undefined);
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.equal(out.envelope.has_more, false);
  assert.ok(out.envelope.meta, "expected envelope meta");
  assert.equal(out.envelope.meta.count, null);
  assert.equal(out.envelope.meta.count_accuracy, "not_counted");
  assert.ok(out.envelope.meta.recall, "expected recall meta");
  assert.equal(out.envelope.meta.recall.complete, false);
  assert.equal(out.envelope.meta.recall.ranking_scope, "unknown");
  assert.equal(out.envelope.meta.recall.truncated, false);
});

test("has_more:false with a bounded window still reports recall.complete:false on every page", async () => {
  // Pagination completeness (has_more) is distinct from recall completeness.
  // A bounded-window snapshot paginated to its last page (has_more:false) must
  // keep recall.complete:false and recall.truncated:true — identical across
  // pages, because recall is a property of the ranked snapshot, not the page.
  const recallMeta: SearchLexicalSnapshotRecall = {
    count: 2,
    count_accuracy: "lower_bound",
    recall: {
      candidate_window_limit: 200,
      complete: false,
      ranked_candidate_count: 2,
      ranking_scope: "candidate_window",
      sources_searched_count: 1,
      truncated: true,
      truncated_source_count: 1,
    },
  };
  const deps = makeRecallDeps(recallMeta);
  const page1 = await executeSearchLexical({ actor: ownerActor, query: { limit: "1", q: "foo" } }, deps);
  assert.equal(page1.envelope.has_more, true);
  assert.ok(page1.envelope.meta?.recall, "expected page1 recall meta");
  assert.equal(page1.envelope.meta.recall.complete, false);
  assert.equal(page1.envelope.meta.recall.truncated, true);

  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { cursor: page1.envelope.next_cursor, limit: "1", q: "foo" } },
    deps
  );
  // Last page: has_more flips to false, but recall facts are unchanged.
  assert.equal(page2.envelope.has_more, false);
  assert.ok(page2.envelope.meta?.recall, "expected page2 recall meta");
  assert.equal(page2.envelope.meta.recall.complete, false);
  assert.equal(page2.envelope.meta.recall.truncated, true);
  assert.equal(page2.envelope.meta.count_accuracy, "lower_bound");
  assert.deepEqual(page2.envelope.meta.recall, page1.envelope.meta.recall);
});

test("recall meta coexists with structured warnings in the same meta object", async () => {
  const deps = makeRecallDeps({
    count: 2,
    count_accuracy: "exact",
    recall: { complete: true, ranking_scope: "all_matches", truncated: false },
  });
  // The deprecated alias triggers a warning; meta must carry BOTH.
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { connector_instance_id: "ci_x", q: "foo" } },
    deps
  );
  assert.ok(out.envelope.meta, "expected envelope meta");
  assert.equal(out.envelope.meta.count_accuracy, "exact");
  assert.ok(Array.isArray(out.envelope.meta.warnings));
  const warning = out.envelope.meta.warnings?.[0];
  assert.ok(warning, "expected a warning");
  assert.equal(warning.code, "deprecated_alias_used");
});

test("a stale grant for a dormant stream rejects before lexical storage/index dependencies", async () => {
  const deps = makeDeps({
    buildSearchPlanForGrant: buildSearchPlanForGrant as SearchLexicalDependencies["buildSearchPlanForGrant"],
    buildSnapshot: () => assert.fail("dormant stream must not reach lexical storage/index snapshot"),
    persistSnapshot: () => assert.fail("dormant stream must not persist a snapshot"),
    resolveClientManifest: () => ({ streams: [{ name: "pay_statements" }] }),
  });
  await assert.rejects(
    () => executeSearchLexical({ actor: clientActor, query: { q: "old", streams: "time_entries" } }, deps),
    (error: unknown) =>
      error !== null && typeof error === "object" && "code" in error && error.code === "stream_not_declared"
  );
});
