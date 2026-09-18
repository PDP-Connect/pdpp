// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Drift tests for the clause-level normative matrix.
//
// WHAT THESE PROTECT. The matrix is the inventory behind every coverage claim
// the suite makes. Its failure mode is silent decay, not a crash: a case gets
// renamed and a clause quietly cites a case that no longer exists; a spec
// section is re-titled and an anchor points nowhere; a new MUST lands in
// spec-core.md and nothing says the matrix missed it. Each of those leaves a
// matrix that still loads, still renders, and is wrong — so the report keeps
// claiming an inventory it no longer has.
//
// THE PLAUSIBLE DEFECT each test catches is therefore an EDIT ELSEWHERE, not a
// bug in matrix.ts: a case rename (case-ids test), a spec heading change
// (anchor test), a catalogue edit (both mapping tests), a new normative
// sentence in the spec (scan test), and a copy-paste duplicate while adding
// entries (unique-id test).
//
// ORACLE AND TRUTH SOURCE. spec-core.md itself, parsed at test time, and the
// registered case list from suite.ts. Nothing here hardcodes a count or an
// anchor list that could drift away from those two sources independently.
//
// WHY NOTHING CHEAPER SUFFICES. Typechecking proves the entries are
// well-formed, which is exactly what a decayed matrix also is. Only comparison
// against the spec file and the live case registry can distinguish them.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import { CLAUSE_MATRIX } from "../src/requirements/matrix.ts";
import { ALL_CASES } from "../src/suite.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPEC_PATH = join(REPO_ROOT, "spec-core.md");
const SPEC = readFileSync(SPEC_PATH, "utf8");
const SPEC_LINES = SPEC.split("\n");

const HEADING = /^#{1,6} (.+)$/;
const EXPLICIT_ANCHOR = /\{#([^}]+)\}/;
const NON_SLUG_CHARS = /[^a-z0-9 -]/g;
const SPACES = / /g;
const SECTION_HEADING = /^## (\d+)\./;
const NORMATIVE_KEYWORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|MAY)\b/;

/**
 * Anchors the spec actually defines.
 *
 * Parsed, never hardcoded: an explicit `{#anchor}` when the heading carries
 * one, otherwise the GitHub slug of the heading text. Hardcoding would make
 * this test pass while the document it claims to check had moved on.
 */
function specAnchors(): ReadonlySet<string> {
  const anchors = new Set<string>();
  for (const line of SPEC_LINES) {
    const [, title] = HEADING.exec(line) ?? [];
    if (!title) {
      continue;
    }
    const [, explicit] = EXPLICIT_ANCHOR.exec(title) ?? [];
    if (explicit) {
      anchors.add(`#${explicit}`);
      continue;
    }
    const slug = title.trim().toLowerCase().replace(NON_SLUG_CHARS, "").replace(SPACES, "-");
    anchors.add(`#${slug}`);
  }
  return anchors;
}

/**
 * Normative sentences the spec contains, found by a keyword scan of sections
 * 4-8 and 10 — the same range the matrix claims to enumerate.
 *
 * Deliberately simple and independent of the matrix's own judgment: it is the
 * OUTSIDE oracle. Fenced code blocks are skipped because a JSON example
 * containing the word "may" is not a clause.
 */
function normativeSpecLines(): readonly { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  let sectionOrdinal = 0;
  let inFence = false;
  for (const [index, line] of SPEC_LINES.entries()) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    const [, sectionNumber] = SECTION_HEADING.exec(line) ?? [];
    if (sectionNumber) {
      sectionOrdinal = Number(sectionNumber);
      continue;
    }
    const inScope = (sectionOrdinal >= 4 && sectionOrdinal <= 8) || sectionOrdinal === 10;
    if (inScope && NORMATIVE_KEYWORD.test(line)) {
      found.push({ line: index + 1, text: line.trim() });
    }
  }
  return found;
}

test("every catalogue requirement traces to at least one clause", () => {
  const mapped = new Set(CLAUSE_MATRIX.flatMap((c) => c.requirementIds));
  const orphans = REQUIREMENTS.map((r) => r.id).filter((id) => !mapped.has(id));
  assert.deepEqual(
    orphans,
    [],
    `Section 9 items with no underlying clause in the matrix: ${orphans.join(", ")}. ` +
      "Every numbered item must name the spec text it summarizes, or the coverage " +
      "denominator is a list of summaries with nothing behind it."
  );
});

test("every requirement id a clause cites exists in the catalogue", () => {
  const known = new Set(REQUIREMENTS.map((r) => r.id));
  const unknown = [...new Set(CLAUSE_MATRIX.flatMap((c) => c.requirementIds))].filter((id) => !known.has(id));
  assert.deepEqual(unknown, [], `Clauses cite requirement ids that are not in catalog.ts: ${unknown.join(", ")}.`);
});

test("every clause anchor is a heading anchor spec-core.md defines", () => {
  const anchors = specAnchors();
  const dangling = [
    ...new Set(CLAUSE_MATRIX.filter((c) => !anchors.has(c.specAnchor)).map((c) => `${c.clauseId} -> ${c.specAnchor}`)),
  ];
  assert.deepEqual(
    dangling,
    [],
    `Clauses point at anchors spec-core.md does not define: ${dangling.join(", ")}. ` +
      "A renamed heading breaks the evidence trail from a finding back to the text."
  );
});

test("every case id a clause cites is a registered case", () => {
  const registered = new Set(ALL_CASES.map((c) => c.caseId));
  const dangling = [
    ...new Set(
      CLAUSE_MATRIX.flatMap((c) => c.caseIds.filter((id) => !registered.has(id)).map((id) => `${c.clauseId} -> ${id}`))
    ),
  ];
  assert.deepEqual(
    dangling,
    [],
    `Clauses claim coverage from cases that do not exist: ${dangling.join(", ")}. ` +
      "A stale case id inflates covered-clause counts with evidence nothing produces."
  );
});

test("every uncovered MUST clause names its missing hook", () => {
  const silent = CLAUSE_MATRIX.filter((c) => c.level === "must" && c.caseIds.length === 0 && !c.gapNote?.trim()).map(
    (c) => c.clauseId
  );
  assert.deepEqual(
    silent,
    [],
    `MUST clauses with no case and no gapNote: ${silent.join(", ")}. ` +
      "An uncovered MUST must name the missing hook, fixture, or capability; " +
      "an unexplained gap reads as an oversight rather than a recorded limit."
  );
});

test("clause ids are unique", () => {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const clause of CLAUSE_MATRIX) {
    if (seen.has(clause.clauseId)) {
      duplicates.add(clause.clauseId);
    }
    seen.add(clause.clauseId);
  }
  assert.deepEqual(
    [...duplicates],
    [],
    `Duplicate clause ids: ${[...duplicates].join(", ")}. Ids are the matrix's ` +
      "primary key; a duplicate silently drops one entry from every lookup."
  );
});

test("clause text is verbatim spec text", () => {
  // The matrix's whole value is that a reader can check a claim against the
  // source. A paraphrase that drifts toward what the suite tests, rather than
  // what the spec says, is the defect this catches. `[...]` marks an elision
  // between fragments; each fragment must still appear verbatim.
  const missing: string[] = [];
  for (const clause of CLAUSE_MATRIX) {
    for (const fragment of clause.text.split("[...]").map((f) => f.trim())) {
      if (fragment && !SPEC.includes(fragment)) {
        missing.push(`${clause.clauseId}: ${fragment.slice(0, 60)}...`);
      }
    }
  }
  assert.deepEqual(missing, [], `Clause text not found verbatim in spec-core.md:\n${missing.join("\n")}`);
});

test("the matrix accounts for every normative line the spec scan finds", () => {
  // The drift alarm for spec edits. The scan is line-based and the matrix is
  // clause-based — one line can hold several clauses, and one clause can span
  // lines — so this does not compare counts. It asserts the weaker, checkable
  // property: every scanned normative LINE has at least one matrix clause whose
  // verbatim text appears on it. A new MUST added to spec-core.md therefore
  // fails here, naming the line, instead of silently enlarging the denominator.
  const unaccounted: string[] = [];
  for (const { line, text } of normativeSpecLines()) {
    const covered = CLAUSE_MATRIX.some((clause) =>
      clause.text
        .split("[...]")
        .map((f) => f.trim())
        .some((fragment) => fragment.length > 0 && text.includes(fragment))
    );
    if (!covered) {
      unaccounted.push(`L${line}: ${text.slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    unaccounted,
    [],
    "spec-core.md carries normative lines no matrix clause quotes. Add an entry " +
      `for each, or the coverage inventory is stale:\n${unaccounted.join("\n")}`
  );
});
