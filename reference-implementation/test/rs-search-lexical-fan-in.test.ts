// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-binding fan-in tests for `rs.search.lexical`.
 *
 * Drives the operation with the new optional dependencies
 * (`listOwnerVisibleBindings`, `resolveOwnerManifestForBinding`,
 * `resolveClientBindings`) so the per-binding fan-out is exercised without
 * standing up the full Fastify host. The native shell wiring in
 * `server/search.js` is itself unit-tested by `lexical-retrieval.test.js`
 * and the storage-layer fan-in helpers (`resolveFanInBindings`,
 * `listActiveOwnerBindingsForConnectors`) are covered by
 * `storage-fan-in-read-contract.test.js`.
 *
 * What this file proves:
 * - owner-mode fan-in emits one connector plan per binding (round-robin
 *   merge across bindings, not just connectors);
 * - client-mode fan-in iterates every binding the grant authorizes;
 * - request-time `connection_id` narrows the binding set the operation
 *   plans against (owner: filter in operation; client: resolver-supplied);
 * - the deprecated `connector_instance_id` alias narrows identically to
 *   the canonical `connection_id`, and emits the deprecated-alias warning;
 * - `source_skipped_not_applicable` warnings carry the binding's
 *   `connection_id` when the skipped unit is one binding under a connector
 *   rather than the entire connector;
 * - cursors pin the snapshot they were issued for; pagination returns
 *   each hit exactly once across the full multi-binding snapshot.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSearchLexical,
  type SearchLexicalActor,
  type SearchLexicalDependencies,
  type SearchLexicalOwnerBinding,
  type SearchLexicalSnapshot,
  type SearchLexicalSnapshotResult,
} from "../operations/rs-search-lexical/index.ts";

const ownerActor: SearchLexicalActor = { kind: "owner", subject_id: "subj_owner" };

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

function hit(
  connectorId: string,
  connectorInstanceId: string,
  recordKey: string,
  score = -1
): SearchLexicalSnapshotResult {
  return {
    connectorId,
    connectorInstanceId,
    emittedAt: "2026-05-01T00:00:00Z",
    matchedFields: ["subject"],
    recordKey,
    score,
    snippet: { field: "subject", text: "snip" },
    stream: "messages",
  };
}

type HitsByBinding = Record<string, SearchLexicalSnapshotResult[] | { _emptyPlan: true }>;

function makeOwnerDepsWithBindings(
  bindings: SearchLexicalOwnerBinding[],
  hitsByBinding: HitsByBinding
): SearchLexicalDependencies & { _stored: Map<string, SearchLexicalSnapshot> } {
  const stored = new Map<string, SearchLexicalSnapshot>();
  return {
    _stored: stored,
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    buildSearchPlanForGrant: ({ manifest }) => {
      const cid =
        (manifest?.storage_binding as { connector_instance_id?: string } | undefined)?.connector_instance_id || null;
      const streamHits = cid ? hitsByBinding[cid] : undefined;
      // Empty plan signal — the operation must treat this as a skipped
      // binding (warning carries the binding's connection_id).
      if (streamHits && !Array.isArray(streamHits) && streamHits._emptyPlan) {
        return [];
      }
      return [
        {
          connectorInstanceId: cid,
          searchableFields: ["subject"],
          streamName: "messages",
        },
      ];
    },
    buildSnapshot: ({ q, perConnectorPlans }) => {
      const results: SearchLexicalSnapshotResult[] = [];
      // Round-robin across plans (each plan is one binding) — same as the
      // native adapter's roundRobinMerge over per-binding hit lists.
      const lists = perConnectorPlans.map((p) => {
        const cid = p.planEntries[0]?.connectorInstanceId as string | undefined;
        const hs = cid ? hitsByBinding[cid] : undefined;
        return Array.isArray(hs) ? hs.slice() : [];
      });
      let i = 0;
      let progress = true;
      while (progress) {
        progress = false;
        for (const list of lists) {
          const next = list[i];
          if (next) {
            results.push(next);
            progress = true;
          }
        }
        i += 1;
      }
      return {
        query: q,
        results,
        snapshot_id: `snap_${q}_${results.length}`,
      };
    },
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => defaultAdvertisement,
    listOwnerVisibleBindings: () => bindings,
    listOwnerVisibleConnectorIds: () => Array.from(new Set(bindings.map((b) => b.connectorId))),
    loadSnapshot: (id) => stored.get(id) ?? null,
    persistSnapshot: (snap) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientManifest: () => ({ streams: [{ name: "messages" }] }),
    resolveOwnerManifestForBinding: (binding) => ({
      connector_id: binding.connectorId,
      storage_binding: { connector_id: binding.connectorId, connector_instance_id: binding.connectorInstanceId },
      streams: [{ name: "messages" }],
    }),
    resolveOwnerManifestForConnector: (connectorId) => ({
      connector_id: connectorId,
      streams: [{ name: "messages" }],
    }),
  };
}

// ─── Owner-mode cross-binding fan-out ────────────────────────────────────

test("owner-mode fan-in: round-robins across two bindings of the same connector", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1"), hit("gmail", "cin_gmail_A", "A2")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1"), hit("gmail", "cin_gmail_B", "B2")],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  const ids = out.envelope.data.map((d) => d.record_key);
  // Round-robin: A1, B1, A2, B2
  assert.deepEqual(ids, ["A1", "B1", "A2", "B2"]);
  // Each hit carries the binding's connection_id.
  for (const item of out.envelope.data) {
    assert.equal(typeof item.connection_id, "string");
    assert.equal(item.connector_instance_id, item.connection_id);
  }
  // Connector count reflects one plan per binding.
  assert.equal(out.disclosureData.connector_count, 2);
});

test("owner-mode fan-in: spans different connectors and bindings together", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
    { connectorId: "slack", connectorInstanceId: "cin_slack" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "GA1")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "GB1")],
    cin_slack: [hit("slack", "cin_slack", "S1")],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  // Round-robin: one from each binding before any second hit (only one
  // exists per binding here).
  const ids = out.envelope.data.map((d) => d.record_key);
  assert.equal(ids.length, 3);
  assert.deepEqual(new Set(ids), new Set(["GA1", "GB1", "S1"]));
  // Three plans emitted = three bindings.
  assert.equal(out.disclosureData.connector_count, 3);
});

test("owner-mode fan-in: connection_id narrows to a single binding", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1")],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { connection_id: "cin_gmail_B", q: "foo" } },
    deps
  );
  assert.deepEqual(
    out.envelope.data.map((d) => d.record_key),
    ["B1"]
  );
});

test("owner-mode fan-in: unknown connection_id raises connection_not_found", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const deps = makeOwnerDepsWithBindings(bindings, {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1")],
  });
  await assert.rejects(
    () => executeSearchLexical({ actor: ownerActor, query: { connection_id: "cin_missing", q: "foo" } }, deps),
    (err: unknown) => {
      assert.ok(err && typeof err === "object" && "code" in err && "param" in err);
      assert.equal(err.code, "connection_not_found");
      assert.equal(err.param, "connection_id");
      return true;
    }
  );
});

test("owner-mode fan-in: deprecated connector_instance_id alias narrows identically and emits warning", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1")],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical(
    { actor: ownerActor, query: { connector_instance_id: "cin_gmail_A", q: "foo" } },
    deps
  );
  assert.deepEqual(
    out.envelope.data.map((d) => d.record_key),
    ["A1"]
  );
  const codes = (out.envelope.meta?.warnings || []).map((w) => w.code);
  assert.ok(codes.includes("deprecated_alias_used"));
});

test("owner-mode fan-in: skipped binding emits source_skipped_not_applicable with connection_id detail", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits: HitsByBinding = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1")],
    cin_gmail_B: { _emptyPlan: true },
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchLexical({ actor: ownerActor, query: { q: "foo" } }, deps);
  const skipped = (out.envelope.meta?.warnings || []).find((w) => w.code === "source_skipped_not_applicable");
  assert.ok(skipped, "expected a source_skipped_not_applicable warning");
  assert.equal(skipped.detail?.source, "gmail");
  assert.equal(skipped.detail?.connection_id, "cin_gmail_B");
});

test("owner-mode fan-in: cursor pages across the full multi-binding snapshot exactly once", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1"), hit("gmail", "cin_gmail_A", "A2")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1"), hit("gmail", "cin_gmail_B", "B2")],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const page1 = await executeSearchLexical({ actor: ownerActor, query: { limit: "2", q: "foo" } }, deps);
  assert.equal(page1.envelope.has_more, true);
  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { cursor: page1.envelope.next_cursor, limit: "2", q: "foo" } },
    deps
  );
  assert.equal(page2.envelope.has_more, false);
  const all = [...page1.envelope.data, ...page2.envelope.data].map((d) => d.record_key);
  assert.equal(new Set(all).size, all.length, "pagination must not duplicate hits");
  assert.equal(all.length, 4);
});

// ─── Client-mode cross-binding fan-out ───────────────────────────────────

const grantWithTwoBindings = {
  source: { id: "gmail", kind: "connector" },
  streams: [{ name: "messages" }],
};
const clientActor: SearchLexicalActor = {
  client_id: "cl1",
  grant: grantWithTwoBindings,
  grant_id: "g1",
  kind: "client",
  subject_id: "subj_owner",
};

interface ClientBindingSpec {
  connectorInstanceId: string;
  displayName?: string;
  manifest: { storage_binding: { connector_id: string; connector_instance_id: string }; streams: { name: string }[] };
}

function makeClientDepsWithBindings(
  bindingSpecs: ClientBindingSpec[],
  hitsByBinding: HitsByBinding,
  opts: { resolverError?: Error } = {}
): SearchLexicalDependencies {
  const stored = new Map<string, SearchLexicalSnapshot>();
  return {
    buildOwnerReadGrantForManifest: (m) => ({ streams: (m.streams || []).map((s) => ({ name: s.name })) }),
    buildSearchPlanForGrant: ({ manifest }) => {
      const cid =
        (manifest?.storage_binding as { connector_instance_id?: string } | undefined)?.connector_instance_id || null;
      return [{ connectorInstanceId: cid, searchableFields: ["subject"], streamName: "messages" }];
    },
    buildSnapshot: ({ q, perConnectorPlans }) => {
      const results: SearchLexicalSnapshotResult[] = [];
      const lists = perConnectorPlans.map((p) => {
        const cid = p.planEntries[0]?.connectorInstanceId as string | undefined;
        const hs = cid ? hitsByBinding[cid] : undefined;
        return Array.isArray(hs) ? hs.slice() : [];
      });
      let i = 0;
      let progress = true;
      while (progress) {
        progress = false;
        for (const list of lists) {
          const next = list[i];
          if (next) {
            results.push(next);
            progress = true;
          }
        }
        i += 1;
      }
      return { query: q, results, snapshot_id: `snap_c_${q}_${results.length}` };
    },
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => defaultAdvertisement,
    listOwnerVisibleConnectorIds: () => ["gmail"],
    loadSnapshot: (id) => stored.get(id) ?? null,
    persistSnapshot: (snap) => {
      stored.set(snap.snapshot_id, snap);
    },
    resolveClientBindings: (_actor, { connectionId }) => {
      if (opts.resolverError) {
        throw opts.resolverError;
      }
      // Honor narrowing by request connection_id; raise connection_not_found
      // when the request asked for a binding that isn't in the grant's set.
      if (connectionId) {
        const match = bindingSpecs.find((b) => b.connectorInstanceId === connectionId);
        if (!match) {
          const err = new Error(`connection_id '${connectionId}' is not addressable under this grant.`) as Error & {
            code: string;
            param: string;
          };
          err.code = "connection_not_found";
          err.param = "connection_id";
          throw err;
        }
        return [
          {
            connectorInstanceId: match.connectorInstanceId,
            manifest: match.manifest,
            ...(match.displayName ? { displayName: match.displayName } : {}),
          },
        ];
      }
      return bindingSpecs.map((b) => ({
        connectorInstanceId: b.connectorInstanceId,
        manifest: b.manifest,
        ...(b.displayName ? { displayName: b.displayName } : {}),
      }));
    },
    resolveClientManifest: () => ({ streams: [{ name: "messages" }] }),
    resolveOwnerManifestForConnector: () => ({ streams: [{ name: "messages" }] }),
  };
}

test("client-mode fan-in: emits one plan per grant-authorized binding", async () => {
  const bindingSpecs = [
    {
      connectorInstanceId: "cin_gmail_A",
      manifest: {
        storage_binding: { connector_id: "gmail", connector_instance_id: "cin_gmail_A" },
        streams: [{ name: "messages" }],
      },
    },
    {
      connectorInstanceId: "cin_gmail_B",
      manifest: {
        storage_binding: { connector_id: "gmail", connector_instance_id: "cin_gmail_B" },
        streams: [{ name: "messages" }],
      },
    },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1")],
  };
  const deps = makeClientDepsWithBindings(bindingSpecs, hits);
  const out = await executeSearchLexical({ actor: clientActor, query: { q: "foo" } }, deps);
  // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
  const ids = out.envelope.data.map((d) => d.record_key).sort();
  assert.deepEqual(ids, ["A1", "B1"]);
  for (const item of out.envelope.data) {
    assert.ok(item.connection_id);
    assert.equal(item.connector_instance_id, item.connection_id);
  }
});

test("client-mode fan-in: request connection_id outside grant raises connection_not_found", async () => {
  const bindingSpecs = [
    {
      connectorInstanceId: "cin_gmail_A",
      manifest: {
        storage_binding: { connector_id: "gmail", connector_instance_id: "cin_gmail_A" },
        streams: [{ name: "messages" }],
      },
    },
  ];
  const deps = makeClientDepsWithBindings(bindingSpecs, { cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1")] });
  await assert.rejects(
    () => executeSearchLexical({ actor: clientActor, query: { connection_id: "cin_unknown", q: "foo" } }, deps),
    (err: unknown) => {
      assert.ok(err && typeof err === "object" && "code" in err && "param" in err);
      assert.equal(err.code, "connection_not_found");
      assert.equal(err.param, "connection_id");
      return true;
    }
  );
});

// ─── Plan-hash binding-set determinism ───────────────────────────────────

test("owner-mode fan-in: cursor pins the issued snapshot even if binding ordering changes on the next call", async () => {
  // The first call enumerates bindings in [A, B]; the cursor pins that
  // snapshot. A subsequent fresh call with the same query but bindings
  // [B, A] would build a different snapshot, but the cursor reuse path
  // loads the original snapshot by id and pages from it unchanged.
  const ordered = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const reversed = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1"), hit("gmail", "cin_gmail_A", "A2")],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1"), hit("gmail", "cin_gmail_B", "B2")],
  };
  const deps = makeOwnerDepsWithBindings(ordered, hits);
  const page1 = await executeSearchLexical({ actor: ownerActor, query: { limit: "2", q: "foo" } }, deps);
  // Now reverse the binding order in the deps (simulating new active
  // bindings being added/removed mid-pagination); page2 must still serve
  // from the original snapshot.
  deps.listOwnerVisibleBindings = () => reversed;
  const page2 = await executeSearchLexical(
    { actor: ownerActor, query: { cursor: page1.envelope.next_cursor, limit: "2", q: "foo" } },
    deps
  );
  const all = [...page1.envelope.data, ...page2.envelope.data].map((d) => d.record_key);
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 4);
});
