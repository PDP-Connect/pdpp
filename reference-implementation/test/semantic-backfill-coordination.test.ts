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

async function withCoordinatorEnvironment<T>(
  values: Record<string, string | number>,
  operation: () => Promise<T>
): Promise<T> {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = String(value);
    }
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

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

test("semantic backfill does NOT hold one instance fence through the whole rebuild — a same-instance write proceeds while an embed is in flight, and both a different instance's write and the eventual backfill converge correctly", async () => {
  // This pins the FIX for the UAT startup-backfill-vs-live-ingest incident:
  // backfill used to hold withConnectorInstanceWrite for the ENTIRE
  // per-instance rebuild (every stream, every embed call), so a same-instance
  // live write queued behind it for the whole rebuild's duration, and — more
  // severely in production — several connector instances' rebuilds could
  // occupy the whole GLOBAL admission pool for that duration, starving
  // completely unrelated live ingest. The fence now covers ONLY each page's
  // bounded, version-CAS'd durable write (see rebuildSemanticIndexForStream),
  // never the scan or the embedding call. This test proves a same-instance
  // write is free to proceed WHILE an embed for that same instance is still
  // in flight (the opposite of the old "A stays fenced until its later
  // stream has completed" guarantee), and that the write-path's own atomic
  // dirty-mark still lets everything converge.
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const stub = makeStubBackend({ dimensions: 8 });
  const blockingBackend = {
    ...stub,
    embedDocument: async (text: string) => {
      if (text === "first blocked") {
        firstEntered.resolve();
        await releaseFirst.promise;
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
    assert.equal(firstStarted, true, "the embed call for the first stream must start before the test proceeds");

    // The embed is in flight, BEFORE the page's write has run — no
    // connector-instance fence is held at all right now (the fence only
    // wraps the write, which cannot happen until the embed resolves).
    assert.deepEqual(
      connectorInstanceWriteCoordinatorStatsForTests(),
      { activeOwnerships: 0, activeWriters: 0, keyedEntries: 0, queuedWriters: 0 },
      "no fence is held while an embed call is in flight — this is the exact starvation this fix closes"
    );

    // A same-instance write must be able to proceed RIGHT NOW, while
    // backfill's embed is still blocked — the old design would have queued
    // this behind the whole rebuild.
    let sameInstanceFinished = false;
    sameInstanceIngest = ingestRecord(
      target("cin_semantic_fence_a"),
      record("first", "a-after", "proceeds while backfill embed is in flight")
    ).then(() => {
      sameInstanceFinished = true;
    });
    await sameInstanceIngest;
    assert.equal(
      sameInstanceFinished,
      true,
      "a same-instance write must complete without waiting for backfill's in-flight embed/rebuild"
    );

    // A different connector instance's write is likewise unaffected.
    let otherInstanceFinished = false;
    otherInstanceIngest = ingestRecord(
      target("cin_semantic_fence_b"),
      record("first", "b-first", "other instance proceeds")
    ).then(() => {
      otherInstanceFinished = true;
    });
    await otherInstanceIngest;
    assert.equal(otherInstanceFinished, true);

    releaseFirst.resolve();
    await backfill;

    // Convergence: the backfill's own page write for "first" still lands
    // (record a-first), and a-after's own write-path apply already landed
    // independently (it ingested while backfill was still mid-embed for the
    // OLDER a-first row, on a different record key, so both persist).
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
      ["first"]
    );
  } finally {
    releaseFirst.resolve();
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

// REQUIRED DISCRIMINATOR (live-incident reproduction): every configured
// global admission slot is held by long-running startup-shaped rebuilds
// (real embed calls blocked open, exactly like production's boot-time
// backfill fanning out across several connector instances), and unrelated
// live ingest must still complete inside its existing PDPP_INGEST_LOCK_WAIT_MS
// budget. Retrying admission (the rejected prior fix) does NOT close this:
// once all N slots are legitimately held by in-flight rebuilds, a retry
// loop just re-observes the same saturation and eventually times out too.
// The only fix that passes this is shrinking what a rebuild holds the
// fence for down to O(one page's durable write) — see
// rebuildSemanticIndexForStream in search-semantic.ts and
// rebuildLexicalIndexForStream in search.ts, both of which now hold
// withConnectorInstanceWrite only around their own bounded write, never
// across the scan/embed phase a "long rebuild" spends most of its time in.
test("REQUIRED DISCRIMINATOR: all configured admission slots held by long startup-shaped rebuilds — unrelated live ingest still completes within its existing wait budget", async () => {
  await withCoordinatorEnvironment({ PDPP_INGEST_ACTIVE_BATCH_LIMIT: 2, PDPP_INGEST_LOCK_WAIT_MS: 300 }, async () => {
    initDb(":memory:");
    const holderCount = 2; // == PDPP_INGEST_ACTIVE_BATCH_LIMIT: saturate every slot.
    const enteredEmbeds: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    const releaseEmbeds: Array<{ promise: Promise<void>; resolve: () => void }> = [];
    for (let i = 0; i < holderCount; i += 1) {
      enteredEmbeds.push(deferred());
      releaseEmbeds.push(deferred());
    }
    let embedCallIndex = 0;
    const stub = makeStubBackend({ dimensions: 8 });
    // Each holder's embed call blocks open until explicitly released —
    // standing in for a long-running startup rebuild's scan+embed phase,
    // the exact shape (many connector instances, each with a slow
    // embedding-bound rebuild) that saturated the global admission pool
    // in the live UAT incident.
    const blockingBackend = {
      ...stub,
      embedDocument: async (text: string) => {
        const index = embedCallIndex;
        embedCallIndex += 1;
        if (index < holderCount) {
          enteredEmbeds[index]?.resolve();
          await releaseEmbeds[index]?.promise;
        }
        return stub.embedDocument(text);
      },
    };
    configureSemanticBackend(blockingBackend);

    // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
    let liveIngest = null;
    const holderBackfills: Promise<unknown>[] = [];
    try {
      await registerConnector(baseManifest);
      for (let i = 0; i < holderCount; i += 1) {
        const instanceId = `cin_saturation_holder_${i}`;
        // biome-ignore lint/performance/noAwaitInLoops: Each holder's seed record must durably exist before any backfill runs; setup, not the code under test.
        await ingestRecord(target(instanceId), record("first", `k${i}`, `holder text ${i}`));
      }
      const liveIngestInstanceId = "cin_saturation_live_ingest";
      await ingestRecord(target(liveIngestInstanceId), record("first", "seed", "seed text"));

      // Start every holder's rebuild concurrently — each one's FIRST
      // embed call blocks, so by the time all holderCount entered-signals
      // resolve, every configured global admission slot the FIRST page's
      // write would need is genuinely saturated by real, in-flight work
      // (not a probe or a mock of the coordinator).
      for (let i = 0; i < holderCount; i += 1) {
        const instanceId = `cin_saturation_holder_${i}`;
        holderBackfills.push(
          semanticIndexBackfillForManifest({
            manifest: {
              connector_id: "semantic-fence",
              storage_binding: { connector_instance_id: instanceId },
              streams: [{ name: "first", query: { search: { semantic_fields: ["subject"] } } }],
            } as unknown as NonNullable<SemanticBackfillOptions["manifest"]>,
          })
        );
      }
      await Promise.all(enteredEmbeds.map((entered) => entered.promise));

      // Live ingest for a COMPLETELY UNRELATED connector instance, while
      // every holder's embed is still blocked open. It must complete
      // (not 503) well within the configured lock-wait budget — this is
      // the exact production symptom (GroupMe 503 connector_instance_busy
      // after PDPP_INGEST_LOCK_WAIT_MS) this fix must close.
      const startedAt = Date.now();
      liveIngest = ingestRecord(
        target(liveIngestInstanceId),
        record("first", "live", "unrelated live ingest must not 503")
      );
      await liveIngest;
      const elapsed = Date.now() - startedAt;
      assert.ok(
        elapsed < 300,
        `live ingest must complete well within PDPP_INGEST_LOCK_WAIT_MS (300ms) while every admission slot is held by long-running rebuilds; took ${elapsed}ms`
      );

      for (const release of releaseEmbeds) {
        release.resolve();
      }
      await Promise.all(holderBackfills);
    } finally {
      for (const release of releaseEmbeds) {
        release.resolve();
      }
      await Promise.allSettled([...holderBackfills, liveIngest].filter(Boolean));
      configureSemanticBackend(null);
      closeDb();
    }
  });
});
