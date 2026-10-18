// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Show what a candidate revision of spec-core.md would change for the matrix,
// before that revision lands: MUST-family sentences no clause quotes yet, and
// clauses whose verbatim text the revision no longer contains.
//
// The completeness self-test answers the same question for the spec-core.md in
// this checkout and fails on any gap. This script answers it for any other file
// (a review branch, a pull request's version), so the transcription work for a
// spec change is known while the change is still under review.
//
// Usage: tsx scripts/spec-delta.ts <path/to/spec-core.md>

import { readFileSync } from "node:fs";
import { SPEC_SENTENCE_EXCLUSIONS } from "../src/requirements/exclusions.ts";
import { CLAUSE_MATRIX } from "../src/requirements/matrix.ts";
import { everyKeywordQuoted, normalizeSpecText, scanSpecSentences } from "../src/requirements/spec-scan.ts";

const CONFORMANCE_SECTION = "9";

const [, , specPath] = process.argv;
if (!specPath) {
  console.error("usage: spec-delta.ts <path/to/spec-core.md>");
  process.exit(2);
}

const spec = readFileSync(specPath, "utf8");
const clauseTexts = CLAUSE_MATRIX.map((clause) => clause.text);
const excluded = (text: string): boolean =>
  SPEC_SENTENCE_EXCLUSIONS.some((e) => text.startsWith(normalizeSpecText(e.startsWith)));

const unquoted = scanSpecSentences(spec).filter(
  (s) =>
    s.family === "must" &&
    s.section !== CONFORMANCE_SECTION &&
    !excluded(s.text) &&
    !everyKeywordQuoted(s.text, clauseTexts)
);
// Same rule as the matrix self-test: each "[...]"-separated fragment must
// appear verbatim.
const vanished = CLAUSE_MATRIX.filter((clause) =>
  clause.text
    .split("[...]")
    .map((part) => part.trim())
    .some((fragment) => fragment.length > 0 && !spec.includes(fragment))
);

console.log(`MUST-family sentences no clause quotes: ${unquoted.length}`);
for (const s of unquoted) {
  console.log(`  L${s.line} §${s.section}: ${s.text}`);
}
console.log(`Clauses whose text is not in this file: ${vanished.length}`);
for (const clause of vanished) {
  console.log(`  ${clause.clauseId} (${clause.level}, cases: ${clause.caseIds.length}): ${clause.text}`);
}
