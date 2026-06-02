/**
 * Per-statement fingerprint behavior for the USAA `statements` stream.
 *
 * Before this gate, `emitStatementRecords` appended a fresh version of
 * every statement on every run because the record body carried a
 * run-clock `fetched_at: nowIso()`. A statement's identity (id,
 * account_id, title, date_delivered) is immutable and its hydrated
 * fields (pdf_path/pdf_sha256/document_url) are content-addressed, so
 * the only field that moved between runs was `fetched_at` — ~15
 * versions/record of pure run-clock churn.
 *
 * These tests pin:
 *
 *   1. Re-emitting the same statements with only a new `fetched_at` is
 *      fully suppressed on the second run.
 *   2. A statement that newly hydrates (pdf_path/sha appear) re-emits.
 *   3. The fingerprint cursor's STATE round-trips and excludes
 *      `fetched_at` so it survives the next run.
 *   4. `readPriorStatementFingerprints` tolerates missing/legacy/
 *      malformed state.
 *   5. Connector fingerprint (excludes `fetched_at`) == compaction
 *      fingerprint over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitStatementRecords, type HydrationSummary, readPriorStatementFingerprints } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { HydrationResult, HydrationResultSuccess, IndexRow } from "./types.ts";

function makeHarness(): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = { emit: harness.emit, emitRecord: harness.emitRecord };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeIndexRow(overrides: Partial<IndexRow> = {}): IndexRow {
  return {
    account_id: "ACCT-CHK-0001",
    account_reference: "USAA CLASSIC CHECKING *9241",
    date_delivered: "2026-04-13",
    id: "IDX-ID-0001",
    rowIndex: 0,
    title: "April 2026 STATEMENT",
    ...overrides,
  };
}

function makeHydrationOk(overrides: Partial<HydrationResultSuccess> = {}): HydrationResultSuccess {
  return {
    buffer: Buffer.from("pdf-bytes"),
    pdfPath: "/tmp/usaa-test/2026-04-deadbeefdeadbeef.pdf",
    pdfSha256: "deadbeef".repeat(8),
    ...overrides,
  };
}

function summaryFor(results: Map<number, HydrationResult>): HydrationSummary {
  let successes = 0;
  for (const v of results.values()) {
    if ("pdfPath" in v) {
      successes += 1;
    }
  }
  return { attempts: results.size, results, successes };
}

/** Pull the persisted `fingerprints` map out of the statements STATE the
 *  helper emitted, in the `{ statements: cursor }` shape the next run reads. */
function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "statements").at(-1);
  return { statements: (state as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };
}

test("statements: re-emitting with only a new fetched_at is fully suppressed", async () => {
  const indexRows = [makeIndexRow({ id: "S1" }), makeIndexRow({ id: "S2", rowIndex: 1, title: "May 2026 STATEMENT" })];
  const hydration = new Map<number, HydrationResult>([
    [0, makeHydrationOk({ pdfPath: "/tmp/usaa/2026-04-aaaa.pdf", pdfSha256: "a".repeat(64) })],
    [1, makeHydrationOk({ pdfPath: "/tmp/usaa/2026-05-bbbb.pdf", pdfSha256: "b".repeat(64) })],
  ]);

  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitStatementRecords(run1.deps, indexRows, hydration, summaryFor(hydration), cursor1);
  assert.equal(run1.emitted.length, 2, "first run emits both statements once");

  // Second run: identical statements, only fetched_at differs (nowIso()
  // advances inside the helper). Nothing should re-emit.
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openFingerprintCursor(priorState.statements, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorStatementFingerprints(priorState),
  });
  await emitStatementRecords(run2.deps, indexRows, hydration, summaryFor(hydration), cursor2);
  assert.equal(run2.emitted.length, 0, "unchanged statements are fully suppressed on the second run");
});

test("statements: a newly-hydrated statement re-emits (index-only → hydrated is a real change)", async () => {
  const indexRows = [makeIndexRow({ id: "S1" })];

  // Run 1: hydration failed → index-only row (pdf fields null).
  const failed = new Map<number, HydrationResult>([[0, { err: "download failed" }]]);
  const run1 = makeHarness();
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitStatementRecords(run1.deps, indexRows, failed, summaryFor(failed), cursor1);
  assert.equal(run1.emitted.length, 1, "index-only row emits");

  // Run 2: same statement now hydrates → pdf_path/sha/document_url populated.
  const ok = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);
  const priorState = nextStateFrom(run1.messages);
  const run2 = makeHarness();
  const cursor2 = openFingerprintCursor(priorState.statements, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorStatementFingerprints(priorState),
  });
  await emitStatementRecords(run2.deps, indexRows, ok, summaryFor(ok), cursor2);
  assert.equal(run2.emitted.length, 1, "hydration appearing is a real change and re-emits");
});

test("statements: STATE carries a fingerprints map that excludes fetched_at", async () => {
  const indexRows = [makeIndexRow({ id: "S1" })];
  const hydration = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);
  const run = makeHarness();
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitStatementRecords(run.deps, indexRows, hydration, summaryFor(hydration), cursor);

  const nextState = nextStateFrom(run.messages);
  const fps = readPriorStatementFingerprints(nextState);
  assert.equal(fps.size, 1, "one fingerprint persisted");
  assert.ok(fps.get("S1"), "keyed by statement id");
});

test("statements: legacy callers without a cursor still emit unconditionally", async () => {
  const indexRows = [makeIndexRow({ id: "S1" })];
  const hydration = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);
  const run = makeHarness();
  // No cursor argument → backward-compatible unconditional emit.
  await emitStatementRecords(run.deps, indexRows, hydration, summaryFor(hydration));
  assert.equal(run.emitted.length, 1, "no cursor → emits");
});

test("readPriorStatementFingerprints: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorStatementFingerprints({}).size, 0, "empty state → empty map");
  assert.equal(
    readPriorStatementFingerprints({ statements: { fetched_at: "x" } }).size,
    0,
    "legacy cursor (no fingerprints) → empty map"
  );
  assert.equal(
    readPriorStatementFingerprints({ statements: { fingerprints: 5 } }).size,
    0,
    "malformed fingerprints value → empty map"
  );
  const ok = readPriorStatementFingerprints({ statements: { fingerprints: { S1: "fp-1", bad: null } } });
  assert.equal(ok.size, 1, "valid entries kept, invalid dropped");
});

test("statements: connector fingerprint (excludes fetched_at) == compaction fingerprint over stored body", () => {
  // Byte-parity contract for the historical compaction policy: the
  // connector excludes fetched_at; the compaction script must use the
  // same exclude set over the stored record_json.
  const body = {
    id: "S1",
    account_id: "ACCT-CHK-0001",
    title: "April 2026 STATEMENT",
    date_delivered: "2026-04-13",
    account_reference: "USAA CLASSIC CHECKING *9241",
    document_url: "file:///tmp/usaa/2026-04-aaaa.pdf",
    pdf_sha256: "a".repeat(64),
    pdf_path: "/tmp/usaa/2026-04-aaaa.pdf",
    fetched_at: "2026-04-22T12:00:00.000Z",
  };
  const later = { ...body, fetched_at: "2026-05-22T12:00:00.000Z" };
  const connectorFp = recordFingerprint(body, ["fetched_at"]);
  const compactionFp = recordFingerprint(later, ["fetched_at"]);
  assert.equal(connectorFp, compactionFp, "fetched_at must not participate; both runs hash identically");
});
