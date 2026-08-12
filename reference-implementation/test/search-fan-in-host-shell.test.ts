// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-shell integration tests for cross-binding lexical search fan-in.
 *
 * Drives `runLexicalSearch` (the native dependency-wiring shell) against
 * the real SQLite FTS5 storage with two active owner-visible bindings
 * under the same connector. Proves the end-to-end path:
 *   - `listOwnerVisibleBindings` enumerates both bindings;
 *   - the snapshot's plan emits one entry per binding;
 *   - the round-robin merge in `buildSnapshot` returns hits from both
 *     bindings;
 *   - each hit carries `connection_id` plus the deprecated alias;
 *   - request-time `connection_id` narrowing scopes the snapshot to one
 *     binding.
 *
 * Skips Postgres (the SQLite reference path is the canonical regression
 * surface; Postgres parity is exercised by `postgres-runtime-storage.test.js`).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { SearchLexicalManifest, SearchLexicalManifestStream } from "../operations/rs-search-lexical/index.ts";
import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from "../server/owner-auth.ts";
import { ingestRecord } from "../server/records.ts";
import { runLexicalSearch } from "../server/search.ts";
import { buildSemanticSearchPlanForGrant as buildSemanticSearchPlanForGrantUntyped } from "../server/search-semantic.ts";
import { createSqliteConnectorInstanceStore } from "../server/stores/connector-instance-store.ts";

// buildSemanticSearchPlanForGrant is imported from checkJs:false JS. Its
// destructured params (connectorId/connectorInstanceId) default to `null`,
// which TS infers as exactly `null | undefined`, rejecting the real string
// arguments this suite passes. Restate the real contract (verified against
// the source body) and widen the call itself to `unknown`, narrowing the
// return with a single-hop cast -- same pattern as
// records-instance-namespace.test.ts.
interface SemanticSearchPlanEntry {
  candidateRecordKeys?: string[];
  connectorInstanceId?: string;
  streamName: string;
}

interface SemanticSearchPlanInput {
  compiledFilter?: unknown;
  connectorId?: string;
  connectorInstanceId?: string;
  grant: unknown;
  manifest: unknown;
  streamsFilter?: string[] | null;
}

function buildSemanticSearchPlanForGrant(input: SemanticSearchPlanInput): SemanticSearchPlanEntry[] {
  const untyped = buildSemanticSearchPlanForGrantUntyped as (input: unknown) => unknown;
  return untyped(input) as SemanticSearchPlanEntry[];
}

const CONNECTOR_ID = "search-fan-in";
const STREAM = "messages";
const ALERTS_STREAM = "alerts";
const INSTANCE_A = "cin_search_fanin_account_a";
const INSTANCE_B = "cin_search_fanin_account_b";

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: CONNECTOR_ID,
  display_name: "Search Fan-in Test Connector",
  manifest_uri: `https://sources.example/${CONNECTOR_ID}`,
  protocol_version: "0.1.0",
  streams: [
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: STREAM,
      primary_key: ["id"],
      query: {
        search: { lexical_fields: ["subject"] },
      },
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject", "received_at"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
    {
      consent_time_field: "received_at",
      cursor_field: "received_at",
      name: ALERTS_STREAM,
      primary_key: ["id"],
      query: {
        search: { lexical_fields: ["subject"] },
      },
      schema: {
        properties: {
          id: { type: "string" },
          received_at: { format: "date-time", type: "string" },
          subject: { type: "string" },
        },
        required: ["id", "subject", "received_at"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

function target(instanceId: string) {
  return { connector_id: CONNECTOR_ID, connector_instance_id: instanceId };
}

function payload(id: string, subject: string, receivedAt: string, stream: string = STREAM) {
  return {
    data: { id, received_at: receivedAt, subject },
    emitted_at: receivedAt,
    key: id,
    stream,
  };
}

async function seedInstance(instanceId: string, displayName: string, sourceBindingKey: string) {
  const store = createSqliteConnectorInstanceStore();
  const now = new Date().toISOString();
  await store.upsert({
    connectorId: CONNECTOR_ID,
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

async function withDualBindingDb(testFn: () => Promise<void>) {
  initDb();
  try {
    await registerConnector(baseManifest);
    await seedInstance(INSTANCE_A, "Account A", "a@example.com");
    await seedInstance(INSTANCE_B, "Account B", "b@example.com");
    await ingestRecord(target(INSTANCE_A), payload("rec-a-1", "overdraft surprise from A", "2026-05-18T12:00:00.000Z"));
    await ingestRecord(target(INSTANCE_A), payload("rec-a-2", "unrelated A message", "2026-05-18T12:01:00.000Z"));
    await ingestRecord(target(INSTANCE_B), payload("rec-b-1", "overdraft fee from B", "2026-05-18T12:02:00.000Z"));
    await ingestRecord(target(INSTANCE_B), payload("rec-b-2", "unrelated B message", "2026-05-18T12:03:00.000Z"));
    await ingestRecord(
      target(INSTANCE_A),
      payload("alert-a-1", "overdraft alert from A", "2026-05-18T12:04:00.000Z", ALERTS_STREAM)
    );
    await ingestRecord(
      target(INSTANCE_B),
      payload("alert-b-1", "overdraft alert from B", "2026-05-18T12:05:00.000Z", ALERTS_STREAM)
    );
    await testFn();
  } finally {
    closeDb();
  }
}

interface OwnerScope extends Record<string, unknown> {
  owner_subject_id: string;
  public_scope: string;
  source: { kind: string; id: string };
  storage_binding: { connector_id: string; connector_instance_id?: string };
}

interface SearchResult {
  connection_id?: string;
  connector_instance_id?: string;
  display_name?: string;
  record_key: string;
  stream: string;
}

type SearchRunArgs = Parameters<typeof runLexicalSearch>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function searchResults(value: unknown): SearchResult[] {
  assert.ok(Array.isArray(value), "search envelope data must be an array");
  return value.map((item, index) => {
    assert.ok(isRecord(item), `search result ${index} must be an object`);
    if (typeof item.record_key !== "string") {
      throw new TypeError(`search result ${index} must carry record_key`);
    }
    if (typeof item.stream !== "string") {
      throw new TypeError(`search result ${index} must carry stream`);
    }
    return {
      ...(typeof item.connection_id === "string" ? { connection_id: item.connection_id } : {}),
      ...(typeof item.connector_instance_id === "string" ? { connector_instance_id: item.connector_instance_id } : {}),
      ...(typeof item.display_name === "string" ? { display_name: item.display_name } : {}),
      record_key: item.record_key,
      stream: item.stream,
    };
  });
}

function disclosureConnectorCount(value: unknown): number {
  assert.ok(isRecord(value), "search disclosure must be an object");
  if (typeof value.connector_count !== "number") {
    throw new TypeError("search disclosure must carry connector_count");
  }
  return value.connector_count;
}

function ownerScopeFrom(value: Record<string, unknown>): OwnerScope {
  if (!(isRecord(value.source) && isRecord(value.storage_binding))) {
    throw new TypeError("owner scope must include source and storage_binding objects");
  }
  const { source, storage_binding: storageBinding } = value;
  if (
    typeof value.owner_subject_id !== "string" ||
    typeof value.public_scope !== "string" ||
    typeof source.id !== "string" ||
    typeof source.kind !== "string" ||
    typeof storageBinding.connector_id !== "string"
  ) {
    throw new TypeError("owner scope must carry string identity fields");
  }
  const connectorInstanceId = storageBinding.connector_instance_id;
  if (connectorInstanceId !== undefined && typeof connectorInstanceId !== "string") {
    throw new TypeError("owner scope connector_instance_id must be a string when present");
  }
  return {
    owner_subject_id: value.owner_subject_id,
    public_scope: value.public_scope,
    source: { id: source.id, kind: source.kind },
    storage_binding: {
      connector_id: storageBinding.connector_id,
      ...(connectorInstanceId === undefined ? {} : { connector_instance_id: connectorInstanceId }),
    },
  };
}

function makeOwnerWiring(query: Record<string, unknown>): SearchRunArgs {
  const req = { query };
  const tokenInfo = {
    pdpp_token_kind: "owner" as const,
    subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
  };
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => ({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
      streams: (manifest?.streams || []).map((s: SearchLexicalManifestStream) => ({ name: s.name })),
    }),
    getOwnerSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
    opts: { lexicalRetrievalSupported: true },
    req,
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    resolveGrantManifest: async () => {
      throw new Error("owner-mode test should not reach client grant resolver");
    },
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    resolveOwnerManifestFromScope: async (scope) => {
      const ownerScope = ownerScopeFrom(scope);
      // Honor a pinned connector_instance_id when the caller (the
      // fan-in path) supplied one; otherwise just return the manifest.
      // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
      const pinned = ownerScope?.storage_binding?.connector_instance_id || null;
      const manifest = {
        ...baseManifest,
        storage_binding: {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
          connector_id: ownerScope?.storage_binding?.connector_id || CONNECTOR_ID,
          ...(pinned ? { connector_instance_id: pinned } : {}),
        },
      };
      return {
        manifest,
        ownerScope,
        storageBinding: manifest.storage_binding,
      };
    },
    resolveOwnerScopeForConnector: (connectorId: string) => ({
      owner_subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      public_scope: "polyfill",
      source: { id: connectorId, kind: "connector" },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerVisibleConnectorIds: () => [CONNECTOR_ID],
    tokenInfo,
  };
}

test("owner-mode lexical fan-in: returns hits from both bindings under one connector", async () => {
  await withDualBindingDb(async () => {
    const wiring = makeOwnerWiring({ q: "overdraft", streams: [STREAM] });
    const { envelope, disclosureData } = await runLexicalSearch(wiring);
    const results = searchResults(envelope.data);
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    const ids = results.map((result) => result.record_key).sort();
    assert.deepEqual(ids, ["rec-a-1", "rec-b-1"]);
    // Each hit must carry connection_id + alias.
    for (const item of results) {
      assert.ok(item.connection_id, "hit must carry connection_id");
      assert.equal(item.connector_instance_id, item.connection_id);
    }
    // Owner-facing display_name surfaces from the store.
    const cidA = results.find((result) => result.connection_id === INSTANCE_A);
    const cidB = results.find((result) => result.connection_id === INSTANCE_B);
    assert.equal(cidA?.display_name, "Account A");
    assert.equal(cidB?.display_name, "Account B");
    // Connector count reflects per-binding plans (= 2).
    assert.equal(disclosureConnectorCount(disclosureData), 2);
  });
});

test("owner-mode lexical fan-in: connection_id narrows to one binding", async () => {
  await withDualBindingDb(async () => {
    const wiring = makeOwnerWiring({ connection_id: INSTANCE_A, q: "overdraft", streams: [STREAM] });
    const { envelope } = await runLexicalSearch(wiring);
    const results = searchResults(envelope.data);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.connection_id, INSTANCE_A);
  });
});

test("owner-mode lexical fan-in: deprecated connector_instance_id alias narrows identically and emits warning", async () => {
  await withDualBindingDb(async () => {
    const wiring = makeOwnerWiring({ connector_instance_id: INSTANCE_B, q: "overdraft", streams: [STREAM] });
    const { envelope } = await runLexicalSearch(wiring);
    const results = searchResults(envelope.data);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.connection_id, INSTANCE_B);
    // The native shell strips meta during envelope re-wrapping; the
    // operation-level test (rs-search-lexical-fan-in.test.js) covers the
    // warning emission. Here we only assert narrowing semantics.
  });
});

function makeClientWiring(
  query: Record<string, unknown>,
  { authorizedInstanceIds = [INSTANCE_A, INSTANCE_B] }: { authorizedInstanceIds?: string[] } = {}
): SearchRunArgs {
  const grant = {
    source: { id: CONNECTOR_ID, kind: "connector" },
    streams: [{ fields: ["id", "subject", "received_at"], instance_ids: authorizedInstanceIds, name: STREAM }],
  };
  const tokenInfo = {
    client_id: "cl_test",
    grant,
    grant_id: "g_test",
    pdpp_token_kind: "client" as const,
    subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
  };
  return {
    buildOwnerReadGrantForManifest: (manifest: SearchLexicalManifest) => ({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
      streams: (manifest?.streams || []).map((s: SearchLexicalManifestStream) => ({ name: s.name })),
    }),
    getOwnerSubjectId: () => OWNER_AUTH_DEFAULT_SUBJECT_ID,
    opts: { lexicalRetrievalSupported: true },
    req: { query },
    resolveGrantManifest: async () => ({
      manifest: { ...baseManifest, storage_binding: { connector_id: CONNECTOR_ID } },
      storageBinding: {},
    }),
    // biome-ignore lint/suspicious/useAwait: localized test assertion preserves its explicit contract.
    resolveOwnerManifestFromScope: async (scope) => {
      const ownerScope = ownerScopeFrom(scope);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
      const pinned = ownerScope?.storage_binding?.connector_instance_id || null;
      const manifest = {
        ...baseManifest,
        storage_binding: {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: localized test assertion preserves its explicit contract.
          connector_id: ownerScope?.storage_binding?.connector_id || CONNECTOR_ID,
          ...(pinned ? { connector_instance_id: pinned } : {}),
        },
      };
      return { manifest, ownerScope, storageBinding: manifest.storage_binding };
    },
    resolveOwnerScopeForConnector: (connectorId: string) => ({
      owner_subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      public_scope: "polyfill",
      source: { id: connectorId, kind: "connector" },
      storage_binding: { connector_id: connectorId },
    }),
    resolveOwnerVisibleConnectorIds: () => [CONNECTOR_ID],
    tokenInfo,
  };
}

test("client-mode lexical fan-in: hits union across explicitly grant-authorized instances", async () => {
  await withDualBindingDb(async () => {
    const wiring = makeClientWiring({ q: "overdraft" });
    const { envelope } = await runLexicalSearch(wiring);
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    const ids = searchResults(envelope.data)
      .map((result) => result.record_key)
      .sort();
    assert.deepEqual(ids, ["rec-a-1", "rec-b-1"]);
  });
});

test("client-mode lexical fan-in: per-stream grant instance_ids constrain search to one binding", async () => {
  await withDualBindingDb(async () => {
    const wiring = makeClientWiring({ q: "overdraft" }, { authorizedInstanceIds: [INSTANCE_A] });
    const { envelope } = await runLexicalSearch(wiring);
    const results = searchResults(envelope.data);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.connection_id, INSTANCE_A);
  });
});

test("client-mode lexical fan-in: mixed per-stream grant instance_ids are honored independently", async () => {
  await withDualBindingDb(async () => {
    const grant = {
      source: { id: CONNECTOR_ID, kind: "connector" },
      streams: [
        { fields: ["id", "subject", "received_at"], instance_ids: [INSTANCE_A], name: STREAM },
        { fields: ["id", "subject", "received_at"], instance_ids: [INSTANCE_B], name: ALERTS_STREAM },
      ],
    };
    const tokenInfo = {
      client_id: "cl_test",
      grant,
      grant_id: "g_test_mixed",
      pdpp_token_kind: "client" as const,
      subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
    };
    const wiring: SearchRunArgs = {
      ...makeClientWiring({ q: "overdraft", streams: [STREAM, ALERTS_STREAM] }),
      resolveGrantManifest: async () => ({
        manifest: { ...baseManifest, storage_binding: { connector_id: CONNECTOR_ID } },
        storageBinding: {},
      }),
      tokenInfo,
    };
    const { envelope } = await runLexicalSearch(wiring);
    // biome-ignore lint/suspicious/useArraySortCompare: localized test assertion preserves its explicit contract.
    const observed = searchResults(envelope.data)
      .map((result) => `${result.stream}:${result.record_key}:${result.connection_id}`)
      .sort();
    assert.deepEqual(observed, [`${ALERTS_STREAM}:alert-b-1:${INSTANCE_B}`, `${STREAM}:rec-a-1:${INSTANCE_A}`]);
  });
});

test("client-mode lexical fan-in: active request connection_id outside grant returns connection_not_found", async () => {
  await withDualBindingDb(async () => {
    const wiring = makeClientWiring(
      { connection_id: INSTANCE_B, q: "overdraft" },
      { authorizedInstanceIds: [INSTANCE_A] }
    );
    await assert.rejects(
      () => runLexicalSearch(wiring),
      (err) => {
        assert.equal((err as { code?: string } | null)?.code, "connection_not_found");
        return true;
      }
    );
  });
});

test("semantic plan builder honors mixed per-stream grant instance_ids per binding", () => {
  const manifest = {
    streams: [
      { name: STREAM, query: { search: { semantic_fields: ["subject"] } } },
      { name: ALERTS_STREAM, query: { search: { semantic_fields: ["subject"] } } },
    ],
  };
  const grant = {
    streams: [
      { fields: ["subject"], instance_ids: [INSTANCE_A], name: STREAM },
      { fields: ["subject"], instance_ids: [INSTANCE_B], name: ALERTS_STREAM },
    ],
  };
  const planA = buildSemanticSearchPlanForGrant({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_A,
    grant,
    manifest,
  });
  const planB = buildSemanticSearchPlanForGrant({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: INSTANCE_B,
    grant,
    manifest,
  });
  assert.deepEqual(
    planA.map((entry) => entry.streamName),
    [STREAM]
  );
  assert.deepEqual(
    planB.map((entry) => entry.streamName),
    [ALERTS_STREAM]
  );
});
