// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Deterministic completeness check: every RFC 2119 MUST-family sentence of
// spec-core.md is quoted by a matrix clause or sits on the explicit exclusion
// list. The scan is independent of the matrix, so a sentence nobody transcribed
// is found here rather than discovered by a reader.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import { SPEC_SENTENCE_EXCLUSIONS } from "../src/requirements/exclusions.ts";
import { CLAUSE_MATRIX } from "../src/requirements/matrix.ts";
import {
  everyKeywordQuoted,
  leadInGaps,
  normalizeSpecText,
  scanLeadIns,
  scanSpecSentences,
} from "../src/requirements/spec-scan.ts";

const PATTERN_BETA_ITEM = /beta item/;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPEC = readFileSync(join(REPO_ROOT, "spec-core.md"), "utf8");
const SPEC_LINES = SPEC.split("\n");
const CLAUSE_TEXTS = CLAUSE_MATRIX.map((clause) => clause.text);
const CONFORMANCE_SECTION = "9";
const NUMBERED_ITEM = /^(\d+)\. (.*)$/;
const ROLE_HEADINGS = [
  { heading: "### Authorization Server conformance", prefix: "AS" },
  { heading: "### Resource Server conformance", prefix: "RS" },
  { heading: "### Client conformance", prefix: "CL" },
] as const;
const CONTINUATION_LINE = /^\s+\S/;
const MUST_KEYWORD = /\b(?:MUST NOT|MUST|SHALL NOT|SHALL|REQUIRED)\b/;

const sentences = scanSpecSentences(SPEC);
const mustSentences = sentences.filter((s) => s.family === "must" && s.section !== CONFORMANCE_SECTION);
const shouldSentences = sentences.filter((s) => s.family === "should" && s.section !== CONFORMANCE_SECTION);

function isExcluded(text: string): boolean {
  return SPEC_SENTENCE_EXCLUSIONS.some((e) => text.startsWith(normalizeSpecText(e.startsWith)));
}

test("every MUST-family sentence in spec-core.md is quoted by a matrix clause or excluded", (t) => {
  const unmapped = mustSentences
    .filter((s) => !(everyKeywordQuoted(s.text, CLAUSE_TEXTS) || isExcluded(s.text)))
    .map((s) => `L${s.line} (section ${s.section}): ${s.text}`);
  t.diagnostic(`MUST-family sentences outside Section 9: ${mustSentences.length}; unmapped: ${unmapped.length}`);
  assert.deepEqual(
    unmapped,
    [],
    `MUST-family sentences with no matrix clause and no exclusion:\n${unmapped.join("\n")}`
  );
});

test("every list item under a MUST lead-in is quoted by the clause that keeps the lead-in", () => {
  const gaps = leadInGaps(SPEC, CLAUSE_TEXTS);
  assert.deepEqual(gaps, [], `List items governed by a MUST lead-in but missing from the matrix:\n${gaps.join("\n")}`);
});

test("a clause that keeps the MUST lead-in but elides a list item fails the lead-in check", () => {
  const elided = CLAUSE_MATRIX.map((clause) =>
    clause.clauseId === "8.12-2" ? clause.text.replace(" [...] `Cache-Control: private, no-store`", "") : clause.text
  );
  assert.notEqual(elided.join("\n"), CLAUSE_TEXTS.join("\n"), "the doctored clause must differ");
  const gaps = leadInGaps(SPEC, elided);
  assert.ok(
    gaps.some((gap) => gap.includes("Cache-Control: private, no-store")),
    `expected the dropped item to be reported, got: ${gaps.join(" | ")}`
  );
  // The sentence-level check alone cannot see it: the MUST keyword is still quoted.
  assert.ok(everyKeywordQuoted("Direct response MUST include:", elided));
});

describe("lead-in scan handles the list layouts Markdown allows", () => {
  const gapsFor = (spec: string, clause: string) => leadInGaps(spec, [clause]);

  it("binds a list separated from its lead-in by a blank line", () => {
    const spec = "## 5. X\n\nThe response MUST include:\n\n- alpha item\n- beta item\n";
    assert.equal(scanLeadIns(spec).length, 1);
    assert.deepEqual(gapsFor(spec, "The response MUST include: [...] alpha item [...] beta item"), []);
    assert.equal(gapsFor(spec, "The response MUST include: [...] alpha item").length, 1);
  });

  it("binds a lead-in wrapped over several lines", () => {
    const spec = "## 5. X\n\nThe response MUST include\nthe following members:\n- alpha item\n";
    const [found] = scanLeadIns(spec);
    assert.equal(found?.leadIn, "The response MUST include the following members:");
    assert.equal(gapsFor(spec, "The response MUST include the following members:").length, 1);
  });

  it("binds wrapped items and blank lines between items", () => {
    const spec = "## 5. X\n\nThe response MUST include:\n\n- alpha item that\n  wraps here\n\n- beta item\n";
    const [found] = scanLeadIns(spec);
    assert.deepEqual(
      found?.items.map((i) => i.text),
      ["alpha item that wraps here", "beta item"]
    );
    const gaps = gapsFor(spec, "The response MUST include: [...] alpha item that wraps here");
    assert.equal(gaps.length, 1);
    assert.match(gaps[0] ?? "", PATTERN_BETA_ITEM);
  });

  it("binds a numbered list", () => {
    const spec = "## 5. X\n\nThe server MUST:\n\n1. do the first thing\n2. do the second thing\n";
    assert.equal(scanLeadIns(spec)[0]?.items.length, 2);
    assert.equal(gapsFor(spec, "The server MUST: [...] do the first thing").length, 1);
  });

  it("does not bind a list that a heading or paragraph separates from the lead-in", () => {
    const spec = "## 5. X\n\nThe response MUST include:\n\nUnrelated paragraph.\n\n- not governed\n";
    assert.equal(scanLeadIns(spec).length, 0);
  });

  it("finds the real blank-line-separated lead-in at spec-core.md 602", () => {
    assert.ok(scanLeadIns(SPEC).some((l) => l.line === 602 && l.items.length === 2));
  });
});

test("every exclusion still matches exactly one MUST-family sentence", () => {
  const stale = SPEC_SENTENCE_EXCLUSIONS.filter(
    (e) => mustSentences.filter((s) => s.text.startsWith(normalizeSpecText(e.startsWith))).length !== 1
  ).map((e) => e.startsWith);
  assert.deepEqual(stale, [], `Exclusions that match zero or several sentences: ${stale.join(" | ")}`);
  assert.ok(SPEC_SENTENCE_EXCLUSIONS.every((e) => e.reason.trim().length > 0));
});

test("every numbered Section 9 item maps to a catalogue requirement", () => {
  const unmapped: string[] = [];
  for (const { heading, prefix } of ROLE_HEADINGS) {
    const start = SPEC_LINES.indexOf(heading);
    assert.notEqual(start, -1, `Section 9 heading not found: ${heading}`);
    const items: string[] = [];
    for (const raw of SPEC_LINES.slice(start + 1)) {
      if (raw.startsWith("### ") || raw.startsWith("## ")) {
        break;
      }
      const numbered = NUMBERED_ITEM.exec(raw);
      if (numbered) {
        items.push(numbered[2] ?? "");
      } else if (items.length > 0 && CONTINUATION_LINE.test(raw)) {
        items[items.length - 1] += ` ${raw.trim()}`;
      }
    }
    const catalogued = REQUIREMENTS.filter((r) => r.id.startsWith(`${prefix}-`));
    if (items.length !== catalogued.length) {
      unmapped.push(`${heading}: spec has ${items.length} items, catalog.ts has ${catalogued.length}`);
    }
    for (const [index, item] of items.entries()) {
      const requirement = catalogued.find((r) => r.specItem === index + 1);
      if (!requirement || requirement.id !== `${prefix}-${index + 1}`) {
        unmapped.push(`${prefix}-${index + 1}: no catalogue entry (${item.slice(0, 60)})`);
        continue;
      }
      const startsShould = item.startsWith("SHOULD ");
      if (startsShould && requirement.level !== "should") {
        unmapped.push(`${requirement.id}: spec item is SHOULD but catalogue says ${requirement.level}`);
      }
      if (!startsShould && MUST_KEYWORD.test(item) && requirement.level !== "must") {
        unmapped.push(
          `${requirement.id}: spec item carries a MUST-family keyword but catalogue says ${requirement.level}`
        );
      }
    }
  }
  assert.deepEqual(unmapped, [], `Section 9 items not transcribed in catalog.ts:\n${unmapped.join("\n")}`);
});

test("SHOULD-family sentences without a matrix clause (informational, never a failure)", (t) => {
  const unquoted = shouldSentences.filter(
    (s) => !CLAUSE_TEXTS.some((text) => normalizeSpecText(text).includes(s.text))
  );
  t.diagnostic(
    `SHOULD-family sentences outside Section 9: ${shouldSentences.length}; not verbatim in any clause: ${unquoted.length}`
  );
  for (const s of unquoted) {
    t.diagnostic(`  L${s.line}: ${s.text.slice(0, 140)}`);
  }
});
