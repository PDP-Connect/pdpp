// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { registerConnector } from "../server/auth.ts";
import {
  connectorInstanceWriteCoordinatorStatsForTests,
  withConnectorInstanceWrite,
} from "../server/connector-instance-write-coordinator.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { ingestRecord } from "../server/records.ts";
import {
  configureSemanticBackend,
  makeStubBackend,
  semanticIndexBackfillForManifest as semanticIndexBackfillForManifestUntyped,
} from "../server/search-semantic.ts";

// `server/search-semantic.js` is plain JS: `semanticIndexBackfillForManifest`'s
// destructured-default parameter (`{ manifest, log = () => {}, signal = null } = {}`)
// makes TS infer its argument type narrowly from the defaults alone (only
// `log`/`signal` have defaults, so `manifest` is inferred as absent) —
// TS2353 territory. Re-typed here via the same documented pattern used in
// test/connector-instance-writer-paths.test.ts for the parallel lexical
// backfill function: import the real export and cast it to a signature
// matching how the production function is actually called (a manifest with
// a connector id and stream-level semantic search config).
type SemanticBackfillOptions = NonNullable<Parameters<typeof semanticIndexBackfillForManifestUntyped>[0]>;
type SemanticIndexBackfillForManifestFn = (
  args: SemanticBackfillOptions & {
    manifest: NonNullable<SemanticBackfillOptions["manifest"]>;
  }
) => Promise<void>;
const semanticIndexBackfillForManifest: SemanticIndexBackfillForManifestFn = (args) =>
  semanticIndexBackfillForManifestUntyped(args);

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const holder: { resolve: ((value: T) => void) | undefined } = { resolve: undefined };
  const promise = new Promise<T>((done) => {
    holder.resolve = done;
  });
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const resolve = holder.resolve;
  if (!resolve) {
    throw new Error("Promise executor did not run synchronously");
  }
  return { promise, resolve };
}

function target(connectorInstanceId: string) {
  return { connector_id: "semantic-fence", connector_instance_id: connectorInstanceId };
}

function record(stream: string, key: string, subject: string) {
  return {
    data: { id: key, subject },
    emitted_at: "2026-07-16T00:00:00.000Z",
    key,
    stream,
  };
}

const baseManifest = {
  capabilities: { human_interaction: [] },
  connector_id: "semantic-fence",
  display_name: "Semantic fence test",
  manifest_uri: "https://sources.example/semantic-fence",
  protocol_version: "0.1.0",
  streams: [
    {
      name: "first",
      primary_key: ["id"],
      query: { search: {} },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
    {
      name: "later",
      primary_key: ["id"],
      query: { search: {} },
      schema: {
        properties: { id: { type: "string" }, subject: { type: "string" } },
        required: ["id", "subject"],
        type: "object",
      },
      selection: { fields: true, resources: true },
      semantics: "mutable_state",
    },
  ],
  version: "1.0.0",
};

const semanticManifest = {
  connector_id: "semantic-fence",
  protocol_version: "0.1.0",
  streams: [
    { name: "first", query: { search: { semantic_fields: ["subject"] } } },
    { name: "later", query: { search: { semantic_fields: ["subject"] } } },
  ],
  version: "1.0.0",
};

test("semantic backfill holds one instance fence through later-stream meta completion while another instance proceeds", async () => {
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const laterEntered = deferred();
  const releaseLater = deferred();
  const stub = makeStubBackend({ dimensions: 8 });
  const blockingBackend = {
    ...stub,
    embedDocument: async (text: string) => {
      if (text === "first blocked") {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      if (text === "later blocked") {
        laterEntered.resolve();
        await releaseLater.promise;
      }
      return stub.embedDocument(text);
    },
  };

  initDb(":memory:");
  configureSemanticBackend(blockingBackend);
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let backfill = null;
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let sameInstanceIngest = null;
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let otherInstanceIngest = null;
  try {
    await registerConnector(baseManifest);
    await ingestRecord(target("cin_semantic_fence_a"), record("first", "a-first", "first blocked"));
    await ingestRecord(target("cin_semantic_fence_a"), record("later", "a-later", "later blocked"));
    assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
      activeOwnerships: 0,
      activeWriters: 0,
      keyedEntries: 0,
      queuedWriters: 0,
    });

    backfill = semanticIndexBackfillForManifest({ manifest: semanticManifest });
    const firstStarted = await Promise.race([
      firstEntered.promise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 1000)),
    ]);
    assert.equal(
      firstStarted,
      true,
      `the first stream must start before the test creates a competing writer: ${JSON.stringify(connectorInstanceWriteCoordinatorStatsForTests())}`
    );

    let sameInstanceFinished = false;
    sameInstanceIngest = ingestRecord(
      target("cin_semantic_fence_a"),
      record("first", "a-after", "must wait for full backfill")
    ).then(() => {
      sameInstanceFinished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(connectorInstanceWriteCoordinatorStatsForTests(), {
      activeOwnerships: 1,
      activeWriters: 2,
      keyedEntries: 1,
      queuedWriters: 0,
    });

    // This is an actual direct-ingest path, not a coordinator-only probe. It
    // proves a different connector instance is not serialized behind A.
    let otherInstanceFinished = false;
    otherInstanceIngest = ingestRecord(
      target("cin_semantic_fence_b"),
      record("first", "b-first", "other instance proceeds")
    ).then(() => {
      otherInstanceFinished = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    await otherInstanceIngest;
    assert.equal(otherInstanceFinished, true);
    assert.equal(sameInstanceFinished, false);

    releaseFirst.resolve();
    await laterEntered.promise;
    assert.equal(sameInstanceFinished, false, "A stays fenced until its later stream has completed");

    releaseLater.resolve();
    await backfill;
    await sameInstanceIngest;

    const meta = getDb()
      .prepare(
        `SELECT stream FROM semantic_search_meta
        WHERE connector_instance_id = ? ORDER BY stream`
      )
      .all("cin_semantic_fence_a");
    assert.deepEqual(
      meta.map((row) => {
        assert.ok(typeof row.stream === "string", "semantic metadata row has a stream name");
        return row.stream;
      }),
      ["first", "later"]
    );
  } finally {
    releaseFirst.resolve();
    releaseLater.resolve();
    await Promise.allSettled([backfill, sameInstanceIngest, otherInstanceIngest].filter(Boolean));
    configureSemanticBackend(null);
    closeDb();
  }
});

test("direct ingest queued before semantic backfill is repaired by the later per-instance backfill", async () => {
  const connectorInstanceId = "cin_semantic_reverse";
  const stub = makeStubBackend({ dimensions: 8 });
  initDb(":memory:");
  configureSemanticBackend(stub);
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let held = null;
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let directIngest = null;
  // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
  let backfill = null;
  try {
    await registerConnector(baseManifest);
    // The initial row makes the instance discoverable while the later direct
    // ingest is still queued behind the test-held instance fence.
    await ingestRecord(target(connectorInstanceId), record("first", "existing", "existing semantic row"));
    const entered = deferred();
    const release = deferred();
    const heldPromise = withConnectorInstanceWrite(connectorInstanceId, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    held = { held: heldPromise, release };
    directIngest = ingestRecord(
      target(connectorInstanceId),
      record("first", "direct-first", "durable before semantic rebuild")
    );
    await new Promise((resolve) => setImmediate(resolve));
    backfill = semanticIndexBackfillForManifest({ manifest: semanticManifest });
    held.release.resolve();
    await held.held;
    await directIngest;
    await backfill;
    const indexed = getDb()
      .prepare(`
      SELECT record_key FROM semantic_search_blob
       WHERE connector_instance_id = ? AND record_key = 'direct-first'
      UNION ALL
      SELECT record_key FROM semantic_search_rowid
       WHERE connector_instance_id = ? AND record_key = 'direct-first'
    `)
      .get(connectorInstanceId, connectorInstanceId);
    assert.ok(indexed, "later backfill indexes the direct ingest record");
    assert.equal(indexed.record_key, "direct-first");
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, directIngest, backfill].filter(Boolean));
    configureSemanticBackend(null);
    closeDb();
  }
});
