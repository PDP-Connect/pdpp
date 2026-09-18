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
// The matrix now carries two revisions, which adds three failure modes of the
// same shape: a v0.2 entry that supersedes a clause id nobody defines (the
// superseded-target test), a `supersedes` on a v0.1 entry, where it can only be
// a copy-paste slip because v0.1 is the earliest revision (the direction test),
// and a v0.2 entry whose text or anchor does not appear in the PR's own files
// (the pinned-revision tests). Each leaves a matrix that still loads and still
// renders a plausible-looking v0.2 view with a silently wrong denominator.
//
// ORACLE AND TRUTH SOURCE. spec-core.md itself, parsed at test time; the PR #1
// spec files read out of a pinned commit via git; and the registered case list
// from suite.ts. Nothing here hardcodes a count or an anchor list that could
// drift away from those sources independently.
//
// WHY NOTHING CHEAPER SUFFICES. Typechecking proves the entries are
// well-formed, which is exactly what a decayed matrix also is. Only comparison
// against the spec file and the live case registry can distinguish them.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REQUIREMENTS } from "../src/requirements/catalog.ts";
import {
  CLAUSE_MATRIX,
  clausesForVersion,
  SPEC_VERSIONS,
  type SpecVersion,
  specFileOf,
} from "../src/requirements/matrix.ts";
import { ALL_CASES } from "../src/suite.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SPEC_PATH = join(REPO_ROOT, "spec-core.md");
const SPEC = readFileSync(SPEC_PATH, "utf8");
const SPEC_LINES = SPEC.split("\n");

/**
 * The commit of vana-com/pdpp PR #1 the v0.2 entries were transcribed from.
 *
 * Pinned, not a branch name: a branch moves, and a verbatim-text test against a
 * moving target would start failing for reasons that have nothing to do with
 * this repository. When the PR is updated, re-transcribe and move this pin
 * deliberately — the test failing IS the signal that the proposal changed under
 * the matrix.
 */
const V02_COMMIT = "656cc8f1ed8cbe35b6ff8317f17205f12d62def2";

/**
 * Read a spec file at the revision an entry names.
 *
 * v0.1 is the working tree. v0.2 is read out of the pinned PR commit via git,
 * because the proposal is not checked into this repository and the alternative —
 * a vendored copy — would be a second source that can drift from the PR while
 * still passing every test here.
 *
 * Returns undefined when the commit is not present locally (a shallow clone, or
 * a fetch that has not happened). The tests that use it then skip rather than
 * fail: a missing object is an environment fact, not a matrix defect, and
 * failing on it would make the suite unrunnable offline.
 */
function specFileAt(version: SpecVersion, file: string): string | undefined {
  if (version === "0.1") {
    return readFileSync(join(REPO_ROOT, file), "utf8");
  }
  try {
    return execFileSync("git", ["show", `${V02_COMMIT}:${file}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/** Anchors a parsed spec file defines, by the same rules as `specAnchors`. */
function anchorsIn(text: string): ReadonlySet<string> {
  const anchors = new Set<string>();
  for (const line of text.split("\n")) {
    const [, title] = HEADING.exec(line) ?? [];
    if (!title) {
      continue;
    }
    const [, explicit] = EXPLICIT_ANCHOR.exec(title) ?? [];
    if (explicit) {
      anchors.add(`#${explicit}`);
      continue;
    }
    anchors.add(`#${title.trim().toLowerCase().replace(NON_SLUG_CHARS, "").replace(SPACES, "-")}`);
  }
  return anchors;
}

const HEADING = /^#{1,6} (.+)$/;
const EXPLICIT_ANCHOR = /\{#([^}]+)\}/;
const NON_SLUG_CHARS = /[^a-z0-9 -]/g;
const SPACES = / /g;
const SECTION_HEADING = /^## (\d+)\./;
const NORMATIVE_KEYWORD = /\b(MUST NOT|MUST|SHALL NOT|SHALL|SHOULD NOT|SHOULD|REQUIRED|MAY)\b/;

/**
 * Entries transcribed from the working tree's spec-core.md.
 *
 * The verbatim-text, anchor and spec-scan tests below read THAT file, so they
 * can only speak about these entries. Running them over the whole matrix would
 * fail every v0.2 entry for quoting a file the test never opened — a false
 * alarm that says nothing about either revision.
 */
const V01_CLAUSES = CLAUSE_MATRIX.filter((c) => c.specVersion === "0.1");

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

test("every v0.1 clause anchor is a heading anchor spec-core.md defines", () => {
  const anchors = specAnchors();
  const dangling = [
    ...new Set(V01_CLAUSES.filter((c) => !anchors.has(c.specAnchor)).map((c) => `${c.clauseId} -> ${c.specAnchor}`)),
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

test("every v0.1 clause text is verbatim spec-core.md text", () => {
  // The matrix's whole value is that a reader can check a claim against the
  // source. A paraphrase that drifts toward what the suite tests, rather than
  // what the spec says, is the defect this catches. `[...]` marks an elision
  // between fragments; each fragment must still appear verbatim.
  const missing: string[] = [];
  for (const clause of V01_CLAUSES) {
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
    const covered = V01_CLAUSES.some((clause) =>
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

test("every entry names a known spec version", () => {
  // The type already constrains this at compile time. The test exists for the
  // path the type cannot reach: an entry constructed from data — a future
  // generator, a JSON import — where an unknown version would otherwise be
  // silently excluded from every view and vanish from the inventory.
  const unknown = CLAUSE_MATRIX.filter((c) => !SPEC_VERSIONS.includes(c.specVersion)).map(
    (c) => `${c.clauseId} -> ${c.specVersion}`
  );
  assert.deepEqual(
    unknown,
    [],
    `Clauses naming a spec version outside ${SPEC_VERSIONS.join(", ")}: ${unknown.join(", ")}. ` +
      "An unknown version is excluded from every per-version view, so the clause " +
      "disappears from the inventory instead of failing loudly."
  );
});

test("every supersedes target is a clause that exists", () => {
  const known = new Set(CLAUSE_MATRIX.map((c) => c.clauseId));
  const dangling = CLAUSE_MATRIX.filter((c) => c.supersedes !== undefined && !known.has(c.supersedes)).map(
    (c) => `${c.clauseId} -> ${c.supersedes}`
  );
  assert.deepEqual(
    dangling,
    [],
    `Clauses superseding ids no entry defines: ${dangling.join(", ")}. ` +
      "A dangling supersedes hides nothing, so the superseding clause and the " +
      "obligation it was meant to replace are BOTH reported — the double count " +
      "this field exists to prevent."
  );
});

test("a supersedes edge points at an earlier revision", () => {
  const backwards = CLAUSE_MATRIX.filter((c) => {
    if (!c.supersedes) {
      return false;
    }
    const target = CLAUSE_MATRIX.find((other) => other.clauseId === c.supersedes);
    return !target || target.specVersion >= c.specVersion;
  }).map((c) => `${c.clauseId} (v${c.specVersion}) -> ${c.supersedes}`);
  assert.deepEqual(
    backwards,
    [],
    `Clauses superseding a clause of the same or a later revision: ${backwards.join(", ")}. ` +
      "Supersession is how a later revision retires earlier text; an edge that " +
      "does not go backwards would remove a clause from the view that still binds."
  );
});

test("a superseded clause is absent from the superseding revision's view", () => {
  // The property the whole mechanism exists for, asserted directly rather than
  // inferred from a count: reading both a clause and its replacement would
  // state one obligation twice under two ids.
  for (const version of SPEC_VERSIONS) {
    const view = clausesForVersion(version);
    const ids = new Set(view.map((c) => c.clauseId));
    for (const clause of view) {
      if (clause.supersedes) {
        assert.ok(
          !ids.has(clause.supersedes),
          `At v${version}, ${clause.clauseId} supersedes ${clause.supersedes}, ` +
            "but both appear in the view. The same obligation is counted twice."
        );
      }
    }
  }
});

test("a revision's view carries no clause from a later revision", () => {
  // v0.1 is the adopted draft. A v0.1 report that included proposal text would
  // measure a target against obligations nobody has agreed to — the exact
  // overclaim the default-to-0.1 rule exists to prevent.
  const v01 = clausesForVersion("0.1");
  const leaked = v01.filter((c) => c.specVersion !== "0.1").map((c) => c.clauseId);
  assert.deepEqual(
    leaked,
    [],
    `The v0.1 view carries clauses from a later revision: ${leaked.join(", ")}. ` +
      "A v0.1 report must measure only against adopted text."
  );
});

test("every v0.2 clause text is verbatim text of the pinned PR #1 revision", () => {
  const v02 = CLAUSE_MATRIX.filter((c) => c.specVersion === "0.2");
  assert.ok(v02.length > 0, "This batch transcribes v0.2 clauses; the test needs them to exist.");

  const missing: string[] = [];
  for (const clause of v02) {
    const file = specFileOf(clause);
    const text = specFileAt("0.2", file);
    if (text === undefined) {
      // The pinned commit is not fetched here. Skipping beats failing: absence
      // of the object says nothing about whether the transcription is faithful.
      return;
    }
    for (const fragment of clause.text.split("[...]").map((f) => f.trim())) {
      if (fragment && !text.includes(fragment)) {
        missing.push(`${clause.clauseId} (${file}): ${fragment.slice(0, 60)}...`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    "Clause text not found verbatim in the pinned PR #1 revision:\n" +
      `${missing.join("\n")}\n` +
      "Either the transcription paraphrased, or the PR moved under the pin. " +
      "Re-read the PR's file before changing either."
  );
});

test("every v0.2 clause anchor is a heading the pinned PR #1 revision defines", () => {
  const v02 = CLAUSE_MATRIX.filter((c) => c.specVersion === "0.2");
  const dangling: string[] = [];
  for (const clause of v02) {
    const file = specFileOf(clause);
    const text = specFileAt("0.2", file);
    if (text === undefined) {
      return;
    }
    if (!anchorsIn(text).has(clause.specAnchor)) {
      dangling.push(`${clause.clauseId} -> ${file}${clause.specAnchor}`);
    }
  }
  assert.deepEqual(
    dangling,
    [],
    `v0.2 clauses point at anchors the PR does not define: ${dangling.join(", ")}. ` +
      "The two revisions share heading text in places, so an anchor resolving in " +
      "spec-core.md is not evidence it resolves in the proposal."
  );
});

test("every v0.2 clause is honest about having no case", () => {
  // The claim the batch makes: mechanics first, cases later. A case id appearing
  // on a v0.2 entry would be a coverage claim for text no case sends, and it
  // would pass the registered-case test — the id exists, it just exercises v0.1.
  const claiming = CLAUSE_MATRIX.filter((c) => c.specVersion === "0.2" && c.caseIds.length > 0).map(
    (c) => `${c.clauseId}: ${c.caseIds.join(", ")}`
  );
  assert.deepEqual(
    claiming,
    [],
    `v0.2 clauses citing cases: ${claiming.join("; ")}. No case sends the v0.2 ` +
      "`authorization_details` type yet, so a case id here claims evidence about " +
      "v0.2 that was produced against v0.1. Remove this test when the first real " +
      "v0.2 case lands."
  );
});
