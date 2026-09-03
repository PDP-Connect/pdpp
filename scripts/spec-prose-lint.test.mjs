// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { fixHardWraps, lintFile } from "./spec-prose-lint.mjs";

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
