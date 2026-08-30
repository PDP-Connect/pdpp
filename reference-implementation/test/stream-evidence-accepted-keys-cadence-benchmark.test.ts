// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Reproducible production-cadence benchmark for the STREAM_EVIDENCE
 * accepted-keys store (`createAcceptedKeysStore`, runtime/index.ts).
 *
 * Independent review (STREAM-EVIDENCE-P1-2-REREVIEW.md item 1) found the
 * prior implementation report's 1M-row benchmark measured one transaction
 * containing 1,000,000 inserts (1,168-1,221ms) -- not the shape production
 * actually runs. Production commits once per `flushBatch` call, and the
 * default flush size (`BATCH_SIZE`, runtime/index.ts) is 500 records, so 1M
 * accepted keys means **2,000 separate transactions**, not one. The review's
 * own bounded measurement of that real cadence, against the pre-fix schema
 * (rollback-journal mode, `synchronous=FULL`, node:sqlite's default -- two
 * fsync barriers per COMMIT), was 138,336ms: ~118x slower than the
 * single-transaction number, entirely explained by fsync-per-commit
 * overhead. The fix is `PRAGMA journal_mode = WAL` + `PRAGMA synchronous =
 * NORMAL` (added to `createAcceptedKeysStore`'s `ensureOpen`), which defers
 * the fsync barrier to a later WAL checkpoint rather than paying it on every
 * commit -- safe here because this store is a per-run, per-process
 * ephemeral temp file with no cross-crash durability requirement (see the
 * doc comment at the PRAGMA call site for the full argument).
 *
 * This file is the reproducible oracle the review asked for: it extracts
 * the EXACT schema/PRAGMA/insert SQL strings, and the EXACT `BATCH_SIZE`
 * default, out of runtime/index.ts by source inspection (not a hand-copied
 * mirror that can silently drift), then replays the real production cadence
 * -- 2,000 transactions of however many rows `BATCH_SIZE` actually defaults
 * to -- against a `node:sqlite` database file, and asserts against an
 * explicit, defensible acceptance target.
 *
 * Honest disclosure on "disk-backed": this file opens the database at a
 * path under `os.tmpdir()`, not `:memory:`, so SQLite issues real file I/O
 * (open/write/fsync syscalls) rather than skipping storage entirely. But in
 * THIS session's own environment, `os.tmpdir()` resolves onto a tmpfs
 * (RAM-backed) mount, confirmed via `df -T` -- so those syscalls do not
 * reach a physical disk here, and fsync is nearly free regardless of
 * journal mode on this machine. The measured numbers below are this
 * environment's numbers, not a guarantee about every CI/production host's
 * storage; see the sanity test below for the bound this environment CAN
 * make (the PRAGMAs actually take effect), and independent review's own
 * 138,336ms figure (STREAM-EVIDENCE-P1-2-REREVIEW.md item 1, a real
 * disk-backed measurement) for the regression class this acceptance target
 * defends against.
 *
 * Acceptance target: total wall-clock for the full 1,000,000-row production
 * cadence MUST stay under 20,000ms (20s). Rationale: the review's own
 * measurement of the UNFIXED cadence (rollback-journal, synchronous=FULL)
 * was 138,336ms -- a regression back to that configuration fails this gate
 * by roughly 7x, with no risk of a false pass. The WAL+NORMAL cadence
 * measured on this session's reference hardware is ~1,200-1,700ms, leaving
 * roughly 12-15x headroom for slower CI/sandboxed storage before the gate
 * would trip on the FIXED configuration. 20s is also small relative to a
 * real 1,000,000-record connector run's total wall-clock (dominated by the
 * per-batch HTTP round-trip to the RS, not this store), so the store cannot
 * become the run's bottleneck at this row count under the fix.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUNTIME_INDEX_PATH = join(HERE, "..", "runtime", "index.ts");

const UNESCAPED_DOUBLE_QUOTE_PATTERN = /(?<!\\)"/;
const INTEGER_FALLBACK_LITERAL_PATTERN = /^\s*\|\|\s*(\d+)/;

/**
 * Extract the double-quoted string literal that starts at `needle`'s own
 * opening quote. `needle` is expected to end exactly at (and include) the
 * opening `"` of the literal, e.g. `db.exec("PRAGMA journal_mode`.
 */
function extractSqlLiteral(source: string, needle: string): string {
  const idx = source.indexOf(needle);
  assert.ok(idx >= 0, `expected to find call site containing ${JSON.stringify(needle)} in runtime/index.ts`);
  const literalStart = idx + needle.lastIndexOf('"');
  const closingQuoteOffset = source.slice(literalStart + 1).search(UNESCAPED_DOUBLE_QUOTE_PATTERN);
  assert.ok(
    closingQuoteOffset >= 0,
    `expected a closing quote for the string literal starting at ${JSON.stringify(needle)}`
  );
  const literal = source.slice(literalStart + 1, literalStart + 1 + closingQuoteOffset);
  return literal.replace(/\\"/g, '"');
}

/**
 * Extract the integer literal that immediately follows `needle` (skipping
 * exactly one `|| ` fallback separator), e.g. reading `500` out of
 * `Number(process.env.PDPP_RUNTIME_BATCH_SIZE) || 500`. Independent
 * exact-head re-review (item 3) found this file previously hardcoded
 * `PRODUCTION_DEFAULT_BATCH_SIZE = 500` as a copied constant rather than
 * binding it to the shipping default in `runtime/index.ts` — a future
 * change to that default would leave this benchmark green while it no
 * longer represented the real production cadence. Extracting the literal
 * makes that class of drift impossible to miss: if the runtime's default
 * ever changes, this extraction either finds the new number automatically
 * (and the benchmark measures the new real cadence) or fails outright if
 * the call site's shape changes beyond a bare fallback integer.
 */
function extractIntegerLiteralAfter(source: string, needle: string): number {
  const idx = source.indexOf(needle);
  assert.ok(idx >= 0, `expected to find call site containing ${JSON.stringify(needle)} in runtime/index.ts`);
  const after = source.slice(idx + needle.length);
  const match = after.match(INTEGER_FALLBACK_LITERAL_PATTERN);
  assert.ok(match, `expected an integer fallback literal (\`|| <int>\`) immediately after ${JSON.stringify(needle)}`);
  return Number((match as RegExpMatchArray)[1]);
}

/**
 * Read the exact PRAGMA/schema/insert SQL, and the exact shipping
 * `BATCH_SIZE` default, runtime/index.ts uses, straight from the source
 * file. This is what makes the benchmark a genuine reproduction rather
 * than a hand-copied mirror that can silently drift from production: if
 * the pragmas, table shape, insert statement, or default batch size ever
 * change in runtime/index.ts without a matching update here, the
 * extraction either fails outright (the call site text it searches for is
 * gone) or the benchmark starts measuring something production no longer
 * does -- either way visible in review.
 */
function readProductionAcceptedKeysSql(): {
  createTable: string;
  defaultBatchSize: number;
  insert: string;
  journalMode: string;
  synchronous: string;
} {
  const source = readFileSync(RUNTIME_INDEX_PATH, "utf8");
  return {
    createTable: extractSqlLiteral(source, 'db.exec("CREATE TABLE accepted_keys'),
    defaultBatchSize: extractIntegerLiteralAfter(source, "Number(process.env.PDPP_RUNTIME_BATCH_SIZE)"),
    insert: extractSqlLiteral(source, 'db.prepare("INSERT OR IGNORE INTO accepted_keys'),
    journalMode: extractSqlLiteral(source, 'db.exec("PRAGMA journal_mode'),
    synchronous: extractSqlLiteral(source, 'db.exec("PRAGMA synchronous'),
  };
}

const BENCHMARK_ROW_COUNT = 1_000_000;
/** See file header for the full rationale. */
const ACCEPTANCE_TARGET_MS = 20_000;

test("accepted-keys store: production flush cadence (2,000 x 500-row transactions) stays under the acceptance target", () => {
  const sql = readProductionAcceptedKeysSql();
  assert.equal(
    sql.journalMode,
    "PRAGMA journal_mode = WAL",
    "benchmark must exercise the same journal mode production sets"
  );
  assert.equal(
    sql.synchronous,
    "PRAGMA synchronous = NORMAL",
    "benchmark must exercise the same synchronous mode production sets"
  );

  const dir = mkdtempSync(join(tmpdir(), "pdpp-accepted-keys-cadence-benchmark-"));
  const db = new DatabaseSync(join(dir, "accepted-keys.sqlite"));
  try {
    db.exec(sql.journalMode);
    db.exec(sql.synchronous);
    db.exec(sql.createTable);
    const insertStmt = db.prepare(sql.insert);

    const flushCount = BENCHMARK_ROW_COUNT / sql.defaultBatchSize;
    assert.equal(
      Math.trunc(flushCount),
      flushCount,
      "row count must divide evenly by BATCH_SIZE for this benchmark's math to be exact"
    );

    let key = 0;
    const start = process.hrtime.bigint();
    for (let flush = 0; flush < flushCount; flush += 1) {
      db.exec("BEGIN IMMEDIATE");
      for (let row = 0; row < sql.defaultBatchSize; row += 1) {
        insertStmt.run("message_bodies", `benchmark-key-${key}`);
        key += 1;
      }
      db.exec("COMMIT");
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    const countStmt = db.prepare("SELECT COUNT(*) AS c FROM accepted_keys WHERE stream = ?");
    const row = countStmt.get("message_bodies") as { c: number } | undefined;
    assert.equal(row?.c, BENCHMARK_ROW_COUNT, "every row across all 2,000 transactions must be durably present");

    assert.ok(
      elapsedMs < ACCEPTANCE_TARGET_MS,
      `production-cadence benchmark took ${elapsedMs.toFixed(1)}ms for ${flushCount} transactions ` +
        `(${BENCHMARK_ROW_COUNT} rows), exceeding the ${ACCEPTANCE_TARGET_MS}ms acceptance target. ` +
        "This is the exact regression class independent review found: a return to " +
        "per-commit fsync overhead (rollback-journal mode / synchronous=FULL) measured " +
        "138,336ms for this identical cadence."
    );
  } finally {
    db.close();
    rmSync(dir, { force: true, recursive: true });
  }
});

test("sanity: the store's PRAGMAs are actually applied, not silently ignored", () => {
  // A relative same-hardware A/B (WAL+NORMAL vs. the node:sqlite default)
  // was tried as a discriminating mutation control and rejected: this
  // suite's own OS tmpdir is tmpfs (RAM-backed, `df -T` confirms), where
  // fsync is nearly free regardless of journal mode -- the two cadences
  // measured within noise of each other (285ms vs 270ms at 200k rows),
  // which would make that comparison flaky-by-environment rather than
  // discriminating. The 138,336ms-vs-1,168ms gap independent review
  // reproduced only shows up against real disk I/O, which this sandboxed
  // environment's tmpdir does not exercise. Asserting the PRAGMAs actually
  // took effect (rather than silently no-op'ing, e.g. because WAL is
  // unsupported against a given libsqlite build) is the guard this
  // environment CAN make: if journal_mode never switched from its default
  // ('delete'), the fix shipped is inert everywhere, including on real disks.
  const dir = mkdtempSync(join(tmpdir(), "pdpp-accepted-keys-pragma-sanity-"));
  const db = new DatabaseSync(join(dir, "accepted-keys.sqlite"));
  try {
    const { journal_mode: beforeJournalMode } = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(beforeJournalMode, "delete", "node:sqlite's own default journal mode must be what this test assumes");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    const { journal_mode: journalMode } = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    const { synchronous } = db.prepare("PRAGMA synchronous").get() as { synchronous: number };
    assert.equal(journalMode, "wal", "PRAGMA journal_mode = WAL must actually take effect");
    assert.equal(synchronous, 1, "PRAGMA synchronous = NORMAL must actually take effect (SQLite's NORMAL = 1)");
  } finally {
    db.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
