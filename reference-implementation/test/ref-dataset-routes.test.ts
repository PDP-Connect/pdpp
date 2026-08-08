// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Route regression tests for the `_ref/dataset/*` and
 * `_ref/records/version-stats` route family.
 *
 * Exercises the routes at the HTTP level to catch wiring regressions
 * that operation-level and auth-gate tests cannot reach. Server runs in
 * open mode (no owner password) so auth does not mask routing errors.
 * Each test verifies the response status code and the top-level `object`
 * discriminator in the envelope.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { startServer } from "../server/index.ts";
import {
  __resetRetainedSizeAutoReconcileThrottleForTest,
  __setRetainedSizeAutoReconcileNowForTest,
  type MountRefDatasetContext,
  mountRefDatasetSummary,
} from "../server/routes/ref-dataset.ts";

// `startServer` lives in the untyped `server/index.js`. It is not migrated
// to `.ts` yet, but it is a plain `export async function`, so TS can infer
// its real return shape via `ReturnType` — no hand-rolled interface (and no
// cast) needed to describe the `{ asServer, rsServer, asPort, rsPort, ... }`
// object it returns (see the `return { ... }` statement near the end of
// `startServer` in `server/index.js`).
type StartedServer = Awaited<ReturnType<typeof startServer>>;

// Envelope shapes returned by the routes under test. These mirror the
// `object` discriminators and fields the route handlers in
// `server/routes/ref-dataset.ts` actually write via `res.json(...)`.
interface DatasetSummaryEnvelope {
  object: "dataset_summary";
  projection: {
    state: string;
    last_error: string | null;
  };
  record_count: number;
  total_retained_bytes: number;
}

interface DatasetSummaryStreamsEnvelope {
  object: "dataset_summary_streams";
  streams: unknown[];
}

interface DatasetSummaryReconcileEnvelope {
  object: "dataset_summary_reconcile";
  reconciled: number;
}

interface RefDatasetSizeEnvelope {
  grain: string;
  object: "ref_dataset_size";
  rows: unknown[];
}

interface RefDatasetSizeRebuildEnvelope {
  object: "ref_dataset_size_rebuild";
}

interface RefDatasetSizeReconcileEnvelope {
  object: "ref_dataset_size_reconcile";
}

interface RefDatasetTopEnvelope {
  object: "ref_dataset_top";
  rows: unknown[];
}

interface PdppErrorEnvelope {
  error?: {
    code?: string;
  };
}

// `startServer`'s inferred `asServer`/`rsServer` fields (via `checkJs` over
// `server/transport.js`'s untyped `listen()`) come back as a narrower
// `http2.Server`-shaped type that omits `closeAllConnections` even though
// the real runtime object (a Node `http.Server`/`Http2SecureServer`, per the
// `return fastify.server` in `server/transport.js`) has it on Node 18.2+.
// `server/index.js` itself only ever calls it via optional chaining
// (`srv.closeAllConnections?.()`) for the same reason. Mirror that here with
// a runtime feature-detect instead of asserting a shape TS can't verify.
function closeAllConnectionsIfSupported(server: object): void {
  if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
    server.closeAllConnections();
  }
}

async function closeServer(server: StartedServer): Promise<void> {
  closeAllConnectionsIfSupported(server.asServer);
  closeAllConnectionsIfSupported(server.rsServer);
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withServer(fn: (ctx: { asUrl: string }) => Promise<void>): Promise<void> {
  const server: StartedServer = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

test("GET /_ref/dataset/summary returns dataset_summary envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as DatasetSummaryEnvelope;
    assert.equal(body.object, "dataset_summary");
    assert.equal(typeof body.record_count, "number");
  });
});

function captureDatasetSummaryHandler(
  ctx: MountRefDatasetContext
): (req: unknown, res: { json: (value: unknown) => unknown }) => unknown | Promise<unknown> {
  let captured: ((req: unknown, res: { json: (value: unknown) => unknown }) => unknown | Promise<unknown>) | null =
    null;
  mountRefDatasetSummary(
    {
      get(_path: string, ...args: unknown[]) {
        captured = args.at(-1) as (
          req: unknown,
          res: { json: (value: unknown) => unknown }
        ) => unknown | Promise<unknown>;
        return this;
      },
      post(_path: string, ..._args: unknown[]) {
        return this;
      },
    },
    ctx
  );
  assert.equal(typeof captured, "function");
  assert.ok(captured);
  return captured;
}

// Mirrors the shape `MountRefDatasetContext.getRetainedSizeGlobal` resolves
// to (`RetainedSizeGlobalRow` in `server/routes/ref-dataset.ts`, not
// exported from there). `metadata` fields are widened to `string | null`
// up front so the fresh/stale literals below are assignable to a single
// shared type without per-field casts.
interface RetainedGlobal {
  blob_bytes: number;
  computed_at: string;
  current_record_json_bytes: number;
  dirty: boolean;
  metadata: {
    state: string;
    stale_since: string | null;
    rebuild_status: string;
    last_error: string | null;
    source_high_watermark: string;
  };
  record_count: number;
  record_history_json_bytes: number;
}

function retainedSizeRouteContext(overrides: Partial<MountRefDatasetContext> = {}): {
  ctx: MountRefDatasetContext;
  state: { global: RetainedGlobal; reconcileCalls: number };
} {
  const freshGlobal: RetainedGlobal = {
    blob_bytes: 0,
    computed_at: "2026-06-25T12:01:00.000Z",
    current_record_json_bytes: 11,
    dirty: false,
    metadata: {
      last_error: null,
      rebuild_status: "idle",
      source_high_watermark: "reconcile:2026-06-25T12:01:00.000Z",
      stale_since: null,
      state: "fresh",
    },
    record_count: 1,
    record_history_json_bytes: 13,
  };
  const staleGlobal: RetainedGlobal = {
    ...freshGlobal,
    computed_at: "2026-06-25T12:00:00.000Z",
    dirty: true,
    metadata: {
      last_error: "bulk write on unknown connection",
      rebuild_status: "idle",
      source_high_watermark: "delta:2026-06-25T12:00:00.000Z",
      stale_since: "2026-06-25T12:00:00.000Z",
      state: "stale",
    },
  };
  const state: { global: RetainedGlobal; reconcileCalls: number } = {
    global: staleGlobal,
    reconcileCalls: 0,
  };
  return {
    ctx: {
      buildRecordVersionStatsEnvelope: async () => ({}),
      // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
      createRequestAbortSignal: () => ({ cleanup() {}, signal: new AbortController().signal }),
      createRequestConnectorInstanceStore: () => ({}),
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      ensureDatasetSummaryProjectionHealthy: async () => {
        throw new Error("read path must not auto-heal the SQLite dataset summary projection in retained-size mode");
      },
      getDatasetBlobBytes: async () => 0,
      getDatasetRecordChangesBytes: async () => 13,
      getDatasetRecordsAggregate: async () => ({
        connector_count: 1,
        earliest_ingested_at: null,
        latest_ingested_at: null,
        record_count: 1,
        record_json_bytes: 11,
        stream_count: 1,
      }),
      getDatasetRecordTimeBounds: async () => ({ earliest: null, latest: null }),
      getDatasetSummaryProjection: () => {
        throw new Error("SQLite dataset summary projection should not be used in retained-size mode");
      },
      getDatasetSummaryStreamRecordTimeBounds: async () => ({ earliest: null, latest: null }),
      getRetainedSizeGlobal: async () => state.global,
      handleError(_res: unknown, err: unknown) {
        throw err;
      },
      isPostgresStorageBackend: () => true,
      listDatasetSummaryStreamProjectionSeeds: async () => [],
      listDatasetTopConnectorCandidates: async () => [],
      listRetainedSizeConnections: async () => [
        {
          connector_id: "test.connector",
          connector_instance_id: "cin_test",
          record_count: 1,
        },
      ],
      listRetainedSizeStreams: async () => [
        {
          computed_at: state.global.computed_at,
          connector_id: "test.connector",
          current_record_json_bytes: 11,
          dirty: false,
          record_count: 1,
          stream: "messages",
        },
      ],
      listRetainedSizeTop: async () => [],
      listStreamProjections: async () => [],
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      rebuildDatasetSummaryProjection: async () => {
        throw new Error("not used");
      },
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      rebuildRetainedSize: async () => {
        throw new Error("read path must not rebuild retained-size projection");
      },
      reconcileDirtyDatasetSummaryRecordTimeBounds: async () => ({ deferred: 0, reconciled: 0, residual: 0 }),
      // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
      reconcileDirtyRetainedSize: async () => {
        state.reconcileCalls += 1;
        state.global = freshGlobal;
        return { connections: 0, streams: 0 };
      },
      requireOwnerSession: (..._args: unknown[]) => {
        // biome-ignore lint/style/useDestructuring: index access documents the asserted ordered position
        const next = _args[2];
        if (typeof next === "function") {
          (next as () => void)();
        }
      },
      ...overrides,
    },
    state,
  };
}

test("GET /_ref/dataset/summary auto-reconciles stale retained-size projection metadata", async () => {
  __resetRetainedSizeAutoReconcileThrottleForTest();
  const { ctx, state } = retainedSizeRouteContext();
  const handler = captureDatasetSummaryHandler(ctx);
  const captured: { body: DatasetSummaryEnvelope | null } = { body: null };

  await handler(
    {},
    {
      json(value: unknown) {
        captured.body = value as DatasetSummaryEnvelope;
      },
    }
  );

  assert.equal(state.reconcileCalls, 1);
  const { body } = captured;
  assert.ok(body);
  assert.equal(body.object, "dataset_summary");
  assert.equal(body.projection.state, "fresh");
  assert.equal(body.projection.last_error, null);
  assert.equal(body.total_retained_bytes, 24);
});

test("GET /_ref/dataset/summary leaves retained-size projection stale when auto-reconcile fails", async () => {
  __resetRetainedSizeAutoReconcileThrottleForTest();
  const { ctx, state } = retainedSizeRouteContext();
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  ctx.reconcileDirtyRetainedSize = async () => {
    state.reconcileCalls += 1;
    throw new Error("simulated reconcile failure");
  };
  const handler = captureDatasetSummaryHandler(ctx);
  const captured: { body: DatasetSummaryEnvelope | null } = { body: null };

  await handler(
    {},
    {
      json(value: unknown) {
        captured.body = value as DatasetSummaryEnvelope;
      },
    }
  );

  assert.equal(state.reconcileCalls, 1);
  const { body } = captured;
  assert.ok(body);
  assert.equal(body.object, "dataset_summary");
  assert.equal(body.projection.state, "stale");
  assert.equal(body.projection.last_error, "bulk write on unknown connection");
});

test("GET /_ref/dataset/summary throttles repeated retained-size auto-reconcile failures", async () => {
  __resetRetainedSizeAutoReconcileThrottleForTest();
  __setRetainedSizeAutoReconcileNowForTest(() => 1000);
  const { ctx, state } = retainedSizeRouteContext();
  // biome-ignore lint/suspicious/useAwait: mock preserves the production Promise contract and rejection timing
  ctx.reconcileDirtyRetainedSize = async () => {
    state.reconcileCalls += 1;
    throw new Error("simulated reconcile failure");
  };
  const handler = captureDatasetSummaryHandler(ctx);

  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  await handler({}, { json() {} });
  // biome-ignore lint/suspicious/noEmptyBlockStatements: skipped test callback is intentionally empty
  await handler({}, { json() {} });

  assert.equal(state.reconcileCalls, 1);
  __resetRetainedSizeAutoReconcileThrottleForTest();
});

test("GET /_ref/dataset/summary/streams returns dataset_summary_streams envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/streams`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as DatasetSummaryStreamsEnvelope;
    assert.equal(body.object, "dataset_summary_streams");
    assert.ok(Array.isArray(body.streams));
  });
});

test("GET /_ref/dataset/size defaults to global grain", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefDatasetSizeEnvelope;
    assert.equal(body.object, "ref_dataset_size");
    assert.equal(body.grain, "global");
    assert.ok(Array.isArray(body.rows));
  });
});

test("GET /_ref/dataset/size rejects unsupported grain with 400", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size?grain=nonsense`);
    assert.equal(resp.status, 400);
    const body = (await resp.json()) as PdppErrorEnvelope;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: assertion retains its defensive runtime boundary
    assert.equal(body?.error?.code, "invalid_request");
  });
});

test("GET /_ref/dataset/top returns ref_dataset_top envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/top`);
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefDatasetTopEnvelope;
    assert.equal(body.object, "ref_dataset_top");
    assert.ok(Array.isArray(body.rows));
  });
});

test("GET /_ref/records/version-stats returns envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/records/version-stats`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body !== null && typeof body === "object");
  });
});

test("POST /_ref/dataset/summary/rebuild returns dataset_summary envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/rebuild`, { method: "POST" });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as DatasetSummaryEnvelope;
    assert.equal(body.object, "dataset_summary");
  });
});

test("POST /_ref/dataset/summary/reconcile returns dataset_summary_reconcile envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/summary/reconcile`, { method: "POST" });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as DatasetSummaryReconcileEnvelope;
    assert.equal(body.object, "dataset_summary_reconcile");
    assert.equal(typeof body.reconciled, "number");
  });
});

test("POST /_ref/dataset/size/rebuild returns ref_dataset_size_rebuild envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size/rebuild`, { method: "POST" });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefDatasetSizeRebuildEnvelope;
    assert.equal(body.object, "ref_dataset_size_rebuild");
  });
});

test("POST /_ref/dataset/size/reconcile returns ref_dataset_size_reconcile envelope", async () => {
  await withServer(async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/_ref/dataset/size/reconcile`, { method: "POST" });
    assert.equal(resp.status, 200);
    const body = (await resp.json()) as RefDatasetSizeReconcileEnvelope;
    assert.equal(body.object, "ref_dataset_size_reconcile");
  });
});
