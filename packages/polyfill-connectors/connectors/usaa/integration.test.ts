// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the USAA connector's `collect()` emit path —
 * the per-stream helpers in index.ts (emitAccountsStream,
 * emitStatementRecords, emitDeferredStreams, emitExportFailure) plus
 * the pure buildIndexRows / hydrationSuccess / shouldParseStatementTitle
 * filters.
 *
 * These tests DON'T drive Playwright. They construct a fake EmitDeps
 * backed by `makeRecordingEmit(validateRecord)` — every emitted record
 * is run through the real zod schema so fixture drift fails the test
 * instead of silently passing. Captures every (stream, data) pair
 * pushed through emitRecord plus every non-RECORD EmittedMessage
 * pushed through emit, then asserts on the observable invariants:
 * parent-before-child ordering,
 * stream-scope suppression, null-enrichment fallback (failed PDF
 * hydration → index-only row), backfill-ladder-exhausted SKIP shape,
 * and emittedAt propagation into account records.
 *
 * Imports directly from ./index.ts — `runConnector({...})` is guarded by
 * `isMainModule(import.meta.url)` so it only fires when index.ts is the
 * process entry point, not when a test imports it.
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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BrowserContext, Page } from "playwright";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import type { CaptureSession } from "../../src/fixture-capture.ts";
import { type EmittedRecord, makeRecordingEmit } from "../../src/test-harness.ts";
import {
  buildIndexRows,
  classifyExportLadderOutcome,
  classifyTerminalExportFailure,
  classifyUsaaAccountPageIdentity,
  classifyUsaaNoExportRoute,
  DEFERRED_STREAMS,
  driveExport,
  type EmitDeps,
  emitAccountsStream,
  emitDeferredStreams,
  emitExportFailure,
  emitPdfStatementTransactions,
  emitStatementRecords,
  finalizeTransactionsStream,
  type HydrationSummary,
  hydrationSuccess,
  isNoDataExportMessage,
  runSingleLadderAttempt,
  shouldParseStatementTitle,
  tryExportLadder,
  USAA_FALLBACK_SERIALIZED_BYTES_MAX,
  USAA_RETRYABLE_PATTERN,
} from "./index.ts";
import { validateRecord } from "./schemas.ts";
import type {
  DashboardAccount,
  DiagnosticInfo,
  DocRow,
  HydrationResult,
  HydrationResultSuccess,
  IndexRow,
  NoExportAffordanceObservation,
} from "./types.ts";

interface RecordingHarness {
  deps: EmitDeps;
  emitted: EmittedRecord[];
  messages: EmittedMessage[];
}

const USAA_MANIFEST_PATH = new URL("../../manifests/usaa.json", import.meta.url);
const FROZEN_EMITTED_AT = "2026-04-22T12:00:00.000Z";

/** Build an EmitDeps that records every emit() + emitRecord() call
 *  through the real zod schema the runtime applies in production.
 *  The helpers under test are Playwright-free, so no tmpDir/progress/
 *  capture fakes are needed. */
function makeHarness(): RecordingHarness {
  const harness = makeRecordingEmit(validateRecord);
  const deps: EmitDeps = {
    emit: harness.emit,
    emitRecord: harness.emitRecord,
  };
  return { deps, emitted: harness.emitted, messages: harness.protocolMessages };
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
    content: { pdf_text_sha256: null, pdf_page_count: null },
    ...overrides,
  };
}

function makeStatementPdf(): Buffer {
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    "(Statement Period 04/01/2026 - 04/30/2026) Tj",
    "0 -20 Td",
    "(TRANSACTIONS) Tj",
    "0 -20 Td",
    "(04/02 COFFEE SHOP #45   -4.50   95.50) Tj",
    "0 -20 Td",
    "(ENDING BALANCE 95.50) Tj",
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function makeNoExportPage(
  finalUrl: string,
  counts: {
    account_detail_marker_count: number;
    export_affordance_candidates?: NoExportAffordanceObservation["export_affordance_candidates"];
    navigation_marker_count: number;
    target_count: number;
    transaction_marker_count: number;
  }
): Page {
  return Object.assign({} as Page, {
    evaluate() {
      return Promise.resolve(counts);
    },
    goto() {
      return Promise.resolve(null);
    },
    locator() {
      return {
        count() {
          return Promise.resolve(0);
        },
        filter() {
          return this;
        },
      };
    },
    url() {
      return finalUrl;
    },
  });
}

function makeNoExportFallbackPage(controlLabel: string): Page {
  return Object.assign({} as Page, {
    evaluate(_fn: (...args: unknown[]) => unknown, arg?: unknown) {
      if (arg && typeof arg === "object" && "accountDetail" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          account_detail_marker_count: 1,
          export_affordance_candidates: [],
          navigation_marker_count: 2,
          target_count: 0,
          transaction_marker_count: 1,
        });
      }
      if (arg && typeof arg === "object" && "exportAffordance" in (arg as Record<string, unknown>)) {
        return Promise.resolve({ candidateCount: 0, candidates: [], controlCount: 0, controls: [] });
      }
      return Promise.resolve([
        {
          aria_disabled: false,
          class_name: "activity-control",
          disabled: false,
          href_path: "/my/activity?accountId=ACCT-CHK-0001&email=owner@example.com",
          label: controlLabel,
          role: "button",
          tag: "BUTTON",
          type: "button",
          visible: true,
        },
      ]);
    },
    goto() {
      return Promise.resolve(null);
    },
    locator() {
      return {
        count() {
          return Promise.resolve(0);
        },
        filter() {
          return this;
        },
      };
    },
    title() {
      return Promise.resolve("OTP 123456 owner@example.com ACCT-CHK-0001");
    },
    url() {
      return "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001";
    },
  });
}

function makeDisabledExportPage(): Page {
  return Object.assign({} as Page, {
    evaluate(_fn: (...args: unknown[]) => unknown, arg?: unknown) {
      if (arg && typeof arg === "object" && "exportAffordance" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          account_detail_marker_count: 1,
          export_affordance_candidates: [
            {
              aria_disabled: false,
              cls: "as_credit__utility-bar-item as_credit__export",
              disabled: true,
              id: "export-button",
              role: "button",
              tag: "BUTTON",
              text: "Export",
              type: "button",
              visible: true,
            },
          ],
          navigation_marker_count: 2,
          target_count: 1,
          transaction_marker_count: 1,
        });
      }
      return Promise.resolve(null);
    },
    goto() {
      return Promise.resolve(null);
    },
    locator(selector: string) {
      if (selector === "button.as_credit__utility-bar-item.as_credit__export") {
        return {
          count: () => Promise.resolve(1),
          first(): unknown {
            return this;
          },
          isEnabled: () => Promise.resolve(false),
        };
      }
      return {
        count: () => Promise.resolve(0),
        filter(): unknown {
          return this;
        },
        first(): unknown {
          return this;
        },
      };
    },
    title: () => Promise.resolve("Bank Account Summary | USAA"),
    url: () => "https://www.usaa.com/my/credit-card?accountId=ACCT-CC-0001",
  });
}

function makeCapturedDisabledExportPage(): Page {
  return Object.assign({} as Page, {
    evaluate(_fn: (...args: unknown[]) => unknown, arg?: unknown) {
      if (arg && typeof arg === "object" && "accountDetail" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          account_detail_marker_count: 1,
          export_affordance_candidates: [
            {
              aria_disabled: true,
              cls: "as_credit__utility-bar-item as_credit__export account-987654",
              disabled: true,
              id: "export-control-secret-987654",
              role: "button",
              tag: "BUTTON",
              text: "Export PRIVATE MERCHANT transaction 987654",
              type: "button",
              visible: false,
            },
          ],
          navigation_marker_count: 1,
          target_count: 1,
          transaction_marker_count: 1,
        });
      }
      if (arg && typeof arg === "object" && "exportAffordance" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          candidateCount: 2,
          candidates: [
            {
              aria_disabled: true,
              class_tokens: "as_credit__utility-bar-item as_credit__export account-987654",
              disabled: true,
              kind: "export",
              role: "button",
              tag: "BUTTON",
              text: "Export PRIVATE MERCHANT transaction 987654",
              type: "button",
              visible: false,
            },
            {
              aria_disabled: false,
              class_tokens: "download-link",
              disabled: false,
              kind: "download",
              role: "link",
              tag: "A",
              text: "CSV PRIVATE MERCHANT",
              type: null,
              visible: true,
            },
          ],
          controlCount: 1,
          controls: [
            {
              aria_disabled: false,
              class_tokens: "dialog-control dynamic-987654",
              disabled: false,
              name: "selectionType",
              role: "combobox",
              tag: "SELECT",
              text: "transaction PRIVATE MERCHANT 987654",
              type: null,
              visible: true,
            },
          ],
        });
      }
      return Promise.resolve(null);
    },
    goto() {
      return Promise.resolve(null);
    },
    locator(selector: string) {
      if (selector === "button.as_credit__utility-bar-item.as_credit__export") {
        return {
          count: () => Promise.resolve(1),
          first(): unknown {
            return this;
          },
          isEnabled: () => Promise.resolve(false),
        };
      }
      return {
        count: () => Promise.resolve(0),
        filter(): unknown {
          return this;
        },
        first(): unknown {
          return this;
        },
      };
    },
    url: () => "https://www.usaa.com/my/checking?accountId=ACCT-CHK-987654",
  });
}

function requestedWith(names: readonly string[]): Map<string, StreamScope> {
  return new Map<string, StreamScope>(names.map((n) => [n, { name: n }]));
}

test("runtime retry classification includes source-unavailable login failures", () => {
  assert.match(
    "source_unavailable: USAA reported its login system is currently unavailable after Next click.",
    USAA_RETRYABLE_PATTERN
  );
});

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
    .sort((a, b) => a.localeCompare(b));
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

// ─── Invariant 4c: per-run detail-coverage evidence on the emit path ─────

function statementCoverage(messages: readonly EmittedMessage[]): EmittedMessage | undefined {
  return messages.find((m) => m.type === "DETAIL_COVERAGE" && m.stream === "statements");
}
function statementGaps(messages: readonly EmittedMessage[]): EmittedMessage[] {
  return messages.filter((m) => m.type === "DETAIL_GAP" && m.stream === "statements");
}

test("emitStatementRecords: fully hydrated statement run emits DETAIL_COVERAGE with required === hydrated, no gaps", async () => {
  const { deps, messages } = makeHarness();
  const indexRows = [makeIndexRow({ rowIndex: 0, id: "S0" }), makeIndexRow({ rowIndex: 1, id: "S1" })];
  const hydration = new Map<number, HydrationResult>([
    [0, makeHydrationOk()],
    [1, makeHydrationOk({ pdfPath: "/tmp/usaa-test/statement-1.pdf" })],
  ]);
  const summary: HydrationSummary = { attempts: 2, successes: 2, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const coverage = statementCoverage(messages);
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE", "a DETAIL_COVERAGE must be emitted");
  assert.equal(coverage.reference_only, true);
  assert.equal(coverage.state_stream, "statements");
  assert.deepEqual([...coverage.required_keys].sort(), ["S0", "S1"]);
  assert.deepEqual([...coverage.hydrated_keys].sort(), ["S0", "S1"]);
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 2);
  assert.equal(coverage.gap_keys, undefined, "no gap_keys when every PDF is present");
  assert.equal(statementGaps(messages).length, 0, "no DETAIL_GAP when fully hydrated");
});

test("emitStatementRecords: a failed statement PDF surfaces a DETAIL_GAP + gap_key (partial, not complete)", async () => {
  const { deps, messages } = makeHarness();
  const indexRows = [makeIndexRow({ rowIndex: 0, id: "OK" }), makeIndexRow({ rowIndex: 1, id: "MISS" })];
  // Only row 0 hydrated; row 1 has no map entry and no carry-forward cursor.
  const hydration = new Map<number, HydrationResult>([[0, makeHydrationOk()]]);
  const summary: HydrationSummary = { attempts: 2, successes: 1, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const coverage = statementCoverage(messages);
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
  assert.deepEqual([...coverage.required_keys].sort(), ["MISS", "OK"]);
  assert.deepEqual(coverage.hydrated_keys, ["OK"]);
  assert.equal(coverage.considered, 2);
  assert.equal(coverage.covered, 1);
  assert.deepEqual(coverage.gap_keys, ["MISS"]);

  const gaps = statementGaps(messages);
  assert.equal(gaps.length, 1, "exactly one DETAIL_GAP for the missing PDF");
  const [gap] = gaps;
  assert.ok(gap && gap.type === "DETAIL_GAP");
  assert.equal(gap.record_key, "MISS");
  assert.equal(gap.status, "pending");
  assert.equal(gap.retryable, true);
  assert.equal(gap.reference_only, true);
});

test("emitStatementRecords: required_keys === hydrated_keys ∪ gap_keys (runtime coverage-completeness invariant)", async () => {
  const { deps, messages } = makeHarness();
  const indexRows = [
    makeIndexRow({ rowIndex: 0, id: "H0" }),
    makeIndexRow({ rowIndex: 1, id: "G1" }),
    makeIndexRow({ rowIndex: 2, id: "H2" }),
  ];
  const hydration = new Map<number, HydrationResult>([
    [0, makeHydrationOk()],
    [2, makeHydrationOk({ pdfPath: "/tmp/usaa-test/statement-2.pdf" })],
  ]);
  const summary: HydrationSummary = { attempts: 3, successes: 2, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const coverage = statementCoverage(messages);
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE");
  const union = new Set([...coverage.hydrated_keys, ...(coverage.gap_keys ?? [])]);
  assert.equal(union.size, coverage.required_keys.length);
  for (const key of coverage.required_keys) {
    assert.ok(union.has(key), `required key ${String(key)} is hydrated or a pending gap`);
  }
  // Every gap_key has exactly one matching pending DETAIL_GAP.
  const gapKeys = new Set(statementGaps(messages).map((g) => g.type === "DETAIL_GAP" && g.record_key));
  for (const key of coverage.gap_keys ?? []) {
    assert.ok(gapKeys.has(key), `gap key ${String(key)} has a DETAIL_GAP`);
  }
});

test("emitStatementRecords: a run with only disclosures (no statement docs) still emits a zero-candidate DETAIL_COVERAGE", async () => {
  const { deps, messages } = makeHarness();
  // Titles the statement-parse predicate rejects (agreement/disclosure).
  const indexRows = [
    makeIndexRow({ rowIndex: 0, id: "D0", title: "CARDHOLDER AGREEMENT" }),
    makeIndexRow({ rowIndex: 1, id: "D1", title: "PRIVACY DISCLOSURE" }),
  ];
  const hydration = new Map<number, HydrationResult>();
  const summary: HydrationSummary = { attempts: 0, successes: 0, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  // Enumeration completed (the documents index was scraped; it just had zero
  // statement-document candidates), so the run measured its denominator and
  // must report it — considered: 0 / covered: 0 — rather than staying silent.
  const coverage = statementCoverage(messages);
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE", "a zero-candidate run still emits DETAIL_COVERAGE");
  assert.deepEqual(coverage.required_keys, []);
  assert.deepEqual(coverage.hydrated_keys, []);
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
  assert.equal(coverage.gap_keys, undefined, "no gaps when there is no real denominator");
  assert.equal(statementGaps(messages).length, 0, "no DETAIL_GAP for non-statement rows");
  // The statement records themselves still emit (index-only) — coverage is additive.
  // (The disclosure rows are honest `statements` records; the PDF-detail
  //  coverage report now reflects the measured zero denominator instead of
  //  being suppressed.)
});

test("emitStatementRecords: zero statement-document rows scraped still emits a zero-candidate DETAIL_COVERAGE", async () => {
  const { deps, messages } = makeHarness();
  const hydration = new Map<number, HydrationResult>();
  const summary: HydrationSummary = { attempts: 0, successes: 0, results: hydration };
  await emitStatementRecords(deps, [], hydration, summary);

  const coverage = statementCoverage(messages);
  assert.ok(coverage && coverage.type === "DETAIL_COVERAGE", "an empty documents index still emits DETAIL_COVERAGE");
  assert.deepEqual(coverage.required_keys, []);
  assert.deepEqual(coverage.hydrated_keys, []);
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
});

test("emitStatementRecords: DETAIL_GAP and DETAIL_COVERAGE never interpolate statement title or account text", async () => {
  const { deps, messages } = makeHarness();
  const indexRows = [
    makeIndexRow({
      rowIndex: 0,
      id: "S0",
      title: "April 2026 STATEMENT",
      account_reference: "USAA CLASSIC CHECKING *9241",
    }),
  ];
  const hydration = new Map<number, HydrationResult>();
  const summary: HydrationSummary = { attempts: 1, successes: 0, results: hydration };
  await emitStatementRecords(deps, indexRows, hydration, summary);

  const refMessages = [statementCoverage(messages), ...statementGaps(messages)].filter(Boolean);
  assert.ok(refMessages.length >= 1, "coverage + at least one gap emitted");
  const serialized = JSON.stringify(refMessages);
  // Target the fixture's document-title + account-reference PII (e.g. "April",
  // "CHECKING", "*9241"), NOT the legitimate lowercase `statements` /
  // `statement_id` protocol identifiers, which are not PII.
  assert.doesNotMatch(
    serialized,
    /April|CHECKING|CLASSIC|\*9241/,
    "no title/account text leaks into coverage evidence"
  );
  assert.match(serialized, /S0/, "only the opaque statement id appears");
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

test("buildIndexRows: blank account reference normalizes to null", () => {
  const rows = buildIndexRows([makeDocRow({ account_reference: "   " })], [makeAccount()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.account_reference, null);
  assert.equal(rows[0]?.account_id, null);
});

test("ambiguous statement account references emit neither PDF transactions nor alternate-account coverage", async () => {
  const accounts = [
    makeAccount({ account_id_raw: "ACCT-CHK-9241", name: "USAA CLASSIC CHECKING", last_four: "9241" }),
    makeAccount({
      account_id_raw: "ACCT-CC-9241",
      account_type: "credit-card",
      name: "USAA CARD",
      last_four: "9241",
    }),
  ];
  const [row] = buildIndexRows([makeDocRow({ account_reference: "USAA CARD *9241" })], accounts);
  assert.ok(row);
  assert.equal(row.account_id, null, "duplicate last-four must stay unresolved");

  const { deps, emitted, messages } = makeHarness();
  const covered = await emitPdfStatementTransactions(
    deps,
    [row],
    new Map([[row.rowIndex, makeHydrationOk({ buffer: makeStatementPdf() })]]),
    accounts
  );
  assert.deepEqual([...covered], []);
  assert.equal(emitted.filter((record) => record.stream === "transactions").length, 0);
  assert.equal(
    messages.some((message) => message.type === "DETAIL_COVERAGE" && message.stream === "transactions"),
    false
  );
});

test("finalizeTransactionsStream keeps exact terminal evidence when PDF coverage hydrates the same account", async () => {
  const { deps, messages } = makeHarness();
  const account = makeAccount();
  const terminalDiag: DiagnosticInfo = {
    account_page_identity: "exact",
    diag: null,
    no_export_observation: {
      account_page_identity: "exact",
      account_detail_marker_count: 1,
      affordance_disabled: true,
      export_affordance_candidates: [],
      navigation_marker_count: 2,
      route: "expected",
      target_count: 1,
      transaction_marker_count: 1,
    },
    phase: "no_export_affordance",
  };
  const result: Parameters<typeof finalizeTransactionsStream>[1] = {
    cursor: {},
    enumerationComplete: true,
    exportFailures: new Map([
      [
        account.account_id_raw ?? "",
        { account, lastDiag: terminalDiag, terminalFailure: "export_affordance_disabled" },
      ],
    ]),
    outcomes: [
      {
        accountId: account.account_id_raw ?? "",
        kind: "unavailable",
        reason: "export_affordance_disabled",
        errorClass: "export_affordance_disabled",
      },
    ],
  };

  await finalizeTransactionsStream(deps, result, new Set([account.account_id_raw ?? ""]));

  const skip = messages.find(
    (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      message.type === "SKIP_RESULT" && message.stream === "transactions"
  );
  assert.ok(skip, "terminal CSV/control evidence must remain visible after PDF hydration");
  assert.equal(skip.reason, "export_affordance_disabled");
  assert.deepEqual(skip.recovery_hint, { action: "capture_live_surface", retryable: false });
  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "transactions"
  );
  assert.ok(coverage);
  assert.deepEqual(coverage.hydrated_keys, [account.account_id_raw]);
  assert.equal(coverage.optional_skip_keys, undefined);
  assert.equal(
    messages.some((message) => message.type === "DETAIL_GAP"),
    false
  );
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

test("emitExportFailure: a missing export affordance is reported as a structure-changed outcome, not export_no_download", async () => {
  // `no_export_affordance` is one of the two fatal phases the ladder breaks on:
  // the export button/page was never located, so a shorter date window can't
  // help. That is the "source UI/API changed" outcome, and it must be visible
  // to the dashboard as a distinct reason — not collapsed into the transient
  // `export_no_download` bucket — so a structurally-broken connector is not
  // mistaken for momentary export pressure.
  const { deps, messages } = makeHarness();
  const diag: DiagnosticInfo = {
    account_page_identity: "exact",
    phase: "no_export_affordance",
    no_export_observation: {
      account_page_identity: "exact",
      account_detail_marker_count: 1,
      affordance_disabled: false,
      export_affordance_candidates: [],
      navigation_marker_count: 2,
      route: "expected",
      target_count: 0,
      transaction_marker_count: 1,
    },
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
  assert.equal(skip.reason, "export_affordance_missing", "a missing affordance/dialog is a structure-changed outcome");
  assert.match(skip.message, /confirmed account page/);
  assert.deepEqual(skip.recovery_hint, { action: "capture_live_surface", retryable: false });
  const emittedDiag = skip.diagnostics as { terminal_failure?: string; browser_surface: Record<string, unknown> };
  assert.equal(emittedDiag.terminal_failure, "source_structure_changed");
  assert.deepEqual(emittedDiag, {
    terminal_failure: "source_structure_changed",
    account_page_identity: "exact",
    browser_surface: {
      account_detail_marker_count: 1,
      activity_table_marker_count: 0,
      dashboard_marker_count: 0,
      managed_surface: "unknown",
      navigation_marker_count: 2,
      parser_count: 0,
      phase: "no_export_affordance",
      posture: "recognized",
      read_count: 1,
      route: "expected",
      surface: "usaa_transaction_export",
      target_count: 0,
      transaction_marker_count: 1,
      verified_empty_marker_count: 0,
      wait_outcome: "not_needed",
    },
  });
  const serialized = JSON.stringify({ message: skip.message, diagnostics: skip.diagnostics });
  assert.doesNotMatch(serialized, /accountId=|https?:\/\/|Checking|BUTTON|ACCT-CHK-0001/);
});

test("classifyUsaaNoExportRoute requires both a closed account route and structural marker", () => {
  assert.equal(classifyUsaaNoExportRoute("https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001", true), "expected");
  assert.equal(classifyUsaaNoExportRoute("https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001", false), "unknown");
  assert.equal(classifyUsaaNoExportRoute("https://www.usaa.com/challenge/step", true), "interstitial");
  assert.equal(classifyUsaaNoExportRoute("https://www.usaa.com/my/logon", true), "interstitial");
  assert.equal(classifyUsaaNoExportRoute("https://www.usaa.com/my/dashboard", true), "unknown");
  assert.equal(classifyUsaaNoExportRoute("https://private.example/my/checking", true), "unknown");
});

test("classifyUsaaAccountPageIdentity requires the requested account id and page path", () => {
  const requested = "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001";
  assert.equal(classifyUsaaAccountPageIdentity(requested, requested), "exact");
  assert.equal(
    classifyUsaaAccountPageIdentity(requested, "https://www.usaa.com/my/checking?accountId=ACCT-CC-0001"),
    "mismatch"
  );
  assert.equal(
    classifyUsaaAccountPageIdentity(requested, "https://www.usaa.com/my/credit-card?accountId=ACCT-CHK-0001"),
    "mismatch"
  );
  assert.equal(classifyUsaaAccountPageIdentity(undefined, requested), "unverified");
  assert.equal(classifyUsaaAccountPageIdentity(requested, "https://www.usaa.com/my/dashboard"), "mismatch");
});

test("tryExportLadder: a confirmed disabled control is terminal and does not try another date window", async () => {
  const { deps, messages } = makeHarness();
  const result = await tryExportLadder(
    deps,
    {} as BrowserContext,
    makeDisabledExportPage(),
    async () => ({ request_id: "test", status: "success", type: "INTERACTION_RESPONSE" }),
    makeAccount({
      account_id_raw: "ACCT-CC-0001",
      account_type: "credit-card",
      account_url: "/my/credit-card?accountId=ACCT-CC-0001",
    }),
    3,
    4,
    ["2026-01-01", "2025-01-01"],
    "2026-07-16",
    () => undefined
  );

  assert.equal(result.terminalFailure, "export_affordance_disabled");
  assert.equal(result.csvPath, null);
  const progress = messages
    .filter((message): message is Extract<EmittedMessage, { type: "PROGRESS" }> => message.type === "PROGRESS")
    .map((message) => message.message);
  assert.equal(progress.filter((message) => message.includes("Export wait")).length, 1);
  assert.equal(
    progress.some((message) => message.includes("Retrying export")),
    false
  );
});

test("driveExport records account, challenge, and unrelated routes through the actual no-export path", async () => {
  for (const { counts, finalUrl, identity, route } of [
    {
      counts: {
        account_detail_marker_count: 1,
        export_affordance_candidates: [],
        navigation_marker_count: 1,
        target_count: 0,
        transaction_marker_count: 0,
      },
      finalUrl: "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      identity: "exact",
      route: "expected",
    },
    {
      counts: {
        account_detail_marker_count: 0,
        export_affordance_candidates: [],
        navigation_marker_count: 0,
        target_count: 0,
        transaction_marker_count: 0,
      },
      finalUrl: "https://www.usaa.com/challenge/step",
      identity: "mismatch",
      route: "interstitial",
    },
    {
      counts: {
        account_detail_marker_count: 0,
        export_affordance_candidates: [],
        navigation_marker_count: 0,
        target_count: 0,
        transaction_marker_count: 0,
      },
      finalUrl: "https://www.usaa.com/my/dashboard",
      identity: "mismatch",
      route: "unknown",
    },
  ]) {
    const diagnostics: DiagnosticInfo[] = [];
    const outcome = await driveExport(
      makeNoExportPage(finalUrl, counts),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      {
        onDiagnostics: (info) => diagnostics.push(info),
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );

    assert.deepEqual(outcome, { kind: "failed" });
    assert.deepEqual(diagnostics, [
      {
        account_page_identity: identity,
        diag: null,
        no_export_observation: {
          ...counts,
          account_page_identity: identity,
          affordance_disabled: false,
          route,
          surface_manifest: {
            capture_state: "captured",
            candidate_count: 0,
            candidates: [],
            control_count: 0,
            controls: [],
            phase: "after_export_affordance_probe",
          },
        },
        phase: "no_export_affordance",
      },
    ]);
  }
});

test("driveExport keeps a wrong-account route retryable instead of classifying terminal absence", async () => {
  const captureRoot = mkdtempSync(join(tmpdir(), "usaa-wrong-route-"));
  try {
    const diagnostics: DiagnosticInfo[] = [];
    const outcome = await driveExport(
      makeNoExportPage("https://www.usaa.com/my/checking?accountId=ACCT-CC-0001", {
        account_detail_marker_count: 1,
        export_affordance_candidates: [],
        navigation_marker_count: 2,
        target_count: 0,
        transaction_marker_count: 1,
      }),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      {
        fallbackDiagnosticRootOverride: captureRoot,
        onDiagnostics: (info) => diagnostics.push(info),
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );
    assert.deepEqual(outcome, { kind: "failed" });
    const [diag] = diagnostics;
    assert.ok(diag);
    assert.equal(diag.account_page_identity, "mismatch");
    assert.equal(diag.no_export_observation?.route, "unknown");
    assert.equal(classifyTerminalExportFailure(diag), null);
    assert.equal(classifyExportLadderOutcome(diag), "navigation_drifted");
  } finally {
    rmSync(captureRoot, { force: true, recursive: true });
  }
});

test("terminal classifiers require exact page identity even when route evidence claims expected", () => {
  const wrongPage: DiagnosticInfo = {
    account_page_identity: "mismatch",
    diag: null,
    no_export_observation: {
      account_detail_marker_count: 1,
      account_page_identity: "mismatch",
      affordance_disabled: true,
      export_affordance_candidates: [],
      navigation_marker_count: 2,
      route: "expected",
      target_count: 1,
      transaction_marker_count: 1,
    },
    phase: "no_export_affordance",
  };
  assert.equal(classifyTerminalExportFailure(wrongPage), null);
  assert.equal(classifyExportLadderOutcome(wrongPage), "navigation_drifted");
  const conflictingIdentity = { ...wrongPage, account_page_identity: "exact" as const };
  assert.equal(classifyTerminalExportFailure(conflictingIdentity), null);
  assert.equal(classifyExportLadderOutcome(conflictingIdentity), "navigation_drifted");

  const wrongDialog: DiagnosticInfo = {
    account_page_identity: "unverified",
    diag: null,
    phase: "export_dialog_unexpected_shape",
  };
  assert.equal(classifyTerminalExportFailure(wrongDialog), null);
  assert.equal(classifyExportLadderOutcome(wrongDialog), "navigation_drifted");
});

test("driveExport writes a redacted, byte-bounded alternate-surface receipt for a terminal no-export observation", async () => {
  const captureRoot = mkdtempSync(join(tmpdir(), "usaa-no-export-capture-"));
  try {
    const first = await driveExport(
      makeNoExportFallbackPage("View activity"),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      {
        fallbackDiagnosticRootOverride: captureRoot,
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );
    assert.deepEqual(first, { kind: "failed" });

    const fallbackPath = join(captureRoot, "usaa", "diagnostics", "no-export-affordance.json");
    const written = JSON.parse(await readFile(fallbackPath, "utf8"));
    assert.equal(written.phase, "no_export_affordance");
    assert.equal(written.observation.route, "expected");
    assert.equal(written.observation.target_count, 0);
    assert.equal(written.surface_controls.length, 1);
    assert.equal(written.page_title, null);
    assert.equal(written.surface_controls[0].label, "");
    assert.equal(written.surface_controls[0].href_path, null);
    assert.equal(written.surface_controls[0].class_name, "");
    assert.ok(
      Buffer.byteLength(await readFile(fallbackPath, "utf8"), "utf8") <= USAA_FALLBACK_SERIALIZED_BYTES_MAX,
      "fallback JSON must stay below the serialized-byte cap"
    );
    assert.doesNotMatch(JSON.stringify(written), /OTP 123456|owner@example\.com|ACCT-CHK-0001|View activity/);

    const second = await driveExport(
      makeNoExportFallbackPage("Statements"),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      {
        fallbackDiagnosticRootOverride: captureRoot,
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );
    assert.deepEqual(second, { kind: "failed" });
    const rewritten = JSON.parse(await readFile(fallbackPath, "utf8"));
    assert.equal(rewritten.surface_controls[0].label, "");
    assert.doesNotMatch(JSON.stringify(rewritten), /View activity|Statements/);
  } finally {
    rmSync(captureRoot, { force: true, recursive: true });
  }
});

// ─── Regression: navigation-drift no-export-affordance (2026-07-14 live capture) ─
//
// Real DOM captures from pdpp-reference-1's 2026-07-14T20-58-01-128Z USAA run
// (fixture-captures/usaa/raw/.../dom/transaction-export-Checking-3602-...-
// no-export-affordance.html and transaction-export-Family_Checking-9932-...-
// no-export-affordance.html) show `<title>Find an ATM | USAA</title>` and
// canonical URL https://www.usaa.com/my/banking-offer/ — a marketing/promo
// detour page, NOT the account detail page `locateExportPage` navigated
// toward. The account never reached the export UI; navigation drifted
// somewhere unrelated (a stale accountId query param or a promo interstitial
// are the two live suspects). Before this fix, `isFatalDiagPhase` treated
// EVERY `no_export_affordance` phase as fatal regardless of where we actually
// landed, so this drifted-navigation case was misclassified as
// `source_structure_changed` / `export_affordance_missing` — "USAA's export
// UI changed, don't bother retrying" — when the real problem was routing, not
// the UI. `classifyUsaaNoExportRoute` already computed the right answer
// (`"unknown"` — hostname is www.usaa.com but the pathname matches neither
// the account-detail nor interstitial regex) but nothing consulted it.

const USAA_MARKETING_DETOUR_URL = "https://www.usaa.com/my/banking-offer/";

test("classifyUsaaNoExportRoute: the real live marketing-detour URL (ATM finder / banking-offer) is 'unknown', never 'expected'", () => {
  // Mirrors the actual 2026-07-14 capture: hostname is www.usaa.com (so not
  // an off-domain redirect) but the pathname is the banking-offer promo page,
  // not an account-detail route — this must NOT read as a confirmed account
  // page regardless of whether stray structural markers happen to be present.
  assert.equal(classifyUsaaNoExportRoute(USAA_MARKETING_DETOUR_URL, true), "unknown");
  assert.equal(classifyUsaaNoExportRoute(USAA_MARKETING_DETOUR_URL, false), "unknown");
});

test("classifyExportLadderOutcome: a marketing-detour no_export_affordance is navigation_drifted, not source_structure_changed", () => {
  const drifted: DiagnosticInfo = {
    diag: null,
    no_export_observation: {
      account_detail_marker_count: 0,
      affordance_disabled: false,
      export_affordance_candidates: [],
      navigation_marker_count: 0,
      route: classifyUsaaNoExportRoute(USAA_MARKETING_DETOUR_URL, false),
      target_count: 0,
      transaction_marker_count: 0,
    },
    phase: "no_export_affordance",
  };
  assert.equal(classifyExportLadderOutcome(drifted), "navigation_drifted");

  // Contrast: the SAME phase with route "expected" (the ladder actually
  // reached the account/transaction page and the button was genuinely gone)
  // stays the truly-fatal source_structure_changed outcome — this fix must
  // not weaken that case.
  const confirmed: DiagnosticInfo = {
    ...drifted,
    account_page_identity: "exact",
    no_export_observation: { ...(drifted.no_export_observation as NoExportAffordanceObservation), route: "expected" },
  };
  assert.equal(classifyExportLadderOutcome(confirmed), "source_structure_changed");
});

test("isFatalDiagPhase (via driveExport→no_export_affordance ladder wiring): a drifted route does not halt the export ladder", async () => {
  // Exercise the real no-export path through driveExport (as tryExportLadder
  // does), landing on the marketing-detour URL with zero structural markers —
  // exactly the live capture's shape.
  const diagnostics: DiagnosticInfo[] = [];
  const outcome = await driveExport(
    makeNoExportPage(USAA_MARKETING_DETOUR_URL, {
      account_detail_marker_count: 0,
      navigation_marker_count: 0,
      target_count: 0,
      transaction_marker_count: 0,
    }),
    "https://www.usaa.com/my/checking?accountId=stale",
    {
      settleDelayMs: 0,
      sinceDate: "2026-06-10",
      untilDate: "2026-07-14",
      onDiagnostics: (info) => diagnostics.push(info),
    }
  );
  assert.deepEqual(outcome, { kind: "failed" });
  const [diag] = diagnostics;
  assert.ok(diag, "expected a no_export_affordance diagnostic");
  assert.equal(
    diag.no_export_observation?.route,
    "unknown",
    "the marketing detour classifies as unknown, not expected"
  );
  // This is the crux of the fix: classifyExportLadderOutcome (what
  // tryExportLadder's `isFatalDiagPhase` check now agrees with) must read
  // this as retryable, not the terminal structure-changed outcome.
  assert.equal(classifyExportLadderOutcome(diag), "navigation_drifted");
});

test("emitExportFailure: a drifted-navigation no-export-affordance is reported under its own reason, distinct from a confirmed structure change", async () => {
  const { deps, messages } = makeHarness();
  const driftedDiag: DiagnosticInfo = {
    diag: null,
    no_export_observation: {
      account_detail_marker_count: 0,
      affordance_disabled: false,
      export_affordance_candidates: [],
      navigation_marker_count: 0,
      route: "unknown",
      target_count: 0,
      transaction_marker_count: 0,
    },
    phase: "no_export_affordance",
  };
  await emitExportFailure(deps, makeAccount(), driftedDiag);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "navigation_drifted", "a drifted route must not be reported as export_affordance_missing");
  assert.notEqual(
    skip.reason,
    "export_affordance_missing",
    "must be distinguishable from the genuinely-fatal confirmed-account-page case"
  );
});

/** A page with a recognized export button but no date-range select ever
 *  rendering in the resulting dialog — drives driveExport into the
 *  "dialog-not-open" branch, which presses Escape after failing to find
 *  the select. Tracks call order so the test can prove the checkpoint
 *  capture happens on the still-intact page, before Escape mutates it. */
function makeDialogNotOpenPage(callOrder: string[]): Page {
  return Object.assign({} as Page, {
    evaluate() {
      return Promise.resolve({
        dialog_html_preview: null,
        dialogs_open: 0,
        export_candidates: [],
        has_utility_bar: false,
        nav_candidates: [],
        title: "",
        url: "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      });
    },
    goto() {
      return Promise.resolve(null);
    },
    keyboard: {
      press(key: string) {
        callOrder.push(`keyboard:${key}`);
        return Promise.resolve();
      },
    },
    locator(selector: string) {
      if (selector === "button.ent-as-utility-bar__item.export") {
        return {
          click() {
            return Promise.resolve();
          },
          count() {
            return Promise.resolve(1);
          },
          first() {
            return this;
          },
          isEnabled() {
            return Promise.resolve(true);
          },
        };
      }
      // Every other locator (the dialog select, the unexpected-shape
      // dialog probe) reports not found.
      return {
        count() {
          return Promise.resolve(0);
        },
        filter() {
          return this;
        },
        first() {
          return this;
        },
        innerHTML() {
          return Promise.reject(new Error("no dialog"));
        },
      };
    },
    title() {
      return Promise.resolve("Bank Account Summary | USAA");
    },
    url() {
      return "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001";
    },
  });
}

/** Same shape as makeDialogNotOpenPage, but the dialog DOES render (a
 *  `[role="dialog"]` element with real innerHTML) — just never gets the
 *  expected `select[name="selectionType"]`, so it still falls into the
 *  unexpected-shape branch, but this time with a real (non-null)
 *  `dialog_html_preview`. The fixture supports the in-memory diagnostic path;
 *  the durable fallback receipt must still contain no DOM/title evidence. */
function makeDialogWrongShapePage(dialogHtml: string, pageTitle = "Bank Account Summary | USAA"): Page {
  return Object.assign({} as Page, {
    evaluate() {
      return Promise.resolve({
        dialog_html_preview: null,
        dialogs_open: 1,
        export_candidates: [],
        has_utility_bar: false,
        nav_candidates: [],
        title: pageTitle,
        url: "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      });
    },
    goto() {
      return Promise.resolve(null);
    },
    keyboard: {
      press() {
        return Promise.resolve();
      },
    },
    locator(selector: string) {
      if (selector === "button.ent-as-utility-bar__item.export") {
        return {
          click() {
            return Promise.resolve();
          },
          count() {
            return Promise.resolve(1);
          },
          first() {
            return this;
          },
          isEnabled() {
            return Promise.resolve(true);
          },
        };
      }
      if (selector === '[role="dialog"]') {
        return {
          first() {
            return this;
          },
          innerHTML() {
            return Promise.resolve(dialogHtml);
          },
        };
      }
      return {
        count() {
          return Promise.resolve(0);
        },
        filter() {
          return this;
        },
        first() {
          return this;
        },
      };
    },
    title() {
      return Promise.resolve(pageTitle);
    },
    url() {
      return "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001";
    },
  });
}

test("driveExport captures the dialog-not-open checkpoint before pressing Escape", async () => {
  const callOrder: string[] = [];
  const outcome = await driveExport(
    makeDialogNotOpenPage(callOrder),
    "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
    {
      capture: {
        baseDir: "/tmp/unused",
        captureDom: (_page: Page, label: string) => {
          callOrder.push(`capture:${label}`);
          return Promise.resolve();
        },
        captureHttp: (label: string): void => {
          callOrder.push(`capture:${label}`);
        },
        finalize: (): void => undefined,
        keepOnSuccess: true,
        markSucceeded: (): void => undefined,
        recordRecord: (): void => undefined,
        runId: "test-dialog-not-open",
      } satisfies CaptureSession,
      captureLabel: "usaa-export",
      settleDelayMs: 0,
      sinceDate: "2026-01-01",
      untilDate: "2026-07-16",
    }
  );

  assert.deepEqual(outcome, { kind: "failed" });
  const captureIdx = callOrder.indexOf("capture:usaa-surface-export_checkpoint-dialog-not-open");
  const escapeIdx = callOrder.indexOf("keyboard:Escape");
  assert.notEqual(captureIdx, -1, "expected a dialog-not-open checkpoint capture");
  assert.notEqual(escapeIdx, -1, "expected an Escape keypress to dismiss the dialog");
  assert.ok(
    captureIdx < escapeIdx,
    `checkpoint capture must run before Escape mutates the page (capture=${captureIdx}, escape=${escapeIdx})`
  );
});

/**
 * Regression for the 2026-08-01 live run (run_a6568f40d5004a3f843a2a2b5a73df55,
 * account 1/4): `located.export.click()` can still time out for actionability
 * reasons OTHER than disabled (covered by an overlay, off-screen, etc.), and
 * Playwright's real timeout message for that shape is a multi-line call log
 * that easily runs past 160 chars. Before this fix, `emitExportClickFailedDiagnostic`
 * truncated the message to `ID_TEXT_SNIP` (160 chars) — sized for short
 * identifiers, not Playwright call logs — so the actionability detail was
 * lost before it ever reached `onDiagnostics`. This test drives a click()
 * that rejects with a realistic, >160-char call log — on a button that
 * reports itself enabled (proving this is the "click timed out despite
 * being enabled" path, distinct from the disabled-button short-circuit
 * covered by the "export-affordance-disabled" test below) — and asserts the
 * full call log survives into both the raw `onDiagnostics` payload and the
 * ladder-exhausted SKIP_RESULT message.
 */
test("driveExport surfaces the full call log on an export-click timeout, not just the first 160 chars", async () => {
  const realisticTimeoutMessage =
    'locator.click: Timeout 5000ms exceeded.\nCall log:\n  - waiting for locator(\'button.ent-as-utility-bar__item.export\').first()\n    - locator resolved to <button class="ent-as-utility-bar__item export" type="button">Export</button>\n    - element is not stable\n    - retrying click action\n      - waiting 20ms\n    - waiting for element to be visible, enabled and stable\n    - element is covered by another element\n    - retrying click action\n      - waiting 100ms';
  assert.ok(
    realisticTimeoutMessage.length > 160,
    "the fixture message must exceed the old 160-char cutoff to prove the regression"
  );

  const diagnostics: DiagnosticInfo[] = [];
  const page: Page = Object.assign({} as Page, {
    evaluate() {
      return Promise.resolve({
        dialog_html_preview: null,
        dialogs_open: 0,
        export_candidates: [],
        has_utility_bar: true,
        nav_candidates: [],
        title: "Bank Account Summary | USAA",
        url: "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      });
    },
    goto() {
      return Promise.resolve(null);
    },
    keyboard: { press: () => Promise.resolve() },
    locator(selector: string) {
      if (selector === "button.ent-as-utility-bar__item.export") {
        return {
          click: () => Promise.reject(new Error(realisticTimeoutMessage)),
          count: () => Promise.resolve(1),
          first(): unknown {
            return this;
          },
          isEnabled: () => Promise.resolve(true),
        };
      }
      return {
        count: () => Promise.resolve(0),
        filter(): unknown {
          return this;
        },
        first(): unknown {
          return this;
        },
      };
    },
    title: () => Promise.resolve("Bank Account Summary | USAA"),
    url: () => "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
  });

  const outcome = await driveExport(page, "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001", {
    onDiagnostics: (d) => diagnostics.push(d),
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    untilDate: "2026-07-16",
  });

  assert.deepEqual(outcome, { kind: "failed" });
  const clickFailed = diagnostics.find((d) => d.phase === "export_click_failed");
  assert.ok(clickFailed, "expected an export_click_failed diagnostic");
  assert.match(
    clickFailed?.error ?? "",
    /element is covered by another element/,
    "the actionability call log must survive truncation"
  );

  const { deps, messages } = makeHarness();
  await emitExportFailure(deps, makeAccount(), clickFailed ?? null);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.match(
    skip.message,
    /element is covered by another element/,
    "the actionability evidence must reach the emitted SKIP_RESULT message, not just the in-memory diagnostic"
  );
});

/**
 * Root-cause fix for the 2026-08-01 live run (run_e7a62f3e17a143819f1edca891544dea,
 * account 3/4, id 0002-PnwSxCt5HLlzn7raPcAK): the export button was located
 * (`button.as_credit__utility-bar-item.as_credit__export` matched, present in
 * the DOM) but stayed disabled through the entire EXPORT_CLICK_TIMEOUT_MS
 * click-actionability wait, for every candidate backfill window — the ladder
 * exhausted with the generic, evidence-poor `export_no_download`. Before this
 * fix, `openExportDialog` always attempted `.click()` first and only learned
 * "disabled" indirectly by parsing Playwright's call-log error string after
 * the click timed out — burning the full click timeout on an attempt that
 * was never going to succeed, and (per the test above) risking losing the
 * disabled marker to truncation. This test drives a located, present button
 * whose `isEnabled()` resolves `false` and asserts: (1) `.click()` is never
 * called at all (the wasted actionability wait is skipped), (2) the ladder
 * gets a precise `no_export_affordance` diagnostic with
 * `affordance_disabled: true` and `target_count > 0` — present-but-not-ready,
 * not "missing" — and (3) `classifyExportLadderOutcome` preserves the
 * `export_pressure` evidence label, never `source_structure_changed`, since a
 * disabled button is not evidence the source's export UI changed. The
 * separate terminal ladder classifier still stops date retries because
 * another window cannot enable this control.
 */
test("driveExport short-circuits a disabled-but-present export affordance to a precise no_export_affordance diagnostic, never attempting the click", async () => {
  let clickCalled = false;
  const diagnostics: DiagnosticInfo[] = [];
  const page: Page = Object.assign({} as Page, {
    evaluate(_fn: (...args: unknown[]) => unknown, arg?: unknown) {
      if (arg && typeof arg === "object" && "exportAffordance" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          account_detail_marker_count: 1,
          export_affordance_candidates: [
            {
              aria_disabled: false,
              cls: "as_credit__utility-bar-item as_credit__export",
              disabled: true,
              id: "export-btn-acct-3",
              role: "button",
              tag: "BUTTON",
              text: "Export",
              type: "button",
              visible: true,
            },
          ],
          navigation_marker_count: 2,
          target_count: 1,
          transaction_marker_count: 1,
        });
      }
      return Promise.resolve(null);
    },
    goto() {
      return Promise.resolve(null);
    },
    keyboard: { press: () => Promise.resolve() },
    locator(selector: string) {
      if (selector === "button.as_credit__utility-bar-item.as_credit__export") {
        return {
          click: () => {
            clickCalled = true;
            return Promise.resolve();
          },
          count: () => Promise.resolve(1),
          first(): unknown {
            return this;
          },
          isEnabled: () => Promise.resolve(false),
        };
      }
      return {
        count: () => Promise.resolve(0),
        filter(): unknown {
          return this;
        },
        first(): unknown {
          return this;
        },
      };
    },
    url: () => "https://www.usaa.com/my/credit-card?accountId=0002-PnwSxCt5HLlzn7raPcAK",
  });

  const outcome = await driveExport(page, "https://www.usaa.com/my/credit-card?accountId=0002-PnwSxCt5HLlzn7raPcAK", {
    onDiagnostics: (d) => diagnostics.push(d),
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    untilDate: "2026-07-16",
  });

  assert.deepEqual(outcome, { kind: "failed" });
  assert.equal(clickCalled, false, "a known-disabled button must never reach .click()");

  const noAffordance = diagnostics.find((d) => d.phase === "no_export_affordance");
  assert.ok(noAffordance, "expected a no_export_affordance diagnostic, not export_click_failed");
  assert.equal(noAffordance?.no_export_observation?.affordance_disabled, true);
  assert.equal(
    noAffordance?.no_export_observation?.target_count,
    1,
    "target_count must stay truthful — the button IS present, just not actionable"
  );

  const outcomeClass = classifyExportLadderOutcome(noAffordance ?? null);
  assert.equal(
    outcomeClass,
    "export_pressure",
    "a disabled-but-present affordance is pressure evidence, not a structural break"
  );

  // Account 3/4 in the live evidence is a credit-card account (its export
  // button matched the as_credit__* selector), so terminal disabled evidence
  // is more precise than the older generic credit-card-unverified reason. The
  // next run can still prove a supported
  // surface, but this run must not leave a retryable detail gap behind.
  const { deps, messages } = makeHarness();
  await emitExportFailure(deps, makeAccount({ account_type: "credit-card" }), noAffordance ?? null);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "export_affordance_disabled");
  assert.match(skip.message, /remained disabled/);
  assert.deepEqual(skip.recovery_hint, { action: "capture_live_surface", retryable: false });
  const stored = skip.diagnostics as { export_affordance_candidates?: Record<string, unknown>[] };
  const [storedCandidate] = stored.export_affordance_candidates ?? [];
  assert.ok(
    storedCandidate,
    "disabled-affordance evidence must reach stored diagnostics even for credit-card accounts"
  );
  assert.equal(storedCandidate.disabled, true);
});

test("driveExport capture keeps selector state while dropping page values and raw DOM capture", async () => {
  const captureRoot = mkdtempSync(join(tmpdir(), "usaa-safe-surface-capture-"));
  const captured: Array<{ body: unknown; label: string }> = [];
  let rawDomCaptureAttempted = false;
  try {
    const diagnostics: DiagnosticInfo[] = [];
    const outcome = await driveExport(
      makeCapturedDisabledExportPage(),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-987654",
      {
        capture: {
          baseDir: "/tmp/unused",
          captureDom: (): Promise<void> => {
            rawDomCaptureAttempted = true;
            return Promise.resolve();
          },
          captureHttp: (label: string, body: unknown): void => {
            captured.push({ body, label });
          },
          finalize: (): void => undefined,
          keepOnSuccess: true,
          markSucceeded: (): void => undefined,
          recordRecord: (): void => undefined,
          runId: "test-safe-surface-capture",
        } satisfies CaptureSession,
        fallbackDiagnosticRootOverride: captureRoot,
        onDiagnostics: (info) => diagnostics.push(info),
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );

    assert.deepEqual(outcome, { kind: "failed" });
    assert.equal(rawDomCaptureAttempted, false);
    assert.ok(captured.some(({ label }) => label === "usaa-surface-account_page_settled"));
    assert.ok(captured.some(({ label }) => label === "usaa-surface-after_export_affordance_probe"));
    const probeCapture = captured.find(({ label }) => label === "usaa-surface-after_export_affordance_probe");
    assert.ok(probeCapture);
    const probe = probeCapture?.body as {
      candidates: Record<string, unknown>[];
      controls: Record<string, unknown>[];
    };
    assert.deepEqual(probe.candidates[0]?.class_tokens, ["as_credit__utility-bar-item", "as_credit__export"]);
    assert.equal(probe.candidates[0]?.disabled, true);
    assert.equal(probe.candidates[0]?.visible, false);
    assert.equal(probe.candidates[1]?.text_category, "csv");
    assert.equal(probe.controls[0]?.name, "selectionType");
    const serialized = JSON.stringify(captured);
    assert.doesNotMatch(serialized, /987654|PRIVATE MERCHANT|account-/);
    assert.doesNotMatch(serialized, /"(?:text|id|href|url)"/);
    const diagnostic = diagnostics.find((info) => info.phase === "no_export_affordance");
    assert.equal(diagnostic?.no_export_observation?.surface_manifest?.candidates[0]?.disabled, true);
  } finally {
    rmSync(captureRoot, { force: true, recursive: true });
  }
});

/**
 * Same disabled-affordance shape as above, but on a non-credit-card
 * (checking) account, where `export_affordance_disabled` is the reason
 * actually reported (credit-card's unverified-flow reason doesn't apply).
 */
test("driveExport surfaces export_affordance_disabled as its own reason for a non-credit-card account", async () => {
  const diagnostics: DiagnosticInfo[] = [];
  const page: Page = Object.assign({} as Page, {
    evaluate(_fn: (...args: unknown[]) => unknown, arg?: unknown) {
      if (arg && typeof arg === "object" && "exportAffordance" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          account_detail_marker_count: 1,
          export_affordance_candidates: [
            {
              aria_disabled: false,
              cls: "ent-as-utility-bar__item export",
              disabled: true,
              id: "export-btn-acct-checking",
              role: "button",
              tag: "BUTTON",
              text: "Export",
              type: "button",
              visible: true,
            },
          ],
          navigation_marker_count: 2,
          target_count: 1,
          transaction_marker_count: 1,
        });
      }
      return Promise.resolve(null);
    },
    goto() {
      return Promise.resolve(null);
    },
    keyboard: { press: () => Promise.resolve() },
    locator(selector: string) {
      if (selector === "button.ent-as-utility-bar__item.export") {
        return {
          click: () => Promise.resolve(),
          count: () => Promise.resolve(1),
          first(): unknown {
            return this;
          },
          isEnabled: () => Promise.resolve(false),
        };
      }
      return {
        count: () => Promise.resolve(0),
        filter(): unknown {
          return this;
        },
        first(): unknown {
          return this;
        },
      };
    },
    url: () => "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0003",
  });

  const outcome = await driveExport(page, "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0003", {
    onDiagnostics: (d) => diagnostics.push(d),
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    untilDate: "2026-07-16",
  });
  assert.deepEqual(outcome, { kind: "failed" });

  const noAffordance = diagnostics.find((d) => d.phase === "no_export_affordance");
  assert.ok(noAffordance);
  assert.equal(noAffordance?.no_export_observation?.affordance_disabled, true);

  const { deps, messages } = makeHarness();
  await emitExportFailure(deps, makeAccount({ account_type: "checking" }), noAffordance ?? null);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "export_affordance_disabled");
  assert.match(skip.message, /remained disabled/);
  assert.deepEqual(skip.recovery_hint, { action: "capture_live_surface", retryable: false });
});

/**
 * Regression for the 2026-07-31 gate finding: the live pending gap on
 * 0002-qjnDfcbON1LHLxlg2AtzmEHo failed with phase=export_dialog_unexpected_shape,
 * and neither PDPP_CAPTURE_FIXTURES nor PDPP_CAPTURE_ON_FAILURE was set for
 * that run, so no dom/*.html checkpoint exists and the durable diagnostic
 * (`sanitizeDiagnosticInfo`) nulls dialog_html_preview before it reaches the
 * DB — the DOM shape that caused the failure is unrecoverable after the
 * fact. The bounded fallback write in `openExportDialog`'s !selectCount
 * branch fires unconditionally (not gated on `options.capture` or even
 * `onDiagnostics`) and closes that gap for the *next* occurrence. This test
 * drives driveExport with no `capture`/`onDiagnostics` at all (matching the
 * live run's actual configuration — this file's other tests always pass at
 * least a fake capture session or onDiagnostics callback; this one
 * deliberately passes neither) and asserts the fallback file lands anyway,
 * bounded to a single fixed filename (proving it can't grow unbounded
 * across repeated failures), strictly redacted, and hard-capped by serialized
 * UTF-8 bytes (proving hostile titles and DOM cannot reach disk).
 *
 * Uses `fallbackDiagnosticRootOverride` rather than mutating
 * `process.env.PDPP_CAPTURE_ROOT_DIR`: this file's tests run as concurrent
 * top-level test() calls by default, so a shared env mutation races with
 * unrelated tests in the same process.
 */
test("driveExport writes a bounded fallback capture for export_dialog_unexpected_shape even with no capture session configured", async () => {
  const captureRoot = mkdtempSync(join(tmpdir(), "usaa-fallback-capture-"));
  try {
    const longDialogHtml = `<div data-otp="123456" data-email="owner@example.com" data-account-id="ACCT-CHK-0001">${"x".repeat(2000)}</div>`;
    const hostileTitle = `OTP 123456 owner@example.com ACCT-CHK-0001 ${"T".repeat(1_000_000)}`;
    const outcome = await driveExport(
      makeDialogWrongShapePage(longDialogHtml, hostileTitle),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      {
        // Deliberately no `capture` and no `onDiagnostics` — matches
        // PDPP_CAPTURE_FIXTURES / PDPP_CAPTURE_ON_FAILURE both being unset
        // and no live diagnostics listener, as on the live 07-31 run.
        fallbackDiagnosticRootOverride: captureRoot,
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );
    assert.deepEqual(outcome, { kind: "failed" });

    const fallbackPath = join(captureRoot, "usaa", "diagnostics", "export-dialog-unexpected-shape.json");
    const written = JSON.parse(await readFile(fallbackPath, "utf8"));
    assert.equal(written.phase, "export_dialog_unexpected_shape");
    assert.equal(written.page_title, null);
    assert.equal(written.dialog_html_preview, null);
    assert.ok(
      Buffer.byteLength(await readFile(fallbackPath, "utf8"), "utf8") <= USAA_FALLBACK_SERIALIZED_BYTES_MAX,
      "fallback JSON must stay below the serialized-byte cap"
    );
    assert.doesNotMatch(
      JSON.stringify(written),
      /123456|owner@example\.com|ACCT-CHK-0001|unexpected-promo-dialog|x{601}/,
      "fallback must not persist OTP, email, account id, DOM, or hostile title evidence"
    );

    // A second occurrence overwrites, not accumulates — the whole point of
    // "bounded" is a fixed single file, not one per run.
    const secondOutcome = await driveExport(
      makeDialogWrongShapePage(`<div>${"y".repeat(2000)}</div>`, `SECOND ${"Y".repeat(1_000_000)}`),
      "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      {
        fallbackDiagnosticRootOverride: captureRoot,
        settleDelayMs: 0,
        sinceDate: "2026-01-01",
        untilDate: "2026-07-16",
      }
    );
    assert.deepEqual(secondOutcome, { kind: "failed" });
    const rewritten = JSON.parse(await readFile(fallbackPath, "utf8"));
    assert.equal(rewritten.page_title, null);
    assert.equal(rewritten.dialog_html_preview, null);
    assert.doesNotMatch(JSON.stringify(rewritten), /x{20}|y{20}|SECOND/);
  } finally {
    rmSync(captureRoot, { force: true, recursive: true });
  }
});

test("runSingleLadderAttempt retains a logon interstitial on the existing re-auth failure outcome", async () => {
  const { deps, messages } = makeHarness();
  deps.browserSurface = "managed";
  deps.reauthenticate = () => Promise.reject(new Error("private reauth failure must not persist"));
  let sessionDead = false;
  const outcome = await runSingleLadderAttempt({
    a: makeAccount(),
    accountOrdinal: 1,
    accountTotal: 1,
    attemptOrdinal: 1,
    attemptTotal: 1,
    context: {} as BrowserContext,
    deps,
    onDiagnostics() {
      // The logon redirect must reach re-auth, not the ordinary no-export callback.
    },
    onSessionDead() {
      sessionDead = true;
    },
    page: makeNoExportPage("https://www.usaa.com/my/logon", {
      account_detail_marker_count: 0,
      navigation_marker_count: 0,
      target_count: 0,
      transaction_marker_count: 0,
    }),
    sendInteraction: async () => ({ request_id: "test", status: "success", type: "INTERACTION_RESPONSE" }),
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    todayIso: "2026-07-16",
  });

  assert.deepEqual(outcome, { kind: "session_dead" });
  assert.equal(sessionDead, true, "the existing session-dead control flow is preserved");
  const skip = messages.find(
    (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      message.type === "SKIP_RESULT" && message.reason === "session_dead_reauth_failed"
  );
  assert.ok(skip);
  assert.deepEqual(skip.diagnostics, {
    browser_surface: {
      account_detail_marker_count: 0,
      activity_table_marker_count: 0,
      dashboard_marker_count: 0,
      managed_surface: "managed",
      navigation_marker_count: 0,
      parser_count: 0,
      phase: "no_export_affordance",
      posture: "unexpected",
      read_count: 1,
      route: "interstitial",
      surface: "usaa_transaction_export",
      target_count: 0,
      transaction_marker_count: 0,
      verified_empty_marker_count: 0,
      wait_outcome: "not_needed",
    },
  });
  assert.doesNotMatch(JSON.stringify(skip), /private reauth|https?:\/\/|accountId/i);
});

test("emitExportFailure: the dialog-unexpected-shape phase is also a structure-changed outcome", async () => {
  const { deps, messages } = makeHarness();
  const diag: DiagnosticInfo = {
    account_page_identity: "exact",
    phase: "export_dialog_unexpected_shape",
    diag: {
      url: "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0001",
      title: "Checking",
      has_utility_bar: false,
      export_candidates: [],
      nav_candidates: [],
      dialogs_open: 1,
      dialog_html_preview: "<div>unexpected</div>",
    },
  };
  await emitExportFailure(deps, makeAccount(), diag);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(
    skip.reason,
    "export_affordance_missing",
    "an unrecognized export dialog is a structure-changed outcome"
  );
  const emittedDiag = skip.diagnostics as DiagnosticInfo & { outcome: string };
  assert.equal(emittedDiag.outcome, "source_structure_changed");
});

test("emitExportFailure: a transient artifact-wait failure stays export_no_download (pressure outcome)", async () => {
  // The affordance and dialog were found and the export submitted; only the
  // download/body never materialized. That is recoverable on a later run, so
  // it must NOT be reported as a structure change.
  const { deps, messages } = makeHarness();
  const diag: DiagnosticInfo = {
    artifact: {
      cdpError: null,
      cdpReady: true,
      candidates: [],
      totalCdpRequestsStarted: 0,
      totalCdpResponsesSeen: 0,
      totalResponsesSeen: 0,
    },
    diag: null,
    error: "download_empty",
    phase: "export_artifact_wait_failed",
  };
  await emitExportFailure(deps, makeAccount(), diag);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "export_no_download", "submitted-but-no-download stays the transient pressure reason");
  assert.match(skip.message, /export_pressure/, "message names the pressure outcome class");
  const emittedDiag = skip.diagnostics as DiagnosticInfo & { outcome: string };
  assert.equal(emittedDiag.outcome, "export_pressure");
});

test("emitExportFailure: no diagnostic at all is an honest unknown outcome (still retryable)", async () => {
  // Every window failed without leaving a diagnostic phase. We don't claim to
  // know whether it was structural or transient, so the reason stays the
  // retryable `export_no_download` and the message says so plainly.
  const { deps, messages } = makeHarness();
  await emitExportFailure(deps, makeAccount(), null);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "export_no_download", "an unknown exhaustion stays retryable, not a structure change");
  assert.match(skip.message, /outcome unknown/, "message is honest that the outcome could not be determined");
  const emittedDiag = skip.diagnostics as { outcome: string };
  assert.equal(emittedDiag.outcome, "unknown");
});

test("emitExportFailure: artifact diagnostics are summarized when page diagnostics are unavailable", async () => {
  const { deps, messages } = makeHarness();
  const diag: DiagnosticInfo = {
    artifact: {
      cdpError: null,
      cdpReady: true,
      totalCdpRequestsStarted: 1,
      totalCdpResponsesSeen: 1,
      totalResponsesSeen: 1,
      candidates: [
        {
          bodyBytes: 128,
          contentDisposition: "",
          contentType: "text/plain",
          method: "POST",
          reason: "not_expected_body",
          source: "cdp",
          status: 200,
          url: "https://www.usaa.com/export",
        },
        {
          bodyError: "Protocol error",
          contentDisposition: "",
          contentType: "text/csv",
          method: "POST",
          reason: "body_error",
          source: "playwright",
          status: 200,
          url: "https://www.usaa.com/export",
        },
      ],
    },
    diag: null,
    error: "body_response_timeout after 45000ms",
    phase: "export_artifact_wait_failed",
  };
  await emitExportFailure(deps, makeAccount(), diag);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.match(skip.message, /export_artifact_wait_failed/);
  assert.match(skip.message, /page=unavailable/);
  assert.match(skip.message, /artifact cdpReady=true candidates=2 matched=0 bodyErrors=1/);
  assert.match(skip.message, /firstCandidate=cdp,200,not_expected_body,128B,text\/plain/);
  assert.doesNotMatch(skip.message, /url=https?:\/\//);
  assert.match(skip.message, /body_response_timeout/);
  const emittedDiag = skip.diagnostics as DiagnosticInfo;
  assert.equal(emittedDiag.artifact?.candidates[0]?.url, "", "artifact candidate URL is redacted before emission");
});

test("emitExportFailure: download diagnostics surface non-PII wait evidence when present", async () => {
  // Live-run regression: when `download_empty` fires under remote n.eko,
  // the candidates list is dominated by Adobe analytics beacons and the
  // real export URL is invisible. This test confirms non-PII download-side
  // evidence (byte count, source path, downloadFailure)
  // reaches the SKIP_RESULT message text so the next run can be triaged
  // offline without a second human OTP cycle.
  const { deps, messages } = makeHarness();
  const diag: DiagnosticInfo = {
    artifact: {
      cdpError: null,
      cdpReady: true,
      candidates: [],
      totalCdpRequestsStarted: 0,
      totalCdpResponsesSeen: 0,
      totalResponsesSeen: 0,
    },
    diag: null,
    download: {
      url: "https://www.usaa.com/inet/ent_logon/bnk/dmd/chk/transactionDownload",
      suggestedFilename: "transaction_history.csv",
      bytes: 0,
      source: "createReadStream",
      saveAsError: "saveAs_returned_zero_bytes",
      streamError: null,
      downloadFailure: "Download canceled by remote",
    },
    error: "download_empty",
    phase: "export_artifact_wait_failed",
  };
  await emitExportFailure(deps, makeAccount(), diag);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.match(skip.message, /export_artifact_wait_failed/);
  assert.doesNotMatch(skip.message, /https?:\/\/|transaction_history\.csv/);
  assert.match(skip.message, /bytes=0/);
  assert.match(skip.message, /source=createReadStream/);
  assert.match(skip.message, /saveAsError=saveAs_returned_zero_bytes/);
  assert.match(skip.message, /downloadFailure=Download canceled by remote/);
  const emittedDiag = skip.diagnostics as DiagnosticInfo;
  assert.equal(emittedDiag.download?.url, null, "download URL is redacted before emission");
  assert.equal(emittedDiag.download?.suggestedFilename, null, "download filename is redacted before emission");
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
  assert.match(skip.message, /credit-card export flow remains live-unverified/);
});

/**
 * Regression for the 2026-08-01 REVISE gate (run_a6568f40d5004a3f843a2a2b5a73df55,
 * account 1/4): a confirmed account-detail page with zero clickable export
 * buttons resolves `no_export_affordance`/`export_affordance_missing` with
 * only structural counts — no bounded evidence of *why* the button wasn't
 * clickable (e.g. present but disabled, or hidden). This test drives
 * `driveExport` through a disabled, hidden-from-a11y export button — the
 * account-4-style shape (button exists in the DOM, `target_count` would be
 * 0 for a strict "clickable" selector match) — and asserts the bounded
 * actionability descriptor (tag/role/type/disabled/aria_disabled/visible)
 * reaches the stored SKIP_RESULT diagnostics, while raw `id`/`text`/page
 * HTML/account data are redacted the same way `export_candidates` already are.
 */
test("driveExport surfaces bounded export-affordance actionability evidence on a no-affordance account-detail page", async () => {
  const diagnostics: DiagnosticInfo[] = [];
  const page: Page = Object.assign({} as Page, {
    evaluate(_fn: (...args: unknown[]) => unknown, arg?: unknown) {
      if (arg && typeof arg === "object" && "exportAffordance" in (arg as Record<string, unknown>)) {
        return Promise.resolve({
          account_detail_marker_count: 1,
          export_affordance_candidates: [
            {
              aria_disabled: true,
              cls: "ent-as-utility-bar__item export",
              disabled: true,
              id: "export-btn-acct-4-secret",
              role: "button",
              tag: "BUTTON",
              text: "Export (account 0001-SECRET)",
              type: "button",
              visible: false,
            },
          ],
          navigation_marker_count: 2,
          target_count: 0,
          transaction_marker_count: 1,
        });
      }
      return Promise.resolve(null);
    },
    goto() {
      return Promise.resolve(null);
    },
    locator() {
      return {
        count: () => Promise.resolve(0),
        filter(): unknown {
          return this;
        },
        first(): unknown {
          return this;
        },
      };
    },
    url: () => "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0004",
  });

  const outcome = await driveExport(page, "https://www.usaa.com/my/checking?accountId=ACCT-CHK-0004", {
    onDiagnostics: (d) => diagnostics.push(d),
    settleDelayMs: 0,
    sinceDate: "2026-01-01",
    untilDate: "2026-07-16",
  });

  assert.deepEqual(outcome, { kind: "failed" });
  const noAffordance = diagnostics.find((d) => d.phase === "no_export_affordance");
  assert.ok(noAffordance, "expected a no_export_affordance diagnostic");
  const [candidate] = noAffordance?.no_export_observation?.export_affordance_candidates ?? [];
  assert.ok(candidate, "expected an in-memory export-affordance candidate");
  assert.equal(candidate.disabled, true);
  assert.equal(candidate.aria_disabled, true);
  assert.equal(candidate.visible, false);
  assert.equal(candidate.role, "button");
  assert.equal(candidate.tag, "BUTTON");
  assert.equal(
    noAffordance?.no_export_observation?.affordance_disabled,
    false,
    "target_count === 0 means the strict export-affordance selector matched nothing — genuinely absent, " +
      "not the same evidence as a located-but-disabled button (see the export-affordance-disabled test)"
  );

  const outcomeClass = classifyExportLadderOutcome(noAffordance ?? null);
  assert.equal(
    outcomeClass,
    "source_structure_changed",
    "a confirmed, genuinely absent export affordance stays fatal/structural"
  );

  const { deps, messages } = makeHarness();
  await emitExportFailure(deps, makeAccount({ account_type: "checking" }), noAffordance ?? null);
  const skip = messages.find((m): m is Extract<EmittedMessage, { type: "SKIP_RESULT" }> => m.type === "SKIP_RESULT");
  assert.ok(skip);
  assert.equal(skip.reason, "export_affordance_missing");
  const stored = skip.diagnostics as {
    export_affordance_candidates?: Record<string, unknown>[];
  };
  const [storedCandidate] = stored.export_affordance_candidates ?? [];
  assert.ok(storedCandidate, "bounded actionability evidence must reach the stored SKIP_RESULT diagnostics");
  assert.equal(storedCandidate.disabled, true, "actionability fact survives into stored diagnostics");
  assert.equal(storedCandidate.aria_disabled, true);
  assert.equal(storedCandidate.visible, false);
  assert.equal(storedCandidate.role, "button");
  assert.equal(storedCandidate.tag, "BUTTON");
  assert.equal(storedCandidate.id, null, "raw id must be redacted before durable storage");
  assert.equal(storedCandidate.text, "", "free-text (which could carry account data) must be redacted");
  assert.equal(
    JSON.stringify(skip.diagnostics).includes("SECRET"),
    false,
    "no raw account-derived text may reach stored diagnostics"
  );
});

test("isNoDataExportMessage: distinguishes source-empty export dialogs from generic failures", () => {
  assert.equal(isNoDataExportMessage("There are no transactions for the selected date range."), true);
  assert.equal(isNoDataExportMessage("Nothing to export for this account."), true);
  assert.equal(isNoDataExportMessage("We couldn't process your request right now."), false);
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

test("usaa manifest: successful manual runs have a bounded freshness window", () => {
  const manifest = JSON.parse(readFileSync(USAA_MANIFEST_PATH, "utf8")) as {
    capabilities?: { refresh_policy?: { maximum_staleness_seconds?: number; recommended_mode?: string } };
  };
  const policy = manifest.capabilities?.refresh_policy;
  assert.equal(policy?.recommended_mode, "manual");
  assert.equal(policy?.maximum_staleness_seconds, 86_400);
});
