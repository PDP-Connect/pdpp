/**
 * Unit tests for the shared statement hydration carry-forward primitive.
 *
 * These pin the contract both statement connectors (chase, usaa) rely on:
 *   - a previously-hydrated statement that fails hydration this run carries
 *     its prior pointers and content fingerprint forward (no value->null flap),
 *   - a never-hydrated statement that fails hydration stays all-null,
 *   - a successful (re)hydration overwrites the carried pointers,
 *   - prune drops statements no longer listed,
 *   - the STATE map round-trips and decodes tolerantly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isHydrated,
  NEVER_HYDRATED,
  openStatementHydrationCursor,
  readPriorStatementHydration,
  type StatementHydration,
} from "./statement-hydration-carry-forward.ts";

const HYD: StatementHydration = {
  document_url: "file:///tmp/chase/2026-04-aaaa.pdf",
  pdf_path: "/tmp/chase/2026-04-aaaa.pdf",
  pdf_sha256: "a".repeat(64),
  pdf_text_sha256: null,
  pdf_page_count: null,
};

function priorMapFrom(state: Record<string, unknown>): ReadonlyMap<string, StatementHydration> {
  return readPriorStatementHydration(state);
}

test("isHydrated: only a complete pointer triple counts as hydrated", () => {
  assert.equal(isHydrated(HYD), true);
  assert.equal(isHydrated(NEVER_HYDRATED), false);
  assert.equal(isHydrated(undefined), false);
  assert.equal(isHydrated({ ...HYD, pdf_path: null }), false, "partial triple is not hydrated");
});

test("resolveOnFailure: previously-hydrated statement carries prior pointers forward", () => {
  // Run A hydrated S1; run B opens a cursor seeded from A's state.
  const cursorA = openStatementHydrationCursor(new Map());
  cursorA.note("S1", HYD);
  const stateA = { hydration: cursorA.toState() };

  const cursorB = openStatementHydrationCursor(priorMapFrom(stateA));
  const carried = cursorB.resolveOnFailure("S1");
  assert.deepEqual(carried, HYD, "failure on a previously-hydrated statement carries prior pointers");
  // The connector then notes the resolved value so the next run still has it.
  cursorB.note("S1", carried);
  assert.deepEqual(cursorB.toState().S1, HYD, "carried pointers survive into the next STATE");
});

test("resolveOnFailure: never-hydrated statement stays all-null (honest index-only)", () => {
  const cursor = openStatementHydrationCursor(new Map());
  const resolved = cursor.resolveOnFailure("NEVER");
  assert.deepEqual(resolved, NEVER_HYDRATED, "a statement with no prior hydration stays all-null");
  assert.equal(resolved.pdf_path, null);
});

test("note: a successful (re)hydration overwrites the carried pointers", () => {
  const cursorA = openStatementHydrationCursor(new Map());
  cursorA.note("S1", HYD);
  const stateA = { hydration: cursorA.toState() };

  const cursorB = openStatementHydrationCursor(priorMapFrom(stateA));
  const rehydrated: StatementHydration = {
    document_url: "file:///tmp/chase/2026-04-bbbb.pdf",
    pdf_path: "/tmp/chase/2026-04-bbbb.pdf",
    pdf_sha256: "b".repeat(64),
    pdf_text_sha256: "c".repeat(64),
    pdf_page_count: 3,
  };
  cursorB.note("S1", rehydrated);
  assert.deepEqual(cursorB.toState().S1, rehydrated, "a fresh hydration replaces the prior pointers");
});

test("pruneStale: a statement no longer listed stops being carried forward", () => {
  const cursorA = openStatementHydrationCursor(new Map());
  cursorA.note("S1", HYD);
  cursorA.note("S2", HYD);
  const stateA = { hydration: cursorA.toState() };

  // Run B only sees S1 (S2 fell off the documents index).
  const cursorB = openStatementHydrationCursor(priorMapFrom(stateA));
  cursorB.note("S1", cursorB.resolveOnFailure("S1"));
  cursorB.pruneStale();
  const next = cursorB.toState();
  assert.ok(next.S1, "still-listed statement is retained");
  assert.equal(next.S2, undefined, "delisted statement is pruned");
});

test("readPriorStatementHydration: tolerates missing / legacy / malformed state", () => {
  assert.equal(readPriorStatementHydration({}).size, 0, "empty state → empty map");
  assert.equal(readPriorStatementHydration({ fetched_at: "x" }).size, 0, "legacy cursor (no hydration) → empty map");
  assert.equal(readPriorStatementHydration({ hydration: 5 }).size, 0, "malformed hydration value → empty map");
  assert.equal(readPriorStatementHydration(null).size, 0, "null state → empty map");
  assert.equal(
    readPriorStatementHydration({ hydration: { S1: { document_url: null, pdf_path: null, pdf_sha256: null } } }).size,
    0,
    "an all-null prior entry is not carriable and is dropped"
  );
  const ok = readPriorStatementHydration({ hydration: { S1: HYD, bad: { pdf_path: 5 } } });
  assert.equal(ok.size, 1, "valid hydrated entries kept, invalid dropped");
  assert.deepEqual(ok.get("S1"), HYD);
});
