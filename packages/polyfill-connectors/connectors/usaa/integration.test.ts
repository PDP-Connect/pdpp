/**
 * Integration tests for the USAA connector's `collect()` emit path —
 * the per-stream helpers in collect-helpers.ts (emitAccountsStream,
 * emitStatementRecords, emitDeferredStreams, emitExportFailure) plus
 * the pure buildIndexRows / hydrationSuccess / shouldParseStatementTitle
 * filters.
 *
 * These tests DON'T drive Playwright. They construct a fake EmitDeps
 * that captures every (stream, data) pair pushed through emitRecord
 * plus every non-RECORD EmittedMessage pushed through emit, then
 * assert on the observable invariants: parent-before-child ordering,
 * stream-scope suppression, null-enrichment fallback (failed PDF
 * hydration → index-only row), backfill-ladder-exhausted SKIP shape,
 * and emittedAt propagation into account records.
 *
 * Imports from ./collect-helpers.ts (not ./index.ts) because index.ts
 * calls `runConnector({...})` at module load — importing it would open
 * stdin and keep the test runner's event loop alive forever.
 *
 * Why bother: parsers.test.ts proves record *shapes* are correct from
 * DOM/CSV/PDF input. Integration tests on the emit path prove the
 * invariants downstream consumers observe:
 *   - accounts emit before transactions/statements in a single run,
 *   - deferred streams emit SKIP_RESULT only when the client asked,
 *   - a requested-but-empty scope produces zero records,
 *   - a failed PDF hydration still emits the statement record
 *     (index-only: pdf_path/pdf_sha256/document_url all null),
 *   - emittedAt on account records threads the run-level timestamp
 *     (not a scattered Date.now() read),
 *   - ladder-exhausted SKIP_RESULT carries the last diagnostic (so
 *     the owner can see the failing phase without re-running),
 *   - duplicate index rows dedupe to one record per rowIndex (the
 *     hydration map keys by rowIndex, so a row emitted twice with the
 *     same result emits the same record — verified as non-regression).
 * Regressing any of these is a real data-integrity bug.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import {
  buildIndexRows,
  DEFERRED_STREAMS,
  type EmitDeps,
  emitAccountsStream,
  emitDeferredStreams,
  emitExportFailure,
  emitStatementRecords,
  type HydrationSummary,
  hydrationSuccess,
  shouldParseStatementTitle,
} from "./collect-helpers.ts";
import type {
  DashboardAccount,
  DiagnosticInfo,
  DocRow,
  HydrationResult,
  HydrationResultSuccess,
  IndexRow,
} from "./types.ts";

interface EmittedRecord {
  data: Record<string, unknown>;
  stream: string;
}

interface RecordingHarness {
  deps: EmitDeps;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
}

const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

/** Build an EmitDeps that records every emit() + emitRecord() call.
 *  The helpers under test are Playwright-free, so no tmpDir/progress/
 *  capture fakes are needed. */
function makeHarness(): RecordingHarness {
  const emitted: EmittedRecord[] = [];
  const messages: EmittedMessage[] = [];
  const deps: EmitDeps = {
    emit: (msg: EmittedMessage): Promise<void> => {
      messages.push(msg);
      return Promise.resolve();
    },
    emitRecord: (stream: string, data: Record<string, unknown>): Promise<void> => {
      emitted.push({ stream, data });
      return Promise.resolve();
    },
  };
  return { deps, emitted, messages };
}

function makeAccount(overrides: Partial<DashboardAccount> = {}): DashboardAccount {
  return {
    account_id_raw: "ACCT-CHK-0001",
    account_type: "checking",
    account_url: "/my/checking?accountId=ACCT-CHK-0001",
    balance_cents: 123_456,
    last_four: "9241",
    name: "USAA CLASSIC CHECKING",
    raw_text: "USAA CLASSIC CHECKING Ending in *9241 $1,234.56",
    ...overrides,
  };
}

function makeDocRow(overrides: Partial<DocRow> = {}): DocRow {
  return {
    account_reference: "USAA CLASSIC CHECKING *9241",
    date_delivered: "Apr 13, 2026",
    rowIndex: 0,
    title: "April 2026 STATEMENT",
    ...overrides,
  };
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
    pdfPath: "/tmp/usaa-test/statement-0.pdf",
    pdfSha256: "deadbeef".repeat(8),
    ...overrides,
  };
}

function requestedWith(names: readonly string[]): Map<string, StreamScope> {
  return new Map<string, StreamScope>(names.map((n) => [n, { name: n }]));
}

// ─── Invariant 1: parent-before-child (accounts before statements) ───────

test("emit order: accounts stream emits before statements for the same run", async () => {
  const { deps, emitted } = makeHarness();
  const accounts = [makeAccount()];
  const indexRows = [makeIndexRow()];
  const hydration = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);
  const summary: HydrationSummary = { attempts: 1, successes: 1, results: hydration };

  await emitAccountsStream(deps, accounts, FROZEN_EMITTED_AT);
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const accountIdx = emitted.findIndex((r) => r.stream === "accounts");
  const stmtIdx = emitted.findIndex((r) => r.stream === "statements");
  assert.notEqual(accountIdx, -1, "expected an accounts record");
  assert.notEqual(stmtIdx, -1, "expected a statements record");
  assert.ok(accountIdx < stmtIdx, "accounts must emit before statements");
});

// ─── Invariant 2: stream-scope filters cleanly ───────────────────────────

test("emitDeferredStreams: only emits for streams the client actually requested", async () => {
  const { deps, messages } = makeHarness();
  // Client asks for a subset of deferred streams (transfers + bill_payments)
  // plus unrelated streams (accounts, statements).
  const requested = requestedWith(["accounts", "statements", "transfers", "bill_payments"]);
  await emitDeferredStreams(deps.emit, requested);

  const skipStreams = messages
    .filter((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT")
    .map((m) => m.stream)
    .sort();
  assert.deepEqual(skipStreams, ["bill_payments", "transfers"], "only the requested deferred streams emit SKIP");
});

test("emitDeferredStreams: every SKIP_RESULT carries reason='selectors_pending'", async () => {
  const { deps, messages } = makeHarness();
  const requested = requestedWith([...DEFERRED_STREAMS]);
  await emitDeferredStreams(deps.emit, requested);
  const skips = messages.filter((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.equal(skips.length, DEFERRED_STREAMS.length, "one SKIP per deferred stream when all are requested");
  for (const s of skips) {
    assert.equal(s.reason, "selectors_pending", `stream=${s.stream} should flag selectors_pending`);
  }
});

// ─── Invariant 3: all-streams-disabled → nothing ─────────────────────────

test("emitDeferredStreams: empty requested scope emits nothing", async () => {
  const { deps, messages } = makeHarness();
  const requested = requestedWith([]);
  await emitDeferredStreams(deps.emit, requested);
  assert.equal(messages.length, 0, "no SKIP_RESULTs when client didn't request any deferred streams");
});

test("emitAccountsStream over zero accounts emits only the STATE heartbeat (no records)", async () => {
  const { deps, emitted, messages } = makeHarness();
  await emitAccountsStream(deps, [], FROZEN_EMITTED_AT);
  assert.equal(emitted.length, 0, "no accounts records emitted when there are no accounts");
  const states = messages.filter((m) => m.type === "STATE");
  assert.equal(states.length, 1, "STATE heartbeat still emits on empty runs (marks the stream as attempted)");
});

// ─── Invariant 4: null-enrichment fallback (failed PDF → index-only row) ─

test("emitStatementRecords: failed hydration emits index-only record (all pdf fields null)", async () => {
  const { deps, emitted } = makeHarness();
  const indexRows = [makeIndexRow()];
  // No entry in the hydration map at all — the helper must still emit.
  const hydration = new Map<number, HydrationResult>();
  const summary: HydrationSummary = { attempts: 1, successes: 0, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const stmt = emitted.find((r) => r.stream === "statements");
  assert.ok(stmt, "a statements record must still emit when PDF hydration failed");
  assert.equal(stmt.data.pdf_path, null, "null pdf_path marks the fallback");
  assert.equal(stmt.data.pdf_sha256, null);
  assert.equal(stmt.data.document_url, null);
  assert.equal(stmt.data.title, "April 2026 STATEMENT", "title survives to the index-only record");
  assert.equal(stmt.data.id, "IDX-ID-0001");
});

test("emitStatementRecords: hydrated rows populate pdf_path + pdf_sha256 + document_url", async () => {
  const { deps, emitted } = makeHarness();
  const indexRows = [makeIndexRow()];
  const ok = makeHydrationOk({ pdfPath: "/tmp/usaa-test/hydrated.pdf", pdfSha256: "cafef00d".repeat(8) });
  const hydration = new Map<number, HydrationResult>([[0, ok]]);
  const summary: HydrationSummary = { attempts: 1, successes: 1, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const stmt = emitted.find((r) => r.stream === "statements");
  assert.ok(stmt);
  assert.equal(stmt.data.pdf_path, "/tmp/usaa-test/hydrated.pdf");
  assert.equal(stmt.data.pdf_sha256, "cafef00d".repeat(8));
  // document_url is a file:// URL derived from pdfPath — we assert the prefix rather than the full
  // platform-dependent path to keep the test portable.
  assert.match(String(stmt.data.document_url), /^file:\/\//, "document_url should be a file:// URL");
});

// ─── Invariant 4b: buildIndexRows drops rows missing date_delivered ──────

test("buildIndexRows: rows without a date_delivered are dropped (no undated keys)", () => {
  const docs: DocRow[] = [
    makeDocRow({ rowIndex: 0, title: "January 2026 STATEMENT" }),
    makeDocRow({ rowIndex: 1, date_delivered: "", title: "BROKEN STATEMENT" }),
    makeDocRow({ rowIndex: 2, title: "February 2026 STATEMENT" }),
  ];
  const rows = buildIndexRows(docs, [makeAccount()]);
  assert.equal(rows.length, 2, "undated row dropped; dated rows kept");
  const kept = rows.map((r) => r.rowIndex);
  assert.deepEqual(kept, [0, 2]);
});

// ─── Invariant 5: dedup — repeated hydration map key yields one emit per row ─

test("emitStatementRecords: duplicate rowIndex in indexRows emits once per row entry (no hidden dedupe)", async () => {
  // The helper is faithful to its input — if the same indexRow is passed twice,
  // it emits twice. Dedup happens at the index-row build layer (via hashId),
  // not the emit layer. This test pins that contract: regressing it would
  // either introduce a surprising dedup in the emit path or silently drop
  // a second occurrence.
  const { deps, emitted } = makeHarness();
  const row = makeIndexRow();
  const hydration = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);
  const summary: HydrationSummary = { attempts: 1, successes: 1, results: hydration };
  await emitStatementRecords(deps, [row, row], hydration, summary);
  const stmts = emitted.filter((r) => r.stream === "statements");
  assert.equal(stmts.length, 2, "each indexRow entry produces one emit; dedup is upstream");
  assert.equal(stmts[0]?.data.id, stmts[1]?.data.id, "both emits share the same hashId");
});

// ─── Invariant 6: emittedAt propagation into the accounts record ─────────

test("emitAccountsStream: emittedAt propagates into every accounts record's fetched_at", async () => {
  const { deps, emitted } = makeHarness();
  const frozen = "2026-01-15T08:00:00.000Z";
  const accounts = [
    makeAccount({ account_id_raw: "A1" }),
    makeAccount({ account_id_raw: "A2", name: "USAA SAVINGS", account_type: "savings" }),
  ];
  await emitAccountsStream(deps, accounts, frozen);
  const accountRecords = emitted.filter((r) => r.stream === "accounts");
  assert.equal(accountRecords.length, 2);
  for (const r of accountRecords) {
    assert.equal(
      r.data.fetched_at,
      frozen,
      `fetched_at on account id=${String(r.data.id)} must be the frozen emittedAt`
    );
  }
});

// ─── Invariant 7: backfill ladder exhausted → SKIP_RESULT shape ──────────

test("emitExportFailure: exhausted ladder with diagnostic emits SKIP_RESULT carrying the last phase", async () => {
  const { deps, messages } = makeHarness();
  const diag: DiagnosticInfo = {
    phase: "no_export_affordance",
    diag: {
      url: "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      title: "Checking",
      has_utility_bar: false,
      export_candidates: [],
      nav_candidates: [],
      dialogs_open: 0,
    },
  };
  await emitExportFailure(deps, makeAccount(), diag);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip, "SKIP_RESULT must emit when the ladder is exhausted");
  assert.equal(skip.stream, "transactions", "export failure is charged to the transactions stream");
  assert.equal(skip.reason, "export_no_download", "non-credit-card account uses export_no_download");
  assert.match(skip.message, /no_export_affordance/, "message carries the last diagnostic phase");
  assert.equal(skip.diagnostics, diag, "last diagnostic threads through as structured context");
});

test("emitExportFailure: credit-card account uses credit_card_export_unverified reason", async () => {
  const { deps, messages } = makeHarness();
  const cc = makeAccount({
    account_id_raw: "ACCT-CC-0001",
    account_type: "credit-card",
    name: "USAA REWARDS AMEX",
    last_four: "0001",
  });
  await emitExportFailure(deps, cc, null);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "credit_card_export_unverified", "credit-card export flow is not yet live-verified");
  assert.match(skip.message, /credit-card export flow not verified/, "message carries the design-notes pointer");
});

// ─── Invariant 8: pure filters ───────────────────────────────────────────

test("shouldParseStatementTitle: keeps statement titles, drops agreements/disclosures/terms", () => {
  assert.equal(shouldParseStatementTitle("April 2026 STATEMENT"), true);
  assert.equal(shouldParseStatementTitle("Monthly Statement"), true);
  assert.equal(shouldParseStatementTitle("CARDHOLDER AGREEMENT"), false, "agreement should be filtered");
  assert.equal(shouldParseStatementTitle("Privacy NOTICE"), false);
  assert.equal(shouldParseStatementTitle("Important DISCLOSURE"), false);
  assert.equal(shouldParseStatementTitle("Terms and CONDITIONs"), false);
  assert.equal(shouldParseStatementTitle("Some random doc"), false, "no STATEMENT token → drop");
});

test("hydrationSuccess: narrows ok branch, returns null for err branch + undefined", () => {
  const ok = makeHydrationOk();
  assert.equal(hydrationSuccess(ok), ok, "ok branch passes through");
  assert.equal(hydrationSuccess({ err: "download_timed_out" }), null, "err branch narrows to null");
  assert.equal(hydrationSuccess(undefined), null, "missing entry narrows to null");
});
