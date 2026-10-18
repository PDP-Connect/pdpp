// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSearchLexical,
  type SearchLexicalActor,
  type SearchLexicalDependencies,
  type SearchLexicalGrant,
  type SearchLexicalInput,
  type SearchLexicalManifest,
  SearchLexicalRequestError,
  type SearchLexicalSnapshot,
} from "./index.ts";

const clientActor = (grant: SearchLexicalGrant = grantFor(["title"]), clientId = "client-1"): SearchLexicalActor => ({
  kind: "client",
  subject_id: "owner-1",
  client_id: clientId,
  grant_id: "grant-1",
  grant,
});

const ownerActor: SearchLexicalActor = { kind: "owner", subject_id: "owner-1" };

function grantFor(fields: string[]): SearchLexicalGrant {
  return { streams: [{ name: "A", fields, instance_ids: ["connection-1", "connection-2"] }] };
}

function manifestFor(searchableFields: string[], grantFields?: string[]): SearchLexicalManifest {
  return {
    streams: [
      {
        name: "A",
        searchable_fields: searchableFields,
        ...(grantFields ? { grant_fields: grantFields } : {}),
      },
    ],
  };
}

const hits: SearchLexicalSnapshot["results"] = [
  {
    connectorId: "source-1",
    connectorInstanceId: "connection-1",
    emittedAt: "2026-01-01T00:00:00.000Z",
    matchedFields: ["title"],
    recordKey: "record-1",
    stream: "A",
  },
  {
    connectorId: "source-1",
    connectorInstanceId: "connection-2",
    emittedAt: "2026-01-01T00:00:01.000Z",
    matchedFields: ["title"],
    recordKey: "record-2",
    stream: "A",
  },
  {
    connectorId: "source-1",
    connectorInstanceId: "connection-1",
    emittedAt: "2026-01-01T00:00:02.000Z",
    matchedFields: ["title"],
    recordKey: "record-3",
    stream: "A",
  },
];

function makeDependencies(
  snapshots: Map<string, SearchLexicalSnapshot>,
  counts: { build: number; persist: number },
  options: { bindingIds?: string[]; getManifest?: () => SearchLexicalManifest } = {}
): SearchLexicalDependencies {
  const bindingIds = options.bindingIds ?? ["connection-1", "connection-2"];
  const getManifest = options.getManifest ?? (() => manifestFor(["title", "body"]));

  return {
    buildOwnerReadGrantForManifest: (manifest) => ({
      streams: (manifest.streams ?? []).map((stream) => {
        const fields = stream.grant_fields;
        return {
          name: stream.name,
          ...(Array.isArray(fields)
            ? { fields: fields.filter((field): field is string => typeof field === "string") }
            : {}),
        };
      }),
    }),
    buildSearchPlanForGrant: ({ grant, manifest }) =>
      (manifest.streams ?? []).flatMap((stream) => {
        const authorized = grant.streams?.find((entry) => entry.name === stream.name);
        if (!authorized) {
          return [];
        }
        const searchableFields = Array.isArray(stream.searchable_fields)
          ? stream.searchable_fields.filter((field): field is string => typeof field === "string")
          : (authorized.fields ?? []);
        return [
          {
            streamName: stream.name,
            searchableFields: authorized.fields
              ? searchableFields.filter((field) => authorized.fields?.includes(field))
              : searchableFields,
          },
        ];
      }),
    buildSnapshot: ({ q }) => {
      counts.build += 1;
      return { query: q, results: hits, snapshot_id: "snapshot-1" };
    },
    formatRecordUrl: ({ stream, recordKey }) => `/streams/${stream}/records/${recordKey}`,
    getAdvertisement: () => ({ cross_stream: true }),
    listOwnerVisibleBindings: () =>
      bindingIds.map((connectorInstanceId) => ({ connectorId: "source-1", connectorInstanceId })),
    listOwnerVisibleConnectorIds: () => [],
    loadSnapshot: (snapshotId) => snapshots.get(snapshotId) ?? null,
    persistSnapshot: (snapshot) => {
      counts.persist += 1;
      snapshots.set(snapshot.snapshot_id, snapshot);
    },
    resolveClientBindings: (_actor, { connectionId }) =>
      bindingIds
        .filter((connectorInstanceId) => !connectionId || connectorInstanceId === connectionId)
        .map((connectorInstanceId) => ({ connectorInstanceId, manifest: getManifest() })),
    resolveClientManifest: () => getManifest(),
    resolveOwnerManifestForBinding: () => getManifest(),
    resolveOwnerManifestForConnector: () => getManifest(),
  };
}

async function expectInvalidCursor(
  request: SearchLexicalInput,
  dependencies: SearchLexicalDependencies
): Promise<void> {
  await assert.rejects(
    executeSearchLexical(request, dependencies),
    (error: unknown) => error instanceof SearchLexicalRequestError && error.code === "invalid_cursor"
  );
}

test("identical authority advances to the next page without overlap", async () => {
  const snapshots = new Map<string, SearchLexicalSnapshot>();
  const counts = { build: 0, persist: 0 };
  const dependencies = makeDependencies(snapshots, counts);
  const actor = clientActor();
  const firstPage = await executeSearchLexical({ actor, query: { q: "hello", limit: "1" } }, dependencies);
  const cursor = firstPage.envelope.next_cursor;
  assert.ok(cursor);
  assert.equal(firstPage.envelope.data.length, 1);
  assert.equal(firstPage.envelope.data[0]?.record_key, "record-1");
  assert.equal(counts.build, 1);
  assert.equal(counts.persist, 1);

  const secondPage = await executeSearchLexical({ actor, query: { q: "hello", limit: "1", cursor } }, dependencies);
  assert.equal(secondPage.envelope.data.length, 1);
  assert.equal(secondPage.envelope.data[0]?.record_key, "record-2");
  assert.notEqual(secondPage.envelope.data[0]?.record_key, firstPage.envelope.data[0]?.record_key);
  assert.equal(counts.build, 1);
  assert.equal(counts.persist, 1);
});

interface CursorMutationCase {
  actor: SearchLexicalActor;
  bindingIds?: string[];
  initialManifest?: SearchLexicalManifest;
  mutateRequest?: (cursor: string) => SearchLexicalInput;
  name: string;
  nextManifest?: SearchLexicalManifest;
}

const cursorMutationCases: CursorMutationCase[] = [
  {
    name: "resolved grant changes while the owner actor and plan entries stay the same",
    actor: ownerActor,
    bindingIds: ["connection-1"],
    initialManifest: manifestFor(["title"], ["title"]),
    nextManifest: manifestFor(["title"], ["title", "body"]),
  },
  {
    name: "resolved plan entries change while actor and grant stay the same",
    actor: clientActor(grantFor(["title", "body"])),
    bindingIds: ["connection-1"],
    initialManifest: manifestFor(["title"]),
    nextManifest: manifestFor(["body"]),
  },
  {
    name: "connection id changes with a single binding and unchanged actor and plan",
    actor: clientActor(),
    bindingIds: ["connection-1"],
    mutateRequest: (cursor) => ({
      actor: clientActor(),
      query: { q: "hello", limit: "1", cursor, connection_id: "connection-1" },
    }),
  },
  {
    name: "actor changes while grant and resolved plan stay the same",
    actor: clientActor(),
    mutateRequest: (cursor) => ({
      actor: clientActor(grantFor(["title"]), "client-2"),
      query: { q: "hello", limit: "1", cursor },
    }),
  },
  {
    name: "query changes while authority stays the same",
    actor: clientActor(),
    mutateRequest: (cursor) => ({
      actor: clientActor(),
      query: { q: "different", limit: "1", cursor },
    }),
  },
];

for (const cursorCase of cursorMutationCases) {
  test(`cursor rejects when ${cursorCase.name}`, async () => {
    let manifest = cursorCase.initialManifest ?? manifestFor(["title", "body"]);
    const snapshots = new Map<string, SearchLexicalSnapshot>();
    const counts = { build: 0, persist: 0 };
    const fixtureOptions = {
      ...(cursorCase.bindingIds ? { bindingIds: cursorCase.bindingIds } : {}),
      getManifest: () => manifest,
    };
    const dependencies = makeDependencies(snapshots, counts, fixtureOptions);
    const firstPage = await executeSearchLexical(
      { actor: cursorCase.actor, query: { q: "hello", limit: "1" } },
      dependencies
    );
    const cursor = firstPage.envelope.next_cursor;
    assert.ok(cursor);
    assert.equal(counts.build, 1);
    assert.equal(counts.persist, 1);

    if (cursorCase.nextManifest) {
      manifest = cursorCase.nextManifest;
    }
    const rejectedRequest = cursorCase.mutateRequest?.(cursor) ?? {
      actor: cursorCase.actor,
      query: { q: "hello", limit: "1", cursor },
    };
    await expectInvalidCursor(rejectedRequest, dependencies);
    assert.equal(counts.build, 1, "rejected cursor must not rebuild a snapshot");
    assert.equal(counts.persist, 1, "rejected cursor must not persist a snapshot");
  });
}

test("malformed and unknown snapshot cursors do not build or rebuild snapshots", async () => {
  const snapshots = new Map<string, SearchLexicalSnapshot>();
  const counts = { build: 0, persist: 0 };
  const dependencies = makeDependencies(snapshots, counts);
  const actor = clientActor();

  await expectInvalidCursor({ actor, query: { q: "hello", cursor: "not-a-cursor" } }, dependencies);
  assert.equal(counts.build, 0);
  assert.equal(counts.persist, 0);

  const firstPage = await executeSearchLexical({ actor, query: { q: "hello", limit: "1" } }, dependencies);
  const cursor = firstPage.envelope.next_cursor;
  assert.ok(cursor);
  snapshots.clear();
  await expectInvalidCursor({ actor, query: { q: "hello", limit: "1", cursor } }, dependencies);
  assert.equal(counts.build, 1);
  assert.equal(counts.persist, 1);
});
