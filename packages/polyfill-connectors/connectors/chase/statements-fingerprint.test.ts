// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-statement fingerprint behavior for the Chase `statements` stream.
 *
 * Before this gate, both statement emit paths (`processStatementRow`'s
 * hydrated emit and `emitStatementIndexOnly`'s index-only emit) appended a
 * fresh version of every statement on every run because the record body
 * carried a run-clock `fetched_at: deps.emittedAt`. A statement's identity
 * (id = shortHash(account_reference|date_delivered|title)) is immutable and
 * its hydrated fields (document_url/pdf_path/pdf_sha256) are
 * content-addressed, so the only field that moved between runs was
 * `fetched_at` — ~10 versions/record of pure run-clock churn.
 *
 * These tests pin (driving the gate through the exported
 * `emitStatementIndexOnly`, which shares the cursor.shouldEmit() path with
 * the hydrated emit):
 *
 *   1. Re-emitting the same statement with only a new `fetched_at` is fully
 *      suppressed on the second run.
 *   2. A statement whose body actually changes (title) re-emits.
 *   3. The fingerprint cursor's STATE round-trips and excludes `fetched_at`.
 *   4. `readPriorStatementFingerprints` tolerates missing/legacy/malformed
 *      state.
 *   5. Legacy callers without a cursor emit unconditionally.
 *   6. Connector fingerprint (excludes `fetched_at`) == compaction
 *      fingerprint over the stored body with excludeKeys ['fetched_at'].
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor, recordFingerprint } from "../../src/fingerprint-cursor.ts";
import {
  openStatementHydrationCursor,
  readPriorStatementHydration,
  type StatementHydrationCursor,
} from "../../src/statement-hydration-carry-forward.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, emitStatementIndexOnly, readPriorStatementFingerprints } from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type { StatementRow } from "./types.ts";

const FROZEN_EMITTED_AT_1 = "2026-04-22T12:00:00.000Z";
const FROZEN_EMITTED_AT_2 = "2026-05-22T12:00:00.000Z";

function makeDeps(emittedAt: string): {
  deps: EmitDeps;
  emitted: Array<{ stream: string; data: unknown }>;
  messages: EmittedMessage[];
} {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    capture: null,
    emit: harness.emit,
    emitRecord: harness.emitRecord,
    emittedAt,
    maxSeenByAccount: {},
    progress: (): Promise<void> => Promise.resolve(),
    requested: new Map<string, StreamScope>([["statements", { name: "statements" }]]),
    resFilters: new Map(),
    tmpDir: "/tmp/chase-test",
    txState: {},
    wantsAccounts: false,
    wantsBalances: false,
    wantsCurrentActivity: false,
    wantsStatements: true,
    wantsTransactions: false,
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
}

function makeRow(overrides: Partial<StatementRow> = {}): StatementRow {
  return {
    account_reference: "Sapphire Preferred *9241",
    date_delivered_raw: "Apr 13, 2026",
    doc_kind: "statement",
    rowAnchorId: "row-0",
    rowIdx: "0",
    tableIdx: "0",
    title: "April 2026 Statement",
    ...overrides,
  };
}

/** Pull the persisted statements STATE in the `{ statements: cursor }`
 *  shape the next run reads. */
function nextStateFrom(messages: EmittedMessage[]): Record<string, unknown> {
  const state = messages.filter((m) => m.type === "STATE" && m.stream === "statements").at(-1);
  return { statements: (state as { cursor?: Record<string, unknown> } | undefined)?.cursor ?? {} };
}

/** Emit one statement through the index-only path, then flush a STATE that
 *  carries the cursor (mirroring runStatements' end-of-loop STATE write). */
async function emitOneStatement(
  deps: EmitDeps,
  emit: EmittedMessage[] extends never ? never : EmitDeps["emit"],
  id: string,
  row: StatementRow,
  cursor: ReturnType<typeof openFingerprintCursor>
): Promise<void> {
  await emitStatementIndexOnly(deps, id, row, "INTACC123", "2026-04-13", cursor);
  const stateCursor: Record<string, unknown> = { fetched_at: deps.emittedAt };
  if (cursor.size() > 0) {
    stateCursor.fingerprints = cursor.toState();
  }
  await emit({ type: "STATE", stream: "statements", cursor: stateCursor });
}

test("statements: re-emitting with only a new fetched_at is fully suppressed", async () => {
  const row = makeRow();
  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitOneStatement(run1.deps, run1.deps.emit, "S1", row, cursor1);
  assert.equal(run1.emitted.length, 1, "first run emits the statement once");

  const priorState = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(priorState.statements, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorStatementFingerprints(priorState),
  });
  await emitOneStatement(run2.deps, run2.deps.emit, "S1", row, cursor2);
  assert.equal(run2.emitted.length, 0, "unchanged statement fully suppressed despite a new fetched_at");
});

test("statements: a changed statement field re-emits", async () => {
  const run1 = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor1 = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitOneStatement(run1.deps, run1.deps.emit, "S1", makeRow({ title: "April 2026 Statement" }), cursor1);

  const priorState = nextStateFrom(run1.messages);
  const run2 = makeDeps(FROZEN_EMITTED_AT_2);
  const cursor2 = openFingerprintCursor(priorState.statements, {
    excludeFromFingerprint: ["fetched_at"],
    priorFingerprints: readPriorStatementFingerprints(priorState),
  });
  // Same id, retitled body → a real change, must re-emit.
  await emitOneStatement(
    run2.deps,
    run2.deps.emit,
    "S1",
    makeRow({ title: "April 2026 Statement (corrected)" }),
    cursor2
  );
  assert.equal(run2.emitted.length, 1, "a retitled statement is a real change and re-emits");
});

test("statements: STATE carries a fingerprints map keyed by statement id", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  const cursor = openFingerprintCursor(undefined, { excludeFromFingerprint: ["fetched_at"] });
  await emitOneStatement(run.deps, run.deps.emit, "S1", makeRow(), cursor);
  const fps = readPriorStatementFingerprints(nextStateFrom(run.messages));
  assert.equal(fps.size, 1, "one fingerprint persisted");
  assert.ok(fps.get("S1"), "keyed by statement id");
});

test("statements: legacy callers without a cursor still emit unconditionally", async () => {
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  await emitStatementIndexOnly(run.deps, "S1", makeRow(), "INTACC123", "2026-04-13");
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
  const body = {
    id: "S1",
    account_id: "INTACC123",
    title: "April 2026 Statement",
    date_delivered: "2026-04-13",
    account_reference: "Sapphire Preferred *9241",
    document_url: "file:///tmp/chase/2026-04-aaaa.pdf",
    pdf_path: "/tmp/chase/2026-04-aaaa.pdf",
    pdf_sha256: "a".repeat(64),
    fetched_at: FROZEN_EMITTED_AT_1,
  };
  const later = { ...body, fetched_at: FROZEN_EMITTED_AT_2 };
  assert.equal(
    recordFingerprint(body, ["fetched_at"]),
    recordFingerprint(later, ["fetched_at"]),
    "fetched_at must not participate; both runs hash identically"
  );
});

// ─── Hydration-availability carry-forward (AC-1..AC-6) ───────────────────
//
// A previously-hydrated immutable statement that later fails to re-download
// must NOT flap its content-addressed pointers value->null and re-version.
// processStatementRow's success branch is not exported, so these tests
// reproduce its exact success record + `note` shape via `emitHydratedSuccess`
// and drive the real failure path through the exported `emitStatementIndexOnly`.

const STMT_ID = "S1";
const ACCT = "INTACC123";
const DATE = "2026-04-13";

/** Mirror of processStatementRow's success branch: build the hydrated
 *  record, gate it on the fingerprint cursor, and `note` the content-
 *  addressed pointers into the hydration cursor — the exact shape the
 *  connector persists on a successful download. */
async function emitHydratedSuccess(
  deps: EmitDeps,
  emit: EmitDeps["emit"],
  id: string,
  row: StatementRow,
  pdfPath: string,
  pdfSha256: string,
  fingerprint: ReturnType<typeof openFingerprintCursor>,
  hydration: StatementHydrationCursor
): Promise<void> {
  const record = {
    id,
    account_id: ACCT,
    title: row.title,
    date_delivered: DATE,
    account_reference: row.account_reference,
    document_url: `file://${pdfPath}`,
    pdf_path: pdfPath,
    pdf_sha256: pdfSha256,
    // These hydration-flap AC tests exercise the conservative `["fetched_at"]`-
    // only fallback (no positive content fingerprint), so the content fields
    // are null here. Content-gated behavior has dedicated coverage in
    // statements-content-fingerprint.test.ts.
    pdf_text_sha256: null,
    pdf_page_count: null,
    fetched_at: deps.emittedAt,
  };
  hydration.note(id, {
    document_url: record.document_url,
    pdf_path: record.pdf_path,
    pdf_sha256: record.pdf_sha256,
    pdf_text_sha256: record.pdf_text_sha256,
    pdf_page_count: record.pdf_page_count,
  });
  if (fingerprint.shouldEmit(record)) {
    await deps.emitRecord("statements", record);
  }
  await flushState(emit, deps.emittedAt, fingerprint, hydration);
}

/** Drive the failure path through the real exported `emitStatementIndexOnly`,
 *  then flush the statements STATE carrying both cursors (mirrors
 *  runStatements' end-of-loop STATE write). */
async function emitFailureRow(
  deps: EmitDeps,
  emit: EmitDeps["emit"],
  id: string,
  row: StatementRow,
  fingerprint: ReturnType<typeof openFingerprintCursor>,
  hydration: StatementHydrationCursor
): Promise<void> {
  await emitStatementIndexOnly(deps, id, row, ACCT, DATE, fingerprint, hydration);
  await flushState(emit, deps.emittedAt, fingerprint, hydration);
}

function flushState(
  emit: EmitDeps["emit"],
  emittedAt: string,
  fingerprint: ReturnType<typeof openFingerprintCursor>,
  hydration: StatementHydrationCursor
): Promise<void> {
  fingerprint.pruneStale();
  hydration.pruneStale();
  const cursor: Record<string, unknown> = { fetched_at: emittedAt };
  if (fingerprint.size() > 0) {
    cursor.fingerprints = fingerprint.toState();
  }
  if (hydration.size() > 0) {
    cursor.hydration = hydration.toState();
  }
  return emit({ type: "STATE", stream: "statements", cursor });
}

function openCursors(priorState: Record<string, unknown>): {
  fingerprint: ReturnType<typeof openFingerprintCursor>;
  hydration: StatementHydrationCursor;
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

test("AC-1: previously hydrated + transient download failure carries pointers forward (no flap)", async () => {
  const row = makeRow();
  const PDF = "/tmp/chase/2026-04-aaaa.pdf";
  const SHA = "a".repeat(64);

  // Run A: hydrate.
  const a = makeDeps(FROZEN_EMITTED_AT_1);
  const ca = openCursors({});
  await emitHydratedSuccess(a.deps, a.deps.emit, STMT_ID, row, PDF, SHA, ca.fingerprint, ca.hydration);
  assert.equal(a.emitted.length, 1, "run A emits the hydrated statement once");
  const priorA = nextStateFrom(a.messages);

  // Run B: same statement fails to re-download.
  const b = makeDeps(FROZEN_EMITTED_AT_2);
  const cb = openCursors(priorA);
  await emitFailureRow(b.deps, b.deps.emit, STMT_ID, row, cb.fingerprint, cb.hydration);
  assert.equal(b.emitted.length, 0, "run B emits NO new version — prior pointers carried forward");

  const carried = readPriorStatementHydration(nextStateFrom(b.messages).statements);
  assert.equal(carried.get(STMT_ID)?.pdf_path, PDF, "carried pdf_path survives the failed run");
  assert.equal(carried.get(STMT_ID)?.pdf_sha256, SHA);
});

test("AC-2: never-hydrated failure stays all-null (honest), and the body has null pointers", async () => {
  const row = makeRow();
  const run = makeDeps(FROZEN_EMITTED_AT_1);
  const c = openCursors({});
  await emitFailureRow(run.deps, run.deps.emit, STMT_ID, row, c.fingerprint, c.hydration);
  assert.equal(run.emitted.length, 1, "index-only row emits");
  const rec = run.emitted[0]?.data as Record<string, unknown>;
  assert.equal(rec.pdf_path, null, "never-hydrated stays all-null");
  assert.equal(rec.document_url, null);
  assert.equal(rec.pdf_sha256, null);
  assert.equal(readPriorStatementHydration(nextStateFrom(run.messages).statements).size, 0, "nothing to carry");
});

test("AC-2b: first hydration (null->value) is real history and versions exactly once", async () => {
  const row = makeRow();
  // Run A: failure (never hydrated).
  const a = makeDeps(FROZEN_EMITTED_AT_1);
  const ca = openCursors({});
  await emitFailureRow(a.deps, a.deps.emit, STMT_ID, row, ca.fingerprint, ca.hydration);

  // Run B: first successful hydration.
  const b = makeDeps(FROZEN_EMITTED_AT_2);
  const cb = openCursors(nextStateFrom(a.messages));
  await emitHydratedSuccess(
    b.deps,
    b.deps.emit,
    STMT_ID,
    row,
    "/tmp/chase/p.pdf",
    "b".repeat(64),
    cb.fingerprint,
    cb.hydration
  );
  assert.equal(b.emitted.length, 1, "first hydration is a real change and versions exactly once");
});

test("AC-4: flap-back is idempotent — hydrate, fail, re-hydrate identical → one version total", async () => {
  const row = makeRow();
  const PDF = "/tmp/chase/p.pdf";
  const SHA = "c".repeat(64);

  const a = makeDeps(FROZEN_EMITTED_AT_1);
  const ca = openCursors({});
  await emitHydratedSuccess(a.deps, a.deps.emit, STMT_ID, row, PDF, SHA, ca.fingerprint, ca.hydration);
  assert.equal(a.emitted.length, 1, "run A versions once");

  const b = makeDeps(FROZEN_EMITTED_AT_2);
  const cb = openCursors(nextStateFrom(a.messages));
  await emitFailureRow(b.deps, b.deps.emit, STMT_ID, row, cb.fingerprint, cb.hydration);
  assert.equal(b.emitted.length, 0, "run B carries forward, no new version");

  const c = makeDeps(FROZEN_EMITTED_AT_1);
  const cc = openCursors(nextStateFrom(b.messages));
  await emitHydratedSuccess(c.deps, c.deps.emit, STMT_ID, row, PDF, SHA, cc.fingerprint, cc.hydration);
  assert.equal(c.emitted.length, 0, "run C re-hydrates the identical PDF — still no new version");
});

test("AC-6: a delisted statement is pruned, never carried forward as a phantom", async () => {
  const rowS1 = makeRow();

  // Run A: hydrate two statements (note both via the success path, single STATE flush).
  const a = makeDeps(FROZEN_EMITTED_AT_1);
  const ca = openCursors({});
  ca.hydration.note("S1", {
    document_url: "file:///tmp/chase/s1.pdf",
    pdf_path: "/tmp/chase/s1.pdf",
    pdf_sha256: "a".repeat(64),
  });
  ca.hydration.note("S2", {
    document_url: "file:///tmp/chase/s2.pdf",
    pdf_path: "/tmp/chase/s2.pdf",
    pdf_sha256: "b".repeat(64),
  });
  await flushState(a.deps.emit, a.deps.emittedAt, ca.fingerprint, ca.hydration);

  // Run B: only S1 is still listed (full scan); S2 was terminally removed.
  const b = makeDeps(FROZEN_EMITTED_AT_2);
  const cb = openCursors(nextStateFrom(a.messages));
  await emitFailureRow(b.deps, b.deps.emit, "S1", rowS1, cb.fingerprint, cb.hydration);
  const carried = readPriorStatementHydration(nextStateFrom(b.messages).statements);
  assert.equal(carried.has("S2"), false, "a delisted statement is pruned, never carried as a phantom");
  assert.equal(carried.has("S1"), true, "the still-listed statement is retained");
});
