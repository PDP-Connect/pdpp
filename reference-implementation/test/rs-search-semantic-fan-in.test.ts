// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-binding fan-in tests for `rs.search.semantic`.
 *
 * Drives the operation with the new optional dependencies
 * (`listOwnerVisibleBindings`, `resolveOwnerManifestForBinding`,
 * `resolveClientBindings`). Mirrors `rs-search-lexical-fan-in.test.js`
 * but the merge is total-order by distance, not round-robin.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSearchSemantic,
  type SearchSemanticActor,
  type SearchSemanticClientBinding,
  type SearchSemanticDependencies,
  type SearchSemanticOwnerBinding,
  type SearchSemanticSnapshot,
  type SearchSemanticSnapshotResult,
  type SearchSemanticWarning,
} from "../operations/rs-search-semantic/index.ts";

const ownerActor: SearchSemanticActor = { kind: "owner", subject_id: "subj_owner" };
const STUB_BACKEND_IDENTITY = "stub-backend-identity-v1";

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
  supported: true,
};

function hit(
  connectorId: string,
  connectorInstanceId: string,
  recordKey: string,
  distance: number
): SearchSemanticSnapshotResult {
  return {
    connectorId,
    connectorInstanceId,
    distance,
    matchedFields: ["subject"],
    recordKey,
    stream: "messages",
    topField: "subject",
  };
}

type HitsByBinding = Record<string, SearchSemanticSnapshotResult[] | { _emptyPlan: true }>;

function makeOwnerDepsWithBindings(
  bindings: SearchSemanticOwnerBinding[],
  hitsByBinding: HitsByBinding
): SearchSemanticDependencies & {
  _stored: Map<string, SearchSemanticSnapshot>;
  resolveClientBindings?: SearchSemanticDependencies["resolveClientBindings"];
} {
  const stored = new Map<string, SearchSemanticSnapshot>();
  return {
    _stored: stored,
    buildOwnerReadGrantForManifest: (m) => ({ streams: (m.streams || []).map((s) => ({ name: s.name })) }),
    buildSearchPlanForGrant: ({ manifest }) => {
      const cid =
        (manifest?.storage_binding as { connector_instance_id?: string } | undefined)?.connector_instance_id || null;
      const hs = cid ? hitsByBinding[cid] : undefined;
      if (hs && !Array.isArray(hs) && hs._emptyPlan) {
        return [];
      }
      return [{ connectorInstanceId: cid, searchableFields: ["subject"], streamName: "messages" }];
    },
    buildSnapshot: ({ q, perConnectorPlans }) => {
      // Per-binding KNN + global total-order merge by distance, mirroring
      // the native semantic adapter.
      const flat: SearchSemanticSnapshotResult[] = [];
      for (const p of perConnectorPlans) {
        const cid = p.planEntries[0]?.connectorInstanceId as string | undefined;
        const hs = cid ? hitsByBinding[cid] : undefined;
        if (Array.isArray(hs)) {
          flat.push(...hs);
        }
      }
      const sorted = flat.sort((a, b) => {
        if (a.distance !== b.distance) {
          return a.distance - b.distance;
        }
        const cia = a.connectorInstanceId || "";
        const cib = b.connectorInstanceId || "";
        if (cia !== cib) {
          return cia < cib ? -1 : 1;
        }
        return a.recordKey < b.recordKey ? -1 : 1;
      });
      return {
        backend_hash: STUB_BACKEND_IDENTITY,
        query: q,
        results: sorted,
        snapshot_id: `snap_sem_${q}_${sorted.length}`,
      };
    },
    formatRecordUrl: ({ stream, recordKey }) => `/v1/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => defaultAdvertisement,
    getCurrentBackendIdentity: () => STUB_BACKEND_IDENTITY,
    hydrateResult: () => ({
      emittedAt: "2026-05-01T00:00:00Z",
      snippet: { field: "subject", text: "snip" },
    }),
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

test("owner-mode semantic fan-in: total-order merge by distance across bindings", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1", 0.1), hit("gmail", "cin_gmail_A", "A2", 0.3)],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1", 0.05), hit("gmail", "cin_gmail_B", "B2", 0.25)],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  // Global order by distance: B1(0.05), A1(0.10), B2(0.25), A2(0.30)
  assert.deepEqual(
    out.envelope.data.map((d) => d.record_key),
    ["B1", "A1", "B2", "A2"]
  );
  for (const item of out.envelope.data) {
    assert.equal(typeof item.connection_id, "string");
    assert.equal(item.connector_instance_id, item.connection_id);
  }
  assert.equal(out.disclosureData.connector_count, 2);
});

test("owner-mode semantic fan-in: a record indexed in two bindings appears twice with distinct connection_ids", async () => {
  // Same record_key in two bindings — must remain two separate hits.
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "shared", 0.1)],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "shared", 0.15)],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  assert.equal(out.envelope.data.length, 2);
  const cids = out.envelope.data.map((d) => d.connection_id);
  assert.deepEqual(new Set(cids), new Set(["cin_gmail_A", "cin_gmail_B"]));
});

test("owner-mode semantic fan-in: connection_id narrows to one binding", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1", 0.1)],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1", 0.05)],
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic(
    { actor: ownerActor, query: { connection_id: "cin_gmail_A", q: "foo" } },
    deps
  );
  assert.deepEqual(
    out.envelope.data.map((d) => d.record_key),
    ["A1"]
  );
});

test("owner-mode semantic fan-in: unknown connection_id raises connection_not_found", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const deps = makeOwnerDepsWithBindings(bindings, {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1", 0.1)],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1", 0.05)],
  });
  await assert.rejects(
    () => executeSearchSemantic({ actor: ownerActor, query: { connection_id: "cin_missing", q: "foo" } }, deps),
    (err: unknown) => {
      assert.ok(err && typeof err === "object" && "code" in err && "param" in err);
      assert.equal(err.code, "connection_not_found");
      assert.equal(err.param, "connection_id");
      return true;
    }
  );
});

test("owner-mode semantic fan-in: empty plan on one binding emits binding-aware skipped warning", async () => {
  const bindings = [
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
    { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
  ];
  const hits: HitsByBinding = {
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1", 0.1)],
    cin_gmail_B: { _emptyPlan: true },
  };
  const deps = makeOwnerDepsWithBindings(bindings, hits);
  const out = await executeSearchSemantic({ actor: ownerActor, query: { q: "foo" } }, deps);
  const skipped = (out.envelope.meta?.warnings || []).find((w) => w.code === "source_skipped_not_applicable") as
    | SearchSemanticWarning
    | undefined;
  assert.ok(skipped);
  assert.equal(skipped.detail?.connection_id, "cin_gmail_B");
  assert.equal(skipped.detail?.source, "gmail");
});

test("client-mode semantic fan-in: iterates every grant-authorized binding", async () => {
  const grant = { source: { id: "gmail", kind: "connector" }, streams: [{ name: "messages" }] };
  const clientActor: SearchSemanticActor = { client_id: "c", grant, grant_id: "g", kind: "client", subject_id: "subj" };
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
    cin_gmail_A: [hit("gmail", "cin_gmail_A", "A1", 0.1)],
    cin_gmail_B: [hit("gmail", "cin_gmail_B", "B1", 0.05)],
  };
  const deps = makeOwnerDepsWithBindings(
    [
      { connectorId: "gmail", connectorInstanceId: "cin_gmail_A" },
      { connectorId: "gmail", connectorInstanceId: "cin_gmail_B" },
    ],
    hits
  );
  // override with client-mode bindings resolver
  deps.resolveClientBindings = (_actor, { connectionId }): SearchSemanticClientBinding[] => {
    if (connectionId) {
      const m = bindingSpecs.find((b) => b.connectorInstanceId === connectionId);
      if (!m) {
        const err = new Error(`connection_id '${connectionId}' is not addressable under this grant.`) as Error & {
          code: string;
          param: string;
        };
        err.code = "connection_not_found";
        err.param = "connection_id";
        throw err;
      }
      return [{ connectorInstanceId: m.connectorInstanceId, manifest: m.manifest }];
    }
    return bindingSpecs.map((b) => ({ connectorInstanceId: b.connectorInstanceId, manifest: b.manifest }));
  };
  const out = await executeSearchSemantic({ actor: clientActor, query: { q: "foo" } }, deps);
  assert.deepEqual(
    out.envelope.data.map((d) => d.record_key),
    ["B1", "A1"]
  );
});
