// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-surface proof that connector-instance canonicalization (account
 * unification) actually changes what every read surface renders once a
 * fragment is grouped — not just that the resolver function is correct in
 * isolation (see connector-instance-canonicalization.test.ts for that).
 *
 * Setup: one connector ("amazon") with two connector_instances rows under
 * one owner — `cin_amazon_canonical` and `cin_amazon_fragment` — grouped via
 * a `connector_instance_groups` row written the same way the migration tool
 * writes it (`connectorInstanceGroupsUpsert`). A third, ungrouped
 * "github"-shape connector instance (`cin_github_unresolved`) proves the
 * grouping is scoped to exactly the fragment it names and never leaks onto
 * an unrelated connection.
 *
 * Asserts, across every wired read surface:
 *   (b) Sources list hides the fragment; only the canonical entry renders.
 *   (c) Explore/timeline listing still returns the fragment's own row,
 *       attributed to the canonical identity via `canonicalConnectorInstanceId`.
 *   (d) A lexical search hit AND a semantic search hit for fragment-only
 *       content both report the canonical connector_instance_id.
 *   (e) The ungrouped GitHub-shape instance is fully unaffected on every
 *       surface above.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { exec } from "../lib/db.ts";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { referenceQueries } from "../server/queries/index.ts";
import { drainConnectorInstanceIndexWork, ingestRecord } from "../server/records.ts";
import { runLexicalSearch } from "../server/search.ts";
import { configureSemanticBackend, makeStubBackend, runSemanticSearch } from "../server/search-semantic.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

const CONNECTOR_ID = "amazon-unification-xsurface";
const GITHUB_CONNECTOR_ID = "github-unification-xsurface";
const STREAM = "orders";
const CANONICAL_ID = "cin_amazon_canonical_xsurface";
const FRAGMENT_ID = "cin_amazon_fragment_xsurface";
const GITHUB_ID = "cin_github_unresolved_xsurface";

const amazonManifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Amazon (cross-surface test)",
  manifest_uri: `https://registry.pdpp.dev/connectors/${CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      query: { search: { lexical_fields: ["title"], semantic_fields: ["title"] } },
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          title: { type: "string" },
        },
        required: ["id", "title", "received_at"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

const githubManifest = {
  capabilities: { human_interaction: [] },
  connector_id: GITHUB_CONNECTOR_ID,
  display_name: "GitHub (cross-surface test)",
  manifest_uri: `https://registry.pdpp.dev/connectors/${GITHUB_CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      query: { search: { lexical_fields: ["title"], semantic_fields: ["title"] } },
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          title: { type: "string" },
        },
        required: ["id", "title", "received_at"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "append_only",
    },
  ],
  version: "1.0.0",
};

function target(connectorId: string, instanceId: string) {
  return { connector_id: connectorId, connector_instance_id: instanceId };
}

function payload(id: string, title: string, receivedAt: string) {
  return {
    data: { id, received_at: receivedAt, title },
    emitted_at: receivedAt,
    key: id,
    stream: STREAM,
  };
}

async function seedInstance(connectorId: string, instanceId: string, displayName: string, sourceBindingKey: string) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId,
    connectorInstanceId: instanceId,
    createdAt: now,
    displayName,
    ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    sourceBinding: { account: sourceBindingKey },
    sourceBindingKey,
    sourceKind: "account",
    status: "active",
    updatedAt: now,
  });
}

function groupFragment(
  connectorInstanceId: string,
  canonicalConnectorInstanceId: string,
  ownerSubjectId: string
): void {
  exec(referenceQueries.connectorInstanceGroupsUpsert, [
    connectorInstanceId,
    canonicalConnectorInstanceId,
    ownerSubjectId,
    "proven_subset",
    JSON.stringify({ test: "cross-surface" }),
    "test-actor",
    new Date().toISOString(),
  ]);
}

async function withSeededDb(testFn: () => Promise<void>) {
  initDb();
  configureSemanticBackend(makeStubBackend({ dimensions: 32 }));
  try {
    await registerConnector(amazonManifest);
    await registerConnector(githubManifest);
    await seedInstance(CONNECTOR_ID, CANONICAL_ID, "Amazon", "amazon-canonical@example.com");
    await seedInstance(CONNECTOR_ID, FRAGMENT_ID, "Amazon (fragment)", "amazon-fragment@example.com");
    await seedInstance(GITHUB_CONNECTOR_ID, GITHUB_ID, "GitHub", "github-user@example.com");

    // Canonical row carries a record too, so Sources still has something to
    // show for it once the fragment is hidden.
    await ingestRecord(
      target(CONNECTOR_ID, CANONICAL_ID),
      payload("order-canonical-1", "canonical widget purchase", "2026-08-01T00:00:00.000Z")
    );
    // Fragment-only content: the record that must remain findable via
    // search, attributed to the canonical identity once grouped.
    await ingestRecord(
      target(CONNECTOR_ID, FRAGMENT_ID),
      payload("order-fragment-1", "fragment gadget purchase unobtainium", "2026-08-02T00:00:00.000Z")
    );
    // Ungrouped GitHub-shape sibling: must stay fully independent everywhere.
    await ingestRecord(
      target(GITHUB_CONNECTOR_ID, GITHUB_ID),
      payload("gh-issue-1", "github unrelated repository issue", "2026-08-03T00:00:00.000Z")
    );

    groupFragment(FRAGMENT_ID, CANONICAL_ID, OWNER_AUTH_DEFAULT_SUBJECT_ID);

    await drainConnectorInstanceIndexWork();
    await testFn();
  } finally {
    configureSemanticBackend(null);
    closeDb();
  }
}

function makeOwnerLexicalWiring(query: Record<string, unknown>) {
  const req = { query };
  const tokenInfo = { pdpp_token_kind: "owner" as const, subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID };
  return {
    buildOwnerReadGrantForManifest: (manifest: { streams?: Array<{ name: string }> }) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    getOwnerSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
    opts: { lexicalRetrievalSupported: true },
    req,
    // biome-ignore lint/suspicious/useAwait: matches the async dependency contract; this test double never resolves.
    resolveGrantManifest: async () => {
      throw new Error("owner-mode test should not reach client grant resolver");
    },
    // biome-ignore lint/suspicious/useAwait: matches the async dependency contract; this test double resolves synchronously.
    resolveOwnerManifestFromScope: async (scope: Record<string, unknown>) => {
      const storageBinding = scope.storage_binding as { connector_id: string; connector_instance_id?: string };
      const manifest = storageBinding.connector_id === GITHUB_CONNECTOR_ID ? githubManifest : amazonManifest;
      const pinned = storageBinding.connector_instance_id || null;
      const projected = {
        ...manifest,
        storage_binding: {
          connector_id: storageBinding.connector_id,
          ...(pinned ? { connector_instance_id: pinned } : {}),
        },
      };
      return { manifest: projected, ownerScope: scope, storageBinding: projected.storage_binding };
    },
    resolveOwnerScopeForConnector: (connectorId: string) => ({
      owner_subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      public_scope: "polyfill",
      source: { id: connectorId, kind: "connector" },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerVisibleConnectorIds: () => [CONNECTOR_ID, GITHUB_CONNECTOR_ID],
    tokenInfo,
  } as unknown as Parameters<typeof runLexicalSearch>[0];
}

function makeOwnerSemanticWiring(query: Record<string, unknown>) {
  const req = { query };
  const tokenInfo = { pdpp_token_kind: "owner" as const, subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID };
  return {
    buildOwnerReadGrantForManifest: (manifest: { streams?: Array<{ name: string }> }) => ({
      streams: (manifest.streams || []).map((s) => ({ name: s.name })),
    }),
    getOwnerSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
    opts: {},
    req,
    // biome-ignore lint/suspicious/useAwait: matches the async dependency contract; this test double never resolves.
    resolveGrantManifest: async () => {
      throw new Error("owner-mode test should not reach client grant resolver");
    },
    // biome-ignore lint/suspicious/useAwait: matches the async dependency contract; this test double resolves synchronously.
    resolveOwnerManifestFromScope: async (scope: Record<string, unknown>) => {
      const storageBinding = scope.storage_binding as { connector_id: string; connector_instance_id?: string };
      const manifest = storageBinding.connector_id === GITHUB_CONNECTOR_ID ? githubManifest : amazonManifest;
      const pinned = storageBinding.connector_instance_id || null;
      const projected = {
        ...manifest,
        storage_binding: {
          connector_id: storageBinding.connector_id,
          ...(pinned ? { connector_instance_id: pinned } : {}),
        },
      };
      return { manifest: projected, ownerScope: scope, storageBinding: projected.storage_binding };
    },
    resolveOwnerScopeForConnector: (connectorId: string) => ({
      owner_subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      public_scope: "polyfill",
      source: { id: connectorId, kind: "connector" },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerVisibleConnectorIds: () => [CONNECTOR_ID, GITHUB_CONNECTOR_ID],
    tokenInfo,
  } as unknown as Parameters<typeof runSemanticSearch>[0];
}

interface SearchResultItem {
  connection_id?: string;
  connector_instance_id?: string;
  record_key: string;
}

function resultItems(envelope: { data?: unknown }): SearchResultItem[] {
  return (envelope.data as SearchResultItem[] | undefined) ?? [];
}

test("(b) Sources list hides the grouped fragment; only the canonical entry renders", async () => {
  // biome-ignore lint/suspicious/useAwait: withSeededDb requires an async callback; this one only needs sync store reads.
  await withSeededDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    const page = store.listSourcesVisibleIdentityPage(OWNER_AUTH_DEFAULT_SUBJECT_ID, { limit: 100 });
    const ids = page.rows.map((row) => row.connectorInstanceId).sort();
    assert.deepEqual(
      ids,
      [CANONICAL_ID, GITHUB_ID].sort(),
      "the fragment must never render its own Sources row once grouped; the ungrouped GitHub-shape instance stays visible"
    );
  });
});

test("(c) Explore/timeline listing still returns the fragment's own row, attributed to the canonical identity", async () => {
  // biome-ignore lint/suspicious/useAwait: withSeededDb requires an async callback; this one only needs sync store reads.
  await withSeededDb(async () => {
    const store = createSqliteConnectorInstanceStore();
    const page = store.listOwnerVisibleIdentityPage(OWNER_AUTH_DEFAULT_SUBJECT_ID, { limit: 100 });
    const ids = page.rows.map((row) => row.connectorInstanceId).sort();
    assert.deepEqual(
      ids,
      [CANONICAL_ID, FRAGMENT_ID, GITHUB_ID].sort(),
      "Explore must keep returning the fragment's own row -- grouping never deletes or hides it here"
    );
    const fragmentRow = page.rows.find((row) => row.connectorInstanceId === FRAGMENT_ID);
    const canonicalRow = page.rows.find((row) => row.connectorInstanceId === CANONICAL_ID);
    const githubRow = page.rows.find((row) => row.connectorInstanceId === GITHUB_ID);
    assert.equal(fragmentRow?.canonicalConnectorInstanceId, CANONICAL_ID);
    assert.equal(canonicalRow?.canonicalConnectorInstanceId, CANONICAL_ID);
    assert.equal(
      githubRow?.canonicalConnectorInstanceId,
      GITHUB_ID,
      "the ungrouped GitHub-shape instance's canonical id is itself"
    );
  });
});

test("(d) a lexical search hit for fragment-only content reports the canonical connector_instance_id", async () => {
  await withSeededDb(async () => {
    const wiring = makeOwnerLexicalWiring({ q: "unobtainium" });
    const { envelope } = await runLexicalSearch(wiring);
    const results = resultItems(envelope);
    const hit = results.find((r) => r.record_key === "order-fragment-1");
    assert.ok(hit, "expected a lexical hit for fragment-only content");
    assert.equal(
      hit.connection_id,
      CANONICAL_ID,
      "a fragment's own lexical hit must attribute to the canonical connection identity"
    );
    assert.equal(hit.connector_instance_id, CANONICAL_ID);
  });
});

test("(d) a semantic search hit for fragment-only content reports the canonical connector_instance_id", async () => {
  await withSeededDb(async () => {
    const wiring = makeOwnerSemanticWiring({ q: "fragment gadget purchase unobtainium" });
    const { envelope } = await runSemanticSearch(wiring);
    const results = resultItems(envelope);
    const hit = results.find((r) => r.record_key === "order-fragment-1");
    assert.ok(hit, "expected a semantic hit for fragment-only content");
    assert.equal(
      hit.connection_id,
      CANONICAL_ID,
      "a fragment's own semantic hit must attribute to the canonical connection identity"
    );
    assert.equal(hit.connector_instance_id, CANONICAL_ID);
  });
});

test("(e) the ungrouped GitHub-shape instance is unaffected by the Amazon grouping on lexical and semantic search", async () => {
  await withSeededDb(async () => {
    const lexicalWiring = makeOwnerLexicalWiring({ q: "unrelated" });
    const { envelope: lexicalEnvelope } = await runLexicalSearch(lexicalWiring);
    const lexicalHit = resultItems(lexicalEnvelope).find((r) => r.record_key === "gh-issue-1");
    assert.ok(lexicalHit, "expected a lexical hit for the GitHub-shape record");
    assert.equal(lexicalHit.connection_id, GITHUB_ID, "the ungrouped instance's own id must be reported, unchanged");

    const semanticWiring = makeOwnerSemanticWiring({ q: "github unrelated repository issue" });
    const { envelope: semanticEnvelope } = await runSemanticSearch(semanticWiring);
    const semanticHit = resultItems(semanticEnvelope).find((r) => r.record_key === "gh-issue-1");
    assert.ok(semanticHit, "expected a semantic hit for the GitHub-shape record");
    assert.equal(semanticHit.connection_id, GITHUB_ID, "the ungrouped instance's own id must be reported, unchanged");
  });
});
