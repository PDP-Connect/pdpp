// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Drift tests for the clause-level normative matrix.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS, SPEC_SOURCE } from "../src/requirements/catalog.ts";
import { CLAUSE_MATRIX, parseSpecVersion } from "../src/requirements/matrix.ts";
import { ALL_CASES } from "../src/suite.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPEC = readFileSync(join(REPO_ROOT, SPEC_SOURCE.path), "utf8");
const SPEC_LINES = SPEC.split("\n");
const HEADING = /^#{1,6} (.+)$/;
const EXPLICIT_ANCHOR = /\{#([^}]+)\}/;
const NON_SLUG_CHARS = /[^a-z0-9 -]/g;
const SPACES = / /g;
const SECTION_HEADING = /^## (\d+)\./;
const NORMATIVE_KEYWORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|MAY)\b/;

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
    } else {
      anchors.add(`#${title.trim().toLowerCase().replace(NON_SLUG_CHARS, "").replace(SPACES, "-")}`);
    }
  }
  return anchors;
}

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

const clauses = CLAUSE_MATRIX;

test("the matrix names only the adopted spec revision", () => {
  assert.equal(parseSpecVersion("0.1"), "0.1");
  assert.ok(clauses.every((clause) => clause.specVersion === "0.1"));
});

test("every catalogue requirement traces to at least one clause", () => {
  const mapped = new Set(clauses.flatMap((clause) => clause.requirementIds));
  const orphans = REQUIREMENTS.map((requirement) => requirement.id).filter((id) => !mapped.has(id));
  assert.deepEqual(orphans, [], `Section 9 items with no underlying clause: ${orphans.join(", ")}.`);
});

test("every requirement id a clause cites exists in the catalogue", () => {
  const known = new Set(REQUIREMENTS.map((requirement) => requirement.id));
  const unknown = [...new Set(clauses.flatMap((clause) => clause.requirementIds))].filter((id) => !known.has(id));
  assert.deepEqual(unknown, [], `Unknown requirement ids: ${unknown.join(", ")}.`);
});

test("every clause anchor is a heading anchor spec-core.md defines", () => {
  const anchors = specAnchors();
  const dangling = [
    ...new Set(
      clauses
        .filter((clause) => !anchors.has(clause.specAnchor))
        .map((clause) => `${clause.clauseId} -> ${clause.specAnchor}`)
    ),
  ];
  assert.deepEqual(dangling, [], `Clauses point at missing anchors: ${dangling.join(", ")}.`);
});

test("every case id a clause cites is registered", () => {
  const registered = new Set(ALL_CASES.map((conformanceCase) => conformanceCase.caseId));
  const dangling = [
    ...new Set(
      clauses.flatMap((clause) =>
        clause.caseIds.filter((id) => !registered.has(id)).map((id) => `${clause.clauseId} -> ${id}`)
      )
    ),
  ];
  assert.deepEqual(dangling, [], `Clauses cite missing cases: ${dangling.join(", ")}.`);
});

test("every uncovered MUST clause names its missing hook", () => {
  const silent = clauses
    .filter((clause) => clause.level === "must" && clause.caseIds.length === 0 && !clause.gapNote?.trim())
    .map((clause) => clause.clauseId);
  assert.deepEqual(silent, [], `MUST clauses with no case and no gap note: ${silent.join(", ")}.`);
});

test("a partial clause names its cases and the part they leave out", () => {
  const bad = clauses
    .filter((clause) => clause.partial && (clause.caseIds.length === 0 || !clause.gapNote?.trim()))
    .map((clause) => clause.clauseId);
  assert.deepEqual(bad, [], `Partial clauses need at least one case and a gapNote naming the gap: ${bad.join(", ")}.`);
});

test("clause ids are unique", () => {
  const ids = clauses.map((clause) => clause.clauseId);
  assert.equal(new Set(ids).size, ids.length, "Clause ids are primary keys and must be unique.");
});

test("every clause text is verbatim spec-core.md text", () => {
  const missing: string[] = [];
  for (const clause of clauses) {
    for (const fragment of clause.text.split("[...]").map((part) => part.trim())) {
      if (fragment && !SPEC.includes(fragment)) {
        missing.push(`${clause.clauseId}: ${fragment.slice(0, 60)}...`);
      }
    }
  }
  assert.deepEqual(missing, [], `Clause text not found verbatim:\n${missing.join("\n")}`);
});

test("the matrix accounts for every normative line in the spec scan", () => {
  const unaccounted: string[] = [];
  for (const { line, text } of normativeSpecLines()) {
    const covered = clauses.some((clause) =>
      clause.text
        .split("[...]")
        .map((part) => part.trim())
        .some((fragment) => fragment.length > 0 && text.includes(fragment))
    );
    if (!covered) {
      unaccounted.push(`L${line}: ${text.slice(0, 120)}`);
    }
  }
  assert.deepEqual(unaccounted, [], `Normative lines missing from the matrix:\n${unaccounted.join("\n")}`);
});
