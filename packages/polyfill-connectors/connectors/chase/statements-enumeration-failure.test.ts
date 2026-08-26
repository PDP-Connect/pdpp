// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Statement-list enumeration must fail closed. These tests use only fake
 * Playwright pages and fixture HTML; no provider navigation or authentication
 * is possible from this file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateStreamCoherence } from "@pdpp/reference-contract/evidence";
import type { Page } from "playwright";
import type { EmittedMessage, StreamScope } from "../../src/connector-runtime.ts";
import { openFingerprintCursor } from "../../src/fingerprint-cursor.ts";
import { openStatementHydrationCursor, type StatementHydration } from "../../src/statement-hydration-carry-forward.ts";
import { makeRecordingEmit } from "../../src/test-harness.ts";
import { type EmitDeps, runStatements } from "./index.ts";
import { validateRecord } from "./schemas.ts";

const EMITTED_AT = "2026-08-23T12:00:00.000Z";
const PRIOR_HYDRATION: StatementHydration = {
  document_url: "file:///tmp/chase/S1.pdf",
  pdf_path: "/tmp/chase/S1.pdf",
  pdf_sha256: "a".repeat(64),
  pdf_text_sha256: "b".repeat(64),
  pdf_page_count: 4,
};

function makeDeps(): { deps: EmitDeps; messages: EmittedMessage[] } {
  const recording = makeRecordingEmit(validateRecord);
  const requested = new Map<string, StreamScope>([["statements", { name: "statements" }]]);
  return {
    deps: {
      capture: null,
      emit: recording.emit,
      emitRecord: recording.emitRecord,
      emittedAt: EMITTED_AT,
      maxSeenByAccount: {},
      progress: (): Promise<void> => Promise.resolve(),
      requested,
      resFilters: new Map(),
      tmpDir: "/tmp/chase-enumeration-failure-test",
      txState: {},
      wantsAccounts: false,
      wantsBalances: false,
      wantsCurrentActivity: false,
      wantsStatements: true,
      wantsTransactions: false,
    },
    messages: recording.protocolMessages,
  };
}

function fakeStatementsPage(content: () => Promise<string>): Page {
  return {
    content,
    goto: async () => undefined,
    locator: () => ({
      first: () => ({
        waitFor: async () => undefined,
      }),
    }),
  } as unknown as Page;
}

function statementSkip(messages: EmittedMessage[]): Extract<EmittedMessage, { type: "SKIP_RESULT" }> | undefined {
  return messages.find(
    (message): message is Extract<EmittedMessage, { type: "SKIP_RESULT" }> =>
      message.type === "SKIP_RESULT" && message.stream === "statements"
  );
}

test("statement enumeration failure is not an empty complete run and preserves cursors", async () => {
  const { deps, messages } = makeDeps();
  const fingerprints = openFingerprintCursor(
    { fingerprints: { S1: "prior-fingerprint" } },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const hydration = openStatementHydrationCursor(new Map([["S1", PRIOR_HYDRATION]]));

  await runStatements(
    deps,
    fakeStatementsPage(async () => Promise.reject(new Error("fixture DOM failure"))),
    [],
    [],
    null,
    fingerprints,
    hydration
  );

  const skip = statementSkip(messages);
  assert.ok(skip, "statement scrape failure must surface through Chase's own failure path");
  assert.equal(skip.reason, "statements_scrape_failed");
  assert.equal(
    messages.some((message) => message.type === "DETAIL_COVERAGE"),
    false,
    "failed enumeration must not emit coverage, including a false 0/0"
  );
  assert.equal(
    messages.some((message) => message.type === "STATE" && message.stream === "statements"),
    false,
    "failed enumeration must not write a statements STATE checkpoint"
  );
  assert.equal(fingerprints.size(), 1, "failed enumeration must not prune hydration fingerprints");
  assert.equal(hydration.size(), 1, "failed enumeration must not prune hydration pointers");

  const verdict = evaluateStreamCoherence(
    {
      checkpoint: null,
      collected: 0,
      considered: null,
      covered: null,
      pending_detail_gaps: 0,
      skipped: { reason: skip.reason },
    },
    { coverage_strategy: "full_inventory", accepted_absence: null }
  );
  assert.deepEqual(verdict, { proven: false, reason: "unresolved_attempt" });
});

test("healthy empty statement enumeration still reports measured complete 0/0", async () => {
  const { deps, messages } = makeDeps();
  const fingerprints = openFingerprintCursor(
    { fingerprints: { stale: "prior-fingerprint" } },
    { excludeFromFingerprint: ["fetched_at"] }
  );
  const hydration = openStatementHydrationCursor(new Map([["stale", PRIOR_HYDRATION]]));

  await runStatements(
    deps,
    fakeStatementsPage(async () => "<!doctype html><html><body><div class=documents-page></div></body></html>"),
    [],
    [],
    null,
    fingerprints,
    hydration
  );

  const coverage = messages.find(
    (message): message is Extract<EmittedMessage, { type: "DETAIL_COVERAGE" }> =>
      message.type === "DETAIL_COVERAGE" && message.stream === "statements"
  );
  assert.ok(coverage, "successful enumeration must emit statement coverage");
  assert.equal(coverage.considered, 0);
  assert.equal(coverage.covered, 0);
  assert.ok(messages.some((message) => message.type === "STATE" && message.stream === "statements"));
  assert.equal(fingerprints.size(), 0, "a successful full scan may prune a stale fingerprint");
  assert.equal(hydration.size(), 0, "a successful full scan may prune stale hydration");

  const verdict = evaluateStreamCoherence(
    {
      checkpoint: "committed",
      collected: 0,
      considered: coverage.considered ?? null,
      covered: coverage.covered ?? null,
      pending_detail_gaps: 0,
      skipped: null,
    },
    { coverage_strategy: "full_inventory", accepted_absence: null }
  );
  assert.deepEqual(verdict, { proven: true, reason: "enumeration_boundary" });
});
