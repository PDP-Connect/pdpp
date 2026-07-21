#!/usr/bin/env node
// Hermetic guard for scripts/check-public-tree-hygiene.mjs.
//
// Pins the four narrow residue-class patterns against both hazard and
// legitimate-content cases so the check can never regress into a broad
// internal-jargon filter (it must not flag product/connector names like
// "Claude" or "Codex") nor silently stop catching the classes it exists for.

import assert from "node:assert/strict";
import test from "node:test";

import { scanText, RESIDUE_CLASSES } from "./check-public-tree-hygiene.mjs";

function classIds(hits) {
  return hits.map((h) => h.classId);
}

test("flags the operator's absolute home path", () => {
  const hits = scanText("see /home/tnunamak/.tmp/report.md for detail");
  assert.deepEqual(classIds(hits), ["operator-home-path"]);
});

test("flags the personal machine codename, case-insensitively", () => {
  assert.deepEqual(classIds(scanText("tested on peregrine after restart")), ["machine-codename"]);
  assert.deepEqual(classIds(scanText("tested on Peregrine after restart")), ["machine-codename"]);
});

test("flags the internal *.vivid.fish hostname, including subdomains", () => {
  const hits = scanText("const url = 'https://peregrine-dev.vivid.fish';");
  const ids = classIds(hits);
  assert.ok(ids.includes("internal-hostname"));
});

test("flags waspflow/<slug> orchestrator branch references", () => {
  const hits = scanText("ported from waspflow/slack-full-coverage-0710 onto main");
  assert.deepEqual(classIds(hits), ["orchestrator-branch-jargon"]);
});

test("does not flag legitimate product/connector names", () => {
  const text = [
    "The Claude and Codex connectors both use the MCP client.",
    "Anthropic's Claude Code and OpenAI's Codex CLI are supported agents.",
    "waspFlowRate is an unrelated identifier and must not match.",
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("does not flag an unrelated *.fish-less hostname or bare 'wasp'", () => {
  const text = ["visit example.com for docs", "a wasp landed on the wasplow near the pond"].join(
    "\n"
  );
  assert.deepEqual(scanText(text), []);
});

test("reports 1-indexed line numbers matching the source text", () => {
  const hits = scanText("line one\nline two has peregrine\nline three");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].lineNumber, 2);
});

test("every declared residue class has a working describe()", () => {
  for (const cls of RESIDUE_CLASSES) {
    const detail = cls.describe("example-match");
    assert.equal(typeof detail, "string");
    assert.ok(detail.length > 0);
  }
});
