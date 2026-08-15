// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: better-sqlite3 is the real driver under test.
import Database from "better-sqlite3";
import type { RuntimeRunConnectorOptions, RuntimeRunConnectorResult } from "../runtime/index.ts";
import { runConnector } from "../runtime/index.ts";
import { DEFAULT_QUARANTINE_POLICY } from "../runtime/recovery-quarantine.ts";
import { closeDb, getDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import {
  createPostgresConnectorDetailGapStore,
  createSqliteConnectorDetailGapStore,
  sanitizeDetailGapMetadata,
} from "../server/stores/connector-detail-gap-store.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

// `runtime/index.ts` (the ambient signature for the still-JS runtime
// entrypoint) does not yet declare `detailGapStore` — the runtime itself
// (runtime/index.ts) reads `opts.detailGapStore` at multiple call sites, so
// this is a real gap in that hand-maintained `.d.ts`, not a test-only
// convenience. This file may only edit itself (not runtime/index.ts), so
// every call site here goes through this locally-widened option type
// instead. `detailGapStore` is `unknown` because call sites pass either the
// real store (createSqliteConnectorDetailGapStore/createPostgresConnectorDetailGapStore)
// or a hand-rolled partial mock implementing only the methods one test needs
// — the runtime duck-types the same as untyped JS always has.
type RunConnectorTestOptions = Omit<RuntimeRunConnectorOptions, "detailGapStore"> & { detailGapStore?: unknown };
type RunConnectorFn = (opts: RunConnectorTestOptions) => Promise<RuntimeRunConnectorResult>;
const runConnectorWithGapStore = runConnector as RunConnectorFn;
const DIFFERENT_PARENT_STREAM_PATTERN = /different parent stream/;

// This file never routes through the real connector-instance store — every
// dependency it hands the runtime (detail gap store, state server, etc.) is
// a hand-rolled in-memory double, so admission only needs to echo back
// whatever identity a test already asserts on. When a test omits
// `connectorInstanceId` entirely, several call sites (and the detail-gap
// store's own `defaultConnectorInstanceId` helper) independently resolve the
// SAME default-account binding id for direct store assertions to line up
// against what the runtime actually persisted under, so the fallback here
// must derive the identical id rather than inventing its own scheme.
function fakeAdmitRunConnection(): (input: {
  connectorId: string;
  connectorInstanceId: string | null;
  ownerSubjectId: string | null;
}) => Promise<{ connectorId: string; connectorInstanceId: string; ownerSubjectId: string }> {
  return ({ connectorId, connectorInstanceId, ownerSubjectId: requestedOwnerSubjectId }) => {
    const ownerSubjectId = requestedOwnerSubjectId || "owner_local";
    const exactId = connectorInstanceId ?? makeDefaultAccountConnectorInstanceId(ownerSubjectId, connectorId);
    return Promise.resolve({ connectorId, connectorInstanceId: exactId, ownerSubjectId });
  };
}

function withTempDb(fn: (dir: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gaps-"));
    try {
      initDb(join(dir, "pdpp.sqlite"));
      await fn(dir);
    } finally {
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  };
}

type DetailGapStoreForTest = ReturnType<typeof createSqliteConnectorDetailGapStore>;
// `DetailGap` is a module-private interface in the source store — redeclared
// here structurally via the store's own narrowed return type so this file
// never invents fields the real store does not have.
type DetailGapForTest = NonNullable<Awaited<ReturnType<DetailGapStoreForTest["upsertPendingGap"]>>>;

test(
  "detail-gap page batches preserve exact-instance facts, short-circuit empties, and chunk SQLite membership reads",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "batch_connector";
    const first = "cin_batch_first";
    const second = "cin_batch_second";
    const now = "2026-07-29T12:00:00.000Z";
    const firstGap = await store.upsertPendingGap({
      connectorId,
      connectorInstanceId: first,
      gapId: "gap_first",
      now,
      reason: "rate_limited",
      recordKey: "first",
      stream: "files",
    });
    const secondGap = await store.upsertPendingGap({
      connectorId,
      connectorInstanceId: second,
      gapId: "gap_second",
      now,
      reason: "other",
      recordKey: "second",
      stream: "messages",
    });
    assert.ok(firstGap);
    assert.ok(secondGap);
    await store.markGapStatus(firstGap.gap_id, "recovered", { now });
    await store.upsertPendingGap({
      connectorId,
      connectorInstanceId: first,
      gapId: "gap_pending",
      now,
      reason: "rate_limited",
      recordKey: "pending",
      stream: "files",
    });
    await store.markGapStatus(secondGap.gap_id, "terminal", { now });
    // A second recovered gap on `first` whose reason lands in the SECOND
    // 98-value reason chunk of the 101-reason filter below, so the count
    // assertion proves disjoint reason chunks are summed, not overwritten.
    const crossChunkGap = await store.upsertPendingGap({
      connectorId,
      connectorInstanceId: first,
      gapId: "gap_cross_chunk",
      now,
      reason: "other_99",
      recordKey: "cross_chunk",
      stream: "files",
    });
    assert.ok(crossChunkGap);
    await store.markGapStatus(crossChunkGap.gap_id, "recovered", { now });

    const originalPrepare = Database.prototype.prepare;
    let membershipStatements = 0;
    let maximumMembershipPlaceholders = 0;
    // The empty scope is a hard no-SQL contract, not merely an empty result.
    Database.prototype.prepare = function prepareWithMembershipCounter(sql: string) {
      if (sql.includes("connector_instance_id IN")) {
        membershipStatements += 1;
        maximumMembershipPlaceholders = Math.max(maximumMembershipPlaceholders, (sql.match(/\?/g) ?? []).length);
      }
      return originalPrepare.call(getDb(), sql);
    } as typeof Database.prototype.prepare;
    try {
      assert.deepEqual(await store.listPendingGapsByConnectorInstanceIds([], { now }), new Map());
      assert.deepEqual(await store.countGapsByStatusForConnectorInstanceIds([], { status: "terminal" }), new Map());
      assert.equal(membershipStatements, 0);

      const pending = await store.listPendingGapsByConnectorInstanceIds([first, second], { now });
      assert.deepEqual(
        pending.get(first)?.map((gap) => gap.gap_id),
        ["gap_pending"]
      );
      assert.deepEqual(pending.get(second), undefined);
      assert.deepEqual(
        await store.countGapsByStatusForConnectorInstanceIds([first, second], {
          reasons: ["rate_limited"],
          status: "recovered",
        }),
        new Map([[first, 1]])
      );
      assert.deepEqual(
        await store.countGapsByStatusByStreamForConnectorInstanceIds([first, second], { status: "terminal" }),
        new Map([[second, new Map([["messages", 1]])]])
      );
      assert.deepEqual(
        await store.countGapsByStatusForConnectorInstanceIds([first], {
          reasons: ["rate_limited", ...Array.from({ length: 100 }, (_, index) => `other_${index}`)],
          status: "recovered",
        }),
        new Map([[first, 2]])
      );
      assert.ok(
        maximumMembershipPlaceholders <= 999,
        "SQLite aggregate chunks reason filters below the historical bind floor"
      );

      membershipStatements = 0;
      await store.listPendingGapsByConnectorInstanceIds([first], { now });
      const oneConnectionStatements = membershipStatements;
      membershipStatements = 0;
      await store.listPendingGapsByConnectorInstanceIds(
        Array.from({ length: 100 }, (_, index) => `cin_batch_page_${index}`),
        { now }
      );
      assert.equal(membershipStatements, oneConnectionStatements, "a fixed 100-id page has constant pending-gap SQL");

      const pageIds = Array.from({ length: 100 }, (_, index) => `cin_batch_page_${index}`);
      membershipStatements = 0;
      await store.countGapsByStatusForConnectorInstanceIds([first], { status: "terminal" });
      const oneCountStatements = membershipStatements;
      membershipStatements = 0;
      await store.countGapsByStatusForConnectorInstanceIds(pageIds, { status: "terminal" });
      assert.equal(membershipStatements, oneCountStatements, "a fixed 100-id page has constant gap-count SQL");
      membershipStatements = 0;
      await store.countGapsByStatusByStreamForConnectorInstanceIds([first], { status: "terminal" });
      const oneStreamCountStatements = membershipStatements;
      membershipStatements = 0;
      await store.countGapsByStatusByStreamForConnectorInstanceIds(pageIds, { status: "terminal" });
      assert.equal(membershipStatements, oneStreamCountStatements, "a fixed 100-id page has constant stream-count SQL");

      membershipStatements = 0;
      await store.listPendingGapsByConnectorInstanceIds(
        Array.from({ length: 901 }, (_, index) => `cin_batch_chunk_${index}`),
        { now }
      );
      assert.ok(
        membershipStatements >= 1 && membershipStatements <= 2,
        "SQLite batches stay below the bind limit and chunk only at the boundary"
      );
    } finally {
      Database.prototype.prepare = originalPrepare;
    }
  })
);

async function forcePendingForTest(store: DetailGapStoreForTest, gapIds: readonly string[]): Promise<void> {
  for (const gapId of gapIds) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await store.markGapStatus(gapId, "pending");
  }
}

// The store's `detail_locator` / `last_error` / `source` / `scope` /
// `list_cursor` fields are genuinely `unknown` (opaque JSON blobs — see
// `DetailGap` in server/stores/connector-detail-gap-store.ts). Tests that seed
// a locator/error shape and then assert on the SANITIZED shape
// `sanitizeDetailGapMetadata` produces need a real, narrowed type to read
// property paths back off; this repeats across many test blocks in this
// file, so it is declared once here and reused everywhere below instead of
// redeclaring it per test.
function asJsonRecord(value: unknown, message: string): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), message);
  return value as Record<string, unknown>;
}

// `sanitizeDetailGapMetadata`'s `safeUrlSummary` redaction shape for a URL-like
// string or `*url*`/`*uri*`/`*href*`/`*endpoint*`-named key.
interface SafeUrlSummary {
  host: string;
  path_hash: string;
  scheme: string;
}

function asSafeUrlSummary(value: unknown, message: string): SafeUrlSummary {
  const record = asJsonRecord(value, message);
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const host = record.host;
  const pathHash = record.path_hash;
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const scheme = record.scheme;
  if (typeof host !== "string" || typeof pathHash !== "string" || typeof scheme !== "string") {
    throw new Error(`${message}: expected a SafeUrlSummary shape, got ${JSON.stringify(record)}`);
  }
  return { host, path_hash: pathHash, scheme };
}

interface ConnectorHandle {
  cleanup: () => void;
  connectorPath: string;
}

// Structural mirror of the source module's private `UpsertGapInput`
// (server/stores/connector-detail-gap-store.ts) for the hand-rolled partial
// `detailGapStore` mocks below — those mocks receive whatever the runtime
// passes to `upsertPendingGap`, which is this same caller-input shape. Every
// field also allows `undefined` (not just optional `?`) because
// `exactOptionalPropertyTypes` is on and these mocks pass caller-supplied
// values (e.g. `input.parentStream`) straight through into another object
// literal without narrowing away an absent field.
interface MockUpsertGapInput {
  connectorId?: string | null | undefined;
  connectorInstanceId?: string | null | undefined;
  detailLocator?: unknown;
  discoveredRunId?: string | null | undefined;
  gapId?: string | null | undefined;
  grantId?: string | null | undefined;
  lastError?: unknown;
  lastRunId?: string | null | undefined;
  listCursor?: unknown;
  nextAttemptAfter?: string | null | undefined;
  now?: string | null | undefined;
  parentStream?: string | null | undefined;
  reason?: string | null | undefined;
  recordKey?: unknown;
  scope?: unknown;
  source?: unknown;
  stream?: string | null | undefined;
}

// Loose shape for a hand-rolled mock's returned/progress-emitted gap-like
// object — these mocks each return only the subset of `DetailGap` fields one
// test needs, so (unlike `DetailGapForTest`) every field is optional here.
// See `MockUpsertGapInput` above for why `| undefined` is explicit.
interface MockGap {
  detail_locator?: unknown;
  gap_id?: string | null | undefined;
  last_error?: unknown;
  list_cursor?: unknown;
  parent_stream?: string | null | undefined;
  reason?: string | null | undefined;
  record_key?: unknown;
  status?: string | null | undefined;
  stream?: string | null | undefined;
  type?: string | undefined;
}

// Shape of the on-disk JSON a `createStartCaptureConnector`/
// `createLeaseSwapConnector` connector writes from the runtime's real START
// message — read back via `JSON.parse(readFileSync(...))` (genuinely
// `any` from `JSON.parse`, but a few call sites below need an explicit
// annotation so a generic `assert.deepEqual` call doesn't force a stricter
// contextual type onto the `.map()` callback than plain `any` would give).
interface CapturedStart {
  detail_gaps: MockGap[];
}

// Recovery admission evidence carried on `DETAIL_GAPS_PAGE_RESPONSE` /
// `DETAIL_GAPS_START_ADMISSION` runtime progress messages (Tasks 2.1/2.6 —
// recorded diagnostics, never enforced/gating).
interface RecoveryAdmissionEvidence {
  admitted: number;
  candidates: number;
  deferred: number;
  deferred_by_reason?: Record<string, number> | undefined;
}

interface ProgressAdmissionMessage {
  admission?: RecoveryAdmissionEvidence | undefined;
  count?: number | undefined;
  reference_only?: boolean | undefined;
  type?: string | undefined;
}

function createConnector(
  messages: readonly Record<string, unknown>[],
  { exitCode = 0 }: { exitCode?: number } = {}
): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gap-connector-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (JSON.parse(line).type !== 'START') return;
  for (const message of ${JSON.stringify(messages)}) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  rl.close();
  process.stdout.write('', () => process.exit(${JSON.stringify(exitCode)}));
});

`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function createStartCaptureConnector(
  outputPath: string,
  messages: readonly Record<string, unknown>[] = [{ records_emitted: 0, status: "succeeded", type: "DONE" }]
): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gap-start-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(msg), 'utf8');
  for (const message of ${JSON.stringify(messages)}) {
    process.stdout.write(JSON.stringify(message) + '\\n');
  }
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function createLeaseSwapConnector(outputPath: string): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gap-lease-swap-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const start = JSON.parse(line);
  if (start.type !== 'START') return;
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(start), 'utf8');
  const [first, second] = start.detail_gaps;
  process.stdout.write(JSON.stringify({
    type: 'DETAIL_GAP_ATTEMPTED', reference_only: true,
    gap_id: first.gap_id, lease_id: second.lease_id, stream: first.stream,
  }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function createParentSwapRedeferConnector(outputPath: string): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gap-parent-swap-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const start = JSON.parse(line);
  if (start.type !== 'START') return;
  writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(start), 'utf8');
  const [first, second] = start.detail_gaps;
  process.stdout.write(JSON.stringify({
    type: 'DETAIL_GAP', reference_only: true, status: 'pending', retryable: true,
    gap_id: first.gap_id, lease_id: first.lease_id, stream: first.stream,
    parent_stream: second.parent_stream, record_key: first.record_key,
    detail_locator: first.detail_locator, reason: 'temporary_unavailable',
  }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function createPagedRecoveryConnector(
  outputPath: string,
  { maxBytes = null }: { maxBytes?: number | null } = {}
): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gap-paged-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const rl = createInterface({ input: process.stdin });
const pages = [];
let requestCounter = 0;
const maxBytes = ${JSON.stringify(maxBytes)};
function emit(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}
function recover(gaps, source) {
  pages.push({ source, count: gaps.length });
  for (const gap of gaps) {
    emit({
      type: 'DETAIL_GAP_RECOVERED',
      reference_only: true,
      gap_id: gap.gap_id,
      stream: gap.stream,
      record_key: gap.record_key,
    });
  }
}
function requestNext() {
  const request_id = 'page_' + (++requestCounter);
  emit({
    type: 'DETAIL_GAPS_PAGE_REQUEST',
    reference_only: true,
    request_id,
    streams: ['messages'],
    ...(maxBytes ? { max_bytes: maxBytes } : {}),
  });
}
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'START') {
    recover(msg.detail_gaps || [], 'start');
    requestNext();
    return;
  }
  if (msg.type === 'DETAIL_GAPS_PAGE_RESPONSE') {
    const gaps = msg.detail_gaps || [];
    recover(gaps, msg.request_id);
    if (gaps.length === 0) {
      writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({ pages }), 'utf8');
      rl.close();
      emit({ type: 'DONE', status: 'succeeded', records_emitted: 0 });
      process.stdout.write('', () => process.exit(0));
      return;
    }
    requestNext();
  }
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

function createPrefixRecoveryConnector(): ConnectorHandle {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gap-prefix-recovery-"));
  const connectorPath = join(dir, "connector.mjs");
  writeFileSync(
    connectorPath,
    `
import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'START') return;
  const [first] = msg.detail_gaps || [];
  if (first) {
    process.stdout.write(JSON.stringify({
      type: 'DETAIL_GAP_RECOVERED',
      reference_only: true,
      gap_id: first.gap_id,
      stream: first.stream,
      record_key: first.record_key,
    }) + '\\n');
  }
  process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
  rl.close();
  process.stdout.write('', () => process.exit(0));
});
`,
    "utf8"
  );
  return { cleanup: () => rmSync(dir, { force: true, recursive: true }), connectorPath };
}

interface StateServerContext {
  rsUrl: string;
  stateWrites: unknown[];
}

async function withStateServer(fn: (ctx: StateServerContext) => Promise<void>): Promise<void> {
  const stateWrites: unknown[] = [];
  const server = createServer(async (req, res) => {
    if (req.method === "PUT" && req.url?.startsWith("/v1/state/")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      stateWrites.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/ingest/")) {
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      for await (const _chunk of req) {
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ records_accepted: 1, records_attempted: 1, records_rejected: 0, rejections: [] }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object", "listening server has an AddressInfo address");
    await fn({
      rsUrl: `http://127.0.0.1:${address.port}`,
      stateWrites,
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function seedPendingDetailGaps(
  store: DetailGapStoreForTest,
  count: number,
  {
    connectorId = "chatgpt",
    payloadFields = 0,
    stream = "messages",
  }: { connectorId?: string; payloadFields?: number; stream?: string } = {}
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const recordKey = `${stream.replace(/[^a-z0-9]+/gi, "_")}_${String(index).padStart(4, "0")}`;
    const listItem: Record<string, string> = {
      id: recordKey,
      title: `Conversation ${index}`,
    };
    for (let field = 0; field < payloadFields; field += 1) {
      listItem[`padding_${field}`] = `${field}:`.padEnd(300, "x");
    }
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await store.upsertPendingGap({
      connectorId,
      detailLocator: {
        conversation_id: recordKey,
        kind: "chatgpt.conversation",
        list_item: listItem,
      },
      grantId: "grant_1",
      reason: "retry_exhausted",
      recordKey,
      stream,
    });
  }
}

async function assertConnectorEmittedDetailGapRoundTrip({
  dir,
  store,
  connectorId = "chatgpt",
  connectorInstanceId = null,
  grantId = "grant_1",
}: {
  dir: string;
  store: DetailGapStoreForTest;
  connectorId?: string;
  connectorInstanceId?: string | null;
  grantId?: string | null;
}): Promise<void> {
  // Host-side linchpin for the ChatGPT 429 resume contract.
  //
  // The package-level connector tests prove the connector EMITS DETAIL_GAP on
  // retry exhaustion and CONSUMES START.detail_gaps on the next run. The two
  // single-direction runtime tests (`runtime records DETAIL_GAP …` and
  // `runtime includes pending detail gaps in START …`) each prove one half of
  // the host seam against a MOCK store, and the instance-isolation test seeds
  // the real store BY HAND. This helper proves the full chain through a REAL
  // store: a connector-emitted gap, written by the runtime's DETAIL_GAP
  // handler, read back verbatim by the next run's START construction.
  const emittedGap = {
    detail_locator: {
      conversation_id: "conv_deferred",
      kind: "chatgpt.conversation",
      list_item: { id: "conv_deferred", title: "Deferred under pressure" },
    },
    last_error: {
      message: "rate limited after retry budget",
      network_pressure: {
        attempt: 12,
        endpoint_route: "GET /conversation/{conversation_id}",
        error_class: "http_429",
        max_attempts: 12,
        status: 429,
      },
    },
    list_cursor: { after: "cursor_30" },
    parent_stream: "conversation_list",
    reason: "upstream_pressure",
    record_key: "conv_deferred",
    retryable: true,
    stream: "messages",
    type: "DETAIL_GAP",
  };
  const runtimeArgs = {
    admitRunConnection: fakeAdmitRunConnection(),
    connectorId,
    connectorInstanceId,
    detailGapStore: store,
    grantId,
    manifest: { streams: [{ name: "messages" }] },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
    onProgress: () => {},
    ownerToken: "owner",
    persistState: false,
  };

  // Run 1: connector emits a realistic ChatGPT 429-deferral DETAIL_GAP, then
  // completes successfully (honest partial coverage). The runtime persists the
  // gap through the real store.
  const emitter = createConnector([emittedGap, { records_emitted: 0, status: "succeeded", type: "DONE" }]);

  let persistedGapId: string | null | undefined;
  try {
    const run1 = await runConnectorWithGapStore({
      ...runtimeArgs,
      connectorPath: emitter.connectorPath,
    });
    assert.equal(run1.status, "succeeded");
    assert.ok(run1.detail_gaps, "run 1 result carries a detail_gaps list");
    assert.equal(run1.detail_gaps.length, 1, "run 1 reports the durable gap it persisted");
    const [run1Gap] = run1.detail_gaps;
    assert.ok(run1Gap, "run 1 detail_gaps has one entry");
    persistedGapId = run1Gap.gap_id;
    assert.ok(persistedGapId, "persisted gap has a stable id");
  } finally {
    emitter.cleanup();
  }

  // Independent proof the row actually landed in the real store (not just that
  // the runtime echoed it back in-memory).
  const persisted = await store.listPendingGaps({
    connectorId,
    connectorInstanceId,
    grantId,
    streams: ["messages"],
  });
  assert.deepEqual(
    persisted.map((gap) => gap.gap_id),
    [persistedGapId]
  );

  // Run 2: a fresh run with the SAME store. The START construction must load
  // the persisted gap and hand it to the connector as a reference-only row.
  const startPath = join(dir, "roundtrip-start.json");
  const capturer = createStartCaptureConnector(startPath);
  try {
    const run2 = await runConnectorWithGapStore({
      ...runtimeArgs,
      connectorPath: capturer.connectorPath,
    });
    assert.equal(run2.status, "succeeded", `terminal=${run2.terminal_reason}`);
  } finally {
    capturer.cleanup();
  }

  const start = JSON.parse(readFileSync(startPath, "utf8"));
  assert.equal(start.detail_gaps.length, 1, "next run START carries exactly the one deferred gap");
  // biome-ignore lint/style/useDestructuring: the property access names the fixture value at its point of use.
  const startGap = start.detail_gaps[0];
  assert.equal(startGap.gap_id, persistedGapId, "same gap identity survives the round-trip");
  assert.equal(startGap.stream, "messages");
  assert.equal(startGap.record_key, "conv_deferred", "the deferred conversation is the one returned for retry");
  assert.equal(startGap.status, "pending");
  assert.equal(startGap.reference_only, true, "gap is handed back as a reference-only recovery row");
  assert.deepEqual(
    startGap.detail_locator,
    emittedGap.detail_locator,
    "the locator the connector needs to re-fetch survives persistence verbatim"
  );
}

test(
  "connector detail gap store upserts pending gaps, updates status, and redacts unsafe metadata",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const gap = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: {
        conversation_id: "conv_1",
        headers: { authorization: "Bearer secret", cookie: "sid=secret" },
        request_body: { private: "payload" },
        url: "https://chatgpt.com/backend-api/conversation/conv_1?access_token=secret",
      },
      discoveredRunId: "run_a",
      grantId: "grant_1",
      lastError: {
        message: "rate limited",
        response_url: "https://chatgpt.com/api?bearer=secret",
        token: "secret",
      },
      listCursor: { after: "cursor_30" },
      parentStream: "conversation_list",
      recordKey: "conv_1",
      stream: "conversations",
    });
    assert.ok(gap, "gap is present");

    assert.equal(gap.status, "pending");
    assert.equal(gap.connector_id, "chatgpt");
    const sanitizedLocator = asJsonRecord(gap.detail_locator, "gap.detail_locator is a sanitized record");
    const sanitizedHeaders = asJsonRecord(sanitizedLocator.headers, "sanitized locator has a headers record");
    const sanitizedLocatorUrl = asSafeUrlSummary(sanitizedLocator.url, "sanitized locator url is a SafeUrlSummary");
    assert.equal(sanitizedHeaders.cookie, "[redacted]");
    assert.equal(sanitizedHeaders.authorization, "[redacted]");
    assert.equal(sanitizedLocator.request_body, "[redacted]");
    assert.equal(sanitizedLocatorUrl.host, "chatgpt.com");
    assert.equal(sanitizedLocatorUrl.path_hash.length, 16);
    const sanitizedLastError = asJsonRecord(gap.last_error, "gap.last_error is a sanitized record");
    const sanitizedResponseUrl = asSafeUrlSummary(
      sanitizedLastError.response_url,
      "sanitized last_error response_url is a SafeUrlSummary"
    );
    assert.equal(sanitizedLastError.token, "[redacted]");
    assert.equal(sanitizedResponseUrl.host, "chatgpt.com");

    const pending = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_1",
      streams: ["conversations"],
    });
    assert.deepEqual(
      pending.map((entry) => entry.gap_id),
      [gap.gap_id]
    );

    const inProgress = await store.markGapStatus(gap.gap_id, "in_progress", { runId: "run_b" });
    assert.ok(inProgress, "inProgress is present");
    assert.equal(inProgress.status, "in_progress");
    assert.equal(inProgress.attempt_count, 1);
    assert.equal(inProgress.last_run_id, "run_b");

    const recovered = await store.markGapStatus(gap.gap_id, "recovered", { runId: "run_b" });
    assert.ok(recovered, "recovered is present");
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.recovered_run_id, "run_b");
  })
);

// P1 review finding (independent review of commit 5712f3afe): a gap recovered
// with NO run id (e.g. `markGapStatus(id, 'recovered', {})`, the shape
// `ref-device-exporters.ts:recoverLocalCollectorGap` uses for the
// local-collector policy-budget drain — no spine run backs that recovery)
// stayed sticky FOREVER under an earlier revision's
// `recovered_run_id IS NULL OR recovered_run_id = excluded.last_run_id`
// clause, because NULL made the OR branch match unconditionally. A NULL
// `recovered_run_id` carries no same-attempt run context to compare against,
// so it must never behave as a stickiness wildcard — every re-upsert of such
// a row (which the runtime's own DETAIL_GAP handler always issues with a
// real, non-null `lastRunId`) is definitionally later, independent evidence
// and must reopen the row to `pending`.
test(
  "a gap recovered with NO run id reopens to pending on any later re-upsert (does not stay sticky forever)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const seeded = await store.upsertPendingGap({
      connectorId: "claude-code",
      connectorInstanceId: "cin_local_device",
      detailLocator: { kind: "local_collector.policy_budget" },
      reason: "policy_budget",
      recordKey: "budget_window_1",
      stream: "local-collector/policy_budget",
    });
    assert.ok(seeded, "seeded is present");
    // Run-id-less recovery: the local-collector policy-budget drain path calls
    // markGapStatus(id, 'recovered', {}) with no runId.
    const recovered = await store.markGapStatus(seeded.gap_id, "recovered", {});
    assert.ok(recovered, "recovered is present");
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.recovered_run_id, null, "no run id was supplied, so recovered_run_id stays null");

    // A LATER, independent event re-upserts the SAME identity with a real run
    // id (the shape a genuine connector run, or a second local-collector
    // heartbeat cycle with fresh evidence, would produce).
    const reupserted = await store.upsertPendingGap({
      connectorId: "claude-code",
      connectorInstanceId: "cin_local_device",
      detailLocator: { kind: "local_collector.policy_budget" },
      discoveredRunId: "run_later",
      lastRunId: "run_later",
      reason: "policy_budget",
      recordKey: "budget_window_1",
      stream: "local-collector/policy_budget",
    });
    assert.ok(reupserted, "reupserted is present");
    assert.equal(reupserted.gap_id, seeded.gap_id, "same identity — same row");
    assert.equal(
      reupserted.status,
      "pending",
      "a null-recovered_run_id row must reopen on any later re-upsert, not stay sticky forever"
    );
    assert.equal(
      reupserted.recovered_run_id,
      null,
      "the null recovered_run_id from the original recovery is left as-is (not overwritten by the SET clause)"
    );
  })
);

test(
  "a gap recovered with NO run id, then re-upserted with ALSO no run id, still reopens (never a wildcard match)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const seeded = await store.upsertPendingGap({
      connectorId: "claude-code",
      connectorInstanceId: "cin_local_device",
      detailLocator: { kind: "local_collector.policy_budget" },
      reason: "policy_budget",
      recordKey: "budget_window_2",
      stream: "local-collector/policy_budget",
    });
    assert.ok(seeded, "seeded is present");
    await store.markGapStatus(seeded.gap_id, "recovered", {});

    // Even a second run-id-less re-upsert (lastRunId also null/absent) must NOT
    // be treated as matching the stored NULL recovered_run_id — SQL NULL never
    // equals NULL, so there is no same-attempt context to protect here either.
    const reupserted = await store.upsertPendingGap({
      connectorId: "claude-code",
      connectorInstanceId: "cin_local_device",
      detailLocator: { kind: "local_collector.policy_budget" },
      reason: "policy_budget",
      recordKey: "budget_window_2",
      stream: "local-collector/policy_budget",
    });
    assert.ok(reupserted, "reupserted is present");
    assert.equal(reupserted.gap_id, seeded.gap_id);
    assert.equal(
      reupserted.status,
      "pending",
      "a null-vs-null recovered_run_id comparison must not be treated as a stickiness match"
    );
  })
);

test(
  "listPendingGaps returns only retry-eligible pending gaps",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const now = "2026-07-06T12:00:00.000Z";
    const due = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "due" },
      grantId: "grant_1",
      nextAttemptAfter: "2026-07-06T11:59:00.000Z",
      recordKey: "due",
      stream: "conversations",
    });
    assert.ok(due, "due is present");
    const noFloor = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "no-floor" },
      grantId: "grant_1",
      recordKey: "no-floor",
      stream: "conversations",
    });
    assert.ok(noFloor, "noFloor is present");
    const future = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "future" },
      grantId: "grant_1",
      nextAttemptAfter: "2026-07-06T12:30:00.000Z",
      recordKey: "future",
      stream: "conversations",
    });
    assert.ok(future, "future is present");

    const eligible = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_1",
      now,
      streams: ["conversations"],
    });
    assert.deepEqual(
      // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
      eligible.map((gap) => gap.gap_id).sort(),
      [due.gap_id, noFloor.gap_id].sort(),
      "runtime recovery serving must not retry gaps before next_attempt_after"
    );

    const diagnostics = await store.listPendingGapsForConnector("chatgpt", { limit: 100 });
    assert.ok(
      diagnostics.some((gap) => gap.gap_id === future.gap_id),
      "diagnostic pending-gap listing still includes future-scheduled gaps"
    );
  })
);

test(
  "listPendingGaps prefers lower-attempt work so one hot row cannot starve fresh gaps",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const hot = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "hot" },
      grantId: "grant_1",
      recordKey: "hot",
      stream: "conversations",
    });
    assert.ok(hot, "hot is present");

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let attempt = 0; attempt < 24; attempt++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(hot.gap_id, "in_progress", { runId: `run_hot_${attempt}` });
      await forcePendingForTest(store, [hot.gap_id]);
    }

    const cold = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "cold" },
      grantId: "grant_1",
      recordKey: "cold",
      stream: "conversations",
    });
    assert.ok(cold, "cold is present");

    const pending = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_1",
      streams: ["conversations"],
    });

    assert.deepEqual(
      pending.map((gap) => gap.gap_id),
      [cold.gap_id, hot.gap_id],
      "fresh work must be served ahead of a repeatedly failing pending row"
    );
    const [pendingFirst, pendingSecond] = pending;
    assert.ok(pendingFirst, "pendingFirst is present");
    assert.ok(pendingSecond, "pendingSecond is present");
    assert.equal(pendingFirst.attempt_count, 0);
    assert.equal(pendingSecond.attempt_count, 24);
  })
);

test(
  "listPendingGaps ages older eligible work ahead of fresh arrivals after the rotation window",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const now = "2026-07-14T12:00:00.000Z";
    const agedFresh = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "aged-fresh" },
      grantId: "grant_1",
      now: "2026-07-14T11:30:00.000Z",
      recordKey: "aged-fresh",
      stream: "conversations",
    });
    assert.ok(agedFresh, "agedFresh is present");

    const fresh = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "fresh" },
      grantId: "grant_1",
      now: "2026-07-14T11:59:30.000Z",
      recordKey: "fresh",
      stream: "conversations",
    });
    assert.ok(fresh, "fresh is present");

    const hot = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "hot-aged" },
      grantId: "grant_1",
      now: "2026-07-14T11:58:00.000Z",
      recordKey: "hot-aged",
      stream: "conversations",
    });
    assert.ok(hot, "hot is present");
    await store.markGapStatus(hot.gap_id, "in_progress", { now: "2026-07-14T11:58:30.000Z", runId: "run_hot_aged" });
    await forcePendingForTest(store, [hot.gap_id]);

    const pending = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_1",
      now,
      streams: ["conversations"],
    });

    assert.deepEqual(
      pending.map((gap) => gap.gap_id),
      [agedFresh.gap_id, fresh.gap_id, hot.gap_id],
      "older eligible work should outrank younger arrivals once it has aged into the rotation bucket"
    );
    const [pendingFirst, pendingSecond, pendingThird] = pending;
    assert.ok(pendingFirst, "pendingFirst is present");
    assert.ok(pendingSecond, "pendingSecond is present");
    assert.ok(pendingThird, "pendingThird is present");
    assert.equal(pendingFirst.attempt_count, 0);
    assert.equal(pendingSecond.attempt_count, 0);
    assert.equal(pendingThird.attempt_count, 1);
  })
);

// ─── Recovery-page fair-progress across multiple runs (gap starvation) ────
//
// Reproduces the live Gmail attachment shape: a pending backlog larger than
// one recovery page, where a fixed head-of-queue subset is served every run
// (every 15 minutes, matching the live cadence) but never recovered. Proves
// that with the aging-bucket ordering every eligible row eventually gets a
// turn across successive runs, while backoff and terminal rows are still
// respected regardless of attempt_count or age.

const RUN_CADENCE_ISO_STEP_MS = 15 * 60 * 1000; // matches PENDING_GAP_ROTATION_WINDOW_SECONDS

function isoAfter(baseIso: string, stepIndex: number, stepMs: number = RUN_CADENCE_ISO_STEP_MS): string {
  return new Date(Date.parse(baseIso) + stepIndex * stepMs).toISOString();
}

/** Seed `headCount` "stuck" gaps (oldest by created_at) plus `tailCount`
 * "fresh" gaps (created later, never yet served), matching the live shape:
 * 256 rows repeatedly re-attempted vs. 10,012 rows at attempt_count=0. */
async function seedStarvationBacklog(
  store: DetailGapStoreForTest,
  {
    headCount,
    tailCount,
    connectorId,
    grantId,
    stream,
    baseIso,
  }: {
    headCount: number;
    tailCount: number;
    connectorId: string;
    grantId: string;
    stream: string;
    baseIso: string;
  }
): Promise<{ head: DetailGapForTest[]; tail: DetailGapForTest[] }> {
  const head: DetailGapForTest[] = [];
  // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
  for (let i = 0; i < headCount; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const headGap = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: `head-${i}` },
      grantId,
      now: isoAfter(baseIso, 0, 1000 * i),
      reason: "temporary_unavailable",
      recordKey: `head-${i}`,
      stream,
    });
    assert.ok(headGap, "headGap is present");
    head.push(headGap);
  }
  const tail: DetailGapForTest[] = [];
  // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
  for (let i = 0; i < tailCount; i++) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    const tailGap = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: `tail-${i}` },
      grantId,
      now: isoAfter(baseIso, 1, 1000 * i),
      reason: "temporary_unavailable",
      recordKey: `tail-${i}`,
      stream,
    });
    assert.ok(tailGap, "tailGap is present");
    tail.push(tailGap);
  }
  return { head, tail };
}

/** Simulate one run: page `pageSize` eligible gaps as of `runIso`, serve them
 * (in_progress), then reset every served-but-unrecovered gap back to pending
 * at run cleanup — mirroring a connector (like pre-fix Gmail attachments)
 * that never consumes served detail gaps for recovery. */
async function simulateOneStarvedRun(
  store: DetailGapStoreForTest,
  {
    connectorId,
    grantId,
    stream,
    pageSize,
    runId,
    runIso,
  }: {
    connectorId: string;
    grantId: string;
    stream: string;
    pageSize: number;
    runId: string;
    runIso: string;
  }
): Promise<DetailGapForTest[]> {
  const page = await store.listPendingGaps({ connectorId, grantId, limit: pageSize, now: runIso, streams: [stream] });
  for (const gap of page) {
    // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
    await store.markGapStatus(gap.gap_id, "in_progress", { now: runIso, runId });
  }
  await forcePendingForTest(
    store,
    page.map((gap) => gap.gap_id)
  );
  return page;
}

test(
  "fair-progress: a multi-page backlog eventually serves every eligible row across successive 15-minute runs, not just the head-of-queue subset",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "gmail";
    const grantId = "grant_1";
    const stream = "attachments";
    const headCount = 20;
    const tailCount = 60;
    const pageSize = 20; // page size « backlog size, matching the live byte-bounded page « 10,268-row backlog shape.
    const baseIso = "2026-07-01T00:00:00.000Z";

    const { head, tail } = await seedStarvationBacklog(store, {
      baseIso,
      connectorId,
      grantId,
      headCount,
      stream,
      tailCount,
    });

    // Simulate many successful runs, each 15 minutes apart (the live cadence),
    // where the connector never recovers or re-defers what it's served.
    const seenGapIds = new Set();
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let run = 0; run < 40; run++) {
      const runIso = isoAfter(baseIso, run + 2);
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const served = await simulateOneStarvedRun(store, {
        connectorId,
        grantId,
        pageSize,
        runId: `run_${run}`,
        runIso,
        stream,
      });
      for (const gap of served) {
        seenGapIds.add(gap.gap_id);
      }
    }

    const allIds = [...head, ...tail].map((gap) => gap.gap_id);
    const neverServed = allIds.filter((id) => !seenGapIds.has(id));
    assert.deepEqual(
      neverServed,
      [],
      `every eligible row must eventually be served across successive runs; starved: ${neverServed.length}/${allIds.length}`
    );

    // The tail rows (initially unattempted) must have been served, not just the
    // original head-of-queue subset repeating forever.
    for (const gap of tail) {
      assert.ok(seenGapIds.has(gap.gap_id), `tail row ${gap.record_key} was never selected for a recovery page`);
    }
  })
);

test(
  "fair-progress: backoff-deferred rows stay excluded across runs regardless of attempt_count or age",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "gmail";
    const grantId = "grant_1";
    const stream = "attachments";
    const baseIso = "2026-07-15T12:00:00.000Z";

    // A row served many times (high attempt_count, old) but currently under its
    // own backoff floor must never be selected, even though both the
    // attempt_count and age components of the ordering would otherwise favor it.
    // `markGapStatus('in_progress')` clears next_attempt_after unconditionally (a
    // row being actively attempted has no floor), so attempt_count is built by
    // re-upserting WITH a floor each time (the connector-re-defer shape), not the
    // plain serve/reset cycle used elsewhere in this suite.
    let backedOff = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "backed-off" },
      grantId,
      nextAttemptAfter: isoAfter(baseIso, 100),
      now: baseIso,
      reason: "temporary_unavailable",
      recordKey: "backed-off",
      stream,
    });
    assert.ok(backedOff, "backedOff is present");
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(backedOff.gap_id, "in_progress", { now: baseIso, runId: `r${i}` });
      backedOff = await store.upsertPendingGap({
        connectorId,
        detailLocator: { id: "backed-off" },
        grantId,
        lastRunId: `r${i}`,
        nextAttemptAfter: isoAfter(baseIso, 100),
        now: baseIso,
        reason: "temporary_unavailable",
        recordKey: "backed-off",
        stream,
      });
      assert.ok(backedOff, "backedOff is present");
    }
    assert.ok(backedOff.attempt_count >= 5, "backed-off row has a high attempt_count going into the assertion");

    const fresh = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "fresh" },
      grantId,
      now: baseIso,
      reason: "temporary_unavailable",
      recordKey: "fresh",
      stream,
    });
    assert.ok(fresh, "fresh is present");

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let run = 0; run < 10; run++) {
      const runIso = isoAfter(baseIso, run);
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const page = await store.listPendingGaps({ connectorId, grantId, now: runIso, streams: [stream] });
      assert.deepEqual(
        page.map((gap) => gap.gap_id),
        [fresh.gap_id],
        `a backoff-deferred row must be excluded from the page at run ${run} even with a favorable attempt_count/age sort key`
      );
    }
  })
);

test(
  "fair-progress: terminal rows never resurface into a recovery page across runs regardless of attempt_count or age",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "gmail";
    const grantId = "grant_1";
    const stream = "attachments";
    const baseIso = "2026-07-01T00:00:00.000Z";

    const terminalCandidate = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "gone" },
      grantId,
      now: baseIso,
      reason: "temporary_unavailable",
      recordKey: "gone",
      stream,
    });
    assert.ok(terminalCandidate, "terminalCandidate is present");
    await store.markGapStatus(terminalCandidate.gap_id, "terminal", { now: baseIso, reason: "quarantined" });

    const fresh = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "fresh" },
      grantId,
      now: baseIso,
      reason: "temporary_unavailable",
      recordKey: "fresh",
      stream,
    });
    assert.ok(fresh, "fresh is present");

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let run = 0; run < 10; run++) {
      const runIso = isoAfter(baseIso, run);
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const page = await store.listPendingGaps({ connectorId, grantId, now: runIso, streams: [stream] });
      assert.deepEqual(
        page.map((gap) => gap.gap_id),
        [fresh.gap_id],
        `a terminal row must never be selected for a recovery page at run ${run} regardless of its attempt_count or age`
      );
    }
  })
);

test(
  "fair-progress: a backlog within one page is unaffected by the aging-bucket ordering (membership, not just order)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "gmail";
    const grantId = "grant_1";
    const stream = "attachments";
    const baseIso = "2026-07-01T00:00:00.000Z";

    const gaps: DetailGapForTest[] = [];
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      const seededGap = await store.upsertPendingGap({
        connectorId,
        detailLocator: { id: `g${i}` },
        grantId,
        now: baseIso,
        reason: "temporary_unavailable",
        recordKey: `g${i}`,
        stream,
      });
      assert.ok(seededGap, "seededGap is present");
      gaps.push(seededGap);
    }
    // Serve the first a few times (raising its attempt_count) without a large
    // backlog — every row should still be returned since the page limit
    // exceeds the total backlog size.
    const [firstGap] = gaps;
    assert.ok(firstGap, "firstGap is present");
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 3; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(firstGap.gap_id, "in_progress", { now: baseIso, runId: `r${i}` });
      await forcePendingForTest(store, [firstGap.gap_id]);
    }

    const page = await store.listPendingGaps({ connectorId, grantId, limit: 100, now: baseIso, streams: [stream] });
    assert.deepEqual(
      // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
      page.map((gap) => gap.gap_id).sort(),
      // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
      gaps.map((gap) => gap.gap_id).sort(),
      "a backlog smaller than the page limit still returns every eligible row"
    );
  })
);

test(
  "fair-progress: a row past the quarantine threshold is not starved forever behind a large backlog (attempt-count rank clamp)",
  withTempDb(async () => {
    // The raw ORDER BY `attempt_count - age_bonus` (age bonus capped at
    // PENDING_GAP_MAX_AGE_BUCKETS=8) gives a row past the quarantine threshold
    // a rank of `attempt_count-8` forever — worse than a CONTINUOUSLY-arriving
    // fresh row, which never accumulates enough age to reach its own floor
    // before the next, even-fresher arrival outranks it. Such a row can never
    // reach `maybeQuarantineGap` (only evaluated on selection+re-defer), so it
    // is stuck pending permanently. This proves the store-level fix: clamping
    // the attempt_count term at the quarantine threshold caps the poison row's
    // worst-case rank at `threshold - maxAgeBonus`, matching a row that is
    // exactly AT the threshold — which the existing (untouched)
    // "ages older eligible work ahead of fresh arrivals" behavior already
    // guarantees eventually wins selection.
    const store = createSqliteConnectorDetailGapStore();
    const connectorId = "gmail";
    const grantId = "grant_1";
    const stream = "attachments";
    const baseIso = "2026-07-01T00:00:00.000Z";
    const threshold = DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts;

    // Seed the poison row already WAY past the quarantine threshold (as if it
    // had been served many times before this fix existed), aged well past the
    // rotation window so its age-bonus term is already fully saturated —
    // i.e. its rank is at its best-case floor and can get no better.
    let poison = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "poison" },
      grantId,
      now: baseIso,
      reason: "temporary_unavailable",
      recordKey: "poison",
      stream,
    });
    assert.ok(poison, "poison is present");
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < threshold + 20; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(poison.gap_id, "in_progress", { now: baseIso, runId: `seed_${i}` });
      poison = await store.upsertPendingGap({
        connectorId,
        detailLocator: { id: "poison" },
        grantId,
        lastRunId: `seed_${i}`,
        now: baseIso,
        reason: "temporary_unavailable",
        recordKey: "poison",
        stream,
      });
      assert.ok(poison, "poison is present");
    }
    assert.ok(
      poison.attempt_count > threshold,
      "poison row attempt_count must exceed the quarantine threshold going into the assertion"
    );
    // Fully saturate the age bonus (past the rotation-window cap; matches the
    // store's PENDING_GAP_MAX_AGE_BUCKETS = 8) before any fresh row has had a
    // chance to age at all.
    const maxAgeBuckets = 8;
    const selectionIso = isoAfter(baseIso, maxAgeBuckets + 1);

    // One never-yet-attempted row created JUST before the selection instant —
    // it has NOT had time to accumulate any age bonus of its own, so its rank
    // is exactly its raw attempt_count (0). Selection is capped at 1 result,
    // isolating a direct two-row rank comparison: with the clamp, the poison
    // row's floor rank (threshold - maxAgeBonus) still loses the tie-break
    // ordering purely on `attempt_count` vs the fresh row's 0 — UNLESS the
    // fresh row itself is old enough to also be judged solely on identical
    // floor rank, in which case last_attempt_at ordering (poison is older)
    // favors poison. Without the clamp, poison's rank is
    // (threshold+20)-maxAgeBonus, categorically worse than the fresh row's 0
    // rank regardless of any tie-break, so it is NEVER selected while the
    // fresh row remains pending.
    const fresh = await store.upsertPendingGap({
      connectorId,
      detailLocator: { id: "fresh" },
      grantId,
      now: selectionIso,
      reason: "temporary_unavailable",
      recordKey: "fresh",
      stream,
    });
    assert.ok(fresh, "fresh is present");

    const page = await store.listPendingGaps({
      connectorId,
      grantId,
      limit: 1,
      now: selectionIso,
      streams: [stream],
    });

    assert.deepEqual(
      page.map((gap) => gap.gap_id),
      [poison.gap_id],
      "a row past the quarantine threshold, once fully aged, must rank at or ahead of a genuinely fresh arrival " +
        `(fresh gap ${fresh.gap_id} must not permanently outrank it) — otherwise it is starved forever and can never reach quarantine`
    );
  })
);

test(
  "connector detail gaps are isolated by connector instance",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const first = await store.upsertPendingGap({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_work",
      detailLocator: { conversation_id: "conv_1" },
      grantId: "grant_1",
      recordKey: "conv_1",
      stream: "conversations",
    });
    assert.ok(first, "first is present");
    const second = await store.upsertPendingGap({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_personal",
      detailLocator: { conversation_id: "conv_1" },
      grantId: "grant_1",
      recordKey: "conv_1",
      stream: "conversations",
    });
    assert.ok(second, "second is present");

    assert.notEqual(first.gap_id, second.gap_id);
    assert.equal(first.connector_instance_id, "cin_chatgpt_work");
    assert.equal(second.connector_instance_id, "cin_chatgpt_personal");

    assert.deepEqual(
      (
        await store.listPendingGaps({
          connectorId: "chatgpt",
          connectorInstanceId: "cin_chatgpt_work",
          grantId: "grant_1",
        })
      ).map((gap) => gap.gap_id),
      [first.gap_id]
    );
    assert.deepEqual(
      (
        await store.listPendingGaps({
          connectorId: "chatgpt",
          connectorInstanceId: "cin_chatgpt_personal",
          grantId: "grant_1",
        })
      ).map((gap) => gap.gap_id),
      [second.gap_id]
    );

    await store.markGapStatus(first.gap_id, "recovered", { runId: "run_recovery_a" });
    assert.deepEqual(
      (
        await store.listPendingGaps({
          connectorId: "chatgpt",
          connectorInstanceId: "cin_chatgpt_work",
          grantId: "grant_1",
        })
      ).map((gap) => gap.gap_id),
      []
    );
    assert.deepEqual(
      (
        await store.listPendingGaps({
          connectorId: "chatgpt",
          connectorInstanceId: "cin_chatgpt_personal",
          grantId: "grant_1",
        })
      ).map((gap) => gap.gap_id),
      [second.gap_id]
    );
  })
);

test(
  "connector detail gap store is idempotent by gap identity when connector-supplied gap ids change",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const first = await store.upsertPendingGap({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_personal",
      detailLocator: { conversation_id: "conv_1" },
      discoveredRunId: "run_a",
      gapId: "gap_transient_a",
      grantId: "grant_1",
      lastRunId: "run_a",
      reason: "rate_limited",
      recordKey: "conv_1",
      stream: "conversations",
    });
    assert.ok(first, "first is present");
    const second = await store.upsertPendingGap({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_personal",
      detailLocator: { conversation_id: "conv_1" },
      discoveredRunId: "run_b",
      gapId: "gap_transient_b",
      grantId: "grant_1",
      lastRunId: "run_b",
      reason: "source_pressure",
      recordKey: "conv_1",
      stream: "conversations",
    });
    assert.ok(second, "second is present");

    assert.equal(second.gap_id, first.gap_id);
    assert.equal(second.reason, "source_pressure");
    assert.equal(second.discovered_run_id, "run_a");
    assert.equal(second.last_run_id, "run_b");
    assert.deepEqual(
      (
        await store.listPendingGaps({
          connectorId: "chatgpt",
          connectorInstanceId: "cin_chatgpt_personal",
          grantId: "grant_1",
        })
      ).map((gap) => gap.gap_id),
      [first.gap_id]
    );
  })
);

test(
  "listPendingGapsForConnector returns gaps across every connector instance for diagnostics",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const work = await store.upsertPendingGap({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_laptop_a",
      grantId: "grant_local",
      recordKey: "work-1",
      source: { device_id: "dev_a", kind: "local_device", source_instance_id: "src_a" },
      stream: "local-collector/policy_budget/messages",
    });
    assert.ok(work, "work is present");
    const home = await store.upsertPendingGap({
      connectorId: "codex",
      connectorInstanceId: "cin_codex_laptop_b",
      grantId: "grant_local",
      recordKey: "home-1",
      source: { device_id: "dev_b", kind: "local_device", source_instance_id: "src_b" },
      stream: "local-collector/policy_budget/messages",
    });
    assert.ok(home, "home is present");

    // Operator-console projection must see both per-device gaps even
    // without naming a connector instance — the per-instance default
    // fallback in `listPendingGaps` would silently drop these.
    const projected = await store.listPendingGapsForConnector("codex", { limit: 100 });
    // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
    assert.deepEqual(projected.map((gap) => gap.gap_id).sort(), [work.gap_id, home.gap_id].sort());

    // Each gap still carries the source identity that distinguishes the
    // two devices.
    const byDevice = new Map(
      projected.map(
        (gap) => [asJsonRecord(gap.source, "projected gap.source is a sanitized record").device_id, gap] as const
      )
    );
    const devA = byDevice.get("dev_a");
    const devB = byDevice.get("dev_b");
    assert.ok(devA, "devA gap is present");
    assert.ok(devB, "devB gap is present");
    assert.equal(asJsonRecord(devA.source, "devA.source is a sanitized record").source_instance_id, "src_a");
    assert.equal(asJsonRecord(devB.source, "devB.source is a sanitized record").source_instance_id, "src_b");

    // Marking one instance recovered must not affect the other.
    await store.markGapStatus(work.gap_id, "recovered", { runId: "run_recovery" });
    const afterRecovery = await store.listPendingGapsForConnector("codex", { limit: 100 });
    assert.deepEqual(
      afterRecovery.map((gap) => gap.gap_id),
      [home.gap_id]
    );
  })
);

// Reason-scoped count-by-status aggregate backing the source-pressure backlog
// rollup's optional `recovered` count
// (`surface-source-pressure-detail-gap-backlog`). It is connector-wide (every
// instance), exact (a real COUNT(*), never a floor), status-scoped, and
// reason-scoped to source pressure — the count-by-status analogue of the
// connector-wide pending read the projection already does.
async function seedRecoveredCountFixture(store: DetailGapStoreForTest, connectorId: string): Promise<void> {
  // Two recovered source-pressure gaps across two different instances...
  const a = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: "cin_recovered_a",
    grantId: "grant_1",
    reason: "upstream_pressure",
    recordKey: "conv_a",
    stream: "messages",
  });
  assert.ok(a, "a is present");
  const b = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: "cin_recovered_b",
    grantId: "grant_1",
    reason: "rate_limited",
    recordKey: "conv_b",
    stream: "messages",
  });
  assert.ok(b, "b is present");
  await store.markGapStatus(a.gap_id, "recovered", { runId: "run_r1" });
  await store.markGapStatus(b.gap_id, "recovered", { runId: "run_r2" });
  // ...a recovered gap with a NON-source-pressure reason (must NOT be counted)...
  const c = await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: "cin_recovered_c",
    grantId: "grant_1",
    reason: "temporary_unavailable",
    recordKey: "conv_c",
    stream: "messages",
  });
  assert.ok(c, "c is present");
  await store.markGapStatus(c.gap_id, "recovered", { runId: "run_r3" });
  // ...and a still-PENDING source-pressure gap (different status, must NOT be
  // counted by the recovered aggregate but proves status scoping).
  await store.upsertPendingGap({
    connectorId,
    connectorInstanceId: "cin_recovered_d",
    grantId: "grant_1",
    reason: "upstream_pressure",
    recordKey: "conv_d",
    stream: "messages",
  });
}

async function assertRecoveredCountAggregate(store: DetailGapStoreForTest, connectorId: string): Promise<void> {
  // Recovered + source-pressure only: a (upstream_pressure) + b (rate_limited).
  const recovered = await store.countGapsByStatusForConnector(connectorId, {
    reasons: ["rate_limited", "upstream_pressure"],
    status: "recovered",
  });
  assert.equal(recovered, 2, "counts only recovered source-pressure gaps across every instance");

  const scopedRecovered = await store.countGapsByStatusForConnector(connectorId, {
    connectorInstanceId: "cin_recovered_a",
    reasons: ["rate_limited", "upstream_pressure"],
    status: "recovered",
  });
  assert.equal(scopedRecovered, 1, "connection-scoped aggregate excludes sibling recovered gaps");

  const scopedEmpty = await store.countGapsByStatusForConnector(connectorId, {
    connectorInstanceId: "cin_missing",
    reasons: ["rate_limited", "upstream_pressure"],
    status: "recovered",
  });
  assert.equal(scopedEmpty, 0, "connection-scoped aggregate returns exact 0 when no sibling rows match");

  // The pending source-pressure gap proves the status filter: it is NOT in the
  // recovered count, but IS in the pending count (same reason scope).
  const pending = await store.countGapsByStatusForConnector(connectorId, {
    reasons: ["rate_limited", "upstream_pressure"],
    status: "pending",
  });
  assert.equal(pending, 1, "status scope excludes recovered rows from the pending count");

  // Without a reason scope, the non-source-pressure recovered gap is included
  // (3 recovered total: a, b, c) — proving the reason filter is what excludes it
  // above, not some unrelated narrowing.
  const recoveredAnyReason = await store.countGapsByStatusForConnector(connectorId, {
    status: "recovered",
  });
  assert.equal(recoveredAnyReason, 3, "no reason scope counts every recovered reason");

  const recoveredByStream = await store.countGapsByStatusByStreamForConnector(connectorId, {
    status: "recovered",
  });
  assert.deepEqual(recoveredByStream, [{ count: 3, stream: "messages" }], "stream aggregate groups by stream");

  const scopedRecoveredByStream = await store.countGapsByStatusByStreamForConnector(connectorId, {
    connectorInstanceId: "cin_recovered_b",
    status: "recovered",
  });
  assert.deepEqual(
    scopedRecoveredByStream,
    [{ count: 1, stream: "messages" }],
    "stream aggregate respects connection scope"
  );

  // A connector with no rows drains to a real exact 0 (never null/NaN).
  const empty = await store.countGapsByStatusForConnector("no_such_connector", {
    reasons: ["rate_limited", "upstream_pressure"],
    status: "recovered",
  });
  assert.equal(empty, 0, "an unmatched connector yields an exact 0, not a fabricated value");

  // Guards the contract by construction: an unsupported status throws.
  await assert.rejects(
    () => Promise.resolve(store.countGapsByStatusForConnector(connectorId, { status: "bogus" })),
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    /Unsupported connector detail gap status/
  );
  await assert.rejects(
    () => Promise.resolve(store.countGapsByStatusByStreamForConnector(connectorId, { status: "bogus" })),
    // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
    /Unsupported connector detail gap status/
  );
}

test(
  "countGapsByStatusForConnector returns an exact reason-scoped recovered count across instances",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    await seedRecoveredCountFixture(store, "chatgpt");
    await assertRecoveredCountAggregate(store, "chatgpt");
  })
);

test("sanitizeDetailGapMetadata does not preserve full URLs or secret-bearing fields", () => {
  const sanitized = asJsonRecord(
    sanitizeDetailGapMetadata({
      access_token: "secret",
      href: "https://example.test/path/to/private?id=123",
      nested: { bearer: "secret", ok: "safe" },
      network_pressure: {
        endpoint_route: "GET /conversation/{conversation_id}",
        unsafe_endpoint_route: "GET /conversation/private-id?token=secret",
      },
    }),
    "sanitizeDetailGapMetadata returns a sanitized record"
  );
  const sanitizedHref = asSafeUrlSummary(sanitized.href, "sanitized.href is a SafeUrlSummary");
  assert.deepEqual(sanitizedHref, { host: "example.test", path_hash: sanitizedHref.path_hash, scheme: "https" });
  assert.equal(sanitized.access_token, "[redacted]");
  const sanitizedNetworkPressure = asJsonRecord(sanitized.network_pressure, "sanitized.network_pressure is a record");
  assert.equal(sanitizedNetworkPressure.endpoint_route, "GET /conversation/{conversation_id}");
  assert.equal(sanitizedNetworkPressure.unsafe_endpoint_route, "[redacted-url]");
  const sanitizedNested = asJsonRecord(sanitized.nested, "sanitized.nested is a record");
  assert.equal(sanitizedNested.bearer, "[redacted]");
  assert.equal(sanitizedNested.ok, "safe");
});

test(
  "runtime records DETAIL_GAP before successful terminal handling",
  withTempDb(async () => {
    const calls: MockUpsertGapInput[] = [];
    const networkPressure = {
      attempt: 12,
      endpoint_route: "GET /conversation/{conversation_id}",
      error_class: "http_429",
      max_attempts: 12,
      method: "GET",
      retry_after_ms: 120_000,
      safe_headers: { "retry-after-ms": 120_000 },
      status: 429,
    };
    const detailGapStore = {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async listPendingGaps(): Promise<MockGap[]> {
        return [];
      },
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async upsertPendingGap(input: MockUpsertGapInput): Promise<MockGap> {
        calls.push(input);
        return {
          detail_locator: { conversation_id: "conv_1" },
          gap_id: "gap_test",
          last_error: input.lastError,
          list_cursor: { after: "cursor_30" },
          parent_stream: input.parentStream,
          reason: input.reason,
          record_key: input.recordKey,
          status: "pending",
          stream: input.stream,
        };
      },
    };
    const { connectorPath, cleanup } = createConnector([
      {
        detail_locator: { conversation_id: "conv_1" },
        last_error: {
          message: "pressure",
          network_pressure: networkPressure,
        },
        list_cursor: { after: "cursor_30" },
        parent_stream: "conversation_list",
        reason: "upstream_pressure",
        record_key: "conv_1",
        retryable: true,
        stream: "conversations",
        type: "DETAIL_GAP",
      },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]);

    const progressMessages: MockGap[] = [];
    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath,
        detailGapStore,
        manifest: { streams: [{ name: "conversations" }] },
        onProgress: (msg) => {
          progressMessages.push(msg as MockGap);
        },
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
      assert.equal(calls.length, 1);
      const [firstCall] = calls;
      assert.ok(firstCall, "firstCall is present");
      assert.equal(firstCall.stream, "conversations");
      assert.deepEqual(
        asJsonRecord(firstCall.lastError, "firstCall.lastError is a record").network_pressure,
        networkPressure
      );
      assert.ok(result.detail_gaps, "result carries a detail_gaps list");
      const [resultGap] = result.detail_gaps;
      assert.ok(resultGap, "result.detail_gaps has one entry");
      assert.equal(resultGap.gap_id, "gap_test");
      const progressGap = progressMessages.find((msg) => msg.type === "DETAIL_GAP");
      assert.ok(progressGap, "progress emits a DETAIL_GAP message");
      assert.deepEqual(
        asJsonRecord(progressGap.last_error, "progressGap.last_error is a record").network_pressure,
        networkPressure
      );
    } finally {
      cleanup();
    }
  })
);

interface MockClaimOptions {
  leaseExpiresAt?: string | null | undefined;
  leaseId?: string | null | undefined;
  runId?: string | null | undefined;
}

interface MockClaimedLeaseCall {
  gapIds: readonly (string | null | undefined)[];
  options: MockClaimOptions;
}

interface MockListPendingGapsInput {
  connectorId?: string | null | undefined;
  grantId?: string | null | undefined;
  streams?: readonly string[] | null | undefined;
}

test(
  "runtime includes pending detail gaps in START as reference-only safe rows",
  withTempDb(async (dir) => {
    const startPath = join(dir, "start.json");
    const pendingGap = {
      detail_locator: {
        conversation_id: "conv_1",
        kind: "chatgpt.conversation",
        list_item: { id: "conv_1", title: "Safe title" },
      },
      gap_id: "gap_pending",
      record_key: "conv_1",
      status: "pending",
      stream: "messages",
    };
    const claimedLeases: MockClaimedLeaseCall[] = [];
    const detailGapStore = {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async claimPendingGaps(
        gapIds: readonly (string | null | undefined)[],
        options: MockClaimOptions
      ): Promise<readonly (string | null | undefined)[]> {
        claimedLeases.push({ gapIds, options });
        return gapIds;
      },
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async listPendingGaps(input: MockListPendingGapsInput): Promise<MockGap[]> {
        assert.equal(input.connectorId, "chatgpt");
        assert.equal(input.grantId, "grant_1");
        assert.deepEqual(input.streams, ["messages"]);
        return [pendingGap];
      },
      // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      async reclaimStrandedInProgressGaps(): Promise<void> {},
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async releaseLeasedGaps(): Promise<{ released: number; lost: number; attemptedUnsettled: number }> {
        return { attemptedUnsettled: 0, lost: 0, released: 1 };
      },
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async upsertPendingGap(): Promise<never> {
        throw new Error("unused");
      },
    };
    const { connectorPath, cleanup } = createStartCaptureConnector(startPath);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath,
        detailGapStore,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
      const start = JSON.parse(readFileSync(startPath, "utf8"));
      assert.equal(start.detail_gaps.length, 1);
      assert.deepEqual(
        { ...start.detail_gaps[0], lease_id: undefined },
        { ...pendingGap, lease_id: undefined, reference_only: true }
      );
      assert.equal(claimedLeases.length, 1, "served gap is claimed by a run-owned lease before connector gets it");
      const [firstClaim] = claimedLeases;
      assert.ok(firstClaim, "firstClaim is present");
      assert.deepEqual(firstClaim.gapIds, [pendingGap.gap_id]);
      assert.equal(firstClaim.options.runId, result.run_id);
    } finally {
      cleanup();
    }
  })
);

test(
  "each same-page gap has its own lease token and a swapped pairing fails closed",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    for (const recordKey of ["attachment_lease_swap_a", "attachment_lease_swap_b"]) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.upsertPendingGap({
        connectorId: "gmail",
        detailLocator: { kind: "gmail.attachment_detail", message_id: recordKey, part_index: "1" },
        grantId: "grant_lease_swap",
        reason: "temporary_unavailable",
        recordKey,
        stream: "attachments",
      });
    }
    const startPath = join(dir, "lease-swap-start.json");
    const { connectorPath, cleanup } = createLeaseSwapConnector(startPath);
    try {
      await assert.rejects(
        () =>
          runConnectorWithGapStore({
            admitRunConnection: fakeAdmitRunConnection(),
            connectorId: "gmail",
            connectorPath,
            detailGapStore: store,
            grantId: "grant_lease_swap",
            manifest: { streams: [{ name: "attachments" }] },
            // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
            onProgress: () => {},
            ownerToken: "owner",
            persistState: false,
          }),
        // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
        /without the current run-owned lease/
      );
    } finally {
      cleanup();
    }
    const start = JSON.parse(readFileSync(startPath, "utf8"));
    assert.equal(start.detail_gaps.length, 2);
    assert.notEqual(start.detail_gaps[0].lease_id, start.detail_gaps[1].lease_id, "lease_id is unique per served gap");
    const pending = await store.listPendingGaps({
      connectorId: "gmail",
      grantId: "grant_lease_swap",
      streams: ["attachments"],
    });
    assert.equal(pending.length, 2, "failed swapped settlement releases both unattempted leases");
    assert.equal(
      pending.every((gap) => gap.attempt_count === 0),
      true
    );
  })
);

test(
  "a served multi-parent gap cannot be re-deferred under its sibling parent",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    for (const parentStream of ["group_messages", "direct_chat_messages"]) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup creates two distinct parent-scoped identities.
      await store.upsertPendingGap({
        connectorId: "groupme",
        detailLocator: { kind: "groupme.attachment", message_id: "shared-key" },
        grantId: "grant_parent_swap",
        parentStream,
        reason: "temporary_unavailable",
        recordKey: "shared-key",
        stream: "attachments",
      });
    }
    const startPath = join(dir, "parent-swap-start.json");
    const { connectorPath, cleanup } = createParentSwapRedeferConnector(startPath);
    try {
      await assert.rejects(
        () =>
          runConnectorWithGapStore({
            admitRunConnection: fakeAdmitRunConnection(),
            connectorId: "groupme",
            connectorPath,
            detailGapStore: store,
            grantId: "grant_parent_swap",
            manifest: {
              streams: [
                { name: "group_messages" },
                { name: "direct_chat_messages" },
                {
                  coverage_strategy: "parent_detail_accounting",
                  name: "attachments",
                  parent_streams: ["group_messages", "direct_chat_messages"],
                },
              ],
            },
            // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op progress observer for the protocol fixture.
            onProgress: () => {},
            ownerToken: "owner",
            persistState: false,
          }),
        DIFFERENT_PARENT_STREAM_PATTERN
      );
    } finally {
      cleanup();
    }
    const start = JSON.parse(readFileSync(startPath, "utf8"));
    assert.deepEqual(start.detail_gaps.map((gap: { parent_stream: string }) => gap.parent_stream).sort(), [
      "direct_chat_messages",
      "group_messages",
    ]);
  })
);

test(
  "runtime loads pending detail gaps only for the requested connector instance",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    await store.upsertPendingGap({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_work",
      detailLocator: { conversation_id: "work_conv" },
      grantId: "grant_1",
      recordKey: "work_conv",
      stream: "messages",
    });
    const personalGap = await store.upsertPendingGap({
      connectorId: "chatgpt",
      connectorInstanceId: "cin_chatgpt_personal",
      detailLocator: { conversation_id: "personal_conv" },
      grantId: "grant_1",
      recordKey: "personal_conv",
      stream: "messages",
    });
    assert.ok(personalGap, "personalGap is present");
    const startPath = join(dir, "start-instance.json");
    const { connectorPath, cleanup } = createStartCaptureConnector(startPath);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorInstanceId: "cin_chatgpt_personal",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
      const start = JSON.parse(readFileSync(startPath, "utf8")) as CapturedStart;
      assert.deepEqual(
        start.detail_gaps.map((gap) => gap.gap_id),
        [personalGap.gap_id]
      );
      assert.deepEqual(
        start.detail_gaps.map((gap) => gap.record_key),
        ["personal_conv"]
      );
    } finally {
      cleanup();
    }
  })
);

test(
  "connector-emitted DETAIL_GAP survives real-store persistence and reappears in the next run START.detail_gaps",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    // Both runs omit connectorInstanceId so they resolve to the same
    // default-account instance — the production single-owner SQLite path.
    await assertConnectorEmittedDetailGapRoundTrip({ dir, store });
  })
);

test(
  "runtime drains more than 100 pending detail gaps in one run through paged recovery requests",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    await seedPendingDetailGaps(store, 150);
    const pageStatsPath = join(dir, "paged-recovery.json");
    const connector = createPagedRecoveryConnector(pageStatsPath);
    const pageResponses: ProgressAdmissionMessage[] = [];

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath: connector.connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        onProgress: (msg) => {
          const progressMsg = msg as ProgressAdmissionMessage;
          // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
          if (progressMsg?.type === "DETAIL_GAPS_PAGE_RESPONSE") {
            pageResponses.push(progressMsg);
          }
        },
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
      assert.ok(result.detail_gaps, "result carries a detail_gaps list");
      assert.equal(
        result.detail_gaps.filter((gap) => gap.status === "recovered").length,
        150,
        "one logical runtime run recovers every seeded gap, not just the first page"
      );
    } finally {
      connector.cleanup();
    }

    const stats = JSON.parse(readFileSync(pageStatsPath, "utf8")) as { pages: { count: number }[] };
    const positivePages = stats.pages.filter((page) => page.count > 0);
    assert.equal(
      positivePages.reduce((sum, page) => sum + page.count, 0),
      150,
      "connector saw and recovered all gaps across START plus requested pages"
    );
    assert.equal(
      (await store.listPendingGaps({ connectorId: "chatgpt", grantId: "grant_1", limit: 500, streams: ["messages"] }))
        .length,
      0,
      "durable pending backlog is drained"
    );
    assert.ok(
      pageResponses.some((page) => page.count === 0),
      "runtime eventually returns an empty page"
    );
  })
);

test(
  "successful partial recovery releases unattempted page leases without inflating their quarantine budget",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const first = await store.upsertPendingGap({
      connectorId: "gmail",
      detailLocator: { kind: "gmail.attachment_detail", message_id: "message_first", part_index: "1" },
      grantId: "grant_1",
      reason: "temporary_unavailable",
      recordKey: "attachment_first",
      stream: "attachments",
    });
    assert.ok(first, "first is present");
    const second = await store.upsertPendingGap({
      connectorId: "gmail",
      detailLocator: { kind: "gmail.attachment_detail", message_id: "message_second", part_index: "1" },
      grantId: "grant_1",
      reason: "temporary_unavailable",
      recordKey: "attachment_second",
      stream: "attachments",
    });
    assert.ok(second, "second is present");
    const connector = createPrefixRecoveryConnector();

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "gmail",
        connectorPath: connector.connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "attachments" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
    } finally {
      connector.cleanup();
    }

    const recovered = await store.getGapById(first.gap_id);
    assert.ok(recovered, "recovered is present");
    const unattempted = await store.getGapById(second.gap_id);
    assert.ok(unattempted, "unattempted is present");
    assert.equal(recovered.status, "recovered");
    assert.equal(unattempted.status, "pending");
    assert.equal(unattempted.attempt_count, 0, "a cleanly unreported lease is not a recovery attempt");
    assert.equal(unattempted.last_attempt_at, null, "the row keeps no false last-attempt evidence");
  })
);

test(
  "DETAIL_GAPS_PAGE_RESPONSE carries connector-neutral recovery admission evidence without gating the served set",
  withTempDb(async (dir) => {
    // Tasks 2.1/2.6: the page response now carries recovery admission evidence
    // (admitted/deferred counts + deferral reason classes) so owner-only
    // diagnostics can answer "why did (or didn't) recovery proceed" — recorded,
    // NOT enforced: every seeded non-pressure gap is still drained.
    const store = createSqliteConnectorDetailGapStore();
    await seedPendingDetailGaps(store, 40); // reason: retry_exhausted → non-pressure, all admitted
    const pageStatsPath = join(dir, "admission-evidence.json");
    const connector = createPagedRecoveryConnector(pageStatsPath);
    const pageResponses: ProgressAdmissionMessage[] = [];
    const startAdmissions: ProgressAdmissionMessage[] = [];

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath: connector.connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        onProgress: (msg) => {
          const progressMsg = msg as ProgressAdmissionMessage;
          // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
          if (progressMsg?.type === "DETAIL_GAPS_PAGE_RESPONSE") {
            pageResponses.push(progressMsg);
          }
          // biome-ignore lint/suspicious/noUnnecessaryConditions: the runtime fixture deliberately exercises an absent or nullable boundary value.
          if (progressMsg?.type === "DETAIL_GAPS_START_ADMISSION") {
            startAdmissions.push(progressMsg);
          }
        },
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
      assert.ok(result.detail_gaps, "result carries a detail_gaps list");
      assert.equal(result.detail_gaps.filter((gap) => gap.status === "recovered").length, 40);
    } finally {
      connector.cleanup();
    }

    // The START-time page emits its own admission evidence line.
    assert.equal(startAdmissions.length, 1, "START recovery page emits one admission-evidence event");
    const [startAdmission] = startAdmissions;
    assert.ok(startAdmission, "startAdmission is present");
    assert.ok(startAdmission.admission, "START admission evidence is present");
    assert.equal(startAdmission.reference_only, true);

    // Every page response carries an admission summary.
    assert.ok(pageResponses.length > 0);
    for (const page of pageResponses) {
      assert.ok(page.admission, "each page response carries admission evidence");
      assert.equal(page.admission.candidates, page.count, "candidate count matches the served page size");
      // All seeded gaps are non-pressure (retry_exhausted): every candidate is
      // admitted, none deferred — the recorded evidence agrees with the drained set.
      assert.equal(page.admission.admitted, page.count);
      assert.equal(page.admission.deferred, 0);
      assert.equal(page.admission.deferred_by_reason, undefined, "no deferral reasons when everything is admitted");
    }

    // The full backlog drained: admission recorded evidence, it never gated the page.
    const allAdmitted = [startAdmission.admission, ...pageResponses.map((p) => p.admission)].reduce(
      (sum, a) => sum + (a?.admitted ?? 0),
      0
    );
    assert.equal(allAdmitted, 40, "all 40 non-pressure gaps were admitted across START + paged requests");
  })
);

test(
  "runtime pages large detail-gap payloads by byte budget while still draining semantics",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    await seedPendingDetailGaps(store, 12, { payloadFields: 20 });
    const pageStatsPath = join(dir, "byte-paged-recovery.json");
    const connector = createPagedRecoveryConnector(pageStatsPath, { maxBytes: 16 * 1024 });
    const priorTarget = process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES;
    process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES = String(16 * 1024);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath: connector.connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
      assert.ok(result.detail_gaps, "result carries a detail_gaps list");
      assert.equal(result.detail_gaps.filter((gap) => gap.status === "recovered").length, 12);
    } finally {
      if (priorTarget === undefined) {
        delete process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES;
      } else {
        process.env.PDPP_DETAIL_GAP_PAGE_TARGET_BYTES = priorTarget;
      }
      connector.cleanup();
    }

    const stats = JSON.parse(readFileSync(pageStatsPath, "utf8")) as { pages: { count: number }[] };
    const positivePages = stats.pages.filter((page) => page.count > 0);
    assert.ok(positivePages.length > 1, "large payloads are split across multiple pages");
    assert.ok(
      positivePages.every((page) => page.count < 12),
      "no positive page carries the whole large backlog under the byte budget"
    );
    assert.equal(
      positivePages.reduce((sum, page) => sum + page.count, 0),
      12
    );
    assert.equal(
      (await store.listPendingGaps({ connectorId: "chatgpt", grantId: "grant_1", limit: 500, streams: ["messages"] }))
        .length,
      0
    );
  })
);

// ─── Attempt-persistence acceptance tests ────────────────────────────────────
//
// These tests prove the cross-run adaptive recovery contract: serving creates
// a crash-honest lease before provider work, while a clean successful connector
// releases a lease it never reported as an actual recovery outcome.

test(
  "a successful connector releases a START gap it never attempts",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    const startPath = join(dir, "attempt-start.json");

    const seeded = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_attempt", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      reason: "upstream_pressure",
      recordKey: "conv_attempt",
      stream: "messages",
    });
    assert.ok(seeded, "seeded is present");
    assert.equal(seeded.attempt_count, 0, "freshly seeded gap starts at attempt_count=0");

    const { connectorPath, cleanup } = createStartCaptureConnector(startPath);
    try {
      await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
    } finally {
      cleanup();
    }

    const afterRun = await store.getGapById(seeded.gap_id);
    assert.ok(afterRun, "afterRun is present");
    assert.equal(afterRun.status, "pending");
    assert.equal(afterRun.attempt_count, 0, "successful cleanup releases an unreported START lease");
    assert.equal(afterRun.last_attempt_at, null, "successful cleanup clears false attempt evidence");
  })
);

test(
  "recovered gap preserves incremented attempt_count after DETAIL_GAP_RECOVERED",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    const seeded = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_recover", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      reason: "rate_limited",
      recordKey: "conv_recover",
      stream: "messages",
    });
    assert.ok(seeded, "seeded is present");

    // Mark in_progress (simulates serving gap) — increments to 1.
    await store.markGapStatus(seeded.gap_id, "in_progress", { runId: "run_x" });

    // Now recover it.
    const recovered = await store.markGapStatus(seeded.gap_id, "recovered", { runId: "run_x" });
    assert.ok(recovered, "recovered is present");
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.attempt_count, 1, "recovered gap retains incremented attempt_count");
    assert.equal(recovered.recovered_run_id, "run_x");
  })
);

test(
  "re-deferred pressure gap remains pending with attempt_count > 0 after runtime re-defers it",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    // Seed a gap, serve it (mark in_progress → attempt_count=1), then re-defer
    // it (connector emits DETAIL_GAP again → upsertPendingGap → status=pending,
    // attempt_count stays at 1 because upsert does not reset attempt_count).
    const seeded = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_redefer", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      reason: "upstream_pressure",
      recordKey: "conv_redefer",
      stream: "messages",
    });
    assert.ok(seeded, "seeded is present");

    // Simulate runtime serving the gap (in_progress).
    await store.markGapStatus(seeded.gap_id, "in_progress", { runId: "run_a" });

    // Simulate connector re-deferring it (DETAIL_GAP emitted again).
    const reDeferred = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_redefer", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      lastRunId: "run_a",
      reason: "upstream_pressure",
      recordKey: "conv_redefer",
      stream: "messages",
    });
    assert.ok(reDeferred, "reDeferred is present");

    assert.equal(reDeferred.status, "pending", "re-deferred gap is pending");
    assert.equal(reDeferred.attempt_count, 1, "attempt_count is preserved at 1 after re-deferral");
    assert.equal(reDeferred.gap_id, seeded.gap_id, "same gap identity persists across re-deferral");
  })
);

test(
  "runtime does not quarantine Amazon planned run-cap re-deferrals carried as retry_exhausted + run_cap_deferred class",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const orderId = "111-2222222-3333333";
    const detailLocator = { kind: "amazon.order_detail", order_date: "2026-01-05", order_id: orderId };
    const seeded = await store.upsertPendingGap({
      connectorId: "amazon",
      detailLocator,
      grantId: "grant_1",
      lastError: { class: "run_cap_deferred" },
      parentStream: "orders",
      reason: "retry_exhausted",
      recordKey: orderId,
      stream: "order_items",
    });
    assert.ok(seeded, "seeded is present");

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 7; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(seeded.gap_id, "in_progress", { runId: `prior_run_${i}` });
      await forcePendingForTest(store, [seeded.gap_id]);
    }

    const { connectorPath, cleanup } = createConnector([
      {
        detail_locator: detailLocator,
        last_error: { class: "run_cap_deferred" },
        parent_stream: "orders",
        reason: "retry_exhausted",
        record_key: orderId,
        reference_only: true,
        retryable: true,
        stream: "order_items",
        type: "DETAIL_GAP",
      },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "amazon",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "order_items" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
    } finally {
      cleanup();
    }

    const pending = await store.listPendingGaps({
      connectorId: "amazon",
      grantId: "grant_1",
      streams: ["order_items"],
    });
    assert.equal(await store.countGapsByStatusForConnector("amazon", { status: "terminal" }), 0);
    assert.equal(pending.length, 1, "planned cap remains queued for the next eligible recovery envelope");
    const [pendingGap] = pending;
    assert.ok(pendingGap, "pendingGap is present");
    assert.equal(pendingGap.gap_id, seeded.gap_id);
    assert.equal(pendingGap.attempt_count, 8, "the served attempt is counted without turning planned cap into poison");
    assert.equal(pendingGap.reason, "retry_exhausted");
    assert.equal(asJsonRecord(pendingGap.last_error, "pendingGap.last_error is a record").class, "run_cap_deferred");
  })
);

test(
  "runtime quarantines Amazon-shaped repeated no-progress re-deferrals at the per-item threshold",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const orderId = "111-2222222-3333334";
    const detailLocator = { kind: "amazon.order_detail", order_date: "2026-01-05", order_id: orderId };
    const seeded = await store.upsertPendingGap({
      connectorId: "amazon",
      detailLocator,
      grantId: "grant_1",
      lastError: { class: "transient_no_progress" },
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: orderId,
      stream: "order_items",
    });
    assert.ok(seeded, "seeded is present");

    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 7; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(seeded.gap_id, "in_progress", { runId: `prior_run_${i}` });
      await forcePendingForTest(store, [seeded.gap_id]);
    }

    const { connectorPath, cleanup } = createConnector([
      {
        detail_locator: detailLocator,
        last_error: { class: "transient_no_progress" },
        parent_stream: "orders",
        reason: "temporary_unavailable",
        record_key: orderId,
        reference_only: true,
        retryable: true,
        stream: "order_items",
        type: "DETAIL_GAP",
      },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "amazon",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "order_items" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
    } finally {
      cleanup();
    }

    const pending = await store.listPendingGaps({
      connectorId: "amazon",
      grantId: "grant_1",
      streams: ["order_items"],
    });
    const terminal = await store.getGapById(seeded.gap_id);
    assert.ok(terminal, "terminal is present");
    assert.equal(pending.length, 0, "poison item no longer consumes the fillable-pending recovery budget");
    assert.equal(await store.countGapsByStatusForConnector("amazon", { status: "terminal" }), 1);
    assert.deepEqual(
      await store.countGapsByStatusByStreamForConnector("amazon", { status: "terminal" }),
      [{ count: 1, stream: "order_items" }],
      "terminal stream aggregate makes quarantined detail gaps visible to source projection"
    );
    assert.equal(terminal.status, "terminal");
    assert.equal(terminal.reason, "quarantined");
    const terminalLastError = asJsonRecord(terminal.last_error, "terminal.last_error is a sanitized record");
    assert.equal(terminalLastError.class, "quarantined");
    assert.equal(terminalLastError.failure_class, "transient_no_progress");
    assert.equal(terminalLastError.attempt_count, 8);
  })
);

test(
  "store deliberately requeues quarantined terminal gaps with a fresh no-progress budget",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorInstanceId = "cin_amazon_retry_test";
    const orderId = "111-2222222-3333335";
    const seeded = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId,
      detailLocator: { kind: "amazon.order_detail", order_date: "2026-01-06", order_id: orderId },
      lastError: { class: "transient_no_progress" },
      parentStream: "orders",
      reason: "retry_exhausted",
      recordKey: orderId,
      stream: "order_items",
    });
    assert.ok(seeded, "seeded is present");
    // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
    for (let i = 0; i < 8; i++) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.markGapStatus(seeded.gap_id, "in_progress", { runId: `prior_run_${i}` });
      await forcePendingForTest(store, [seeded.gap_id]);
    }
    await store.markGapStatus(seeded.gap_id, "terminal", {
      lastError: {
        attempt_count: 8,
        class: "quarantined",
        failure_class: "transient_no_progress",
        reason: "retry_exhausted",
        threshold: 8,
      },
      reason: "quarantined",
    });

    const summary = await store.requeueQuarantinedTerminalGapsForConnectorInstance("amazon", connectorInstanceId, {
      now: "2026-07-09T12:00:00.000Z",
      streams: ["order_items"],
    });

    assert.deepEqual(summary, { matched: 1, requeued: 1 });
    assert.equal(await store.countGapsByStatusForConnector("amazon", { connectorInstanceId, status: "terminal" }), 0);
    const pending = await store.listPendingGaps({
      connectorId: "amazon",
      connectorInstanceId,
      now: "2026-07-09T12:00:00.000Z",
      streams: ["order_items"],
    });
    assert.equal(pending.length, 1);
    const [pendingGap] = pending;
    assert.ok(pendingGap, "pendingGap is present");
    assert.equal(pendingGap.gap_id, seeded.gap_id);
    assert.equal(pendingGap.status, "pending");
    assert.equal(pendingGap.reason, "retry_exhausted");
    assert.equal(pendingGap.attempt_count, 0);
    assert.equal(pendingGap.last_attempt_at, null);
    assert.equal(pendingGap.next_attempt_after, null);
    const pendingLastError = asJsonRecord(pendingGap.last_error, "pendingGap.last_error is a record");
    assert.equal(pendingLastError.class, "quarantine_retry_requested");
    assert.equal(pendingLastError.previous_class, "quarantined");
    assert.equal(pendingLastError.previous_failure_class, "transient_no_progress");
  })
);

test(
  "store requeue path does not revive non-quarantined terminal gaps",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const connectorInstanceId = "cin_amazon_terminal_test";
    const orderId = "111-2222222-3333336";
    const seeded = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId,
      detailLocator: { kind: "amazon.order_detail", order_date: "2026-01-07", order_id: orderId },
      lastError: { class: "transient_no_progress" },
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: orderId,
      stream: "order_items",
    });
    assert.ok(seeded, "seeded is present");
    await store.markGapStatus(seeded.gap_id, "terminal", {
      lastError: { class: "not_found", status: 404 },
      reason: "not_found",
    });

    const summary = await store.requeueQuarantinedTerminalGapsForConnectorInstance("amazon", connectorInstanceId, {
      streams: ["order_items"],
    });

    assert.deepEqual(summary, { matched: 0, requeued: 0 });
    assert.equal(await store.countGapsByStatusForConnector("amazon", { connectorInstanceId, status: "terminal" }), 1);
    const pending = await store.listPendingGaps({
      connectorId: "amazon",
      connectorInstanceId,
      streams: ["order_items"],
    });
    assert.equal(pending.length, 0);
    const terminal = await store.getGapById(seeded.gap_id);
    assert.ok(terminal, "terminal is present");
    assert.equal(terminal.status, "terminal");
    assert.equal(terminal.reason, "not_found");
  })
);

// ─── Durable lease acceptance tests ──────────────────────────────────────────
//
// These tests prove the lease fix: gaps marked in_progress when served are
// reset back to pending if the connector exits without recovering or re-deferring
// them, so they remain retryable. Recovered gaps are never reset.

test(
  "an untouched lease from a failed connector returns pending without inventing an attempt",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    const seeded = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_lease", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      reason: "upstream_pressure",
      recordKey: "conv_lease",
      stream: "messages",
    });
    assert.ok(seeded, "seeded is present");
    assert.equal(seeded.attempt_count, 0);

    // This connector never emits DETAIL_GAP_ATTEMPTED, so its failed envelope is
    // not itself evidence of provider work.
    const { connectorPath, cleanup } = createConnector([], { exitCode: 1 });
    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "failed");
    } finally {
      cleanup();
    }

    // Gap must be back to pending so it can be retried.
    const pending = await store.listPendingGaps({ connectorId: "chatgpt", grantId: "grant_1", streams: ["messages"] });
    assert.equal(pending.length, 1, "gap is retryable (pending) after connector failure");
    const [pendingGap] = pending;
    assert.ok(pendingGap, "pendingGap is present");
    assert.equal(pendingGap.gap_id, seeded.gap_id);
    assert.equal(pendingGap.attempt_count, 0, "an untouched failed lease does not invent an attempt");
  })
);

test(
  "lease CAS preserves prior attempt evidence and stale cleanup cannot release a re-served row",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const seeded = await store.upsertPendingGap({
      connectorId: "gmail",
      detailLocator: { kind: "gmail.attachment_detail", message_id: "message_lease_cas", part_index: "1" },
      grantId: "grant_1",
      reason: "temporary_unavailable",
      recordKey: "attachment_lease_cas",
      stream: "attachments",
    });
    assert.ok(seeded, "seeded is present");
    await store.markGapStatus(seeded.gap_id, "in_progress", {
      now: "2026-07-02T00:00:00.000Z",
      runId: "prior_real_attempt",
    });
    await forcePendingForTest(store, [seeded.gap_id]);

    await store.claimPendingGaps([seeded.gap_id], {
      leaseExpiresAt: "2020-01-01T00:00:00.000Z",
      leaseId: "lease_a",
      runId: "run_a",
    });
    await store.reclaimStrandedInProgressGaps({ connectorId: "gmail", grantId: "grant_1" });
    await store.claimPendingGaps([seeded.gap_id], {
      leaseExpiresAt: "2030-01-01T00:00:00.000Z",
      leaseId: "lease_b",
      runId: "run_b",
    });

    const stale = await store.releaseLeasedGaps([{ gapId: seeded.gap_id, leaseId: "lease_a", runId: "run_a" }]);
    assert.deepEqual(stale, { attemptedUnsettled: 0, lost: 1, released: 0 });
    const stillOwned = await store.getGapById(seeded.gap_id);
    assert.ok(stillOwned, "stillOwned is present");
    assert.equal(stillOwned.status, "in_progress");
    assert.equal(stillOwned.lease_id, "lease_b");

    const released = await store.releaseLeasedGaps([{ gapId: seeded.gap_id, leaseId: "lease_b", runId: "run_b" }]);
    assert.deepEqual(released, { attemptedUnsettled: 0, lost: 0, released: 1 });
    const after = await store.getGapById(seeded.gap_id);
    assert.ok(after, "after is present");
    assert.equal(after.status, "pending");
    assert.equal(after.attempt_count, 1);
    assert.equal(
      after.last_attempt_at,
      "2026-07-02T00:00:00.000Z",
      "untouched issuance never erases prior real-attempt recency"
    );
  })
);

test(
  "an explicit attempt survives failed, cancelled, and crashed lease release",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const seeded = await store.upsertPendingGap({
      connectorId: "gmail",
      detailLocator: { kind: "gmail.attachment_detail", message_id: "message_attempted", part_index: "1" },
      grantId: "grant_1",
      reason: "temporary_unavailable",
      recordKey: "attachment_attempted",
      stream: "attachments",
    });
    assert.ok(seeded, "seeded is present");
    for (const terminalPath of ["failed", "cancelled", "crashed"]) {
      const runId = `run_${terminalPath}`;
      const leaseId = `lease_${terminalPath}`;
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.claimPendingGaps([seeded.gap_id], { leaseExpiresAt: "2030-01-01T00:00:00.000Z", leaseId, runId });
      await store.markLeasedGapAttempt({ gapId: seeded.gap_id, leaseId, runId });
      await store.releaseLeasedGaps([{ gapId: seeded.gap_id, leaseId, runId }]);
    }
    const after = await store.getGapById(seeded.gap_id);
    assert.ok(after, "after is present");
    assert.equal(after.status, "pending");
    assert.equal(after.attempt_count, 3, "each explicit provider attempt is retained independent of terminal envelope");
    assert.ok(after.last_attempt_at);
  })
);

test(
  "successful run resolution waits for durable outstanding-lease release",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();
    await store.upsertPendingGap({
      connectorId: "gmail",
      detailLocator: { kind: "gmail.attachment_detail", message_id: "message_wait", part_index: "1" },
      grantId: "grant_1",
      reason: "temporary_unavailable",
      recordKey: "attachment_wait",
      stream: "attachments",
    });
    let releaseStoreWrite!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      releaseStoreWrite = resolve;
    });
    const delayedStore = {
      ...store,
      async releaseLeasedGaps(
        leases: readonly { gapId?: unknown; leaseId?: unknown; runId?: unknown }[]
      ): ReturnType<DetailGapStoreForTest["releaseLeasedGaps"]> {
        await releaseGate;
        return store.releaseLeasedGaps(leases);
      },
    };
    const startPath = join(dir, "await-release-start.json");
    const { connectorPath, cleanup } = createStartCaptureConnector(startPath);
    let settled = false;
    try {
      const resultPromise = runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "gmail",
        connectorPath,
        detailGapStore: delayedStore,
        grantId: "grant_1",
        manifest: { streams: [{ name: "attachments" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      }).then((result) => {
        settled = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(settled, false, "DONE must not resolve before lease release is durable");
      releaseStoreWrite();
      assert.equal((await resultPromise).status, "succeeded");
    } finally {
      cleanup();
    }
  })
);

test(
  "failed, cancelled, and crashed run completion waits for durable outstanding-lease release",
  withTempDb(async () => {
    for (const scenario of [
      {
        expectedStatus: "failed",
        messages: [
          {
            error: { message: "synthetic failure", retryable: true },
            records_emitted: 0,
            status: "failed",
            type: "DONE",
          },
        ],
        name: "failed",
      },
      {
        expectedStatus: "cancelled",
        messages: [
          {
            error: { message: "synthetic cancellation", retryable: false },
            records_emitted: 0,
            status: "cancelled",
            type: "DONE",
          },
        ],
        name: "cancelled",
      },
      { expectedStatus: "failed", messages: [], name: "crashed" },
    ]) {
      const store = createSqliteConnectorDetailGapStore();
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await store.upsertPendingGap({
        connectorId: "gmail",
        detailLocator: {
          kind: "gmail.attachment_detail",
          message_id: `message_wait_${scenario.name}`,
          part_index: "1",
        },
        grantId: `grant_${scenario.name}`,
        reason: "temporary_unavailable",
        recordKey: `attachment_wait_${scenario.name}`,
        stream: "attachments",
      });
      let releaseStoreWrite!: () => void;
      const releaseGate = new Promise<void>((resolve) => {
        releaseStoreWrite = resolve;
      });
      const delayedStore = {
        ...store,
        async releaseLeasedGaps(
          leases: readonly { gapId?: unknown; leaseId?: unknown; runId?: unknown }[]
        ): ReturnType<DetailGapStoreForTest["releaseLeasedGaps"]> {
          await releaseGate;
          return store.releaseLeasedGaps(leases);
        },
      };
      const { connectorPath, cleanup } = createConnector(scenario.messages, { exitCode: 1 });
      let settled = false;
      try {
        const resultPromise = runConnectorWithGapStore({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorId: "gmail",
          connectorPath,
          detailGapStore: delayedStore,
          grantId: `grant_${scenario.name}`,
          manifest: { streams: [{ name: "attachments" }] },
          // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
          onProgress: () => {},
          ownerToken: "owner",
          persistState: false,
        }).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(settled, false, `${scenario.name} must not complete before lease release is durable`);
        releaseStoreWrite();
        assert.equal((await resultPromise).status, scenario.expectedStatus);
      } finally {
        cleanup();
      }
    }
  })
);

test(
  "recovered gap is not reset to pending by run cleanup",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    const seeded = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_recovered_lease", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      reason: "rate_limited",
      recordKey: "conv_recovered_lease",
      stream: "messages",
    });
    assert.ok(seeded, "seeded is present");

    // Simulate a run: serve the gap (in_progress) then recover it.
    const emittedGap = {
      gap_id: seeded.gap_id,
      record_key: seeded.record_key,
      reference_only: true,
      stream: "messages",
      type: "DETAIL_GAP_RECOVERED",
    };
    const { connectorPath, cleanup } = createConnector([
      emittedGap,
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
    } finally {
      cleanup();
    }

    // Gap must remain recovered, not be reset to pending.
    const pending = await store.listPendingGaps({ connectorId: "chatgpt", grantId: "grant_1", streams: ["messages"] });
    assert.equal(pending.length, 0, "recovered gap is not reset to pending by cleanup");
  })
);

test(
  "prior-run in_progress gap is reclaimed to pending before a new run serves gaps",
  withTempDb(async (dir) => {
    const store = createSqliteConnectorDetailGapStore();

    const seeded = await store.upsertPendingGap({
      connectorId: "chatgpt",
      detailLocator: { conversation_id: "conv_stranded", kind: "chatgpt.conversation" },
      grantId: "grant_1",
      reason: "upstream_pressure",
      recordKey: "conv_stranded",
      stream: "messages",
    });
    assert.ok(seeded, "seeded is present");

    // Simulate a prior crashed run: its lease is explicitly expired. A different
    // live run id alone must never make a lease reclaimable.
    await store.claimPendingGaps([seeded.gap_id], {
      leaseExpiresAt: "2020-01-01T00:00:00.000Z",
      leaseId: "lease_prior_crashed",
      runId: "run_prior_crashed",
    });

    // Gap is now in_progress and invisible to listPendingGaps.
    const beforeReclaim = await store.listPendingGaps({
      connectorId: "chatgpt",
      grantId: "grant_1",
      streams: ["messages"],
    });
    assert.equal(beforeReclaim.length, 0, "stranded in_progress gap is not returned by listPendingGaps");

    // A new run should reclaim it and see it in START.
    const startPath = join(dir, "reclaim-start.json");
    const { connectorPath, cleanup } = createStartCaptureConnector(startPath);
    try {
      await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chatgpt",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_1",
        manifest: { streams: [{ name: "messages" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
    } finally {
      cleanup();
    }

    const start = JSON.parse(readFileSync(startPath, "utf8"));
    assert.equal(start.detail_gaps.length, 1, "new run serves the previously stranded gap after reclaiming it");
    assert.equal(start.detail_gaps[0].gap_id, seeded.gap_id, "reclaimed gap has same identity");
  })
);

test(
  "SQLite bootstrap upgrades a legacy lease-less in_progress gap without erasing real attempt evidence",
  // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
  withTempDb(async (dir) => {
    const databasePath = join(dir, "pdpp.sqlite");
    const raw = getDb();
    raw.exec(`
    DROP TABLE connector_detail_gaps;
    CREATE TABLE connector_detail_gaps (
      gap_id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL,
      grant_id TEXT,
      source_json TEXT NOT NULL,
      stream TEXT NOT NULL,
      parent_stream TEXT,
      record_key TEXT,
      detail_locator_json TEXT,
      list_cursor_json TEXT,
      scope_json TEXT,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      next_attempt_after TEXT,
      last_error_json TEXT,
      discovered_run_id TEXT,
      last_run_id TEXT,
      recovered_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal'))
    );
  `);
    raw
      .prepare(`
    INSERT INTO connector_detail_gaps(
      gap_id, connector_id, connector_instance_id, grant_id, source_json, stream,
      status, attempt_count, last_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '{}', ?, 'in_progress', 7, ?, ?, ?)
  `)
      .run(
        "gap_legacy_lease_less",
        "gmail",
        "cin_gmail_legacy",
        "grant_legacy",
        "attachments",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z"
      );
    closeDb();

    initDb(databasePath);
    const after = getDb()
      .prepare(`
    SELECT status, attempt_count, last_attempt_at, lease_run_id, lease_id, lease_attempted, lease_expires_at
    FROM connector_detail_gaps WHERE gap_id = 'gap_legacy_lease_less'
  `)
      .get();
    assert.deepEqual(after, {
      attempt_count: 7,
      last_attempt_at: "2026-07-01T00:00:00.000Z",
      lease_attempted: 0,
      lease_expires_at: null,
      lease_id: null,
      lease_run_id: null,
      status: "pending",
    });
  })
);

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (POSTGRES_URL) {
  test("detail-gap page batch preserves exact-instance pending and aggregate facts on Postgres", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `gap_pg_batch_${suffix}`;
    const first = `cin_gap_pg_first_${suffix}`;
    const second = `cin_gap_pg_second_${suffix}`;
    const now = "2026-07-29T12:00:00.000Z";
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const store = createPostgresConnectorDetailGapStore();
      await store.upsertPendingGap({
        connectorId,
        connectorInstanceId: first,
        gapId: `gap_pg_pending_${suffix}`,
        now,
        reason: "rate_limited",
        stream: "files",
      });
      await store.upsertPendingGap({
        connectorId,
        connectorInstanceId: second,
        gapId: `gap_pg_terminal_${suffix}`,
        now,
        reason: "other",
        stream: "messages",
      });
      await store.markGapStatus(`gap_pg_terminal_${suffix}`, "terminal", { now });
      const pending = await store.listPendingGapsByConnectorInstanceIds([first, second], { now });
      assert.deepEqual(
        pending.get(first)?.map((gap) => gap.gap_id),
        [`gap_pg_pending_${suffix}`]
      );
      assert.equal(pending.get(second), undefined);
      assert.deepEqual(
        await store.countGapsByStatusByStreamForConnectorInstanceIds([first, second], { status: "terminal" }),
        new Map([[second, new Map([["messages", 1]])]])
      );
    } finally {
      await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_instance_id = ANY($1::text[])", [
        [first, second],
      ]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test("countGapsByStatusForConnector returns an exact reason-scoped recovered count (Postgres)", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `chatgpt_pg_recovered_${suffix}`;

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      // Same fixture + assertions as the SQLite test: proves backend parity for
      // the bounded reason-scoped count-by-status aggregate.
      await seedRecoveredCountFixture(store, connectorId);
      await assertRecoveredCountAggregate(store, connectorId);
    } finally {
      try {
        await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [connectorId]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
  test("Postgres recovery leases preserve prior evidence and reject stale release after re-serve", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `gmail_pg_lease_${suffix}`;
    const connectorInstanceId = `cin_gmail_pg_lease_${suffix}`;
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      const store = createPostgresConnectorDetailGapStore();
      const gap = await store.upsertPendingGap({
        connectorId,
        connectorInstanceId,
        detailLocator: { kind: "gmail.attachment_detail", message_id: "message_pg_lease", part_index: "1" },
        grantId: "grant_pg_lease",
        reason: "temporary_unavailable",
        recordKey: "attachment_pg_lease",
        stream: "attachments",
      });
      assert.ok(gap, "gap is present");
      await store.markGapStatus(gap.gap_id, "in_progress", { now: "2026-07-02T00:00:00.000Z", runId: "prior" });
      await forcePendingForTest(store, [gap.gap_id]);
      await store.claimPendingGaps([gap.gap_id], {
        leaseExpiresAt: "2020-01-01T00:00:00.000Z",
        leaseId: "lease_a",
        runId: "run_a",
      });
      await store.reclaimStrandedInProgressGaps({ connectorId, connectorInstanceId, grantId: "grant_pg_lease" });
      await store.claimPendingGaps([gap.gap_id], {
        leaseExpiresAt: "2030-01-01T00:00:00.000Z",
        leaseId: "lease_b",
        runId: "run_b",
      });
      assert.deepEqual(await store.releaseLeasedGaps([{ gapId: gap.gap_id, leaseId: "lease_a", runId: "run_a" }]), {
        attemptedUnsettled: 0,
        lost: 1,
        released: 0,
      });
      const stillOwned = await store.getGapById(gap.gap_id);
      assert.ok(stillOwned, "stillOwned is present");
      assert.equal(stillOwned.lease_id, "lease_b");
      await store.releaseLeasedGaps([{ gapId: gap.gap_id, leaseId: "lease_b", runId: "run_b" }]);
      const after = await store.getGapById(gap.gap_id);
      assert.ok(after, "after is present");
      assert.equal(after.attempt_count, 1);
      assert.equal(after.last_attempt_at, "2026-07-02T00:00:00.000Z");
    } finally {
      try {
        await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
  test("Postgres bootstrap upgrades a legacy lease-less in_progress gap without erasing real attempt evidence", async () => {
    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery("DROP TABLE connector_detail_gaps");
      await postgresQuery(`
        CREATE TABLE connector_detail_gaps (
          gap_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          connector_instance_id TEXT NOT NULL,
          grant_id TEXT,
          source_json JSONB NOT NULL,
          stream TEXT NOT NULL,
          parent_stream TEXT,
          record_key TEXT,
          detail_locator_json JSONB,
          list_cursor_json JSONB,
          scope_json JSONB,
          reason TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TEXT,
          next_attempt_after TEXT,
          last_error_json JSONB,
          discovered_run_id TEXT,
          last_run_id TEXT,
          recovered_run_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      await postgresQuery(
        `
        INSERT INTO connector_detail_gaps(
          gap_id, connector_id, connector_instance_id, grant_id, source_json, stream,
          status, attempt_count, last_attempt_at, created_at, updated_at
        ) VALUES ($1, 'gmail', 'cin_gmail_legacy_pg', 'grant_legacy_pg', '{}'::jsonb, 'attachments',
          'in_progress', 7, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `,
        ["gap_legacy_lease_less_pg"]
      );
      await closePostgresStorage();

      await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });
      const result = await postgresQuery(
        `
        SELECT status, attempt_count, last_attempt_at, lease_run_id, lease_id, lease_attempted, lease_expires_at
        FROM connector_detail_gaps WHERE gap_id = $1
      `,
        ["gap_legacy_lease_less_pg"]
      );
      assert.deepEqual(result.rows[0], {
        attempt_count: 7,
        last_attempt_at: "2026-07-01T00:00:00.000Z",
        lease_attempted: 0,
        lease_expires_at: null,
        lease_id: null,
        lease_run_id: null,
        status: "pending",
      });
    } finally {
      await closePostgresStorage();
      closeDb();
    }
  });
  test("Postgres locator drift re-upserts the same identity and recovery closes the old-shape pending", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `amazon_pg_drift_${suffix}`;
    const connectorInstanceId = `cin_amazon_pg_${suffix}`;
    const grantId = `grant_pg_drift_${suffix}`;

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      // Backend parity for the locator-drift fix: old-shape locator (no
      // order_date) then a new-shape re-discovery must resolve to the SAME
      // identity, and recovery must close the old-shape pending row.
      const oldShape = await store.upsertPendingGap({
        connectorId,
        connectorInstanceId,
        detailLocator: { kind: "amazon.order_detail", order_id: "order-A" },
        grantId,
        parentStream: "orders",
        reason: "temporary_unavailable",
        recordKey: "order-A",
        stream: "order_items",
      });
      assert.ok(oldShape, "oldShape is present");
      const newShape = await store.upsertPendingGap({
        connectorId,
        connectorInstanceId,
        detailLocator: { kind: "amazon.order_detail", order_date: "2024-11-18", order_id: "order-A" },
        grantId,
        parentStream: "orders",
        reason: "temporary_unavailable",
        recordKey: "order-A",
        stream: "order_items",
      });
      assert.ok(newShape, "newShape is present");
      assert.equal(newShape.gap_id, oldShape.gap_id, "locator drift re-upserts the same identity on Postgres");
      assert.equal(
        asJsonRecord(newShape.detail_locator, "newShape.detail_locator is a record").order_date,
        "2024-11-18",
        "Postgres stores the newer locator shape on identity conflict"
      );

      const pendingBefore = await store.listPendingGaps({
        connectorId,
        connectorInstanceId,
        grantId,
        streams: ["order_items"],
      });
      assert.deepEqual(
        pendingBefore.map((g) => g.gap_id),
        [oldShape.gap_id],
        "exactly one pending row survives the drift"
      );

      await store.markGapStatus(newShape.gap_id, "recovered", { runId: "run_recover" });
      const pendingAfter = await store.listPendingGaps({
        connectorId,
        connectorInstanceId,
        grantId,
        streams: ["order_items"],
      });
      assert.equal(pendingAfter.length, 0, "recovery closes the old-shape pending — no immortal orphan on Postgres");

      // Locator fallback preserved: distinct locators with no record_key stay distinct.
      const locA = await store.upsertPendingGap({
        connectorId,
        connectorInstanceId,
        detailLocator: { page: 1 },
        grantId,
        recordKey: null,
        stream: "nokey",
      });
      assert.ok(locA, "locA is present");
      const locB = await store.upsertPendingGap({
        connectorId,
        connectorInstanceId,
        detailLocator: { page: 2 },
        grantId,
        recordKey: null,
        stream: "nokey",
      });
      assert.ok(locB, "locB is present");
      assert.notEqual(locA.gap_id, locB.gap_id, "without a record_key the locator still disambiguates on Postgres");
    } finally {
      try {
        await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
  test("connector-emitted DETAIL_GAP survives Postgres persistence and reappears in START.detail_gaps", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `chatgpt_pg_gap_${suffix}`;
    const connectorInstanceId = `cin_chatgpt_pg_gap_${suffix}`;
    const grantId = `grant_pg_gap_${suffix}`;
    const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gaps-pg-"));

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      await assertConnectorEmittedDetailGapRoundTrip({
        connectorId,
        connectorInstanceId,
        dir,
        grantId,
        store,
      });
    } finally {
      try {
        await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_instance_id = $1", [
          connectorInstanceId,
        ]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
      rmSync(dir, { force: true, recursive: true });
    }
  });
  test("fair-progress: a multi-page backlog eventually serves every eligible row across successive runs (Postgres)", async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `gmail_pg_fairness_${suffix}`;
    const grantId = `grant_pg_fairness_${suffix}`;
    const stream = "attachments";
    const baseIso = "2026-07-01T00:00:00.000Z";

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();
      const headCount = 20;
      const tailCount = 60;
      const pageSize = 20;
      const { head, tail } = await seedStarvationBacklog(store, {
        baseIso,
        connectorId,
        grantId,
        headCount,
        stream,
        tailCount,
      });

      const seenGapIds = new Set();
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      for (let run = 0; run < 40; run++) {
        const runIso = isoAfter(baseIso, run + 2);
        // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
        const served = await simulateOneStarvedRun(store, {
          connectorId,
          grantId,
          pageSize,
          runId: `run_${run}`,
          runIso,
          stream,
        });
        for (const gap of served) {
          seenGapIds.add(gap.gap_id);
        }
      }

      const allIds = [...head, ...tail].map((gap) => gap.gap_id);
      const neverServed = allIds.filter((id) => !seenGapIds.has(id));
      assert.deepEqual(
        neverServed,
        [],
        `Postgres: every eligible row must eventually be served across successive runs; starved: ${neverServed.length}/${allIds.length}`
      );
    } finally {
      try {
        await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [connectorId]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });

  test("fair-progress: a row past the quarantine threshold is not starved forever behind a large backlog (Postgres)", async () => {
    // Backend-parity twin of the SQLite attempt-count rank clamp test above:
    // the store's `pendingGapOrderBySql` has separate SQLite (`MIN`) and
    // Postgres (`LEAST`) branches for the same clamp, and only this branch
    // runs against the live backend.
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `gmail_pg_clamp_${suffix}`;
    const grantId = `grant_pg_clamp_${suffix}`;
    const stream = "attachments";
    const baseIso = "2026-07-01T00:00:00.000Z";
    const threshold = DEFAULT_QUARANTINE_POLICY.maxNoProgressAttempts;

    initDb(":memory:");
    await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL });

    try {
      const store = createPostgresConnectorDetailGapStore();

      let poison = await store.upsertPendingGap({
        connectorId,
        detailLocator: { id: "poison" },
        grantId,
        now: baseIso,
        reason: "temporary_unavailable",
        recordKey: "poison",
        stream,
      });
      assert.ok(poison, "poison is present");
      // biome-ignore lint/style/noIncrementDecrement: the loop counter is local, unambiguous test setup state.
      for (let i = 0; i < threshold + 20; i++) {
        // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
        await store.markGapStatus(poison.gap_id, "in_progress", { now: baseIso, runId: `seed_${i}` });
        poison = await store.upsertPendingGap({
          connectorId,
          detailLocator: { id: "poison" },
          grantId,
          lastRunId: `seed_${i}`,
          now: baseIso,
          reason: "temporary_unavailable",
          recordKey: "poison",
          stream,
        });
        assert.ok(poison, "poison is present");
      }
      assert.ok(
        poison.attempt_count > threshold,
        "Postgres: poison row attempt_count must exceed the quarantine threshold going into the assertion"
      );
      const maxAgeBuckets = 8;
      const selectionIso = isoAfter(baseIso, maxAgeBuckets + 1);

      const fresh = await store.upsertPendingGap({
        connectorId,
        detailLocator: { id: "fresh" },
        grantId,
        now: selectionIso,
        reason: "temporary_unavailable",
        recordKey: "fresh",
        stream,
      });
      assert.ok(fresh, "fresh is present");

      const page = await store.listPendingGaps({
        connectorId,
        grantId,
        limit: 1,
        now: selectionIso,
        streams: [stream],
      });

      assert.deepEqual(
        page.map((gap) => gap.gap_id),
        [poison.gap_id],
        "Postgres: a row past the quarantine threshold, once fully aged, must rank at or ahead of a genuinely fresh arrival " +
          `(fresh gap ${fresh.gap_id} must not permanently outrank it)`
      );
    } finally {
      try {
        await postgresQuery("DELETE FROM connector_detail_gaps WHERE connector_id = $1", [connectorId]);
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
} else {
  test("connector-emitted DETAIL_GAP survives Postgres persistence and reappears in START.detail_gaps (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
  test("countGapsByStatusForConnector returns an exact reason-scoped recovered count (Postgres) (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
  test("Postgres locator drift re-upserts the same identity and recovery closes the old-shape pending (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
  test("fair-progress: a multi-page backlog eventually serves every eligible row across successive runs (Postgres) (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
  test("fair-progress: a row past the quarantine threshold is not starved forever behind a large backlog (Postgres) (skipped: PDPP_TEST_POSTGRES_URL unset)", {
    skip: true,
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
  }, () => {});
}

test(
  "runtime fails closed when pending detail gap loading fails before START",
  withTempDb(async () => {
    const detailGapStore = {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async listPendingGaps() {
        throw new Error("pending gap load failed");
      },
    };
    const { connectorPath, cleanup } = createConnector([{ records_emitted: 0, status: "succeeded", type: "DONE" }]);

    try {
      await assert.rejects(
        () =>
          runConnectorWithGapStore({
            admitRunConnection: fakeAdmitRunConnection(),
            connectorId: "chatgpt",
            connectorPath,
            detailGapStore,
            manifest: { streams: [{ name: "messages" }] },
            // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
            onProgress: () => {},
            ownerToken: "owner",
            persistState: false,
          }),
        // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
        /pending gap load failed/
      );
    } finally {
      cleanup();
    }
  })
);

interface MockMarkGapStatusCall {
  gapId: string;
  options: { runId?: string | null | undefined; now?: string | undefined; reason?: string | null | undefined };
  status: string;
}

test(
  "runtime marks DETAIL_GAP_RECOVERED only after prior records flush successfully",
  withTempDb(async () => {
    await withStateServer(async ({ rsUrl }) => {
      const statusCalls: MockMarkGapStatusCall[] = [];
      const detailGapStore = {
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async listPendingGaps(): Promise<MockGap[]> {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async markGapStatus(
          gapId: string,
          status: string,
          options: MockMarkGapStatusCall["options"]
        ): Promise<MockGap> {
          statusCalls.push({ gapId, options, status });
          return {
            gap_id: gapId,
            reason: "rate_limited",
            record_key: "conv_1",
            status,
            stream: "messages",
          };
        },
      };
      const { connectorPath, cleanup } = createConnector([
        {
          data: { conversation_id: "conv_1", id: "msg_1" },
          emitted_at: new Date().toISOString(),
          key: "msg_1",
          stream: "messages",
          type: "RECORD",
        },
        {
          gap_id: "gap_conv_1",
          record_key: "conv_1",
          reference_only: true,
          stream: "messages",
          type: "DETAIL_GAP_RECOVERED",
        },
        { records_emitted: 1, status: "succeeded", type: "DONE" },
      ]);

      try {
        const result = await runConnectorWithGapStore({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorId: "chatgpt",
          connectorPath,
          detailGapStore,
          manifest: { streams: [{ name: "messages" }] },
          // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
          onProgress: () => {},
          ownerToken: "owner",
          persistState: false,
          rsUrl,
        });
        assert.equal(result.status, "succeeded");
        assert.equal(result.records_emitted, 1);
        assert.equal(statusCalls.length, 1);
        const [firstStatusCall] = statusCalls;
        assert.ok(firstStatusCall, "firstStatusCall is present");
        assert.equal(firstStatusCall.gapId, "gap_conv_1");
        assert.equal(firstStatusCall.status, "recovered");
        assert.equal(firstStatusCall.options.runId, result.run_id);
      } finally {
        cleanup();
      }
    });
  })
);

test(
  "runtime fails closed when DETAIL_GAP persistence fails",
  withTempDb(async () => {
    const detailGapStore = {
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async listPendingGaps() {
        return [];
      },
      // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
      async upsertPendingGap() {
        throw new Error("durable gap write failed");
      },
    };
    const { connectorPath, cleanup } = createConnector([
      {
        detail_locator: { conversation_id: "conv_1" },
        stream: "conversations",
        type: "DETAIL_GAP",
      },
      { cursor: { after: "cursor_30" }, stream: "conversations", type: "STATE" },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]);

    try {
      await assert.rejects(
        () =>
          runConnectorWithGapStore({
            admitRunConnection: fakeAdmitRunConnection(),
            connectorId: "chatgpt",
            connectorPath,
            detailGapStore,
            manifest: { streams: [{ name: "conversations" }] },
            // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
            onProgress: () => {},
            ownerToken: "owner",
            state: {},
          }),
        // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
        /durable gap write failed/
      );
    } finally {
      cleanup();
    }
  })
);

// Contract revised 2026-08-08: an unproven DETAIL_COVERAGE key still WITHHOLDS
// the state commit (a claim of completeness must carry proof), but it no longer
// KILLS the run. A coverage shortfall is a reported gap, not a protocol
// violation — the connector's envelope was well-formed and it simply covered
// fewer detail items than expected, so a run whose records are already ingested
// must keep them. The cursor-withholding half below is unchanged and is the
// invariant this test has always really been protecting.
test(
  "runtime withholds state commit and reports a gap when required DETAIL_COVERAGE has no hydrated detail or durable gap",
  withTempDb(async () => {
    await withStateServer(async ({ rsUrl, stateWrites }) => {
      const { connectorPath, cleanup } = createConnector([
        {
          hydrated_keys: [],
          reference_only: true,
          required_keys: ["conv_1"],
          state_stream: "conversation_list",
          stream: "conversations",
          type: "DETAIL_COVERAGE",
        },
        { cursor: { after: "cursor_30" }, stream: "conversation_list", type: "STATE" },
        { records_emitted: 0, status: "succeeded", type: "DONE" },
      ]);

      try {
        const result = await runConnectorWithGapStore({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorId: "chatgpt",
          connectorPath,
          manifest: { streams: [{ name: "conversation_list" }, { name: "conversations" }] },
          // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
          onProgress: () => {},
          ownerToken: "owner",
          rsUrl,
          state: {},
        });

        assert.equal(result.status, "succeeded", "a coverage shortfall is not a run-killing protocol violation");
        // The unproven state_stream's cursor is still not advanced.
        assert.equal(stateWrites.length, 0);
        // ...and the shortfall is reported honestly rather than swallowed.
        const gaps = (result.known_gaps ?? []) as Record<string, unknown>[];
        const coverageGap = gaps.find((gap) => gap.reason === "detail_coverage_incomplete");
        assert.ok(coverageGap, "the shortfall is surfaced as a known gap");
        assert.match(
          String(coverageGap.message ?? ""),
          // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
          /Connector detail coverage incomplete: state_stream=conversation_list stream=conversations missing_required_keys=1/
        );
      } finally {
        cleanup();
      }
    });
  })
);

test(
  "runtime commits state when required DETAIL_COVERAGE is backed by matching pending DETAIL_GAP",
  withTempDb(async () => {
    await withStateServer(async ({ rsUrl, stateWrites }) => {
      const detailGapStore = {
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async listPendingGaps(): Promise<MockGap[]> {
          return [];
        },
        // biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
        async upsertPendingGap(input: MockUpsertGapInput): Promise<MockGap> {
          return {
            detail_locator: input.detailLocator,
            gap_id: "gap_conv_1",
            last_error: input.lastError,
            list_cursor: input.listCursor,
            parent_stream: input.parentStream,
            reason: input.reason,
            record_key: input.recordKey,
            status: "pending",
            stream: input.stream,
          };
        },
      };
      const { connectorPath, cleanup } = createConnector([
        {
          detail_locator: { conversation_id: "conv_1" },
          list_cursor: { after: "cursor_30" },
          parent_stream: "conversation_list",
          reason: "upstream_pressure",
          record_key: "conv_1",
          retryable: true,
          stream: "conversations",
          type: "DETAIL_GAP",
        },
        {
          gap_keys: ["conv_1"],
          hydrated_keys: [],
          reference_only: true,
          required_keys: ["conv_1"],
          state_stream: "conversation_list",
          stream: "conversations",
          type: "DETAIL_COVERAGE",
        },
        { cursor: { after: "cursor_30" }, stream: "conversation_list", type: "STATE" },
        { records_emitted: 0, status: "succeeded", type: "DONE" },
      ]);

      try {
        const result = await runConnectorWithGapStore({
          admitRunConnection: fakeAdmitRunConnection(),
          connectorId: "chatgpt",
          connectorPath,
          detailGapStore,
          manifest: { streams: [{ name: "conversation_list" }, { name: "conversations" }] },
          // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
          onProgress: () => {},
          ownerToken: "owner",
          rsUrl,
          state: {},
        });

        assert.equal(result.status, "succeeded");
        assert.deepEqual(stateWrites, [{ state: { conversation_list: { after: "cursor_30" } } }]);
        assert.deepEqual(result.state, { conversation_list: { after: "cursor_30" } });
      } finally {
        cleanup();
      }
    });
  })
);

interface NoCommitScenario {
  exitCode: number;
  // `null` (not `false`) for the non-rejecting scenarios: falsy for the
  // `if (scenario.expectReject)` branch below exactly like a `false` literal
  // would be, but a valid `RegExp | null` union member — `assert.rejects`
  // does not accept a bare boolean AssertPredicate, only `null`/undefined-as-
  // absent, a RegExp, an Error, or a predicate function.
  expectReject: RegExp | null;
  messages: Record<string, unknown>[];
  name: string;
}

test(
  "runtime preserves no-commit behavior for failed, cancelled, and protocol-violating runs",
  withTempDb(async () => {
    const cases: NoCommitScenario[] = [
      {
        exitCode: 1,
        expectReject: null,
        messages: [
          { cursor: { after: "cursor_30" }, stream: "conversation_list", type: "STATE" },
          {
            error: { message: "upstream failure", retryable: true },
            records_emitted: 0,
            status: "failed",
            type: "DONE",
          },
        ],
        name: "failed",
      },
      {
        exitCode: 1,
        expectReject: null,
        messages: [
          { cursor: { after: "cursor_30" }, stream: "conversation_list", type: "STATE" },
          {
            error: { message: "operator cancelled", retryable: false },
            records_emitted: 0,
            status: "cancelled",
            type: "DONE",
          },
        ],
        name: "cancelled",
      },
      {
        exitCode: 0,
        // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
        expectReject: /Connector reported records_emitted 1 but runtime observed 0/,
        messages: [
          { cursor: { after: "cursor_30" }, stream: "conversation_list", type: "STATE" },
          { records_emitted: 1, status: "succeeded", type: "DONE" },
        ],
        name: "protocol-violating",
      },
    ];

    for (const scenario of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: ordered setup is intentionally sequential because each iteration advances shared test state.
      await withStateServer(async ({ rsUrl, stateWrites }) => {
        const { connectorPath, cleanup } = createConnector(scenario.messages, { exitCode: scenario.exitCode });
        try {
          const run = () =>
            runConnectorWithGapStore({
              admitRunConnection: fakeAdmitRunConnection(),
              connectorId: "chatgpt",
              connectorPath,
              manifest: { streams: [{ name: "conversation_list" }] },
              // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
              onProgress: () => {},
              ownerToken: "owner",
              rsUrl,
              state: {},
            });

          if (scenario.expectReject) {
            await assert.rejects(run, scenario.expectReject);
          } else {
            const result = await run();
            assert.equal(result.status, scenario.name);
          }

          assert.equal(stateWrites.length, 0, `${scenario.name} run must not persist staged STATE`);
        } finally {
          cleanup();
        }
      });
    }
  })
);

// Chase-shaped end-to-end: a successful retry that emits DETAIL_GAP_RECOVERED for
// the served account gap (the exact message packages/polyfill-connectors chase
// now emits) clears the matching pending transactions gap and leaves an
// unmatched pending gap untouched. Proves the durable half of the Chase fix
// against a real store + real runtime, without driving Playwright.
test(
  "chase 0-transaction retry recovers the matching served account gap and leaves an unmatched gap pending",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    // The account the retry reaches (matches the served gap it recovers).
    const matched = await store.upsertPendingGap({
      connectorId: "chase",
      detailLocator: { account_id: "1212486749", kind: "chase.account" },
      grantId: "grant_chase",
      parentStream: "accounts",
      reason: "temporary_unavailable",
      recordKey: "1212486749",
      stream: "transactions",
    });
    assert.ok(matched, "matched is present");
    // A second pending gap for a different account the run never reaches. It must
    // stay pending — recovery must not clear unrelated gaps.
    const unmatched = await store.upsertPendingGap({
      connectorId: "chase",
      detailLocator: { account_id: "9999999999", kind: "chase.account" },
      grantId: "grant_chase",
      parentStream: "accounts",
      reason: "temporary_unavailable",
      recordKey: "9999999999",
      stream: "transactions",
    });
    assert.ok(unmatched, "unmatched is present");

    // The chase connector, on a 0-transaction successful parse of the reached
    // account, emits exactly this DETAIL_GAP_RECOVERED for the served gap_id.
    const { connectorPath, cleanup } = createConnector([
      {
        gap_id: matched.gap_id,
        record_key: "1212486749",
        reference_only: true,
        stream: "transactions",
        type: "DETAIL_GAP_RECOVERED",
      },
      { records_emitted: 0, status: "succeeded", type: "DONE" },
    ]);

    try {
      const result = await runConnectorWithGapStore({
        admitRunConnection: fakeAdmitRunConnection(),
        connectorId: "chase",
        connectorPath,
        detailGapStore: store,
        grantId: "grant_chase",
        manifest: { streams: [{ name: "accounts" }, { name: "transactions" }] },
        // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op test double represents an optional side effect.
        onProgress: () => {},
        ownerToken: "owner",
        persistState: false,
      });
      assert.equal(result.status, "succeeded");
    } finally {
      cleanup();
    }

    const matchedRow = await store.getGapById(matched.gap_id);
    assert.ok(matchedRow, "matchedRow is present");
    assert.equal(matchedRow.status, "recovered", "the reached account gap moves to recovered");
    assert.ok(matchedRow.recovered_run_id, "recovered_run_id is set on the recovered gap");

    const unmatchedRow = await store.getGapById(unmatched.gap_id);
    assert.ok(unmatchedRow, "unmatchedRow is present");
    assert.equal(unmatchedRow.status, "pending", "the unreached account gap stays pending — no collateral recovery");
    assert.equal(unmatchedRow.recovered_run_id, null, "the unmatched gap never gets a recovered_run_id");

    const pending = await store.listPendingGaps({
      connectorId: "chase",
      grantId: "grant_chase",
      streams: ["transactions"],
    });
    assert.deepEqual(
      // biome-ignore lint/suspicious/useArraySortCompare: the test relies on the platform default lexical sort behavior.
      pending.map((g) => g.record_key).sort(),
      ["9999999999"],
      "only the unmatched account remains pending after the retry"
    );
  })
);

// ─── Locator-schema-drift identity tests ─────────────────────────────────────
//
// The durable gap identity is `(instance, grant, stream, parent, record_key)`
// with the VOLATILE `detail_locator_json` deliberately excluded when a
// record_key is present. This closes the "immortal orphan" class observed live
// on Amazon: a connector changed its detail_locator shape (added `order_date`),
// which — when the locator was part of identity — minted a NEW gap_id for the
// SAME record, orphaning the old-shape pending row so it could never be closed
// when the record was later recovered under the new shape.

test(
  "locator-schema drift re-upserts the SAME gap identity (no orphan) when record_key is stable",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    // Old-shape locator: no `order_date` (the exact live Amazon orphan shape).
    const oldShape = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon",
      detailLocator: { kind: "amazon.order_detail", order_id: "113-0037140-4304201" },
      grantId: "grant_1",
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: "113-0037140-4304201",
      stream: "order_items",
    });
    assert.ok(oldShape, "oldShape is present");

    // New-shape locator for the SAME record: the connector now also emits
    // `order_date`. Under locator-in-identity this minted a second row; now it
    // must resolve to the SAME identity and update the existing row in place.
    const newShape = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon",
      detailLocator: { kind: "amazon.order_detail", order_date: "2024-11-18", order_id: "113-0037140-4304201" },
      grantId: "grant_1",
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: "113-0037140-4304201",
      stream: "order_items",
    });
    assert.ok(newShape, "newShape is present");

    assert.equal(
      newShape.gap_id,
      oldShape.gap_id,
      "a locator-shape change re-upserts the same identity, not a new orphan"
    );
    assert.equal(
      asJsonRecord(newShape.detail_locator, "newShape.detail_locator is a record").order_date,
      "2024-11-18",
      "the durable row stores the newer locator shape"
    );

    // Exactly one durable row exists for the record — the orphan can never form.
    const pending = await store.listPendingGaps({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon",
      grantId: "grant_1",
      streams: ["order_items"],
    });
    assert.deepEqual(
      pending.map((g) => g.gap_id),
      [oldShape.gap_id],
      "exactly one pending row survives the locator drift"
    );
  })
);

test(
  "recovery under a new-shape locator closes the pre-existing old-shape pending gap",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    // A pending gap discovered under the OLD locator shape.
    const pendingOld = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon",
      detailLocator: { kind: "amazon.order_detail", order_id: "order-A" },
      grantId: "grant_1",
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: "order-A",
      stream: "order_items",
    });
    assert.ok(pendingOld, "pendingOld is present");

    // The next run rediscovers the record under a NEW locator shape and recovers
    // it. Because identity ignores the locator, the recovered gap_id is the SAME
    // row — recovery closes the very pending row that was previously immortal.
    const rediscovered = await store.upsertPendingGap({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon",
      detailLocator: { kind: "amazon.order_detail", order_date: "2024-11-18", order_id: "order-A" },
      grantId: "grant_1",
      parentStream: "orders",
      reason: "temporary_unavailable",
      recordKey: "order-A",
      stream: "order_items",
    });
    assert.ok(rediscovered, "rediscovered is present");
    assert.equal(rediscovered.gap_id, pendingOld.gap_id);

    const recovered = await store.markGapStatus(rediscovered.gap_id, "recovered", { runId: "run_recover" });
    assert.ok(recovered, "recovered is present");
    assert.equal(recovered.status, "recovered");

    const stillPending = await store.listPendingGaps({
      connectorId: "amazon",
      connectorInstanceId: "cin_amazon",
      grantId: "grant_1",
      streams: ["order_items"],
    });
    assert.equal(stillPending.length, 0, "no immortal old-shape orphan remains after recovery");
  })
);

test(
  'a record_key literally starting with "loc:" never collides with a locator-only gap',
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();

    // A real record whose key literally begins with the locator-fallback prefix.
    const keyed = await store.upsertPendingGap({
      connectorId: "x",
      connectorInstanceId: "cin_x",
      detailLocator: { any: "thing" },
      grantId: "grant_1",
      recordKey: "loc:hello",
      stream: "s",
    });
    assert.ok(keyed, "keyed is present");

    // A DIFFERENT gap with NO record_key whose locator text could hash toward the
    // same string if branches were not namespaced. These MUST remain distinct.
    const locatorOnly = await store.upsertPendingGap({
      connectorId: "x",
      connectorInstanceId: "cin_x",
      detailLocator: "hello",
      grantId: "grant_1",
      recordKey: null,
      stream: "s",
    });
    assert.ok(locatorOnly, "locatorOnly is present");

    assert.notEqual(
      keyed.gap_id,
      locatorOnly.gap_id,
      "key: and loc: namespaces are disjoint — no cross-branch collision"
    );
    const pending = await store.listPendingGaps({
      connectorId: "x",
      connectorInstanceId: "cin_x",
      grantId: "grant_1",
      streams: ["s"],
    });
    assert.equal(pending.length, 2, "both distinct gaps persist");
  })
);

test(
  "with no record_key, distinct locators still form distinct identities (locator fallback preserved)",
  withTempDb(async () => {
    const store = createSqliteConnectorDetailGapStore();
    const first = await store.upsertPendingGap({
      connectorId: "x",
      connectorInstanceId: "cin_x",
      detailLocator: { page: 1 },
      grantId: "grant_1",
      recordKey: null,
      stream: "s",
    });
    assert.ok(first, "first is present");
    const second = await store.upsertPendingGap({
      connectorId: "x",
      connectorInstanceId: "cin_x",
      detailLocator: { page: 2 },
      grantId: "grant_1",
      recordKey: null,
      stream: "s",
    });
    assert.ok(second, "second is present");
    assert.notEqual(first.gap_id, second.gap_id, "without a record_key the locator still disambiguates");
    const pending = await store.listPendingGaps({
      connectorId: "x",
      connectorInstanceId: "cin_x",
      grantId: "grant_1",
      streams: ["s"],
    });
    assert.equal(pending.length, 2);
  })
);

// Migration reconciliation: a DB carrying pre-existing duplicate rows (the live
// state — same record, two locator shapes) is collapsed to one row on init,
// keeping the most-resolved sibling and deleting the orphan pending row. This
// also proves the new UNIQUE identity index can be built over previously-dup'd
// data without a constraint violation.
// biome-ignore lint/suspicious/useAwait: async test doubles retain the Promise-returning dependency contract and its microtask timing.
test("migration collapses pre-existing locator-drift duplicate rows, keeping the resolved sibling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-detail-gaps-migrate-"));
  const dbPath = join(dir, "pdpp.sqlite");
  try {
    initDb(dbPath);
    // Simulate the live pre-fix state: two rows for ONE record differing only in
    // detail_locator_json — an old-shape pending orphan and a new-shape recovered
    // sibling. Insert them directly with the identity index dropped so the legacy
    // (locator-in-identity) duplicate can exist, exactly as it does in prod.
    const raw = getDb();
    raw.exec("DROP INDEX IF EXISTS uniq_connector_detail_gaps_identity");
    const insert = raw.prepare(`
      INSERT INTO connector_detail_gaps(
        gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key,
        detail_locator_json, reason, status, attempt_count, created_at, updated_at
      ) VALUES (?, 'amazon', 'cin_amazon', 'grant_1', '{}', 'order_items', 'orders', 'order-A', ?, 'temporary_unavailable', ?, ?, ?, ?)
    `);
    // Old-shape pending orphan (high attempt count, older) …
    insert.run(
      "gap_old_orphan",
      JSON.stringify({ kind: "amazon.order_detail", order_id: "order-A" }),
      "pending",
      17,
      "2026-06-19T00:00:00.000Z",
      "2026-06-26T00:00:00.000Z"
    );
    // … and the new-shape recovered sibling (the record IS actually covered).
    insert.run(
      "gap_new_recovered",
      JSON.stringify({ kind: "amazon.order_detail", order_date: "2024-11-18", order_id: "order-A" }),
      "recovered",
      3,
      "2026-06-30T00:00:00.000Z",
      "2026-06-30T00:00:00.000Z"
    );
    closeDb();

    // Re-open the SAME file: the detail-gap migration runs, reconciling the
    // duplicates before rebuilding the unique identity index.
    initDb(dbPath);
    const reopened = getDb();
    const rows = reopened
      .prepare("SELECT gap_id, status FROM connector_detail_gaps WHERE record_key = 'order-A' ORDER BY gap_id")
      .all();
    assert.deepEqual(
      rows,
      [{ gap_id: "gap_new_recovered", status: "recovered" }],
      "migration keeps the resolved sibling and deletes the immortal old-shape pending orphan"
    );

    // The rebuilt unique identity index now rejects a re-inserted duplicate.
    assert.throws(
      () =>
        reopened
          .prepare(`
        INSERT INTO connector_detail_gaps(gap_id, connector_id, connector_instance_id, grant_id, source_json, stream, parent_stream, record_key, detail_locator_json, reason, status, attempt_count, created_at, updated_at)
        VALUES ('gap_dupe_attempt', 'amazon', 'cin_amazon', 'grant_1', '{}', 'order_items', 'orders', 'order-A', ?, 'x', 'pending', 0, ?, ?)
      `)
          .run(
            JSON.stringify({ kind: "amazon.order_detail", order_date: "2099-01-01", order_id: "order-A" }),
            "2026-07-07T00:00:00.000Z",
            "2026-07-07T00:00:00.000Z"
          ),
      // biome-ignore lint/performance/useTopLevelRegex: test assertion patterns remain colocated with the assertion they explain.
      /UNIQUE|constraint/i,
      "the rebuilt identity index is locator-independent: a third locator shape for the same record is a duplicate"
    );
  } finally {
    closeDb();
    rmSync(dir, { force: true, recursive: true });
  }
});
