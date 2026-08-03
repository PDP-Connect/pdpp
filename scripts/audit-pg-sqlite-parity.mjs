#!/usr/bin/env node
/**
 * Deterministic PG/SQLite filter-parity oracle.
 *
 * Defect class under audit (found live on /grants pagination):
 *   a Postgres implementation silently ignores a filter/opt that its SQLite
 *   counterpart honours, so the caller's argument is accepted and dropped.
 *   `postgresListSpineCorrelations` accepted `filters.cursor`, emitted a
 *   `next_cursor`, and never applied it — Next returned page 1 forever.
 *
 * Method (mechanical, no LLM judgement):
 *   1. Find the set of filter/opt keys each side *reads* (`filters.X` / `opts.X`).
 *   2. Report keys read by the SQLite side but NOT by the Postgres side, and
 *      keys a function accepts-but-never-reads.
 *   3. Separately flag "declared but unused": a key named in a guard like
 *      hasOnlyFirstPageRecentFilters() but never applied in the query builder
 *      — that is the exact shape of the cursor bug.
 *
 * Exit 1 if any parity gap is found. Intended to run in CI as a regression gate.
 */

import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

const PG = "reference-implementation/lib/postgres-spine.js";
const SQLITE = "reference-implementation/lib/spine.ts";

/** Every `bag.key` member read in a source, grouped by bag name. */
function readKeys(src, bagNames) {
  const found = new Map();
  for (const bag of bagNames) {
    const re = new RegExp(`\\b${bag}\\s*(?:\\?\\.)?\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
    const keys = new Set();
    for (const m of src.matchAll(re)) keys.add(m[1]);
    found.set(bag, keys);
  }
  return found;
}

/**
 * Slice a function body by brace balance starting at a declaration index.
 *
 * Skips the parameter list first: a default value like `filters = {}` puts a
 * brace before the body, and balancing on that returns an empty string — which
 * silently makes every key look "never read" and floods the report with false
 * positives. Walk the parens to their close, then take the next brace.
 */
function functionBody(src, declIdx) {
  const paren = src.indexOf("(", declIdx);
  let cursor = declIdx;
  if (paren >= 0) {
    let pdepth = 0;
    for (let i = paren; i < src.length; i += 1) {
      if (src[i] === "(") pdepth += 1;
      else if (src[i] === ")") {
        pdepth -= 1;
        if (pdepth === 0) {
          cursor = i;
          break;
        }
      }
    }
  }
  const open = src.indexOf("{", cursor);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

function bodyOf(src, fnName) {
  const idx = src.search(new RegExp(`function\\s+${fnName}\\b`));
  return idx < 0 ? "" : functionBody(src, idx);
}

const pgSrc = readFileSync(PG, "utf8");
const liteSrc = readFileSync(SQLITE, "utf8");

const findings = [];

// ---- Check 1: correlation-list filter parity -------------------------------
// Both sides implement the same logical operation over the same filter bag.
const pgList = bodyOf(pgSrc, "postgresListSpineCorrelations");
const liteList =
  bodyOf(liteSrc, "listSpineCorrelationsSqlite") + bodyOf(liteSrc, "buildCorrelationAggregateSql");

const pgKeys = readKeys(pgList, ["filters"]).get("filters");
const liteKeys = readKeys(liteList, ["filters"]).get("filters");

for (const key of liteKeys) {
  if (!pgKeys.has(key)) {
    findings.push({
      check: "correlation-filter-parity",
      severity: "P1",
      detail: `filters.${key} is honoured by the SQLite correlation list but never read by postgresListSpineCorrelations — the argument is silently dropped on the Postgres backend.`,
    });
  }
}

// ---- Check 2: accepted-then-dropped (the cursor bug shape) ------------------
// A key mentioned ONLY inside a first-page/fast-path guard, never in the
// query builder, is accepted by the API and then ignored.
const guard = bodyOf(pgSrc, "hasOnlyFirstPageRecentFilters");
const guardKeys = readKeys(guard, ["filters"]).get("filters");
// Strip the guard body out of the function body so we test the real query path.
const pgListSansGuard = pgList.replace(guard, "");
const pgAppliedKeys = readKeys(pgListSansGuard, ["filters"]).get("filters");

for (const key of guardKeys) {
  if (!pgAppliedKeys.has(key)) {
    findings.push({
      check: "accepted-then-dropped",
      severity: "P1",
      detail: `filters.${key} disables the first-page fast path but is never applied in the fallback query — callers get an unfiltered page back while the parameter appears supported.`,
    });
  }
}

// ---- Check 3: cursor/sort-order agreement -----------------------------------
// Keyset pagination is only correct when the ORDER BY tiebreak direction
// matches the cursor's comparison direction on the same column.
function orderTiebreak(src, label) {
  const m = src.match(/ORDER BY\s+last_at\s+DESC\s*,\s*id\s+(ASC|DESC)/i);
  return m ? { dir: m[1].toUpperCase(), label } : null;
}
const pgOrder = orderTiebreak(pgList, "postgres");
const liteOrder = orderTiebreak(liteList, "sqlite");
if (pgOrder && liteOrder && pgOrder.dir !== liteOrder.dir) {
  findings.push({
    check: "cursor-sort-order-agreement",
    severity: "P1",
    detail: `Correlation list tiebreak differs by backend: postgres ORDER BY id ${pgOrder.dir} vs sqlite id ${liteOrder.dir}. Keyset pagination skips or repeats rows at equal last_at unless the cursor comparison and the sort share a direction.`,
  });
}

const json = argv.includes("--json");
if (json) {
  console.log(JSON.stringify({ findings }, null, 2));
} else {
  if (findings.length === 0) {
    console.log("PG/SQLite parity: no gaps found.");
  }
  for (const f of findings) {
    console.log(`[${f.severity}] ${f.check}\n  ${f.detail}\n`);
  }
}
exit(findings.length > 0 ? 1 : 0);
