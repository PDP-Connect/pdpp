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
import {
  openStatementHydrationCursor,
  readPriorStatementHydration,
} from "../../src/statement-hydration-carry-forward.ts";
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

// ─── Hydration-availability carry-forward (AC-1..AC-6) ───────────────────
//
// A previously-hydrated immutable statement that later fails to re-download
// must NOT flap its content-addressed pointers value->null and re-version.
// The connector carries the prior pointers forward; a never-hydrated
// statement stays honestly all-null; a terminal removal is not masked.

const FAILED: HydrationResult = { err: "download failed" };

/** Open the fingerprint + hydration cursors together exactly as the
 *  connector does, seeded from the prior statements STATE. */
function openCursors(priorState: Record<string, unknown>): {
  fingerprint: ReturnType<typeof openFingerprintCursor>;
  hydration: ReturnType<typeof openStatementHydrationCursor>;
} {
  return {
    fingerprint: openFingerprintCursor(priorState.statements, {
      excludeFromFingerprint: ["fetched_at"],
      priorFingerprints: readPriorStatementFingerprints(priorState),
    }),
    hydration: openStatementHydrationCursor(
      readPriorStatementHydration((priorState as { statements?: unknown }).statements)
    ),
  };
}

/** Run `emitStatementRecords` for one run, returning the emitted records and
 *  the next-run STATE (in the `{ statements: cursor }` shape). */
async function runEmit(
  indexRows: readonly IndexRow[],
  results: Map<number, HydrationResult>,
  priorState: Record<string, unknown>
): Promise<{ emitted: Array<{ stream: string; data: unknown }>; nextState: Record<string, unknown> }> {
  const harness = makeHarness();
  const { fingerprint, hydration } = openCursors(priorState);
  await emitStatementRecords(harness.deps, indexRows, results, summaryFor(results), fingerprint, hydration);
  return { emitted: harness.emitted, nextState: nextStateFrom(harness.messages) };
}

test("AC-1: previously hydrated + transient failure carries pointers forward (no flap)", async () => {
  const rows = [makeIndexRow({ id: "S1" })];
  const ok = new Map<number, HydrationResult>([
    [0, makeHydrationOk({ pdfPath: "/tmp/usaa/p.pdf", pdfSha256: "a".repeat(64) })],
  ]);

  // Run A hydrates.
  const a = await runEmit(rows, ok, {});
  assert.equal(a.emitted.length, 1, "run A emits the hydrated statement once");

  // Run B fails to re-download the SAME statement.
  const b = await runEmit(rows, new Map([[0, FAILED]]), a.nextState);
  assert.equal(b.emitted.length, 0, "run B emits NO new version — prior pointers carried forward");

  // Prove the carried body is the prior hydrated body (modulo fetched_at):
  // the next-run STATE still holds the real pointers, not null.
  const carried = readPriorStatementHydration(b.nextState.statements);
  assert.equal(carried.get("S1")?.pdf_path, "/tmp/usaa/p.pdf", "carried pdf_path survives the failed run");
  assert.equal(carried.get("S1")?.pdf_sha256, "a".repeat(64));
});

test("AC-2: never-hydrated statement that fails stays all-null (honest), then first hydration versions once", async () => {
  const rows = [makeIndexRow({ id: "S1" })];

  // Run A: never hydrated → index-only all-null.
  const a = await runEmit(rows, new Map([[0, FAILED]]), {});
  assert.equal(a.emitted.length, 1, "index-only row emits");
  const aRec = a.emitted.find((r) => r.stream === "statements")?.data as Record<string, unknown>;
  assert.equal(aRec.pdf_path, null, "never-hydrated stays all-null");
  assert.equal(aRec.document_url, null);
  // No carriable pointers persisted for a never-hydrated statement.
  assert.equal(readPriorStatementHydration(a.nextState.statements).size, 0, "nothing to carry");

  // Run B: first real hydration → null->value is real history, versions once.
  const b = await runEmit(rows, new Map([[0, makeHydrationOk()]]), a.nextState);
  assert.equal(b.emitted.length, 1, "first hydration is a real change and versions exactly once");
});

test("AC-3: a genuine identity/title change still re-versions (carry-forward never masks it)", async () => {
  const ok = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);

  const a = await runEmit([makeIndexRow({ id: "S1", title: "April 2026 STATEMENT" })], ok, {});
  assert.equal(a.emitted.length, 1);

  // Same id, retitled body, hydration still succeeds → a real change.
  const b = await runEmit([makeIndexRow({ id: "S1", title: "April 2026 STATEMENT (amended)" })], ok, a.nextState);
  assert.equal(b.emitted.length, 1, "a retitled statement is real history and re-versions");
});

test("AC-4: flap-back is idempotent — hydrate, fail, re-hydrate identical → one version total", async () => {
  const rows = [makeIndexRow({ id: "S1" })];
  const ok = new Map<number, HydrationResult>([
    [0, makeHydrationOk({ pdfPath: "/tmp/usaa/p.pdf", pdfSha256: "c".repeat(64) })],
  ]);

  const a = await runEmit(rows, ok, {}); // hydrate
  assert.equal(a.emitted.length, 1, "run A versions once");

  const b = await runEmit(rows, new Map([[0, FAILED]]), a.nextState); // fail → carry forward
  assert.equal(b.emitted.length, 0, "run B carries forward, no new version");

  const c = await runEmit(rows, ok, b.nextState); // re-hydrate IDENTICAL pdf
  assert.equal(c.emitted.length, 0, "run C re-hydrates the identical PDF — still no new version");
});

test("AC-6: a terminal removal is NOT hidden as a carried-forward success", async () => {
  // Run A hydrates two statements.
  const rowsA = [makeIndexRow({ id: "S1" }), makeIndexRow({ id: "S2", rowIndex: 1, title: "May 2026 STATEMENT" })];
  const okBoth = new Map<number, HydrationResult>([
    [0, makeHydrationOk()],
    [1, makeHydrationOk()],
  ]);
  const a = await runEmit(rowsA, okBoth, {});
  assert.equal(a.emitted.length, 2);

  // Run B: S2 has fallen off the documents index entirely (terminal removal,
  // not a transient download failure of a still-listed statement). The full
  // scan only returns S1. Carry-forward must NOT resurrect S2.
  const rowsB = [makeIndexRow({ id: "S1" })];
  const b = await runEmit(rowsB, new Map([[0, makeHydrationOk()]]), a.nextState);
  const carriedAfterB = readPriorStatementHydration(b.nextState.statements);
  assert.equal(carriedAfterB.has("S2"), false, "a delisted statement is pruned, never carried forward as a phantom");
  assert.equal(carriedAfterB.has("S1"), true, "the still-listed statement is retained");
});
