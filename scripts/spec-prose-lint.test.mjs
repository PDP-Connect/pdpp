// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { RATCHETABLE, applyRatchet, fingerprint, fixHardWraps, lintFile } from "./spec-prose-lint.mjs";

const rulesIn = (source, file = "spec-fixture.md") => lintFile(file, source).map((f) => f.rule);

test("hard-wrap fires on prose broken mid-sentence and not on separate sentences", () => {
  const wrapped = "# T\n\nThe authorization server retains the declaration\nsnapshot it accepted.\n";
  assert.deepEqual(rulesIn(wrapped), ["hard-wrap"]);

  const unwrapped = "# T\n\nThe authorization server retains the snapshot.\nIt does not refetch the declaration.\n";
  assert.deepEqual(rulesIn(unwrapped), []);
});

test("hard-wrap ignores tables, lists, code blocks, and the Status/Date headers", () => {
  const source = [
    "# T",
    "",
    "Status: Normative draft",
    "Date: 2026-09-03",
    "",
    "| Field | Meaning |",
    "| --- | --- |",
    "| `id` | The source identity |",
    "",
    "- a list item that runs on",
    "- another item continuing it",
    "",
    "```http",
    "Authorization: Bearer <token>",
    "GET /records",
    "```",
    "",
  ].join("\n");
  assert.deepEqual(rulesIn(source), []);
});

test("--fix rejoins wrapped prose without changing any word", () => {
  const wrapped = "# T\n\nThe resource server enforces the grant on\nevery request it serves.\n";
  const fixed = fixHardWraps(wrapped);
  assert.equal(fixed, "# T\n\nThe resource server enforces the grant on every request it serves.\n");
  // Same words, only the line breaks moved.
  assert.equal(fixed.replace(/\s+/g, " "), wrapped.replace(/\s+/g, " "));
  // Converged: a second pass is a no-op, and the rule no longer fires.
  assert.equal(fixHardWraps(fixed), fixed);
  assert.deepEqual(rulesIn(fixed), []);
});

test("lowercase-normative fires on a role obligation but not on descriptive may", () => {
  const obligation = "# T\n\nThis section is normative: a resource server must implement this interface.\n";
  assert.ok(rulesIn(obligation).includes("lowercase-normative"));

  // RFC 8174: lowercase words carry their ordinary English meaning. These are
  // descriptions and definitions, not requirements, so they must stay quiet.
  const descriptive = [
    "# T",
    "",
    "A resource server may hold pre-collected data with no collection machinery.",
    "",
    "| **Grant** | An artifact specifying what data a client may access. |",
    "",
    "These two concerns must not be conflated.",
    "",
  ].join("\n");
  assert.deepEqual(rulesIn(descriptive), []);

  // A correctly capitalized key word is the goal, not a finding.
  const correct = "# T\n\nA resource server MUST implement this interface.\n";
  assert.deepEqual(rulesIn(correct), []);
});

test("keyword-in-note fires only inside a note block", () => {
  const inNote = "# T\n\n**Note:** The client MUST retry the request.\n";
  assert.deepEqual(rulesIn(inNote), ["keyword-in-note"]);

  const labelled = "# T\n\n**Note on defaults:** Omitting the field asks for everything. The AS MUST reject an empty list.\n";
  assert.ok(rulesIn(labelled).includes("keyword-in-note"));

  // The same sentence in body text is exactly what a spec should look like.
  const inBody = "# T\n\nThe client MUST retry the request.\n";
  assert.deepEqual(rulesIn(inBody), []);

  // The note ends at the blank line; prose after it is normative again.
  const afterNote = "# T\n\n**Note:** This is background.\n\nThe client MUST retry the request.\n";
  assert.deepEqual(rulesIn(afterNote), []);
});

test("long-sentence counts words but not inline code, links, or URLs", () => {
  const long = `# T\n\n${"word ".repeat(45).trim()}.\n`;
  assert.ok(rulesIn(long).includes("long-sentence"));

  // 20 real words plus code spans and a link that a reader takes as one token.
  const dense = `# T\n\n${"word ".repeat(20).trim()} \`a\` \`b\` \`c\` [see the spec](https://example.com/very/long/path).\n`;
  assert.ok(!rulesIn(dense).includes("long-sentence"));

  // "v0.1" and "e.g." must not be read as sentence ends.
  const abbrev = "# T\n\nThe AS accepts v0.1 declarations, e.g. the one above. It rejects the rest.\n";
  assert.deepEqual(rulesIn(abbrev), []);
});

test("filler fires on meta-commentary and unfalsifiable adjectives", () => {
  const filler = "# T\n\nIt is worth noting that this section describes a robust and seamless flow.\n";
  const hits = rulesIn(filler).filter((r) => r === "filler");
  assert.ok(hits.length >= 3, `expected several filler hits, got ${hits.length}`);

  // Substrings inside longer words must not trip the rule.
  const clean = "# T\n\nThe server notes the version and returns it.\n";
  assert.deepEqual(rulesIn(clean), []);
});

test("duplicate-paragraph fires on a repeated block, not on short repeats", () => {
  const para = "The authorization server retains the exact declaration snapshot it accepted for this grant.";
  assert.deepEqual(rulesIn(`# T\n\n${para}\n\nSomething else entirely goes here.\n\n${para}\n`), ["duplicate-paragraph"]);

  // Short repeated lines (labels, stock phrases) are legitimate.
  assert.deepEqual(rulesIn("# T\n\nSee Section 4.\n\nOther text here.\n\nSee Section 4.\n"), []);
});

// --- the ratchet ---

test("hard-wrap is the only rule the ratchet will not waive", () => {
  assert.equal(RATCHETABLE.has("hard-wrap"), false);
  for (const id of ["lowercase-normative", "long-sentence", "keyword-in-note", "filler", "duplicate-paragraph"]) {
    assert.ok(RATCHETABLE.has(id), `${id} should be waivable`);
  }
});

test("fingerprint ignores position but distinguishes content, rule, and file", () => {
  const at = (line) => ({ rule: "long-sentence", file: "spec-a.md", line, text: "44 words: the same sentence entirely" });
  // Moving a finding down the file must not make it look new.
  assert.equal(fingerprint(at(10)), fingerprint(at(900)));

  // The derived word-count prefix is stripped: an edit that changes only the
  // count would otherwise read as a new finding.
  const counted = (n) => ({ rule: "long-sentence", file: "spec-a.md", line: 1, text: `${n} words: the same sentence entirely` });
  assert.equal(fingerprint(counted(41)), fingerprint(counted(52)));

  // So is the line reference duplicate-paragraph leads with.
  const dup = (n) => ({ rule: "duplicate-paragraph", file: "spec-a.md", line: 1, text: `duplicate of line ${n}: repeated body text` });
  assert.equal(fingerprint(dup(5)), fingerprint(dup(77)));

  // Different content, rule, or file are all different findings.
  assert.notEqual(fingerprint(at(1)), fingerprint({ ...at(1), text: "44 words: a different sentence" }));
  assert.notEqual(fingerprint(at(1)), fingerprint({ ...at(1), rule: "filler" }));
  assert.notEqual(fingerprint(at(1)), fingerprint({ ...at(1), file: "spec-b.md" }));
});

test("applyRatchet waives a baselined judgment finding and blocks a new one", () => {
  const old = { rule: "filler", file: "spec-a.md", line: 3, text: '"robust" in: a robust design' };
  const fresh = { rule: "filler", file: "spec-a.md", line: 9, text: '"seamless" in: a seamless design' };
  const baseline = new Set([fingerprint(old)]);

  const { blocking, waived } = applyRatchet([old, fresh], baseline);
  assert.deepEqual(waived, [old]);
  assert.deepEqual(blocking, [fresh]);
});

test("applyRatchet never waives hard-wrap, even when baselined", () => {
  const wrap = { rule: "hard-wrap", file: "spec-a.md", line: 3, text: "a line broken mid-sentence" };
  const { blocking, waived } = applyRatchet([wrap], new Set([fingerprint(wrap)]));
  assert.deepEqual(waived, []);
  assert.deepEqual(blocking, [wrap]);
});

test("applyRatchet with no baseline blocks everything, the pre-ratchet behavior", () => {
  const fs = [
    { rule: "filler", file: "spec-a.md", line: 1, text: '"robust" in: x' },
    { rule: "hard-wrap", file: "spec-a.md", line: 2, text: "y" },
  ];
  const { blocking, waived } = applyRatchet(fs, null);
  assert.deepEqual(waived, []);
  assert.deepEqual(blocking, fs);
});

test("a baseline is reflow-invariant, so unwrapping prose introduces no finding", () => {
  // The same over-long sentence, hard-wrapped and not. Wrapped, the
  // sentence-length rule sees only single lines and stays quiet; unwrapped it
  // fires. The fingerprints must still match, or the reflow commit that
  // exposed the sentence would be blamed for introducing it.
  const sentence = `${"word ".repeat(45).trim()}.`;
  const unwrapped = `# T\n\n${sentence}\n`;
  const wrapped = `# T\n\n${sentence.replace(/((?:\S+\s+){10})/g, "$1\n").replace(/\n$/, "")}\n`;

  assert.deepEqual(rulesIn(wrapped).filter((r) => r === "long-sentence"), [], "wrapped: rule cannot see the whole sentence");
  assert.ok(rulesIn(unwrapped).includes("long-sentence"), "unwrapped: rule fires");

  // Baselining reflows first, which is what makes the two sides comparable.
  const baseline = new Set(
    lintFile("spec-a.md", fixHardWraps(wrapped))
      .filter((f) => RATCHETABLE.has(f.rule))
      .map(fingerprint),
  );
  const { blocking } = applyRatchet(lintFile("spec-a.md", unwrapped), baseline);
  assert.deepEqual(blocking, [], "the reflow must introduce nothing");
});
