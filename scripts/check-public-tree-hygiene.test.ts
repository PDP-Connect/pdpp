#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Hermetic guard for scripts/check-public-tree-hygiene.ts.
//
// Pins the four narrow residue-class patterns against both hazard and
// legitimate-content cases so the check can never regress into a broad
// internal-jargon filter (it must not flag product/connector names like
// "Claude" or "Codex") nor silently stop catching the classes it exists for.

import assert from "node:assert/strict";
import test from "node:test";

import { RESIDUE_CLASSES, scanText } from "./check-public-tree-hygiene.ts";

function classIds(hits: { classId: string }[]): string[] {
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

test("flags a real personal mailbox at a consumer mail host", () => {
  // The exact leak class this check was extended for: a maintainer's real
  // address sitting in a test fixture, and a third party's address copied
  // out of a live Gmail `cc` field.
  // The probe addresses are themselves synthetic: a scanner cannot tell a
  // canary from a real mailbox, so this file must not hold anyone's actual
  // address even to prove the check works.
  assert.deepEqual(classIds(scanText('const owner = "rlangdon@gmail.com";')), ["personal-email-address"]);
  assert.deepEqual(classIds(scanText('{ email: "s.lindqvist@icloud.com" }')), ["personal-email-address"]);
  assert.deepEqual(classIds(scanText("contact first.last+tag@proton.me for access")), ["personal-email-address"]);
});

test("does not flag synthetic addresses at RFC 2606 reserved domains", () => {
  // These are the repo's established convention, so the fix for a hit is
  // always to move the address here — never to widen an allowlist.
  const text = [
    'assert.equal(redactEmailForProgress("taylor.rivera@example.com"), "t***@example.com");',
    '{ email: "sasha.lindqvist@example.org", name: "Sasha Lindqvist" }',
    'account_email: "jordan@example.com"',
    'const fixture = "owner@example.test";',
    'const pinned = "pdpp-reference@example.invalid";',
    'const nested = "front-desk@dental.example";',
  ].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("does not flag role mailboxes or placeholder locals at real domains", () => {
  // Fixture data legitimately carries vendor role senders and generic
  // placeholders; neither identifies a person, so neither is residue.
  const text = [
    'from: "GitHub <noreply@github.com>"',
    'from: "Chase Online <no-reply@chase.com>"',
    'from: "Costco Wholesale <orders@costco.com>"',
    "security@vana.org is the published disclosure contact",
    'const placeholder = "your-chatgpt-email@example.com";',
    'const generic = "user@gmail.com";',
    'const generic2 = "you@icloud.com";',
    'url = "git@github.com:PDP-Connect/pdpp.git"',
  ].join("\n");
  assert.deepEqual(scanText(text), []);
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
  const text = ["visit example.com for docs", "a wasp landed on the wasplow near the pond"].join("\n");
  assert.deepEqual(scanText(text), []);
});

test("reports 1-indexed line numbers matching the source text", () => {
  const hits = scanText("line one\nline two has peregrine\nline three");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.lineNumber, 2);
});

test("every declared residue class has a working describe()", () => {
  for (const cls of RESIDUE_CLASSES) {
    const detail = cls.describe("example-match");
    assert.equal(typeof detail, "string");
    assert.ok(detail.length > 0);
  }
});
